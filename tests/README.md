# Engine tests

Headless tests for the main-process engines — no Electron, no display, no
network. They run under plain node in a few seconds.

```bash
npm test
```

| Script | Covers |
| --- | --- |
| `npm run test:studio` | pty manager, adapters, policy engine, live wiring |
| `npm run test:orchestrator` | key pool, capability bus, planner, runner, scheduler |
| `npm run test:build` | just regenerate the bundles |

## How it works

Main-process modules import `electron`, which does not exist outside the
Electron runtime. `build.mjs` bundles each module with esbuild, aliasing
`electron` to [electron-stub.js](electron-stub.js) — a dozen-line fake exposing
only the surface these modules touch (`app.getPath`, `safeStorage`, `ipcMain`).
The result is a self-contained `.test.cjs` that node can `require` directly.

`node-pty` stays **external**: it is a real native addon, and the tests spawn
real PowerShell processes rather than mocking the terminal. A bundled copy would
not load its prebuilt binary.

Bundles are build output and gitignored. Regenerate them any time:

```bash
node tests/build.mjs
```

## What the studio tests actually prove

The interesting assertions are the safety ones, because auto-answering an
agent's permission prompt is the genuinely dangerous part of Studio:

- an agent is **still blocked** while a human decides — not racing ahead behind
  the approval card
- a catastrophic command (`rm -rf /`, `curl … | sh`) is **never** auto-answered,
  including in autonomous mode
- an **unrecognised** prompt asks rather than guessing
- a prompt is answered **once**, and is not re-answered when the TUI redraws
- two concurrent agents queue independently and each gets its own answer
- the policy server binds localhost only and rejects requests without its
  bearer token

`test-studio-wiring.mjs` deliberately registers a throwing data listener to
confirm one bad subscriber cannot break the terminal stream. The
`[Studio] data hook threw` line in its output is that listener being caught —
it is expected, not a failure.
