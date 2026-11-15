# Fork inventory

This fork tracks `upstream/main` (baseline `4c41c25`) plus one feature: a local live voice bridge. Ovis is its first client, not a dependency. All other fork additions have been removed; upstream's prompt, configuration, native audio, floor queue, visualizer and tests remain upstream-owned.

## Fork-owned files

| Path                               | Purpose                                                                                                              |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `src/fork/live-bridge/index.ts`    | Own session listeners; connect client controls to a media-hosted call; end calls and close the listener at shutdown. |
| `src/fork/live-bridge/socket.ts`   | User-private unix socket, bounded NDJSON input/output, control/media routing, connection lifecycle.                  |
| `src/fork/live-bridge/protocol.ts` | Version 1 frames, validation, bounded UTF-8 decoding and sanitized transcript/error output.                          |
| `src/fork/live-bridge/media.ts`    | Client media requests, hello handshake, request deadlines, keepalive, mute and close. No SSH or child processes.     |
| `tests/fork-live-bridge*.test.ts`  | Fork protocol, socket, call lifecycle and injected-media regressions. No upstream tests are patched.                 |
| `docs/fork.md`                     | This inventory.                                                                                                      |

## Upstream hooks

| Path                     | Hook                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `index.ts`               | One import and `registerLiveBridge(pi, registerOpenAILive(pi, config))`.                                                                                                                                                                                                                                                                                                       |
| `src/live/transport.ts`  | Optional `createMedia(callbacks, signal)`; the default is the unchanged native peer. Injected media supplies SDP, events and levels, and receives mute/activate/close.                                                                                                                                                                                                         |
| `src/live/controller.ts` | Pass `createMedia` through; skip local microphone capture when supplied; accept client input levels.                                                                                                                                                                                                                                                                           |
| `src/live/index.ts`      | Return `startCall(ctx, options)` alongside `isActive`/`stop`. The call handle exposes `done`, `stop` and idempotent `setMuted`; callbacks report phase/transcript. Calls share `/live`, agent events and shutdown, but do not enter the native device floor queue or modal UI. Reserve before lazy loading and recheck native starts afterward to prevent competing ownership. |
| `package.json`           | Only extend `lint`/`lint:fix` to cover `src/fork/*/*.ts`. No dependency, identity or release changes.                                                                                                                                                                                                                                                                          |

**Upstream PR candidates:** the optional transport/controller media seam and the registration's media-hosted start-call handle. Neither imports fork code. Keep these hooks small when syncing; do not move bridge policy into upstream files.

## Socket and configuration

In interactive TUI sessions on Unix, session start listens at `<agentDir>/live-bridge/<pid>.sock`. The existing `PI_CODING_AGENT_DIR` resolution applies. The directory must be owned by the current user and private (`0700` when created); the socket is `0600`. Unsafe directories and non-socket files/symlinks at the socket path are refused. Windows and non-TUI sessions do not offer the socket. No terminal launcher or `hc` integration is installed or required. `HERDR_PANE_ID`, when present, is only echoed in `ready.pane`.

The bridge is on by default with no new setting. Existing `live.enabled` is checked for each start, and `live.voice` is the default unless the client supplies a voice. Only one call can own a Pi session. A connection owns one call and cannot stop or mute another connection's call; disconnect ends its own call. `/live` can stop a client call too. Socket setup failure does not prevent Pi from starting.

## Wire contract

Frames are UTF-8 NDJSON, each carrying `v: 1`, with a 1 MiB line limit. The client receives `ready` before starting. Relay controls are `start` (optional voice), `stop`, `set-muted`, and `resume` (accepted as a no-op). Media input is `hello`, `response`, `event`, `levels`, and `failure`. Pi sends `request` (`open`, `createOffer`, `acceptAnswer`, `waitForOpen`), `activate`, `mute`, `ping`, `close`, `phase`, `transcript`, `transcript-clear`, and `ended`.

These frames match Ovis's `shared/pi-voice.ts` and its shared version. Pi never sends `park` or `usage`, even when advertised in `hello.features`. There is no idle hang-up, parking/resumption mechanism, speech gating, readout, chat-memory injection, usage reporting or Pi phone-event endpoint. The client's microphone, speaker and WebRTC peer handle audio directly with OpenAI. Pi keeps credentials, attestation, authenticated signaling, the sideband and agent delegation; none of those credentials cross the socket.

## Verification and syncing

Run `bun install --frozen-lockfile`, `bun run test -- tests/fork-live-bridge`, `bun run test -- tests/live-`, and `bun run check`. For wire changes, compare every variant with the client's `shared/pi-voice.ts` before changing either copy; never silently change version 1 shapes. Test an actual client call separately when client hardware and credentials are available.

After an upstream sync, inspect `git diff upstream/main`: it should contain only this inventory, the fork folder/tests and the hooks listed above. Restore upstream tests rather than adapting them to fork behavior.
