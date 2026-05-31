# @cemoody/pi-crust-ext-terminal

A **browser terminal** for [pi-crust](https://github.com/cemoody/pi-crust), packaged as an extension. It adds a **Terminal** item to the sidebar that streams a real shell (PTY) for the active session over pi-crust's realtime gateway.

- **Server** (`server.mjs`): registers the `pty:*` protocol on the shared Socket.IO gateway via `ctx.server.realtime.onConnection`, spawning a real shell with [`node-pty`](https://github.com/microsoft/node-pty). The shell's working directory is the session's `cwd` — it can never escape the session root.
- **Web** (`web.mjs`): a self-contained ESM module that renders a [wterm](https://www.npmjs.com/package/@wterm/dom) DOM terminal and connects a dedicated socket to the page origin. React is provided by the host.

## Requirements

- pi-crust with the `ctx.server.realtime` extension API (pi-crust ≥ the release that includes PR #219).
- Node ≥ 22 (for `node-pty`'s prebuilt binaries / native build).

## Install

In pi-crust, open **Settings → Extensions → Add a source** and enter:

```
npm:@cemoody/pi-crust-ext-terminal
```

Or add it to your pi-crust `settings.json`:

```json
{
  "packages": [
    { "source": "npm:@cemoody/pi-crust-ext-terminal", "kind": "npm" }
  ]
}
```

You can also install from a git URL (`git:https://github.com/cemoody/pi-crust-ext-terminal`) or a local checkout path.

## Usage

After installing, a **Terminal** entry appears in the sidebar. Click it to open a shell bound to the active session's working directory. Closing the tab (or disconnecting) tears the shell down — no orphan processes.

## How it works

```
client ─ pty:open  { sessionId, cols, rows } ─► server ─ ack { ok, ptyId }
       ─ pty:input { ptyId, data }           ─►        ─ ack { ok }
       ─ pty:resize{ ptyId, cols, rows }     ─►        ─ ack { ok }
       ─ pty:close { ptyId }                 ─►        ─ ack { ok }
       ◄─ pty:data { ptyId, seq, data }
       ◄─ pty:exit { ptyId, exitCode, signal? }
```

Each browser connection owns only the PTYs it opened (per-connection scope), so there is zero cross-talk between terminals and a disconnect always cleans up.

## Development

```sh
npm install
npm run build   # bundles src/web.src.mjs -> web.mjs (wterm + socket.io-client inlined; React external)
npm test        # vitest unit tests for the PtyManager + realtime protocol
```

`web.mjs` is a generated artifact (committed for convenience and published) — edit `src/web.src.mjs` and re-run `npm run build`.

## License

MIT
