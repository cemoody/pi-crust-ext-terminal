import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPtyManager } from '../server.mjs';
import activate from '../server.mjs';

/** A fake pty child + spawner so the suite needs no real shell / native addon. */
function fakeSpawner() {
  const children = [];
  const spawn = (opts) => {
    const dataListeners = new Set();
    const exitListeners = new Set();
    const child = {
      opts,
      pid: 1000 + children.length,
      killed: false,
      written: [],
      lastResize: null,
      write: (d) => child.written.push(d),
      resize: (cols, rows) => { child.lastResize = { cols, rows }; },
      onData: (l) => { dataListeners.add(l); return () => dataListeners.delete(l); },
      onExit: (l) => { exitListeners.add(l); return () => exitListeners.delete(l); },
      kill: () => { child.killed = true; for (const l of [...exitListeners]) l({ exitCode: 0 }); },
      emitData: (d) => { for (const l of [...dataListeners]) l(d); },
      emitExit: (e) => { for (const l of [...exitListeners]) l(e); },
    };
    children.push(child);
    return child;
  };
  return { spawn, children };
}

describe('createPtyManager', () => {
  it('opens a pty, streams ordered data, routes input, and resizes', () => {
    const { spawn, children } = fakeSpawner();
    const manager = createPtyManager({ spawn });
    const data = [];
    manager.onData((e) => data.push(e));

    const ptyId = manager.open({ cwd: '/tmp', cols: 80, rows: 24 });
    expect(ptyId).toBe('pty-1');
    expect(children[0].opts.cwd).toBe('/tmp');

    children[0].emitData('hello');
    children[0].emitData('world');
    expect(data).toEqual([
      { ptyId: 'pty-1', seq: 1, data: 'hello' },
      { ptyId: 'pty-1', seq: 2, data: 'world' },
    ]);

    manager.input(ptyId, 'ls\n');
    expect(children[0].written).toEqual(['ls\n']);

    manager.resize(ptyId, 120, 40);
    expect(children[0].lastResize).toEqual({ cols: 120, rows: 40 });
  });

  it('emits exit and stops streaming after the child exits', () => {
    const { spawn, children } = fakeSpawner();
    const manager = createPtyManager({ spawn });
    const exits = [];
    manager.onExit((e) => exits.push(e));

    const ptyId = manager.open({ cwd: '/tmp', cols: 80, rows: 24 });
    children[0].emitExit({ exitCode: 3, signal: 15 });
    expect(exits).toEqual([{ ptyId, exitCode: 3, signal: 15 }]);
    expect(manager.has(ptyId)).toBe(false);
  });

  it('truncates runaway output with a marker instead of buffering unbounded', () => {
    const { spawn, children } = fakeSpawner();
    const manager = createPtyManager({ spawn, maxBufferedBytes: 8 });
    const data = [];
    manager.onData((e) => data.push(e.data));
    manager.open({ cwd: '/tmp', cols: 80, rows: 24 });
    children[0].emitData('123456789'); // > 8 bytes
    expect(data.at(-1)).toContain('output truncated');
  });

  it('close() is terminal and idempotent', () => {
    const { spawn, children } = fakeSpawner();
    const manager = createPtyManager({ spawn });
    const exits = [];
    manager.onExit((e) => exits.push(e));
    const ptyId = manager.open({ cwd: '/tmp', cols: 80, rows: 24 });
    manager.close(ptyId);
    manager.close(ptyId);
    expect(children[0].killed).toBe(true);
    expect(exits.length).toBe(1);
    expect(manager.has(ptyId)).toBe(false);
  });
});

describe('activate (realtime pty:* protocol via ctx.server.realtime)', () => {
  // A fake extension context that captures the connection handler and lets the
  // test drive a fake socket connection through it, exactly like the real
  // gateway does.
  function fakeContext() {
    const { spawn, children } = fakeSpawner();
    let connectionHandler;
    const activities = [];
    const sessions = new Map([['s1', { id: 's1', cwd: '/work/s1' }]]);
    const prc = {
      activity: { registerView: (v) => activities.push(v) },
      sessions: { get: async (id) => sessions.get(id) },
      server: {
        realtime: { onConnection: (handler) => { connectionHandler = handler; return { dispose() {} }; } },
      },
    };
    // Inject our fake spawner by patching the manager's spawner: activate()
    // builds its own manager with the real node-pty spawner, so instead we test
    // through a connection but stub node-pty by routing open via the fake. To
    // keep activate() honest we override createNodePtySpawner indirectly: the
    // simplest seam is to not call activate's internal spawner — see note.
    return { prc, children, getHandler: () => connectionHandler, activities, spawn };
  }

  function fakeConnection() {
    const handlers = new Map();
    const emitted = [];
    const conn = {
      id: 'sock-1',
      on: (event, handler) => { handlers.set(event, handler); },
      emit: (event, payload) => { emitted.push({ event, payload }); },
    };
    const send = (event, payload) => new Promise((resolve) => {
      const h = handlers.get(event);
      if (!h) return resolve(undefined);
      const maybe = h(payload, resolve);
      if (maybe && typeof maybe.then === 'function') maybe.catch(() => resolve({ ok: false }));
    });
    return { conn, emitted, send };
  }

  it('registers a Terminal sidebar activity', () => {
    const { prc, activities } = fakeContext();
    activate(prc);
    expect(activities.map((a) => a.title)).toContain('Terminal');
  });

  it('refuses to activate (with a clear message) on a host without ctx.server.realtime', () => {
    const noRealtime = {
      activity: { registerView() {} },
      sessions: { get: async () => undefined },
      server: {}, // older pi-crust: no realtime capability
    };
    expect(() => activate(noRealtime)).toThrow(/requires.*ctx\.server\.realtime/i);
  });

  it('rejects pty:open without a sessionId and for unknown sessions', async () => {
    const { prc, getHandler } = fakeContext();
    activate(prc);
    const { conn, send } = fakeConnection();
    getHandler()(conn);

    expect(await send('pty:open', {})).toEqual({ ok: false, error: 'pty:open requires a sessionId' });
    expect(await send('pty:open', { sessionId: 'nope' })).toEqual({ ok: false, error: 'unknown session: nope' });
  });
});

// Regression: the terminal previously rendered as unstyled proportional text
// because wterm's REQUIRED stylesheet (.wterm/.term-grid/.term-row) was never
// loaded. The build must INLINE that CSS into web.mjs and the module must
// inject it as a <style> tag at runtime.
describe('web.mjs bundles + injects wterm CSS', () => {
  const web = readFileSync(fileURLToPath(new URL('../web.mjs', import.meta.url)), 'utf8');

  it('inlines wterm CSS class rules into the bundle', () => {
    // Core wterm selectors that come ONLY from terminal.css.
    expect(web).toContain('.term-grid');
    expect(web).toContain('.term-row');
    // The terminal palette / monospace declaration proves the full sheet (not
    // just a class name reference) is present.
    expect(web).toMatch(/--term-font-family|monospace/);
    expect(web).toContain('--term-bg');
  });

  it('injects the stylesheet via a <style> tag at runtime', () => {
    // The injection helper creates a <style> and appends it to the document.
    expect(web).toMatch(/createElement\(["']style["']\)/);
    expect(web).toContain('pi-crust-ext-terminal-wterm-css');
  });
});
