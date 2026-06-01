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
  style.textContent = wtermCss + '\n' + TOOLBAR_CSS;
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
  const { useCallback, useEffect, useRef, useState } = React;
  const hostRef = useRef(null);
  // Live refs to the active terminal + transport so toolbar buttons can act on
  // the CURRENT shell without re-subscribing or re-rendering on every change.
  const termRef = useRef(null);
  const ptyIdRef = useRef(null);
  const transportRef = useRef(null);
  const [sessionId, setSessionId] = useState(null);
  const [status, setStatus] = useState('resolving-session');
  const [exit, setExit] = useState(null);
  const [restartNonce, setRestartNonce] = useState(0);
  const [maximized, setMaximized] = useState(false);
  const [copied, setCopied] = useState(false);

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
    transportRef.current = transport;

    const term = new WTerm(host, {
      autoResize: true,
      onData: (data) => { if (ptyId) transport.input(ptyId, data); },
      onResize: (cols, rows) => { if (ptyId) transport.resize(ptyId, cols, rows); },
    });
    termRef.current = term;

    const offData = transport.onData((event) => { if (event.ptyId === ptyId) term.write(event.data); });
    const offExit = transport.onExit((event) => { if (event.ptyId === ptyId) setExit({ exitCode: event.exitCode }); });

    Promise.resolve(term.init())
      .then(() => transport.open(sessionId, term.cols || 80, term.rows || 24))
      .then((openedPtyId) => {
        if (disposed) { transport.close(openedPtyId); return; }
        ptyId = openedPtyId;
        ptyIdRef.current = openedPtyId;
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
      if (termRef.current === term) termRef.current = null;
      if (transportRef.current === transport) transportRef.current = null;
      if (ptyIdRef.current === ptyId) ptyIdRef.current = null;
    };
  }, [sessionId, restartNonce]);

  // After (un)maximizing, the container box changes size; nudge wterm to refit
  // on the next frame so cols/rows match the new viewport.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return undefined;
    const id = requestAnimationFrame(() => { try { term.resize(term.cols, term.rows); term.focus(); } catch { /* ignore */ } });
    return () => cancelAnimationFrame(id);
  }, [maximized]);

  // Esc leaves the maximized (full-viewport) view.
  useEffect(() => {
    if (!maximized) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setMaximized(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [maximized]);

  // --- Toolbar actions -----------------------------------------------------
  // Maximize: fill the viewport height (your requested button). The panel goes
  // to a fixed full-viewport box; wterm autoResize + the effect above refit it.
  const toggleMaximize = useCallback(() => setMaximized((m) => !m), []);

  // Clear: send Ctrl+L (form-feed) to the shell so it redraws a clean screen.
  // (wterm has no public clear(); driving the PTY keeps scrollback semantics
  // identical to a real terminal.)
  const clearScreen = useCallback(() => {
    const ptyId = ptyIdRef.current;
    const transport = transportRef.current;
    if (ptyId && transport) transport.input(ptyId, '\f');
    termRef.current?.focus?.();
  }, []);

  // Copy: grab the rendered buffer text and write it to the clipboard.
  const copyBuffer = useCallback(async () => {
    const host = hostRef.current;
    const text = host ? (host.querySelector('.term-grid')?.innerText ?? host.innerText ?? '') : '';
    const trimmed = String(text).replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
    try {
      await navigator.clipboard.writeText(trimmed);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* clipboard blocked; ignore */ }
    termRef.current?.focus?.();
  }, []);

  // Restart: tear down + relaunch the shell in place.
  const restartShell = useCallback(() => {
    setExit(null);
    setStatus('ready');
    setRestartNonce((n) => n + 1);
  }, []);

  const hasSession = status !== 'no-session' && status !== 'resolving-session';

  // Icon-only toolbar, styled to mirror the host's Fork/Clone action buttons:
  // small (26px) square, borderless, subtle, grouped at the right. The CSS for
  // the hover/disabled states is injected with the wterm styles.
  const iconColor = maximized ? 'rgba(212,212,212,0.85)' : undefined;
  const toolbar = React.createElement(
    'div',
    { className: 'pi-crust-ext-terminal-toolbar', role: 'toolbar', 'aria-label': 'Terminal actions' },
    React.createElement(IconButton, {
      React, title: copied ? 'Copied' : 'Copy terminal output', testid: 'term-btn-copy',
      onClick: copyBuffer, disabled: !hasSession, color: iconColor,
      glyph: copied ? CheckIconPath : CopyIconPath,
    }),
    React.createElement(IconButton, {
      React, title: 'Clear screen (Ctrl+L)', testid: 'term-btn-clear',
      onClick: clearScreen, disabled: !hasSession, color: iconColor, glyph: ClearIconPath,
    }),
    React.createElement(IconButton, {
      React, title: 'Restart the shell', testid: 'term-btn-restart',
      onClick: restartShell, disabled: !hasSession, color: iconColor, glyph: RestartIconPath,
    }),
    React.createElement(IconButton, {
      React, title: maximized ? 'Restore terminal size (Esc)' : 'Resize terminal to fill the viewport',
      testid: 'term-btn-maximize', onClick: toggleMaximize, disabled: !hasSession,
      'aria-pressed': maximized, color: iconColor,
      glyph: maximized ? RestoreIconPath : MaximizeIconPath,
    }),
  );

  return React.createElement(
    'div',
    {
      className: `pi-crust-ext-terminal${maximized ? ' is-maximized' : ''}`,
      role: 'tabpanel', 'aria-label': 'Terminal',
      'data-maximized': maximized ? 'true' : 'false',
      style: maximized ? MAXIMIZED_PANEL_STYLE : PANEL_STYLE,
    },
    toolbar,
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
            { type: 'button', onClick: restartShell, style: BUTTON_STYLE },
            'Restart',
          ),
        )
      : null,
  );
}

// A small, icon-only square button mirroring the host's Fork/Clone actions:
// 26px, borderless, transparent, subtle hover (driven by the injected CSS via
// the `term-toolbar-btn` class). `color` overrides the glyph color (used to
// lighten icons over the dark maximized background).
function IconButton({ React, glyph, title, testid, onClick, disabled, color, ...rest }) {
  return React.createElement(
    'button',
    {
      type: 'button', className: 'term-toolbar-btn', title, 'aria-label': title,
      'data-testid': testid, onClick, disabled,
      style: color ? { color } : undefined, ...rest,
    },
    React.createElement(
      'svg',
      { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
      glyph(React),
    ),
  );
}

// Inline SVG glyph bodies (line-art, 16x16), matching the host's icon style.
function CopyIconPath(R) {
  return R.createElement(R.Fragment, null,
    R.createElement('rect', { x: 5.5, y: 5.5, width: 8, height: 8, rx: 1.5 }),
    R.createElement('path', { d: 'M11.5 5.5V4A1.5 1.5 0 0 0 10 2.5H4A1.5 1.5 0 0 0 2.5 4v6A1.5 1.5 0 0 0 4 11.5h1.5' }),
  );
}
function CheckIconPath(R) {
  return R.createElement('path', { d: 'M3.5 8.5l3 3 6-7' });
}
function ClearIconPath(R) {
  // Eraser/clear: a slash through a box.
  return R.createElement(R.Fragment, null,
    R.createElement('rect', { x: 2.5, y: 2.5, width: 11, height: 11, rx: 2 }),
    R.createElement('path', { d: 'M5 11l6-6' }),
  );
}
function RestartIconPath(R) {
  // Circular refresh arrow.
  return R.createElement(R.Fragment, null,
    R.createElement('path', { d: 'M12.5 5.5A5 5 0 1 0 13 8' }),
    R.createElement('path', { d: 'M12.5 2.5v3h-3' }),
  );
}
function MaximizeIconPath(R) {
  // Expand: four corner arrows.
  return R.createElement(R.Fragment, null,
    R.createElement('path', { d: 'M6 2.5H2.5V6' }),
    R.createElement('path', { d: 'M10 2.5h3.5V6' }),
    R.createElement('path', { d: 'M13.5 10v3.5H10' }),
    R.createElement('path', { d: 'M2.5 10v3.5H6' }),
  );
}
function RestoreIconPath(R) {
  // Collapse: four inward corner arrows.
  return R.createElement(R.Fragment, null,
    R.createElement('path', { d: 'M2.5 5.5H6V2' }),
    R.createElement('path', { d: 'M13.5 5.5H10V2' }),
    R.createElement('path', { d: 'M13.5 10.5H10V14' }),
    R.createElement('path', { d: 'M2.5 10.5H6V14' }),
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
// Maximized: a fixed full-viewport overlay so the terminal fills the screen
// regardless of the host's sidebar/panel layout. Esc or the Restore button
// returns to the inline panel.
const MAXIMIZED_PANEL_STYLE = {
  display: 'flex', flexDirection: 'column',
  position: 'fixed', inset: '0', zIndex: 2147483000,
  height: '100vh', width: '100vw', minHeight: 0,
  background: 'var(--term-bg, #1e1e1e)', padding: '8px', boxSizing: 'border-box',
};
const HOST_STYLE = { flex: '1 1 auto', minHeight: 0, width: '100%' };
const NOTICE_STYLE = { padding: '12px', opacity: 0.8 };
const EXIT_STYLE = { display: 'flex', alignItems: 'center', gap: '12px', padding: '8px 12px', borderTop: '1px solid rgba(127,127,127,0.3)' };
const BUTTON_STYLE = { padding: '4px 12px', cursor: 'pointer' };
// Toolbar look/behavior live in injected CSS (TOOLBAR_CSS) so we get :hover /
// :disabled / :focus-visible states that match the host's Fork/Clone buttons.
const TOOLBAR_CSS = `
.pi-crust-ext-terminal-toolbar {
  display: flex;
  align-items: center;
  justify-content: flex-end; /* group actions off to the right */
  gap: 2px;
  padding: 4px 6px;
  flex: 0 0 auto;
  min-height: 34px;
  box-sizing: border-box;
}
.pi-crust-ext-terminal:not(.is-maximized) .pi-crust-ext-terminal-toolbar {
  border-bottom: 1px solid rgba(127,127,127,0.18);
}
.term-toolbar-btn {
  width: 26px;
  height: 26px;
  padding: 0;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: currentColor;
  opacity: 0.7;
  cursor: pointer;
  transition: background-color 0.12s ease, opacity 0.12s ease;
}
.term-toolbar-btn:hover:not(:disabled) {
  opacity: 1;
  background: rgba(127,127,127,0.18);
}
.term-toolbar-btn[aria-pressed="true"] {
  opacity: 1;
  background: rgba(127,127,127,0.22);
}
.term-toolbar-btn:disabled { opacity: 0.3; cursor: not-allowed; }
.term-toolbar-btn:focus-visible { outline: 0; box-shadow: 0 0 0 2px rgba(90,150,255,0.6); }
.pi-crust-ext-terminal.is-maximized .term-toolbar-btn:hover:not(:disabled),
.pi-crust-ext-terminal.is-maximized .term-toolbar-btn[aria-pressed="true"] {
  background: rgba(255,255,255,0.14);
}
`;
