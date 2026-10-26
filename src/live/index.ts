import {
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text, type TUI } from "@earendil-works/pi-tui";
import { fileURLToPath } from "node:url";
import { getCodexCredentials } from "../codex-auth.ts";
import type { ResolvedConfig } from "../config.ts";
import { sanitizeDiagnosticError } from "../format.ts";
import { piAgentDir } from "../paths.ts";
import { createBridgeMediaFactory } from "./bridge/media.ts";
import type { BridgeControlFrame } from "./bridge/protocol.ts";
import { type LiveBridgeConnection, LiveBridgeServer } from "./bridge/socket.ts";
import {
  LIVE_DELEGATION_MESSAGE_TYPE,
  LIVE_TRANSCRIPT_HEADING,
  LIVE_TRANSCRIPT_MESSAGE_TYPE,
  recentChat,
} from "./context.ts";
import {
  type LivePhase,
  LiveSessionController,
  type LiveSessionControllerOptions,
  type LiveTranscript,
} from "./controller.ts";
import { attachFocusReporting, probeFocusReporting, type FocusTerminalHandle } from "./focus.ts";
import { type LauncherOptions, registerPersonalLauncher } from "./remote/host.ts";
import { type MediaTarget, OriginCancelled } from "./remote/origin.ts";
import { type RouteDependencies, resolveLiveMedia, resolveLiveTarget } from "./remote/route.ts";
import {
  LIVE_QUEUE_TICK_MS,
  LiveFloorArbiter,
  type LiveActivationCause,
  type LiveFloorArbiterCallbacks,
  type LiveFloorArbiterLike,
  type LiveFloorArbiterOptions,
} from "./queue.ts";
import { LiveVisualizer, LIVE_VISUALIZER_TOGGLE_KEY } from "./visualizer.ts";

export const LIVE_COMMAND = "live";
export { LIVE_DELEGATION_MESSAGE_TYPE };
export const LIVE_FOCUS_SETTLE_MS = 400;
const LIVE_WIDGET_KEY = "better-openai-live";

interface LiveSessionRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  toggleMute(): void;
  handleAgentMessage(message: unknown): void;
  handleAgentSettled(): void;
}

// An enrollment outlives any single realtime session: `/live` opens the
// visualizer and joins the cross-process queue, then the arbiter activates
// (creates the actual mic + WebRTC session) and parks (stops it) as the floor
// comes and goes. Only the floor holder runs a realtime session at all, so a
// dozen enrolled windows cost zero open connections while standby.
interface ActiveLiveRun {
  getSession(): LiveSessionRuntime | undefined;
  finishUi(result: LiveUiResult): void;
  dispose(): Promise<void>;
}

type LiveUiResult = { error?: Error };

type LiveUiFactory = (
  tui: TUI,
  theme: Theme,
  done: (result: LiveUiResult) => void,
) => Component & { dispose?(): void };

// A call from Ovis shows above the editor and leaves it the keyboard, so what is typed on the
// phone reaches the chat; the phone has its own mute and end. Any other call takes the keyboard.
function showLiveUi(
  ctx: ExtensionContext,
  aboveEditor: boolean,
  factory: LiveUiFactory,
): Promise<LiveUiResult> {
  if (!aboveEditor) {
    return ctx.ui.custom<LiveUiResult>((tui, theme, _keybindings, done) =>
      factory(tui, theme, done),
    );
  }
  return new Promise((resolve) => {
    let finished = false;
    ctx.ui.setWidget(LIVE_WIDGET_KEY, (tui, theme) =>
      factory(tui, theme, (result) => {
        if (finished) return;
        finished = true;
        // after the factory has returned, so a call that ends at once still takes its widget away
        setImmediate(() => ctx.ui.setWidget(LIVE_WIDGET_KEY, undefined));
        resolve(result);
      }),
    );
  });
}

type LiveSessionFactory = (options: LiveSessionControllerOptions) => LiveSessionRuntime;

type LiveArbiterFactory = (
  options: LiveFloorArbiterOptions,
  callbacks: LiveFloorArbiterCallbacks,
) => LiveFloorArbiterLike;

export interface LiveRegistrationDependencies {
  createSession?: LiveSessionFactory;
  createArbiter?: LiveArbiterFactory;
  probeFocusReporting?: typeof probeFocusReporting;
  attachFocusReporting?: typeof attachFocusReporting;
  notifyActivatedUnfocused?: (handle: FocusTerminalHandle, label: string) => void;
  tickMs?: number;
  registerLauncher?: (options: Pick<LauncherOptions, "entry">) => unknown;
  resolveTarget?: RouteDependencies["resolveTarget"];
  /** Where the bridge socket goes; defaults to Pi's agent directory. */
  bridgeAgentDir?: string;
  /** The environment that says whether Pi runs in a Herdr pane; defaults to this process's. */
  env?: NodeJS.ProcessEnv;
}

// The phone behind a bridge connection, when a run's audio device is one. `takeControl` hands the
// run the connection's stop and mute frames, including any that arrived while it was starting.
interface BridgedCall {
  connection: LiveBridgeConnection;
  takeControl(handler: (frame: BridgeControlFrame) => void): void;
}

const ALREADY_ON = "Live voice is already on in this Pi.";
const DISABLED = "Live voice is disabled. Enable it in /openai-settings.";

// eslint-disable-next-line no-control-regex -- OSC payloads must not carry raw control characters; matching them is the point
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/g;

export function notifyActivatedUnfocused(handle: FocusTerminalHandle, label: string): void {
  // OSC 9 desktop toast. Reaching this branch means the mic went hot in a
  // window the user is not typing into (FIFO promotion or a vacant-floor
  // background claim), so the toast is the only signal that it happened.
  const safeLabel = label.replace(CONTROL_CHARACTER_PATTERN, " ").trim();
  try {
    handle.write(`\x1b]9;Live voice is now active in ${safeLabel}\x07`);
  } catch {
    // Notification support is optional and terminal-dependent.
  }
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (item): item is { type: "text"; text: string } =>
        typeof item === "object" &&
        item !== null &&
        "type" in item &&
        item.type === "text" &&
        "text" in item &&
        typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("\n");
}

function errorFrom(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

export function registerOpenAILive(
  pi: ExtensionAPI,
  getConfig: (ctx: ExtensionContext) => ResolvedConfig,
  dependencies: LiveRegistrationDependencies = {},
): {
  isActive(): boolean;
  stop(): Promise<void>;
  attachBridge(ctx: ExtensionContext): Promise<void>;
} {
  const createSession =
    dependencies.createSession ?? ((options) => new LiveSessionController(options));
  const createArbiter: LiveArbiterFactory =
    dependencies.createArbiter ??
    ((options, callbacks) => new LiveFloorArbiter(options, callbacks));
  const probeFocus = dependencies.probeFocusReporting ?? probeFocusReporting;
  const attachFocus = dependencies.attachFocusReporting ?? attachFocusReporting;
  const notifyUnfocused = dependencies.notifyActivatedUnfocused ?? notifyActivatedUnfocused;
  const tickMs = dependencies.tickMs ?? LIVE_QUEUE_TICK_MS;
  try {
    // Lets Pi on another computer start this copy's media host over SSH; only the personal
    // install of the package ever writes it.
    (dependencies.registerLauncher ?? registerPersonalLauncher)({
      entry: fileURLToPath(new URL("./remote/media-host.mjs", import.meta.url)),
    });
  } catch {
    // Best effort: a read-only home must not stop /live from registering.
  }
  let activeRun: ActiveLiveRun | undefined;
  let settling: Promise<void> | undefined;
  let choosing = false;
  let bridging = false;
  let bridge: LiveBridgeServer | undefined;
  let bridgeCtx: ExtensionContext | undefined;
  let attaching = false;
  const bridgedCalls = new Set<Promise<void>>();
  const env = dependencies.env ?? process.env;

  async function stopActive(): Promise<void> {
    const run = activeRun;
    if (!run) {
      if (settling) await settling;
      return;
    }
    run.finishUi({});
    await run.dispose();
  }

  async function start(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("Live voice requires interactive TUI mode.", "warning");
      return;
    }
    const cfg = getConfig(ctx);
    if (!cfg.live.enabled) {
      ctx.ui.notify(DISABLED, "warning");
      return;
    }
    if (settling) await settling;

    // `auto` may have to ask which computer the user is at. That is settled here, when /live is
    // asked, so a start that later waits for the floor neither asks at an odd moment nor skips
    // the answer: it reuses this target.
    let target: MediaTarget | undefined;
    if (cfg.live.audioHost?.trim() === "auto") {
      if (choosing) return;
      choosing = true;
      try {
        target = await resolveLiveTarget({
          audioHost: cfg.live.audioHost,
          resolveTarget: dependencies.resolveTarget,
          choose: async (labels, notes) => {
            for (const note of notes) ctx.ui.notify(`Not offered: ${note}`, "info");
            return ctx.ui.select("Which computer are you at?", labels);
          },
        });
      } catch (cause) {
        ctx.ui.notify(
          sanitizeDiagnosticError(errorFrom(cause).message),
          cause instanceof OriginCancelled ? "info" : "error",
        );
        return;
      } finally {
        choosing = false;
      }
    }

    await runUi(ctx, cfg, target);
  }

  async function runUi(
    ctx: ExtensionContext,
    cfg: ResolvedConfig,
    target: MediaTarget | undefined,
    bridged?: BridgedCall,
  ): Promise<LiveUiResult> {
    // what was said, in order, across every session the call runs: saved to the chat once it ends
    const spoken = new Map<string, string>();
    let generation = 0;
    const result = await showLiveUi(ctx, bridged !== undefined, (tui, theme, done) => {
      let completed = false;
      let disposed = false;
      let session: LiveSessionRuntime | undefined;
      let sessionParked = false;
      let arbiter: LiveFloorArbiterLike | undefined;
      let tickInterval: NodeJS.Timeout | undefined;
      let focusDebounce: NodeJS.Timeout | undefined;
      let disposeFocus: (() => void) | undefined;
      let lastPhase: LivePhase | undefined;

      const finishUi = (value: LiveUiResult) => {
        if (completed) return;
        completed = true;
        done(value);
      };

      const visualizer = new LiveVisualizer({
        theme,
        requestRender: () => tui.requestRender(),
        onStop: () => finishUi({}),
        onToggleMute: () => session?.toggleMute(),
        ...(bridged ? { source: "phone", keys: false } : {}),
      });
      visualizer.setPhase(bridged ? "connecting" : "standby");
      const bridgedMedia = bridged ? createBridgeMediaFactory(bridged.connection) : undefined;

      const terminalHandle: FocusTerminalHandle = {
        write: (data) => tui.terminal.write(data),
        addInputListener: (listener) => tui.addInputListener(listener),
      };

      const parkSession = () => {
        const current = session;
        session = undefined;
        sessionParked = true;
        visualizer.setPhase("standby");
        visualizer.setTranscript(undefined);
        if (current) void current.stop().catch(() => undefined);
      };

      const activateSession = () => {
        if (completed || session) return;
        sessionParked = false;
        generation += 1;
        const said = generation;
        const created = createSession({
          sessionId: ctx.sessionManager.getSessionId(),
          chat: recentChat(ctx.sessionManager.getBranch()),
          voice: cfg.live.voice,
          getCredentials: (signal) => getCodexCredentials(ctx, signal),
          resolveMedia: bridgedMedia
            ? async () => bridgedMedia
            : () =>
                resolveLiveMedia({
                  audioHost: cfg.live.audioHost,
                  resolveTarget: target && (async () => target),
                }),
          delegate: (request) => {
            pi.sendMessage(
              {
                customType: LIVE_DELEGATION_MESSAGE_TYPE,
                content: request,
                display: true,
                details: { source: "live" },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          },
          callbacks: {
            onPhase: (phase) => {
              lastPhase = phase;
              visualizer.setPhase(phase);
              bridged?.connection.send({ type: "phase", phase });
            },
            onLevels: (input) => visualizer.setInputLevel(input),
            onTranscript: (transcript: LiveTranscript | undefined) => {
              if (transcript) {
                const speaker = transcript.role === "user" ? "User" : "Assistant";
                spoken.set(
                  `${said}:${transcript.role}:${transcript.turn}`,
                  `${speaker}: ${transcript.text}`,
                );
              }
              visualizer.setTranscript(transcript);
              bridged?.connection.send(
                transcript ? { type: "transcript", ...transcript } : { type: "transcript-clear" },
              );
            },
            onTerminal: (error) => {
              if (sessionParked) return;
              finishUi(error ? { error } : {});
            },
          },
        });
        session = created;
        setImmediate(() => {
          if (session !== created) return;
          void created.start().catch((cause) => {
            finishUi({ error: errorFrom(cause) });
          });
        });
      };

      const dispose = async (): Promise<void> => {
        if (disposed) return;
        disposed = true;
        if (focusDebounce) clearTimeout(focusDebounce);
        if (tickInterval) clearInterval(tickInterval);
        disposeFocus?.();
        arbiter?.leave();
        const current = session;
        session = undefined;
        if (current) await current.stop().catch(() => undefined);
      };

      const run: ActiveLiveRun = {
        getSession: () => session,
        finishUi,
        dispose,
      };
      activeRun = run;

      if (bridged) {
        // The phone is the only microphone in play, so there is no floor to queue for.
        bridged.connection.onClose(() => finishUi({}));
        bridged.takeControl((frame) => {
          if (frame.type === "stop") finishUi({});
          else if (frame.type === "set-muted" && (lastPhase === "muted") !== frame.muted) {
            session?.toggleMute();
          }
        });
        activateSession();
      } else
        setImmediate(() => {
          void (async () => {
            try {
              const focusSupported = await probeFocus(terminalHandle);
              if (completed) return;
              const enrolled = createArbiter(
                {
                  pid: process.pid,
                  sessionId: ctx.sessionManager.getSessionId(),
                  cwd: ctx.cwd,
                  policy: focusSupported ? "focus" : "fifo",
                },
                {
                  onActivated: (cause: LiveActivationCause) => {
                    if (cause !== "focus") notifyUnfocused(terminalHandle, enrolled.label);
                    activateSession();
                  },
                  onDeactivated: parkSession,
                },
              );
              arbiter = enrolled;
              enrolled.join();
              tickInterval = setInterval(() => {
                try {
                  enrolled.tick();
                } catch {
                  // A failing tick must not tear down the enrollment.
                }
              }, tickMs);
              tickInterval.unref?.();
              if (!focusSupported) return;
              disposeFocus = attachFocus(terminalHandle, (focused) => {
                if (focusDebounce) clearTimeout(focusDebounce);
                if (!focused) {
                  enrolled.setFocused(false);
                  return;
                }
                // Debounce focus-in so window-manager focus flicker does not flap
                // floor ownership between two live windows.
                focusDebounce = setTimeout(() => {
                  focusDebounce = undefined;
                  try {
                    enrolled.setFocused(true);
                  } catch {
                    // Focus edges are advisory; a lost race settles next tick.
                  }
                }, LIVE_FOCUS_SETTLE_MS);
                focusDebounce.unref?.();
              });
            } catch (cause) {
              finishUi({ error: errorFrom(cause) });
            }
          })();
        });

      return visualizer;
    });

    const run = activeRun;
    if (run) {
      const cleanup = run.dispose().catch(() => undefined);
      settling = cleanup;
      await cleanup;
      if (activeRun === run) activeRun = undefined;
      if (settling === cleanup) settling = undefined;
    }
    if (spoken.size > 0) {
      // into the chat, so the session and the next call know what was said; never starts a turn
      pi.sendMessage(
        {
          customType: LIVE_TRANSCRIPT_MESSAGE_TYPE,
          content: `${LIVE_TRANSCRIPT_HEADING}\n${[...spoken.values()].join("\n")}`,
          display: true,
          details: { source: "live" },
        },
        { triggerTurn: false },
      );
    }
    if (result.error) ctx.ui.notify(sanitizeDiagnosticError(result.error.message), "error");
    return result;
  }

  const isBusy = () => activeRun !== undefined || settling !== undefined || choosing || bridging;

  async function startBridged(
    ctx: ExtensionContext,
    connection: LiveBridgeConnection,
    takeControl: BridgedCall["takeControl"],
  ): Promise<void> {
    let ended: { error?: string } = {};
    let owned = false;
    try {
      const cfg = getConfig(ctx);
      const refusal =
        ctx.mode !== "tui"
          ? "Live voice requires interactive TUI mode."
          : !cfg.live.enabled
            ? DISABLED
            : isBusy()
              ? ALREADY_ON
              : undefined;
      if (refusal) {
        ended = { error: refusal };
        return;
      }
      bridging = true;
      owned = true;
      const result = await runUi(ctx, cfg, undefined, { connection, takeControl });
      if (result.error) ended = { error: result.error.message };
    } catch (cause) {
      ended = { error: errorFrom(cause).message };
    } finally {
      if (owned) bridging = false;
      connection.send({ type: "ended", ...ended });
      connection.close();
    }
  }

  async function attachBridge(ctx: ExtensionContext): Promise<void> {
    bridgeCtx = ctx;
    if (bridge || attaching) return;
    if (process.platform === "win32" || !env.HERDR_PANE_ID || ctx.mode !== "tui") return;
    attaching = true;
    try {
      if (!getConfig(ctx).live.enabled) return;
      const server = new LiveBridgeServer({
        agentDir: dependencies.bridgeAgentDir ?? piAgentDir(),
        pane: env.HERDR_PANE_ID,
        isBusy,
        onConnection: (connection) => {
          const waiting: BridgeControlFrame[] = [];
          let handler: ((frame: BridgeControlFrame) => void) | undefined;
          connection.onControl((frame) => {
            if (frame.type !== "start") {
              if (handler) handler(frame);
              else waiting.push(frame);
              return;
            }
            if (!bridgeCtx) return connection.close();
            const call = startBridged(bridgeCtx, connection, (next) => {
              handler = next;
              for (const queued of waiting.splice(0)) next(queued);
            }).catch(() => undefined);
            bridgedCalls.add(call);
            void call.finally(() => bridgedCalls.delete(call));
          });
        },
      });
      if (await server.listen()) bridge = server;
    } catch {
      // The bridge is an extra; Pi must start without it.
    } finally {
      attaching = false;
    }
  }

  async function toggle(ctx: ExtensionContext): Promise<void> {
    if (activeRun) {
      activeRun.finishUi({});
      return;
    }
    await start(ctx);
  }

  pi.registerMessageRenderer(LIVE_DELEGATION_MESSAGE_TYPE, (message, _options, theme) => {
    const text = messageText(message.content).trim();
    const label = theme.fg("accent", theme.bold("Live request"));
    return new Text(`${label}\n${theme.fg("customMessageText", text)}`, 1, 0);
  });

  pi.registerMessageRenderer(LIVE_TRANSCRIPT_MESSAGE_TYPE, (message, _options, theme) => {
    const text = messageText(message.content).replace(LIVE_TRANSCRIPT_HEADING, "").trim();
    const label = theme.fg("accent", theme.bold("Live call"));
    return new Text(`${label}\n${theme.fg("customMessageText", text)}`, 1, 0);
  });

  pi.registerCommand(LIVE_COMMAND, {
    description: "Start or stop Codex-backed realtime voice mode",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /live", "error");
        return;
      }
      await toggle(ctx);
    },
  });

  pi.registerShortcut(LIVE_VISUALIZER_TOGGLE_KEY, {
    description: "Start or stop Better OpenAI live voice mode",
    handler: toggle,
  });

  pi.on("message_end", (event) => {
    activeRun?.getSession()?.handleAgentMessage(event.message);
  });

  pi.on("agent_settled", () => {
    activeRun?.getSession()?.handleAgentSettled();
  });

  pi.on("session_shutdown", async () => {
    await stopActive();
    activeRun = undefined;
    // A phone on the line hears the call end before the socket goes.
    await Promise.allSettled(bridgedCalls);
    bridgeCtx = undefined;
    const closing = bridge;
    bridge = undefined;
    await closing?.close();
  });

  return {
    isActive: () => activeRun !== undefined || settling !== undefined,
    stop: stopActive,
    attachBridge,
  };
}
