import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { LiveSessionControllerOptions } from "../src/live/controller.ts";
import { registerOpenAILive } from "../src/live/index.ts";
import { registerLiveBridge } from "../src/fork/live-bridge/index.ts";
import { makeResolvedConfig } from "./helpers.ts";

type Frame = Record<string, unknown> & { type: string };
// Ported from live-bridge.test.ts: a real unix socket, with only the session boundary stubbed.
function connectClient(path: string) {
  const seen: Frame[] = [];
  let buffered = "";
  const socket = net.connect(path);
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffered += chunk;
    for (;;) {
      const end = buffered.indexOf("\n");
      if (end === -1) break;
      seen.push(JSON.parse(buffered.slice(0, end)) as Frame);
      buffered = buffered.slice(end + 1);
    }
  });
  socket.on("error", () => undefined);
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  const consumed = new Map<string, number>();
  return {
    seen,
    closed,
    send: (frame: Record<string, unknown>) =>
      socket.write(`${JSON.stringify({ v: 1, ...frame })}\n`),
    sendRaw: (text: string) => socket.write(text),
    end: () => socket.end(),
    async next(type: string): Promise<Frame> {
      let found: Frame | undefined;
      await vi.waitFor(() => {
        const index = seen.findIndex(
          (frame, at) => frame.type === type && at >= (consumed.get(type) ?? 0),
        );
        expect(
          index,
          `no ${type}; saw ${seen.map((f) => f.type).join(",")}`,
        ).toBeGreaterThanOrEqual(0);
        consumed.set(type, index + 1);
        found = seen[index];
      });
      return found!;
    },
  };
}
function makeSession(options: LiveSessionControllerOptions) {
  let muted = false;
  const stub = {
    options,
    offer: undefined as string | undefined,
    media: undefined as
      | ReturnType<NonNullable<LiveSessionControllerOptions["createMedia"]>>
      | undefined,
    start: vi.fn(async () => {
      options.callbacks.onPhase("connecting");
      const media = options.createMedia!({
        onEvent: vi.fn(),
        onLevels: vi.fn(),
        onFailure: vi.fn(),
      });
      stub.media = media;
      stub.offer = await media.createOffer();
      await media.acceptAnswer("answer");
      await media.waitForOpen();
      media.activate?.();
      options.callbacks.onPhase("listening");
      options.callbacks.onTranscript({ role: "user", text: "hello there", turn: 1, final: true });
    }),
    stop: vi.fn(async () => {
      await stub.media?.close();
    }),
    toggleMute: vi.fn(() => {
      muted = !muted;
      stub.media?.setMuted(muted);
      options.callbacks.onPhase(muted ? "muted" : "listening");
    }),
    handleAgentMessage: vi.fn(),
    handleAgentSettled: vi.fn(),
  };
  return stub;
}
let scratch: string;
let agentDir: string;
const cleanups: Array<() => Promise<void>> = [];
const clients: Array<ReturnType<typeof connectClient>> = [];
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pbo-bridge-"));
  agentDir = join(scratch, "agent");
  mkdirSync(agentDir);
});
afterEach(async () => {
  for (const client of clients.splice(0)) client.end();
  for (const cleanup of cleanups.splice(0)) await cleanup();
  rmSync(scratch, { recursive: true, force: true });
});
const socketPath = () => join(agentDir, "live-bridge", `${process.pid}.sock`);
async function setup(
  overrides: { enabled?: () => boolean; mode?: string; sessionFor?: typeof makeSession } = {},
) {
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
  const pi = {
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    registerMessageRenderer: vi.fn(),
    sendMessage: vi.fn(),
    on: vi.fn((event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
      handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    ),
  } as unknown as ExtensionAPI;
  const sessions: ReturnType<typeof makeSession>[] = [];
  const createArbiter = vi.fn();
  const live = registerOpenAILive(
    pi,
    () => makeResolvedConfig({ live: { enabled: overrides.enabled?.() ?? true, voice: "sol" } }),
    {
      createSession: (options) => {
        const session = (overrides.sessionFor ?? makeSession)(options);
        sessions.push(session);
        return session;
      },
      createArbiter,
    },
  );
  const ctx = {
    mode: overrides.mode ?? "tui",
    cwd: "/project",
    ui: { custom: vi.fn(), notify: vi.fn() },
    sessionManager: { getSessionId: () => "session-7" },
    modelRegistry: {},
  } as unknown as ExtensionCommandContext;
  registerLiveBridge(pi, live, { agentDir, pane: "p_1" });
  const emit = async (event: string) => {
    for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
  };
  cleanups.push(() => emit("session_shutdown"));
  await emit("session_start");
  return { live, sessions, createArbiter, ctx, pi, emit };
}
async function open() {
  const client = connectClient(socketPath());
  clients.push(client);
  return { client, ready: await client.next("ready") };
}
async function startCall() {
  const harness = await setup();
  const { client } = await open();
  client.send({ type: "hello", features: ["park", "usage"] });
  client.send({ type: "start", voice: "vale" });
  for (const method of ["open", "createOffer", "acceptAnswer", "waitForOpen"]) {
    const request = await client.next("request");
    expect(request.method).toBe(method);
    client.send({
      type: "response",
      id: request.id,
      ok: true,
      ...(method === "createOffer" ? { sdp: "v=0" } : {}),
    });
  }
  await client.next("transcript");
  return { ...harness, client };
}

describe("the fork live bridge", () => {
  test("listens privately on session_start and reports ready before any call", async () => {
    const { sessions } = await setup();
    expect(statSync(join(agentDir, "live-bridge")).mode & 0o777).toBe(0o700);
    expect(statSync(socketPath()).mode & 0o777).toBe(0o600);
    expect((await open()).ready).toEqual({
      v: 1,
      type: "ready",
      pid: process.pid,
      pane: "p_1",
      busy: false,
    });
    expect(sessions).toHaveLength(0);
  });
  test("does not offer live calls outside TUI mode", async () => {
    await setup({ mode: "rpc" });
    expect(existsSync(socketPath())).toBe(false);
  });
  test("refuses an unsafe directory or a non-socket at its path", async () => {
    mkdirSync(join(agentDir, "live-bridge"), { mode: 0o700 });
    chmodSync(join(agentDir, "live-bridge"), 0o770);
    await setup();
    expect(existsSync(socketPath())).toBe(false);
    chmodSync(join(agentDir, "live-bridge"), 0o700);
    writeFileSync(socketPath(), "not a socket");
    await setup();
    expect(statSync(socketPath()).isFile()).toBe(true);
  });
  test("closes and unlinks on shutdown, then listens on the next session", async () => {
    const { emit } = await setup();
    const { client } = await open();
    await emit("session_shutdown");
    await client.closed;
    expect(existsSync(socketPath())).toBe(false);
    await emit("session_start");
    expect((await open()).ready.busy).toBe(false);
  });
  test("rejects malformed frames and media before start", async () => {
    await setup();
    for (const bad of [
      '{"v":1,"type":"ready","pid":1,"busy":false}\n',
      '{"v":2,"type":"start"}\n',
      "garbage\n",
      '{"v":1,"type":"event","payload":"{}"}\n',
    ]) {
      const { client } = await open();
      client.sendRaw(bad);
      await client.closed;
    }
  });
  test("runs client media without the native floor queue or modal UI", async () => {
    const { client, sessions, createArbiter, ctx, pi, emit } = await startCall();
    expect(sessions[0]!.offer).toBe("v=0");
    expect(sessions[0]!.options.voice).toBe("vale");
    expect(createArbiter).not.toHaveBeenCalled();
    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(client.seen.filter((f) => f.type === "phase").map((f) => f.phase)).toEqual([
      "connecting",
      "listening",
    ]);
    expect(client.seen.find((f) => f.type === "transcript")).toMatchObject({
      role: "user",
      text: "hello there",
      turn: 1,
      final: true,
    });
    sessions[0]!.options.callbacks.onTranscript(undefined);
    await client.next("transcript-clear");
    sessions[0]!.options.delegate("run tests");
    expect(pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ content: "run tests" }), {
      triggerTurn: true,
      deliverAs: "steer",
    });
    await emit("message_end");
    await emit("agent_settled");
    expect(sessions[0]!.handleAgentMessage).toHaveBeenCalled();
    expect(sessions[0]!.handleAgentSettled).toHaveBeenCalled();
    client.send({ type: "stop" });
    expect(await client.next("ended")).toEqual({ v: 1, type: "ended" });
    await client.closed;
  });
  test("mutes idempotently, accepts resume as a no-op, never sends park or usage", async () => {
    const { client, sessions } = await startCall();
    client.send({ type: "set-muted", muted: true });
    client.send({ type: "set-muted", muted: true });
    client.send({ type: "resume" });
    client.send({ type: "set-muted", muted: false });
    await vi.waitFor(() => expect(sessions[0]!.toggleMute).toHaveBeenCalledTimes(2));
    client.send({ type: "stop" });
    await client.next("ended");
    expect(client.seen.some((f) => f.type === "park" || f.type === "usage")).toBe(false);
  });
  test("busy clients cannot mute or stop the active call", async () => {
    const { client, sessions } = await startCall();
    const other = await open();
    expect(other.ready.busy).toBe(true);
    other.client.sendRaw(
      '{"v":1,"type":"start"}\n{"v":1,"type":"set-muted","muted":true}\n{"v":1,"type":"stop"}\n',
    );
    expect(await other.client.next("ended")).toMatchObject({
      error: "Live voice is already on in this Pi.",
    });
    await other.client.closed;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.toggleMute).not.toHaveBeenCalled();
    expect(sessions[0]!.stop).not.toHaveBeenCalled();
    client.send({ type: "stop" });
    await client.next("ended");
  });
  test("disconnect ends its call quietly and releases the reservation", async () => {
    const { client, sessions, live } = await startCall();
    client.end();
    await client.closed;
    await vi.waitFor(() => expect(live.isActive()).toBe(false));
    expect(sessions[0]!.stop).toHaveBeenCalled();
  });
  test("terminal /live stops the same call", async () => {
    const { pi, ctx, client } = await startCall();
    const command = vi.mocked(pi.registerCommand).mock.calls[0]![1];
    await command.handler("", ctx);
    expect(await client.next("ended")).toEqual({ v: 1, type: "ended" });
  });
  test("errors and shutdown send ended before closing", async () => {
    const { client, sessions, emit } = await startCall();
    sessions[0]!.options.callbacks.onTerminal(new Error("signaling failed"));
    expect(await client.next("ended")).toEqual({ v: 1, type: "ended", error: "signaling failed" });
    await client.closed;
    const next = await open();
    next.client.send({ type: "start" });
    await vi.waitFor(() => expect(sessions).toHaveLength(2));
    await emit("session_shutdown");
    expect(await next.client.next("ended")).toEqual({ v: 1, type: "ended" });
    await next.client.closed;
  });
  test("checks existing live.enabled at start, not only at registration", async () => {
    let enabled = true;
    await setup({ enabled: () => enabled });
    const { client } = await open();
    enabled = false;
    client.send({ type: "start" });
    expect(await client.next("ended")).toMatchObject({
      error: "Live voice is disabled. Enable it in /openai-settings.",
    });
  });
  test("a pending native start cannot overwrite a call reserved during lazy loading", async () => {
    const { live, pi, ctx } = await setup({
      sessionFor: (options) => ({ ...makeSession(options), start: vi.fn(async () => undefined) }),
    });
    const command = vi.mocked(pi.registerCommand).mock.calls[0]![1];
    vi.mocked(ctx.ui.custom).mockResolvedValue({});
    const nativeStart = command.handler("", ctx);
    const call = live.startCall(ctx, {
      createMedia: () => {
        throw new Error("unused");
      },
      callbacks: { onPhase: vi.fn(), onTranscript: vi.fn() },
    });
    try {
      await nativeStart;
      expect(ctx.ui.custom).not.toHaveBeenCalled();
      expect(live.isActive()).toBe(true);
    } finally {
      call.stop();
      await call.done;
    }
  });

  test("stop arriving with start cancels before lazy session construction", async () => {
    const { sessions, live } = await setup();
    const { client } = await open();
    client.sendRaw('{"v":1,"type":"start"}\n{"v":1,"type":"stop"}\n');
    await client.next("ended");
    expect(sessions).toHaveLength(0);
    expect(live.isActive()).toBe(false);
  });
});
