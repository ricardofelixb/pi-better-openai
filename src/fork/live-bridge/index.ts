import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LiveCall, registerOpenAILive } from "../../live/index.ts";
import { piAgentDir } from "../../paths.ts";
import { createBridgeMediaFactory } from "./media.ts";
import { LiveBridgeServer, type LiveBridgeConnection } from "./socket.ts";

type LiveHandle = ReturnType<typeof registerOpenAILive>;
export function registerLiveBridge(
  pi: ExtensionAPI,
  live: LiveHandle,
  options: { agentDir?: string; pane?: string } = {},
): void {
  let server: LiveBridgeServer | undefined;
  let attaching: Promise<void> | undefined;
  const calls = new Set<LiveCall>();
  function connect(connection: LiveBridgeConnection, ctx: ExtensionContext): void {
    let call: LiveCall | undefined;
    connection.onClose(() => call?.stop());
    const finish = (error?: unknown) => {
      connection.send({
        type: "ended",
        ...(error === undefined
          ? {}
          : { error: error instanceof Error ? error.message : String(error) }),
      });
      connection.close();
    };
    connection.onControl((frame) => {
      if (frame.type === "resume") return; // Version 1 clients may request it; calls no longer park.
      if (frame.type === "stop") return call?.stop();
      if (frame.type === "set-muted") return call?.setMuted(frame.muted);
      try {
        call = live.startCall(ctx, {
          createMedia: createBridgeMediaFactory(connection),
          ...(frame.voice ? { voice: frame.voice } : {}),
          callbacks: {
            onPhase: (phase) => connection.send({ type: "phase", phase }),
            onTranscript: (transcript) =>
              connection.send(
                transcript ? { type: "transcript", ...transcript } : { type: "transcript-clear" },
              ),
          },
        });
        const current = call;
        calls.add(current);
        void current.done.then(
          () => {
            calls.delete(current);
            finish();
          },
          (error: unknown) => {
            calls.delete(current);
            finish(error);
          },
        );
      } catch (error) {
        finish(error);
      }
    });
  }
  pi.on("session_start", (_event, ctx) => {
    if (server || attaching || ctx.mode !== "tui" || process.platform === "win32") return;
    attaching = (async () => {
      const candidate = new LiveBridgeServer({
        agentDir: options.agentDir ?? piAgentDir(),
        pane: options.pane ?? process.env.HERDR_PANE_ID,
        isBusy: () => live.isActive(),
        onConnection: (connection) => connect(connection, ctx),
      });
      if (await candidate.listen()) server = candidate;
    })()
      .catch(() => undefined)
      .finally(() => {
        attaching = undefined;
      });
    return attaching;
  });
  pi.on("session_shutdown", async () => {
    await attaching;
    for (const call of calls) call.stop();
    await Promise.allSettled([...calls].map((call) => call.done));
    await server?.close();
    server = undefined;
  });
}
