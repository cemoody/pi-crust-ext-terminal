/**
 * pi-crust-ext-terminal — web module (source).
 *
 * Bundled by scripts/build-web.mjs into ../web.mjs (a single self-contained
 * ESM file: @wterm/dom + socket.io-client are inlined; React stays EXTERNAL
 * and is provided by the host via props.React, matching how core loads
 * external web activities).
 *
 * Exports `renderActivity(props)` — the contract pi-crust's ExternalWebActivity
 * expects. props: { React, api, activity, extensions, navigation }.
 */
import { WTerm } from '@wterm/dom';
import { io } from 'socket.io-client';
// wterm's REQUIRED stylesheet, inlined as a string by the build (text loader).
// Without it the terminal renders as unstyled proportional text — see
// scripts/build-web.mjs.
import wtermCss from '@wterm/dom/src/terminal.css';

const STYLE_ELEMENT_ID = 'pi-crust-ext-terminal-wterm-css';

// Inject wterm's CSS once into <head>. Idempotent across mounts/instances and
// safe if the document isn't ready yet.
function ensureWtermStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ELEMENT_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ELEMENT_ID;
  style.textContent = wtermCss;
  (document.head || document.documentElement).appendChild(style);
}

export function renderActivity(props) {
  const React = props.React;
  ensureWtermStyles();
  return React.createElement(TerminalActivity, { hostProps: props });
}

export default renderActivity;

// A terminal is bound to the active session. We read the active session id
// from the host api when available, else fall back to the first listed session.
function TerminalActivity({ hostProps }) {
  const React = hostProps.React;
  const { useEffect, useRef, useState } = React;
  const hostRef = useRef(null);
  const [sessionId, setSessionId] = useState(null);
  const [status, setStatus] = useState('resolving-session');
  const [exit, setExit] = useState(null);
  const [restartNonce, setRestartNonce] = useState(0);

  // Resolve a session to attach the shell to.
  useEffect(() => {
    let cancelled = false;
    resolveSessionId(hostProps.api)
      .then((id) => { if (!cancelled) { setSessionId(id ?? null); setStatus(id ? 'ready' : 'no-session'); } })
      .catch(() => { if (!cancelled) setStatus('no-session'); });
    return () => { cancelled = true; };
  }, []);

  // Own the wterm view + socket lifecycle once a session is known. Recreated on
  // restart (restartNonce) so an exited shell can be relaunched in place.
  useEffect(() => {
    if (!sessionId) return undefined;
    const host = hostRef.current;
    if (!host) return undefined;
    ensureWtermStyles();

    let disposed = false;
    let ptyId = null;
    const transport = createSocketTerminalTransport();

    const term = new WTerm(host, {
      autoResize: true,
      onData: (data) => { if (ptyId) transport.input(ptyId, data); },
      onResize: (cols, rows) => { if (ptyId) transport.resize(ptyId, cols, rows); },
    });

    const offData = transport.onData((event) => { if (event.ptyId === ptyId) term.write(event.data); });
    const offExit = transport.onExit((event) => { if (event.ptyId === ptyId) setExit({ exitCode: event.exitCode }); });

    Promise.resolve(term.init())
      .then(() => transport.open(sessionId, term.cols || 80, term.rows || 24))
      .then((openedPtyId) => {
        if (disposed) { transport.close(openedPtyId); return; }
        ptyId = openedPtyId;
        setStatus('connected');
        term.focus();
      })
      .catch((error) => { if (!disposed) { setStatus('error'); setExit({ exitCode: -1, message: String(error?.message ?? error) }); } });

    return () => {
      disposed = true;
      offData();
      offExit();
      if (ptyId) transport.close(ptyId);
      try { term.destroy(); } catch { /* ignore */ }
      transport.dispose();
    };
  }, [sessionId, restartNonce]);

  return React.createElement(
    'div',
    { className: 'pi-crust-ext-terminal', role: 'tabpanel', 'aria-label': 'Terminal', style: PANEL_STYLE },
    status === 'no-session'
      ? React.createElement('div', { role: 'status', style: NOTICE_STYLE }, 'Open or create a session to start a terminal.')
      : null,
    React.createElement('div', { ref: hostRef, className: 'pi-crust-ext-terminal-host', 'data-testid': 'wterm-root', style: HOST_STYLE }),
    exit
      ? React.createElement(
          'div',
          { className: 'pi-crust-ext-terminal-exit', role: 'status', style: EXIT_STYLE },
          React.createElement('span', null, exit.message ? `Terminal error: ${exit.message}` : `Process exited (code ${exit.exitCode})`),
          React.createElement(
            'button',
            { type: 'button', onClick: () => { setExit(null); setStatus('ready'); setRestartNonce((n) => n + 1); }, style: BUTTON_STYLE },
            'Restart',
          ),
        )
      : null,
  );
}

async function resolveSessionId(api) {
  // Prefer an explicit active session if the host exposes one.
  try {
    if (typeof api?.getActiveSessionId === 'function') {
      const id = await api.getActiveSessionId();
      if (id) return id;
    }
  } catch { /* fall through */ }
  // Otherwise attach to the most recent listed session.
  try {
    const cwd = typeof api?.getDefaultCwd === 'function' ? await api.getDefaultCwd() : undefined;
    const sessions = await api.listSessions(cwd);
    if (Array.isArray(sessions) && sessions.length > 0) return sessions[0].id;
  } catch { /* fall through */ }
  return null;
}

// Dedicated socket on the SAME origin the page loaded from. Core mounts the
// realtime gateway at /socket.io/ on that origin, and our extension registered
// the pty:* handlers on it via ctx.server.realtime.
function createSocketTerminalTransport() {
  const socket = io(window.location.origin, {
    path: '/socket.io/',
    transports: ['websocket', 'polling'],
    reconnection: true,
  });
  const dataListeners = new Set();
  const exitListeners = new Set();
  socket.on('pty:data', (e) => { for (const l of [...dataListeners]) l(e); });
  socket.on('pty:exit', (e) => { for (const l of [...exitListeners]) l(e); });

  const emitWithAck = (event, payload) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} ack timeout`)), 5000);
    socket.emit(event, payload, (ack) => { clearTimeout(timer); resolve(ack); });
  });

  return {
    async open(sessionId, cols, rows) {
      const ack = await emitWithAck('pty:open', { sessionId, cols, rows });
      if (!ack?.ok || !ack.ptyId) throw new Error(ack?.error ?? 'pty:open failed');
      return ack.ptyId;
    },
    input(ptyId, data) { socket.emit('pty:input', { ptyId, data }); },
    resize(ptyId, cols, rows) { socket.emit('pty:resize', { ptyId, cols, rows }); },
    close(ptyId) { socket.emit('pty:close', { ptyId }); },
    onData(listener) { dataListeners.add(listener); return () => dataListeners.delete(listener); },
    onExit(listener) { exitListeners.add(listener); return () => exitListeners.delete(listener); },
    dispose() { try { socket.disconnect(); } catch { /* ignore */ } },
  };
}

const PANEL_STYLE = { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 };
const HOST_STYLE = { flex: '1 1 auto', minHeight: 0, width: '100%' };
const NOTICE_STYLE = { padding: '12px', opacity: 0.8 };
const EXIT_STYLE = { display: 'flex', alignItems: 'center', gap: '12px', padding: '8px 12px', borderTop: '1px solid rgba(127,127,127,0.3)' };
const BUTTON_STYLE = { padding: '4px 12px', cursor: 'pointer' };
