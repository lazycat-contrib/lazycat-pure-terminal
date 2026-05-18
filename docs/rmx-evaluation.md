# rmx Session Manager Evaluation

## Decision

Keep Pure Terminal's current `TerminalRegistry` / `ManagedTerminal` session runtime for this migration. Revisit `rmx` after the Restty frontend is stable and after the integration points below are either supported upstream or wrapped behind a local adapter.

## Why rmx Is Promising

`rmx` already has the right shape for a future backend consolidation:

- `SessionManager` is `Arc`-friendly and exposes `get_or_create`, `get`, `list`, and `close`.
- `InProcessBackend` uses `portable-pty`, `tokio`, and broadcast-style session events, matching Pure Terminal's current runtime stack.
- `FileStore` and `MemoryStore` separate session persistence from runtime control.
- `SessionHandle` exposes byte input, resize, history replay, interrupt, and command-run helpers.

## Current Gaps For Direct Replacement

Pure Terminal's session layer currently owns several app-specific contracts that are not a one-to-one fit yet:

- Session records persist LightOS selector, host, tab/pane metadata, restartability, and Connect proto state.
- The WebSocket path replays bounded output frames from an in-memory buffer before subscribing to live output.
- Session status is persisted as `running`, `stopped`, `exited`, or `closed`, and non-restartable sessions are pruned at startup.
- Shell startup is LightOS-specific: `/lzcinit/lightosctl exec -ti <selector> /bin/sh -lc <bootstrap>`.
- Resize and terminal I/O currently keep the existing binary WebSocket protocol stable for the frontend and provider contract.

## Recommended Migration Path

1. Add a small local `TerminalRuntime` trait around open, close, resize, write, subscribe, and replay.
2. Implement that trait with the current `TerminalRegistry` first, with no behavior change.
3. Add an experimental `rmx` implementation behind a Cargo feature or branch.
4. Map Pure Terminal session metadata into `rmx` metadata/store semantics.
5. Run the same WebSocket and restart/restore tests against both runtimes before switching the default.

This keeps `rmx` as a credible replacement candidate without combining a frontend terminal-library migration and a backend session-kernel migration in one release.
