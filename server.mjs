/**
 * pi-crust-ext-terminal — server activation.
 *
 * Registers a PTY (pseudo-terminal) protocol on the SHARED Socket.IO realtime
 * gateway via `ctx.server.realtime.onConnection` (the extension-API capability
 * added in pi-crust core). Each browser connection that opens the Terminal
 * sidebar speaks the `pty:*` wire protocol:
 *
 *   client -> server : pty:open { sessionId, cols, rows }      -> ack { ok, ptyId }
 *                       pty:input { ptyId, data }              -> ack { ok }
 *                       pty:resize { ptyId, cols, rows }       -> ack { ok }
 *                       pty:close { ptyId }                    -> ack { ok }
 *   server -> client : pty:data { ptyId, seq, data }
 *                       pty:exit { ptyId, exitCode, signal? }
 *
 * Ownership is per-connection: a socket can only touch ptys it opened, and a
 * disconnect kills them (no orphan shells). The shell cwd is resolved from the
 * session (`prc.sessions.get(sessionId).cwd`) — the same trusted cwd the rest
 * of pi-crust confines to — so a terminal can never escape the session root.
 */
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);

const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024; // 1 MiB
const TRUNCATION_MARKER = '\r\n[pty: output truncated]\r\n';

export default function activate(prc) {
  // This extension requires the `ctx.server.realtime` capability (pi-crust core
  // with PR #219+). On older hosts it is absent — fail with a clear, actionable
  // message instead of a cryptic "cannot read properties of undefined".
  if (typeof prc?.server?.realtime?.onConnection !== 'function') {
    throw new Error(
      '@cemoody/pi-crust-ext-terminal requires a pi-crust version that provides ' +
      'ctx.server.realtime (the per-connection Socket.IO API). Your pi-crust is ' +
      'too old. Please upgrade pi-crust to a release that includes ctx.server.realtime.',
    );
  }

  // Sidebar entry. The matching web module (web.mjs, declared via piCrust.web)
  // renders the wterm panel; core mounts it as a sidebar activity automatically.
  // `icon` asks the host to use its built-in terminal glyph instead of the
  // generic extension icon (host support added in pi-crust core; older hosts
  // simply ignore the field and fall back to the default glyph).
  prc.activity.registerView({ id: 'cemoody.terminal.activity', title: 'Terminal', icon: 'terminal', order: 40 });

  const manager = createPtyManager({ spawn: createNodePtySpawner() });

  prc.server.realtime.onConnection((conn) => {
    // ptys this connection opened; the only ptys it is allowed to touch.
    const owned = new Set();

    const offData = manager.onData((event) => {
      if (owned.has(event.ptyId)) conn.emit('pty:data', event);
    });
    const offExit = manager.onExit((event) => {
      if (!owned.has(event.ptyId)) return;
      owned.delete(event.ptyId);
      conn.emit('pty:exit', event);
    });

    conn.on('pty:open', async (payload, ack) => {
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : undefined;
      if (!sessionId) { ack?.({ ok: false, error: 'pty:open requires a sessionId' }); return; }
      let cwd;
      try {
        const session = await prc.sessions.get?.(sessionId);
        cwd = session?.cwd;
        if (!cwd) throw new Error(`unknown session: ${sessionId}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ack?.({ ok: false, error: /unknown session/i.test(message) ? `unknown session: ${sessionId}` : message });
        return;
      }
      try {
        const cols = typeof payload?.cols === 'number' ? payload.cols : 80;
        const rows = typeof payload?.rows === 'number' ? payload.rows : 24;
        const ptyId = manager.open({ cwd, cols, rows });
        owned.add(ptyId);
        ack?.({ ok: true, ptyId });
      } catch (error) {
        ack?.({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });

    conn.on('pty:input', (payload, ack) => {
      const ptyId = typeof payload?.ptyId === 'string' ? payload.ptyId : undefined;
      if (!ptyId || !owned.has(ptyId)) { ack?.({ ok: false, error: 'unknown pty' }); return; }
      manager.input(ptyId, typeof payload?.data === 'string' ? payload.data : '');
      ack?.({ ok: true });
    });

    conn.on('pty:resize', (payload, ack) => {
      const ptyId = typeof payload?.ptyId === 'string' ? payload.ptyId : undefined;
      if (!ptyId || !owned.has(ptyId)) { ack?.({ ok: false, error: 'unknown pty' }); return; }
      manager.resize(ptyId, Number(payload?.cols), Number(payload?.rows));
      ack?.({ ok: true });
    });

    conn.on('pty:close', (payload, ack) => {
      const ptyId = typeof payload?.ptyId === 'string' ? payload.ptyId : undefined;
      if (ptyId && owned.has(ptyId)) { owned.delete(ptyId); manager.close(ptyId); }
      ack?.({ ok: true });
    });

    // Disconnect: kill every pty this socket owned, then detach manager taps.
    return () => {
      for (const ptyId of [...owned]) { try { manager.close(ptyId); } catch { /* ignore */ } }
      owned.clear();
      offData();
      offExit();
    };
  });
}

// --- PtyManager (ported from pi-crust core, dependency-free) --------------
export function createPtyManager(options) {
  const spawn = options.spawn;
  const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  const ptys = new Map();
  const dataListeners = new Set();
  const exitListeners = new Set();
  let nextId = 1;

  const clampDimension = (value) => {
    if (!Number.isFinite(value)) return null;
    const floored = Math.floor(value);
    return floored > 0 ? floored : null;
  };

  const emitData = (ptyId, entry, data) => {
    entry.seq += 1;
    const envelope = { ptyId, seq: entry.seq, data };
    for (const listener of [...dataListeners]) listener(envelope);
  };

  const handleData = (ptyId, entry, data) => {
    entry.bufferedBytes += Buffer.byteLength(data, 'utf8');
    if (entry.bufferedBytes > maxBufferedBytes && !entry.truncatedNotified) {
      entry.truncatedNotified = true;
      emitData(ptyId, entry, TRUNCATION_MARKER);
      return;
    }
    emitData(ptyId, entry, data);
  };

  const handleExit = (ptyId, entry, exitCode, signal) => {
    if (!ptys.has(ptyId)) return;
    ptys.delete(ptyId);
    for (const unsub of entry.unsubscribers) { try { unsub(); } catch { /* ignore */ } }
    const envelope = signal === undefined ? { ptyId, exitCode } : { ptyId, exitCode, signal };
    for (const listener of [...exitListeners]) listener(envelope);
  };

  return {
    open(opts) {
      const cols = clampDimension(opts.cols) ?? 80;
      const rows = clampDimension(opts.rows) ?? 24;
      const child = spawn({ cwd: opts.cwd, cols, rows });
      const ptyId = `pty-${nextId++}`;
      const entry = { child, seq: 0, bufferedBytes: 0, truncatedNotified: false, unsubscribers: [] };
      ptys.set(ptyId, entry);
      entry.unsubscribers.push(child.onData((data) => handleData(ptyId, entry, data)));
      entry.unsubscribers.push(child.onExit((event) => handleExit(ptyId, entry, event.exitCode, event.signal)));
      return ptyId;
    },
    input(ptyId, data) {
      const entry = ptys.get(ptyId);
      if (entry) entry.child.write(data);
    },
    resize(ptyId, cols, rows) {
      const entry = ptys.get(ptyId);
      if (!entry) return;
      const c = clampDimension(cols);
      const r = clampDimension(rows);
      if (c === null || r === null) return;
      entry.child.resize(c, r);
    },
    close(ptyId) {
      const entry = ptys.get(ptyId);
      if (!entry) return;
      entry.child.kill();
      if (ptys.has(ptyId)) handleExit(ptyId, entry, 137, 9);
    },
    onData(listener) { dataListeners.add(listener); return () => dataListeners.delete(listener); },
    onExit(listener) { exitListeners.add(listener); return () => exitListeners.delete(listener); },
    has(ptyId) { return ptys.has(ptyId); },
    disposeAll() { for (const ptyId of [...ptys.keys()]) this.close(ptyId); },
  };
}

// --- node-pty spawner ------------------------------------------------------
function defaultShell() {
  if (process.platform === 'win32') return process.env.COMSPEC ?? 'cmd.exe';
  return process.env.SHELL ?? '/bin/bash';
}

export function createNodePtySpawner(spawnerOptions = {}) {
  return (opts) => {
    // Lazy require so the native addon only loads when a real pty is opened
    // (keeps activation cheap and survives platforms where node-pty is absent
    // until the user actually opens a terminal).
    const pty = requireCjs('node-pty');
    const child = pty.spawn(opts.shell ?? spawnerOptions.defaultShell ?? defaultShell(), [], {
      name: 'xterm-color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: { ...process.env, ...spawnerOptions.env, ...opts.env, TERM: 'xterm-color' },
    });
    return {
      pid: child.pid,
      write: (data) => child.write(data),
      resize: (cols, rows) => child.resize(cols, rows),
      onData: (listener) => { const sub = child.onData(listener); return () => sub.dispose(); },
      onExit: (listener) => {
        const sub = child.onExit(({ exitCode, signal }) => listener(signal === undefined ? { exitCode } : { exitCode, signal }));
        return () => sub.dispose();
      },
      kill: (signal) => { try { child.kill(signal); } catch { /* already dead */ } },
    };
  };
}
