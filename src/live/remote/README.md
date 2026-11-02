# Remote live voice: developer notes

User-facing setup is in the package [README](../../../README.md#remote-audio-experimental). These notes
cover how the pieces fit and how to try them.

`/live` can run its audio on a different computer than Pi does. The Pi host (**B**) keeps the UI,
Codex OAuth, DeviceCheck attestation, signaling, the sideband WebSocket and the Pi turns. The audio
computer (**A**) runs capture, the microphone filter, the native WebRTC peer and playback
(`LocalLiveMedia`), started by B over `ssh`.

Only SDP, control messages, levels and server events cross the SSH connection. There is no field
for credentials, attestation or audio, and unknown fields are rejected.

## Status

- **A is Linux only** (PipeWire or PulseAudio). A Mac or Windows PC that is reached by `audioHost`
  answers `open` with "Only a Linux computer can provide the audio for remote live voice for now.";
  one found by `auto` is refused before it is contacted.
- Run by hand with real devices: Linux B to Linux A (muted session, audible reply, a delegated tool
  run, teardown, a second session) and macOS B to Linux A (including DeviceCheck attestation, which
  only exists on macOS). Real human speech through the remote microphone is not yet verified.
- `auto` inside Herdr reads the server's clients only on a Linux B with `ss`. On macOS, Windows or
  a Linux without `ss` it can only tell that no remote Herdr client exists (then this computer) or
  that one may (then it refuses); see "Where the clients cannot be read". `auto` outside Herdr
  only reads Pi's own SSH variables and works on any B. The Windows process list has not been run
  on a real Windows computer.
- Routing, identity, lock, lease and launcher are covered by tests with fakes; `auto` was also
  run against a real stock Herdr server with a local client and a remote client attached (below).

## Which audio computer

`live.audioHost` decides, and only `auto` looks anything up:

| `live.audioHost`     | `/live` uses                                                                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unset, empty         | this computer. Nothing is looked up: no `ss`, no Tailscale, no process is read.                                                                                                  |
| a host               | that SSH host, trusted to be the computer meant: only its `hello` (version) is checked                                                                                           |
| `auto`, not in Herdr | no SSH variables: this computer; `SSH_CONNECTION`: the computer it came from (Tailscale); `SSH_CLIENT`/`SSH_TTY` alone, or tmux/screen/zellij with any SSH variable: **refuses** |
| `auto`, in Herdr     | the one computer attached to the pane's Herdr server; **asks** which one when several are attached, **refuses** when it cannot tell (below)                                      |

Inside Herdr (`HERDR_PANE_ID` set) Pi's own `SSH_*` variables are ignored: a pane carries the
environment of the Herdr server, not of whoever is typing. By the computer running Pi:

| B (runs Pi)                                    | `auto` outside Herdr  | `auto` in a Herdr pane                                                                                       |
| ---------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------ |
| Linux with `ss`                                | as in the table above | reads the server's clients (below): one computer is it, several are **asked about**, unrecognized **refuse** |
| Linux without `ss`, or a pane without a socket | as above              | this computer if no remote Herdr client is running, else **refuses**                                         |
| macOS                                          | as above              | this computer if no remote Herdr client is running, else **refuses**                                         |
| Windows                                        | as above              | the same, from a PowerShell process list (not yet run on a real Windows)                                     |

Outside Herdr nothing depends on the operating system: Pi's own `SSH_CONNECTION` names the computer
(Tailscale looks it up), and no SSH variable means this computer.

1. `ss -x -a -n -p` lists the unix sockets. The server is the process listening on
   `HERDR_SOCKET_PATH`. It also listens on a second socket (`herdr-client.sock` beside it) that
   attached clients use; the API socket only serves one-off commands. A client is the holder of the
   other end of a connection the server accepted on that second socket, which the kernel names by
   inode, so a client of another Herdr session (another server) is never counted.
2. Each client is recognized as one of two things, whatever it is called. Remote: it has an
   `SSH_CONNECTION` in `/proc/<pid>/environ` (a remote-client bridge, run by sshd, has one). Local:
   it has none and its stdin is a terminal (`/proc/<pid>/fd/0` is a `/dev/pts/N` or `/dev/ttyN`; a
   bridge's is a pipe). A client that is neither, such as a redesigned bridge that no longer
   inherits sshd's environment, **refuses** with "Pi can't tell which computer is connected to this
   Herdr", even next to clients that are recognized. A process that exited meanwhile is skipped,
   but one that only closed its stdin (no `/proc/<pid>/fd/0` while `/proc/<pid>` is there) is not
   at a terminal. A connection whose client `ss` shows no process for (another user's, or one that
   made itself non-dumpable) is a client too, just not placed, so it refuses the same way; one
   that already hung up (peer inode 0) is not a client.
   A client whose `/proc` cannot be read (`EACCES`) goes to the process list (below), which
   answers this computer only if it shows no remote Herdr client **and** shows each unread client
   as a local `herdr`: the `herdr` program with a readable command line, not `herdr server`, not
   the bridge command, not started by sshd. Being in the list is not enough (an unrecognized
   `tunnel-v2 --stdio` under sshd is in it too); next to a client already known to be remote it
   refuses outright.
   A server whose owner `ss` cannot show (it made itself non-dumpable, so its sockets have no
   `users:`) is not an absent server: its clients cannot be told either, so it takes the same
   process-list route as a computer without `ss`, with that route's limits (below). Nothing
   listening on the socket path at all still refuses.
3. One origin: it is that computer (`identify`: `tailscale whois`, same Tailscale user, Linux, a
   machine name safe for `ssh`; its media host must announce the same node ID in its `hello`).
4. Several origins (this computer's own client plus a remote one, or two remote computers):
   `/live` **asks** "Which computer are you at?" with `ctx.ui.select`: each identified remote by its
   Tailscale name, then "this computer (<hostname>)" if a local client is attached. Several
   connections from one computer (two bridges from the same laptop, or a bridge from this very
   computer next to its local client) are one origin. A computer that cannot be the audio computer
   (not identified, another Tailscale user's, macOS or Windows) is **not offered**: a
   `Not offered: <address>: <reason>` notice says why. It is still counted, so one usable computer
   among unusable ones is asked about too (the unusable one may be the typist). With nothing usable
   it refuses with the reasons. The chosen remote goes through the same identity checks as a
   single one (`identify`, then the media host's `hello` node) before any device opens. Escape, or
   an answer that was not offered, ends as `OriginCancelled`: a short notice and nothing started.
   Where nobody can be asked (`resolveMediaTarget` called without `choose`) it **refuses**, naming
   the computers and `live.audioHost`.

   The question is asked in the `/live` command and the toggle shortcut (`start` in
   `src/live/index.ts`), before the voice UI opens, every time and never remembered. The answer is
   passed to the session as its target, so a start that waits for the floor (and one resumed after
   losing it) uses it and does not ask again at a later moment.

### Why several attached computers are asked about

Herdr tells nothing about who typed, and none of its API is used (stock Herdr has no client list
or origin method). No other signal found separates the typist reliably, so `auto` does not guess:

- The TCP `lastrcv` of a remote client's SSH connection (time since it last sent data) moves on a
  keystroke, but also on the client's keepalive: an idle client sends a 36-byte segment every
  5.05 s, the same size as one keystroke. Matched against when `/live` was asked within 120 ms, an
  idle attached laptop was taken for the typist in 8 of 400 trials (2%), choosing the laptop's
  microphone for someone at the Pi computer; and a lookup delayed beyond the window chose this
  computer for someone at the laptop. That was implemented and removed.
- A local client has no signal at all: the tty's atime moves in 8-second steps by design, and
  `/proc/<pid>/io` mixes keystrokes with the rendering the client reads back. "Nobody remote just
  typed" is not evidence that the local one did.

So with several computers attached, Pi asks the person who knows. Detaching the ones you are not
using (a screen left attached counts) avoids the question, and so does setting `live.audioHost` to
a host. A reliable signal, such as Herdr reporting which client sent a pane its last input, would
make the question unnecessary. Where it cannot read the clients at all (macOS, Windows, no `ss`)
it cannot list who is attached, so it cannot ask either: it refuses if a remote client may exist.

### Where the clients cannot be read

macOS and Windows have no `ss` and no `/proc`, and a Linux can lack `ss` or a pane its
`HERDR_SOCKET_PATH`. There the only evidence is the user's process list (`ps -ww -U <uid> -o
pid=,ppid=,command=`; on Windows all users, from `Get-CimInstance Win32_Process`), and it can only
show whether a remote client may exist. `auto` is this computer if none does, and refuses if one
does or the list cannot be read (an empty list counts as unreadable). It does not try to say which
of the computers is typing: the clients cannot be tied to this pane's server there, and their SSH
connection is not read.

A process is a possible remote client when it is:

- Herdr's program (`herdr`, `herdr.exe`, with any path) running the `remote-client-bridge`
  subcommand, wherever its parent is; or
- a `herdr` that is not its `server` and has `sshd` as an ancestor (a client started by hand in an
  SSH session, or a bridge whose subcommand was renamed); or
- anything else with `remote-client-bridge` in its command and `sshd` as an ancestor (the bridge
  under another binary name); or
- a process whose command line is hidden. Windows hides it for elevated processes from an
  unelevated reader (`CommandLine` is null), so the PowerShell listing puts the program's name and
  `(unreadable command line)` in its place. A hidden `herdr` counts, whatever its parent, since it
  cannot be told from a bridge; so does a nameless row under `sshd`. A hidden `sshd` is still
  `sshd` by its name, and a hidden process that is not Herdr changes nothing.

An `ssh` whose remote command is `herdr remote-client-bridge` is **not** one. That is this
computer's own Herdr client reaching another computer's server (the opposite direction), and a
machine that reaches others, as this PC and the Mac mini do, always has some.

### Limits of recognizing clients

- On Linux with `ss`, nothing depends on a name: a remote client is anything with an
  `SSH_CONNECTION`, a local one anything at a terminal, the rest refuses. What it cannot see is a
  client the Herdr server holds itself, without a process of its own on this computer (a
  redesign that connects to the server over the network): only the local client is visible, and the
  answer is this computer.
- On the process-list route a remote client that is not named like Herdr's bridge and was not
  started by sshd (a `mosh` or Tailscale SSH session, a different tunnel) is not seen, and the
  answer is this computer. A bridge that stays attached after its user left refuses, as on Linux.
  The first is pinned by a test, so a change is noticed.
- A bridge is only known by the subcommand name Herdr 0.9.x uses. If Herdr renames it, Linux with
  `ss` keeps working (nothing there depends on the name); the process-list route would stop seeing
  the bridge itself, and only still sees a bridge or `herdr` that sshd started.

## One-time setup

- **A:** the package installed through Pi's personal settings (`pi install npm:…` or
  `pi install git:…`). Starting Pi once writes the launcher `~/.pi/agent/live-host/media-host`
  (B always looks in the default agent dir, so a custom `PI_CODING_AGENT_DIR` on A is not supported).
  It records the absolute Node path, because SSH sessions rarely have Node on `PATH`. Copies loaded with
  `-e`, from a project, or from a path never write it. `XDG_RUNTIME_DIR` is filled in when SSH leaves
  it unset.
- **B to A:** `ssh <host>` must work without prompts (keys, or Tailscale SSH). New host keys are
  accepted automatically (`StrictHostKeyChecking=accept-new`); a changed key is refused. A userspace
  Tailscale needs a `Host` entry with a `ProxyCommand tailscale nc %h %p`.
- **`auto` only:** the Tailscale CLI on B and A. Inside Herdr, a Linux B also wants the `ss`
  command (iproute2); without it, and on macOS and Windows, only the local-screen case works.

## Trying a checkout without touching your settings

```bash
# A: record this checkout as the launcher (replaces the one the personal install wrote, until Pi
# next starts there with the personal install)
node <checkout>/src/live/remote/media-host.mjs register
# B: load only this checkout, with "live": { "audioHost": "<A>" } in its config
pi -ne -e <checkout>
```

## Manual acceptance checklist

Run per pair (B, A). Mark a cell only after doing it.

- [ ] `/live` with `audioHost` set: A's microphone is hot and B's is not; the reply plays on A.
- [ ] A coding request runs its tools on B and the result is spoken on A.
- [ ] Mute and unmute from the panel; stopping with `/live` releases A's microphone.
- [ ] Killing B's Pi, or dropping the network, releases A's microphone within ~20 s.
- [ ] A second `/live` from another B while one runs is refused as busy; it works after the first stops.
- [ ] A bad host name or a Mac/Windows `audioHost` fails with a readable reason and opens no device.
- [ ] With `auto` in Herdr: one computer attached uses it; two attached ask "Which computer are you at?" (Escape starts nothing, a pick uses that computer), and it stops asking once one detaches.
- [ ] With `auto` in Herdr on macOS and Windows: only the local screen attached uses this computer's audio; a laptop attached through Herdr refuses and names `live.audioHost`.

| B \ A   | Linux                                 | macOS   | Windows |
| ------- | ------------------------------------- | ------- | ------- |
| Linux   | session, audible reply, delegated run | refused | refused |
| macOS   | muted session, audible reply          | refused | refused |
| Windows | not run                               | refused | refused |

## A phone through Ovis

The browser of an [Ovis](https://github.com/ricardofelixb/ovis) client plays the audio computer. It is the same protocol with the roles of the pipe changed: instead of an SSH child process, the "media host process" is a connection on a unix socket, so `client.ts` runs unchanged (`bridge/media.ts` wraps the connection as a `RemoteMediaProcess`). Ovis relays text frames between the phone and the socket; the audio goes from the phone to OpenAI over WebRTC and never through Ovis or Pi.

- **Socket.** In a Herdr pane (`HERDR_PANE_ID` set), in the TUI, on Linux and macOS, with `live.enabled`, Pi listens on `<agentDir>/live-bridge/<process.pid>.sock` (`agentDir` honors `PI_CODING_AGENT_DIR`). It creates the directory `0700`, refuses to listen if the directory is a symlink, belongs to another user, or is group or world accessible, chmods the socket `0600`, replaces a stale socket left by an earlier process with the same pid, and unlinks it on `session_shutdown`. A path longer than 100 bytes is skipped silently. `index.ts` calls `attachBridge(ctx)` from its `session_start` handler, so `/reload` listens again.
- **Frames** (`bridge/protocol.ts`, version 1 like the media protocol, same limits and strictness). Pi sends `ready {pid, pane?, busy}` first, then the usual media `request`, `activate`, `mute`, `ping`, `close` frames, and `phase`, `transcript`, `transcript-clear`, `ended {error?}`, and, to a phone that asked for them, `park` and `usage` (see [Features: parking and usage](#features-parking-and-usage)). The phone sends `start`, `stop`, `set-muted`, `resume` and the usual `hello`, `response`, `event`, `levels`, `failure`. Before `start` only one `hello` is accepted. Control frames never reach the media parser, and a second `start`, an unknown type or field, or a bad version drops the connection. There is no field for credentials or audio.
- **Starting.** `start` refuses with `ended {error}` when live voice is off, a run is active or settling, or Pi is not in the TUI. Otherwise it shows the same panel as `/live`, minus the floor queue (the phone's microphone is shared with no other window), and creates the session at once with the connection as its media. The panel sits above the editor as a widget and takes no keys, so what is typed on the phone reaches the chat; its footer reads `phone`.
- **Stopping.** A `stop` frame, the socket closing, the media failing, `/live`, and `session_shutdown` all end the run. Pi then sends `ended` (with an error only when something failed) and closes the connection. A phone that goes away ends the call without an error.
- **Security.** Only your user can connect. The relay in Ovis authenticates the phone, allows one call per pane and closes both ends when the phone stops answering pings for 20 s.

Manual acceptance (phone on Android Chrome, Pi pane in Herdr, Ovis behind HTTPS):

- [ ] The voice orb shows in an idle Pi pane with an empty composer; tapping it asks for the microphone and shows "Listening", and the pane's panel shows `phone`.
- [ ] "Hello" is answered through the phone's speaker, with the transcript on both screens.
- [ ] "Count the files in this folder" runs in the pane with its model (also with Claude selected through pi-claude-bridge) and the answer is spoken.
- [ ] Mute on the phone mutes; speech is ignored while muted. Typing on the phone during the call reaches the chat.
- [ ] End on the phone, and `Escape` in the pane, each close both sides and release the microphone.
- [ ] Airplane mode mid-call frees Pi within about 20 s; a second tab gets "already on" meanwhile.
- [ ] `/live` without Ovis still works with a local device or `live.audioHost`.

### The phone endpoint

A phone can also reach this Pi without Ovis, through another extension in the same process, such as a gateway that authenticates it. `phone/endpoint.ts` runs the call that Ovis's relay runs, in-process: each call opens a duplex pair (`stream.duplexPair()`), one end goes into the same connection handler the unix socket uses (so `ready`, `start`, the busy refusal and the media proxy behave exactly as above, with no socket file and no `HERDR_PANE_ID`), and the other end is the relay's. The relay (`phone/relay.ts`) is `PiVoiceRelay` and `PiVoiceHub` from Ovis (`server/pi-voice.ts`) ported to Node with the Pi side injected, so Ovis can pass a unix-socket dial to the same function and switch to `phone/protocol.ts` (its `shared/pi-voice.ts`) later without touching its phone app.

**Finding it.** The endpoint is emitted on `pi.events` as `pi-better-openai:live-phone` (`LIVE_PHONE_EVENT`) at load and at every `session_start`, always the same object, so load order does not matter. Another package cannot import it (a git package installs apart from this one and would load a second copy with no call running), so it keeps a structural copy of the types it uses and checks `version`:

```ts
let endpoint: LivePhoneEndpoint | undefined;
pi.events.on("pi-better-openai:live-phone", (value) => {
  if (isLivePhoneEndpoint(value)) endpoint = value; // your own copy of the version 1 check
});
```

**The API** (`LivePhoneEndpoint`, version 1):

- `status()` gives `{ available, busy }`: `available` while a TUI session runs with `live.enabled`, `busy` while a call is on. A caller that finds it unavailable should refuse the request itself, for example with HTTP 503; a call accepted anyway ends with `unavailable`.
- `upgrade(request, socket, head, options?)` takes an HTTP upgrade request the caller already authenticated, completes the WebSocket handshake with this package's `ws` (frames up to 1 MiB, no compression), runs one call on it and resolves with the call once the socket is open. A refused handshake rejects with the socket destroyed.
- `accept(peer, options?)` runs one call on a socket the caller holds, such as Bun's. The peer is `{ send(text), close(), ping() }`, and the caller reports `message(data)`, `pong()` and `closed()` into the returned call.
- The call has `ended`, `send(frame)` (a host frame; false once the call is over) and `end()`, which tells the phone `ended {code: "closed"}`, for example when its device is revoked.
- Options: `voice` for this call, `hostFrames`, `onHostFrame` and `onEnd({ code?, error? })`, called once however the call ends. `hostFrames` names frame types the host handles itself (step 3's `tool-call` and `tool-result`): the phone's frames of those types go to `onHostFrame`, checked only for the version, the type, the size and being an object, and `call.send` sends them back. Naming a type a call already uses throws.

**The wire format** is Ovis's phone protocol (`phone/protocol.ts`): one WebSocket per call, each text message one JSON object with `"v": 1`, at most 1 MiB. An unknown type or field, a bad value, a binary message or another version ends the call, quietly.

| Direction        | Frames                                                                                                                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| phone to Pi      | `hello {features?}`, `response {id, ok: true, sdp?}`, `response {id, ok: false, error}`, `event {payload}`, `levels {input, output}`, `failure {message}`, `stop`, `set-muted {muted}`, `resume`                                                                               |
| Pi to phone      | `request {id, method}` (`open`, `createOffer`, `acceptAnswer {sdp}`, `waitForOpen {timeoutMs?}`), `activate`, `mute {muted}`, `ping`, `close`, `park`, `phase {phase}`, `usage {seconds}`, `transcript {role, text, turn, final}`, `transcript-clear`, `ended {error?, code?}` |
| relay to Pi only | `start {voice?}`, which the phone cannot send                                                                                                                                                                                                                                  |

The phone sends `hello` at once; the relay holds up to 16 frames while it reaches Pi and waits up to 2 s for `ready`. `ready.busy` ends the call with `ended {code: "busy"}`, a missing or wrong `ready` with `unavailable`, and a second `ready` or a frame Pi may not send with `closed`. Then it sends `start`, flushes what it held and relays both ways, checking and re-serializing every frame. It pings the WebSocket every 5 s and ends the call 20 s after the last pong or message, which is what catches a phone that went silent (the bridge has no lease of its own). `not_pi` is also a valid code, but it is Ovis's, for a pane that runs no Pi: this endpoint never sends it. No frame is ever logged; an SDP carries addresses.

### Features: parking and usage

A call is billed by the second it is connected to OpenAI, so Pi closes the realtime session while a long task runs and opens a fresh one for the result (`live.parkAfterSeconds`; see the README). A phone takes part only if it says so. Both additions are optional and gated on the phone's `hello`, so a phone that knows neither sees no new frame and works as before.

**`hello.features`.** The phone's `hello` may carry `features`, an array of at most 8 names of at most 32 characters each. Pi acts on the names it knows, `"park"` and `"usage"`, and ignores the rest, so a phone can offer names for later versions. A `hello` with more than 8 names, or a name longer than 32 characters, is refused like any malformed frame. The names are read from the `hello` of the media host, so they are not known before it arrives; Pi asks at the moment it needs them.

**`"park"`.**

- When a delegated task has run `live.parkAfterSeconds` with no speech either way, Pi closes the realtime session and sends `park {}`, then `phase {phase: "parked"}`. On `park` the phone closes its `RTCPeerConnection` and data channel and stops sending `levels`, and keeps its microphone stream and the connection to Pi.
- While parked, Pi goes on sending `ping` as usual, so the phone's lease on Pi's frames holds; a phone may fail the call if Pi goes silent.
- When the task finishes, or the phone sends `resume {}` to reconnect now, Pi sends `request` `createOffer`, `acceptAnswer` and `waitForOpen` and `activate` again, on the same connection and without a second `open`, and `phase` goes through `connecting` and `listening` as in a new call. A `mute` before the offer carries the mute state, which a parked call keeps (`set-muted` is honored while parked). `resume` at any other time is ignored.
- A `failure` while parked ends the call when Pi tries to reconnect, with that message.
- A phone that did not name `"park"` is never parked: it gets no `park`, and the idle hang-up (`live.idleHangupSeconds`) still ends its call as if the user had hung up, with the usual `ended`.

**`"usage"`.** To a phone that named it, Pi sends `usage {seconds}` (an integer, 0 or more): the seconds the call has been connected so far, which is what is billed, summed over the sessions of the call. It comes with every update the server sends, about every 15 s, and once more just before `ended`, with the final count.

## Pieces

- `route.ts`: the `ssh` command line (host validation) and the media factory a session uses.
- `origin.ts`: what `auto` does (above) and the Tailscale identity of a computer from its SSH connection.
- `clients.ts`: the Herdr clients of a server (`ss` output), `SSH_CONNECTION` and terminal of a process, and the process list with its remote-client rule.
- `client.ts` / `companion.ts` / `protocol.ts`: the Pi-side media, the host loop, and the framing
  (versioned, size-bounded, strictly validated; ping and a 20 s lease so a vanished Pi host
  releases the microphone).
- `host.ts`, `media-host.mjs`: launcher, per-user lock (a Linux abstract socket the kernel frees
  when the host dies), runtime directory; loads the TypeScript through `jiti` because Node refuses
  `.ts` inside `node_modules`.
- `tailscale.ts`: CLI lookup.
- `../bridge/protocol.ts` / `socket.ts` / `media.ts`: the Ovis bridge's frames, the per-process socket and connection, and the connection as a media process (see above).
- `../phone/protocol.ts` / `relay.ts` / `endpoint.ts`: the phone's frames, the relay between a phone and a Pi, and the in-process endpoint other extensions take calls through (see above).

Tests use fakes and local subprocesses; none opens a device or reaches the network.
