import { createServer, type IncomingMessage, type Server } from "node:http";
import net, { type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { connectedPair } from "../src/live/bridge/socket.ts";
import type { ResolvedConfig } from "../src/config.ts";
import type { LiveSessionControllerOptions } from "../src/live/controller.ts";
import { registerOpenAILive } from "../src/live/index.ts";
import {
  createLivePhoneEndpoint,
  isLivePhoneEndpoint,
  LIVE_PHONE_EVENT,
  type LivePhoneCall,
  type LivePhoneCallOptions,
  type LivePhoneEndpoint,
} from "../src/live/phone/endpoint.ts";
import { MAX_FRAME_BYTES } from "../src/live/remote/protocol.ts";
import { makeResolvedConfig } from "./helpers.ts";

vi.mock("../src/usage.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/usage.ts")>()),
  requestCodexUsage: vi.fn(async () => undefined),
}));

type Frame = Record<string, unknown> & { type: string };

const lineOf = (body: Record<string, unknown>) => `${JSON.stringify({ v: 1, ...body })}\n`;

/** A node:http server that hands every upgrade to the endpoint, as the gateway will. */
async function serve(
  endpoint: LivePhoneEndpoint,
  options?: LivePhoneCallOptions | ((request: IncomingMessage) => LivePhoneCallOptions),
) {
  const calls: LivePhoneCall[] = [];
  const failures: unknown[] = [];
  const sockets = new Set<net.Socket>();
  const server: Server = createServer((_request, response) => {
    response.writeHead(426).end();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    const callOptions = typeof options === "function" ? options(request) : options;
    endpoint.upgrade(request, socket, head, callOptions).then(
      (call) => calls.push(call),
      (cause) => failures.push(cause),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  stops.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { port, calls, failures };
}

/** The phone: a WebSocket client that keeps what it was sent. */
function connectPhone(port: number, options: WebSocket.ClientOptions = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/call`, options);
  const seen: Frame[] = [];
  const waiters = new Set<() => void>();
  const consumed = new Map<string, number>();
  const closed = new Promise<{ code: number }>((resolve) =>
    ws.once("close", (code) => resolve({ code })),
  );
  ws.on("message", (data) => {
    seen.push(JSON.parse(data.toString()) as Frame);
    for (const wake of waiters) wake();
  });
  ws.on("error", () => undefined);
  phones.push(ws);
  return {
    ws,
    seen,
    closed,
    opened: new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    }),
    send: (body: Record<string, unknown>) => ws.send(JSON.stringify({ v: 1, ...body })),
    async next(type: string, timeoutMs = 3000): Promise<Frame> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const index = seen.findIndex(
          (frame, at) => frame.type === type && at >= (consumed.get(type) ?? 0),
        );
        if (index !== -1) {
          consumed.set(type, index + 1);
          return seen[index]!;
        }
        if (Date.now() > deadline) {
          throw new Error(`no ${type} frame; saw ${seen.map((frame) => frame.type).join(",")}`);
        }
        await new Promise<void>((resolve) => {
          const wake = () => {
            waiters.delete(wake);
            resolve();
          };
          waiters.add(wake);
          setTimeout(wake, 50);
        });
      }
    },
  };
}

const stops: Array<() => Promise<void>> = [];
const phones: WebSocket[] = [];

afterEach(async () => {
  for (const ws of phones.splice(0)) ws.terminate();
  for (const stop of stops.splice(0)) await stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Pi's end of the in-process connection, driven by hand. */
function fakeBridge() {
  const [relaySide, piSide] = connectedPair();
  const lines: Frame[] = [];
  let buffered = "";
  piSide.setEncoding("utf8");
  piSide.on("data", (chunk: string) => {
    buffered += chunk;
    for (let end = buffered.indexOf("\n"); end !== -1; end = buffered.indexOf("\n")) {
      lines.push(JSON.parse(buffered.slice(0, end)) as Frame);
      buffered = buffered.slice(end + 1);
    }
  });
  piSide.on("error", () => undefined);
  return {
    lines,
    piSide,
    openBridge: vi.fn((): Duplex => relaySide),
    say: (body: Record<string, unknown>) => piSide.write(lineOf(body)),
  };
}

describe("a call upgraded from node:http", () => {
  test("relays a call from hello to ended, then closes the socket", async () => {
    const bridge = fakeBridge();
    const ends: unknown[] = [];
    const endpoint = createLivePhoneEndpoint({
      status: () => ({ available: true, busy: false }),
      openBridge: bridge.openBridge,
    });
    const { port, calls } = await serve(endpoint, {
      voice: "vale",
      onEnd: (end) => ends.push(end),
    });
    const phone = connectPhone(port);
    await phone.opened;
    phone.send({ type: "hello" });
    bridge.say({ type: "ready", pid: process.pid, busy: false });
    await vi.waitFor(() => expect(bridge.lines).toHaveLength(2));
    expect(bridge.lines).toEqual([
      { v: 1, type: "start", voice: "vale" },
      { v: 1, type: "hello" },
    ]);
    bridge.say({ type: "request", id: 1, method: "open" });
    expect(await phone.next("request")).toEqual({ v: 1, type: "request", id: 1, method: "open" });
    phone.send({ type: "response", id: 1, ok: true });
    await vi.waitFor(() => expect(bridge.lines).toHaveLength(3));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.ended).toBe(false);
    bridge.say({ type: "ended" });
    expect(await phone.next("ended")).toEqual({ v: 1, type: "ended" });
    expect((await phone.closed).code).toBe(1000);
    expect(calls[0]!.ended).toBe(true);
    expect(ends).toEqual([{}]);
  });

  test("resolves with the call once the socket is open, and the host can end it", async () => {
    const bridge = fakeBridge();
    const endpoint = createLivePhoneEndpoint({
      status: () => ({ available: true, busy: false }),
      openBridge: bridge.openBridge,
    });
    const { port, calls } = await serve(endpoint);
    const phone = connectPhone(port);
    await phone.opened;
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    calls[0]!.end();
    expect(await phone.next("ended")).toEqual({ v: 1, type: "ended", code: "closed" });
    await phone.closed;
    expect(bridge.piSide.destroyed).toBe(true);
  });

  test("carries the host's frames both ways", async () => {
    const bridge = fakeBridge();
    const endpoint = createLivePhoneEndpoint({
      status: () => ({ available: true, busy: false }),
      openBridge: bridge.openBridge,
    });
    const seen: unknown[] = [];
    const { port, calls } = await serve(endpoint, {
      hostFrames: ["tool-call", "tool-result"],
      onHostFrame: (frame) => seen.push(frame),
    });
    const phone = connectPhone(port);
    await phone.opened;
    bridge.say({ type: "ready", pid: process.pid, busy: false });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.send({ type: "tool-call", id: 1, name: "open", args: {} })).toBe(true);
    expect(await phone.next("tool-call")).toEqual({
      v: 1,
      type: "tool-call",
      id: 1,
      name: "open",
      args: {},
    });
    phone.send({ type: "tool-result", id: 1, ok: true, result: "done" });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toEqual({ type: "tool-result", id: 1, ok: true, result: "done" });
  });

  test("tells a phone that Pi is not available, without opening the bridge", async () => {
    const bridge = fakeBridge();
    const endpoint = createLivePhoneEndpoint({
      status: () => ({ available: false, busy: false }),
      openBridge: bridge.openBridge,
    });
    const { port } = await serve(endpoint);
    const phone = connectPhone(port);
    expect(await phone.next("ended")).toEqual({ v: 1, type: "ended", code: "unavailable" });
    await phone.closed;
    expect(bridge.openBridge).not.toHaveBeenCalled();
  });

  test("ends quietly on a binary message", async () => {
    const bridge = fakeBridge();
    const endpoint = createLivePhoneEndpoint({
      status: () => ({ available: true, busy: false }),
      openBridge: bridge.openBridge,
    });
    const ends: unknown[] = [];
    const { port } = await serve(endpoint, { onEnd: (end) => ends.push(end) });
    const phone = connectPhone(port);
    await phone.opened;
    bridge.say({ type: "ready", pid: process.pid, busy: false });
    phone.ws.send(Buffer.from([1, 2, 3]));
    await phone.closed;
    expect(phone.seen).toEqual([]);
    expect(ends).toEqual([{}]);
  });

  test("ends quietly on a message over one MiB, which the socket refuses", async () => {
    const bridge = fakeBridge();
    const endpoint = createLivePhoneEndpoint({
      status: () => ({ available: true, busy: false }),
      openBridge: bridge.openBridge,
    });
    const ends: unknown[] = [];
    const { port } = await serve(endpoint, { onEnd: (end) => ends.push(end) });
    const phone = connectPhone(port);
    await phone.opened;
    phone.ws.send("x".repeat(MAX_FRAME_BYTES + 1));
    expect((await phone.closed).code).toBe(1009);
    expect(phone.seen).toEqual([]);
    await vi.waitFor(() => expect(ends).toEqual([{}]));
  });

  test("ends quietly when the phone goes away", async () => {
    const bridge = fakeBridge();
    const endpoint = createLivePhoneEndpoint({
      status: () => ({ available: true, busy: false }),
      openBridge: bridge.openBridge,
    });
    const ends: unknown[] = [];
    const { port } = await serve(endpoint, { onEnd: (end) => ends.push(end) });
    const phone = connectPhone(port);
    await phone.opened;
    phone.ws.terminate();
    await vi.waitFor(() => expect(ends).toEqual([{}]));
    await vi.waitFor(() => expect(bridge.piSide.destroyed).toBe(true));
  });

  test("rejects, with the socket destroyed, when the handshake fails", async () => {
    const bridge = fakeBridge();
    const endpoint = createLivePhoneEndpoint({
      status: () => ({ available: true, busy: false }),
      openBridge: bridge.openBridge,
    });
    const { port, failures } = await serve(endpoint);
    // an upgrade request with no Sec-WebSocket-Key
    const raw = net.connect(port, "127.0.0.1");
    let answer = "";
    raw.setEncoding("utf8");
    raw.on("data", (chunk: string) => (answer += chunk));
    raw.write(
      "GET /v1/call HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n\r\n",
    );
    await new Promise((resolve) => raw.once("close", resolve));
    expect(answer).toMatch(/^HTTP\/1\.1 400 /);
    await vi.waitFor(() => expect(failures).toHaveLength(1));
    expect(failures[0]).toBeInstanceOf(Error);
    expect(bridge.openBridge).not.toHaveBeenCalled();
  });

  test("rejects, with the socket destroyed, for host frames that name a call frame", async () => {
    const bridge = fakeBridge();
    const endpoint = createLivePhoneEndpoint({
      status: () => ({ available: true, busy: false }),
      openBridge: bridge.openBridge,
    });
    const { port, failures } = await serve(endpoint, { hostFrames: ["levels"] });
    const phone = connectPhone(port);
    await expect(phone.opened).rejects.toBeInstanceOf(Error);
    await vi.waitFor(() => expect(failures).toHaveLength(1));
    expect(String(failures[0])).toContain("levels");
    expect(bridge.openBridge).not.toHaveBeenCalled();
  });

  async function beat(phone: ReturnType<typeof connectPhone>, answered: boolean) {
    const pinged = new Promise((resolve) => phone.ws.once("ping", resolve));
    vi.advanceTimersByTime(5_000);
    await pinged;
    // the client's automatic pong has to cross the socket before the next beat
    if (answered) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  async function heartbeatCall(clientOptions: WebSocket.ClientOptions) {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const bridge = fakeBridge();
    const endpoint = createLivePhoneEndpoint({
      status: () => ({ available: true, busy: false }),
      openBridge: bridge.openBridge,
    });
    const { port, calls } = await serve(endpoint);
    const phone = connectPhone(port, clientOptions);
    await phone.opened;
    bridge.say({ type: "ready", pid: process.pid, busy: false });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    return { phone, call: calls[0]! };
  }

  test("keeps a phone that answers its pings", async () => {
    const { phone, call } = await heartbeatCall({});
    for (let at = 0; at < 12; at += 1) await beat(phone, true);
    expect(call.ended).toBe(false);
    expect(phone.seen).toEqual([]);
  });

  test("ends a phone that stops answering, twenty seconds on", async () => {
    const { phone, call } = await heartbeatCall({ autoPong: false });
    for (let at = 0; at < 4; at += 1) await beat(phone, false);
    expect(call.ended).toBe(false);
    vi.advanceTimersByTime(5_000);
    expect(await phone.next("ended")).toEqual({ v: 1, type: "ended", code: "closed" });
    expect(call.ended).toBe(true);
  });
});

describe("isLivePhoneEndpoint", () => {
  const endpoint = createLivePhoneEndpoint({
    status: () => ({ available: false, busy: false }),
    openBridge: () => connectedPair()[0],
  });

  test("knows an endpoint, which has version 1 and three functions", () => {
    expect(endpoint.version).toBe(1);
    expect(isLivePhoneEndpoint(endpoint)).toBe(true);
  });

  test("knows what is not one", () => {
    for (const value of [
      undefined,
      null,
      "endpoint",
      {},
      { ...endpoint, version: 2 },
      { ...endpoint, status: undefined },
      { ...endpoint, upgrade: "upgrade" },
      { ...endpoint, accept: undefined },
    ]) {
      expect(isLivePhoneEndpoint(value)).toBe(false);
    }
  });

  test("its event name is namespaced to this package", () => {
    expect(LIVE_PHONE_EVENT).toBe("pi-better-openai:live-phone");
  });
});

// The same, through the live voice registration that owns the call handler.

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function makeWidget() {
  const captured: { component?: Component & { dispose?(): void } } = {};
  const setWidget = vi.fn((_key: string, factory: unknown) => {
    if (typeof factory !== "function") {
      captured.component?.dispose?.();
      return;
    }
    const tui = {
      requestRender: vi.fn(),
      terminal: { write: vi.fn() },
      addInputListener: vi.fn(() => vi.fn()),
    };
    captured.component = (
      factory as (tui: unknown, theme: Theme) => Component & { dispose?(): void }
    )(tui, theme);
  });
  return { setWidget };
}

/** Stands in for LiveSessionController; drives its media like the controller's transport does. */
function makeSession(options: LiveSessionControllerOptions) {
  const stub = {
    options,
    media: undefined as undefined | { close(): Promise<void>; park?(): Promise<void> },
    start: vi.fn(async () => {
      options.callbacks.onPhase("connecting");
      const factory = await options.resolveMedia!();
      const media = factory!({ onEvent: vi.fn(), onLevels: vi.fn(), onFailure: vi.fn() });
      stub.media = media;
      await media.createOffer();
      options.callbacks.onPhase("listening");
    }),
    stop: vi.fn(async () => {
      await stub.media?.close();
    }),
    toggleMute: vi.fn(),
    handleAgentMessage: vi.fn(),
    resume: vi.fn(),
    handleAgentSettled: vi.fn(),
  };
  return stub;
}

const live: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  for (const run of live.splice(0)) await run.stop().catch(() => undefined);
});

describe("the endpoint of a live voice registration", () => {
  let enabled: boolean;
  let mode: string;

  beforeEach(() => {
    enabled = true;
    mode = "tui";
  });

  function register(env: NodeJS.ProcessEnv = {}) {
    const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
    const published: Array<{ channel: string; data: unknown }> = [];
    const pi = {
      registerCommand: vi.fn(),
      registerShortcut: vi.fn(),
      registerMessageRenderer: vi.fn(),
      on: vi.fn((event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
        handlers.set(event, handler),
      ),
      sendMessage: vi.fn(),
      events: {
        emit: vi.fn((channel: string, data: unknown) => void published.push({ channel, data })),
        on: vi.fn(),
      },
    } as unknown as ExtensionAPI;
    const sessions: Array<ReturnType<typeof makeSession>> = [];
    const registration = registerOpenAILive(
      pi,
      (): ResolvedConfig => makeResolvedConfig({ live: { enabled, voice: "sol", audioHost: "" } }),
      {
        createSession: (options) => {
          const stub = makeSession(options);
          sessions.push(stub);
          return stub;
        },
        createArbiter: vi.fn(),
        registerLauncher: vi.fn(),
        // no socket in these tests: the endpoint needs neither a Herdr pane nor the file
        bridgeAgentDir: "/nonexistent/agent",
        env,
      },
    );
    live.push(registration);
    const { setWidget } = makeWidget();
    const notify = vi.fn();
    const ctx = () =>
      ({
        mode,
        cwd: "/project",
        ui: { custom: vi.fn(), setWidget, notify, select: vi.fn() },
        sessionManager: { getSessionId: () => "session-7", getBranch: () => [] },
        modelRegistry: {},
      }) as unknown as ExtensionCommandContext;
    return { pi, handlers, published, sessions, registration, ctx, notify };
  }

  const published = (harness: ReturnType<typeof register>) =>
    harness.published.filter(({ channel }) => channel === LIVE_PHONE_EVENT);

  test("is published at registration and again whenever a session attaches", async () => {
    const harness = register();
    expect(published(harness)).toHaveLength(1);
    const endpoint = published(harness)[0]!.data;
    expect(isLivePhoneEndpoint(endpoint)).toBe(true);
    await harness.registration.attachBridge(harness.ctx());
    await harness.registration.attachBridge(harness.ctx());
    expect(published(harness)).toHaveLength(3);
    for (const { data } of published(harness)) expect(data).toBe(endpoint);
  });

  test("is published even where the unix socket is not offered", async () => {
    mode = "rpc";
    const harness = register({});
    await harness.registration.attachBridge(harness.ctx());
    expect(published(harness)).toHaveLength(2);
  });

  test("is not published, and nothing breaks, where Pi has no event bus", async () => {
    const harness = register();
    const bare = { ...harness.pi, events: undefined } as unknown as ExtensionAPI;
    expect(() =>
      registerOpenAILive(bare, () => makeResolvedConfig(), { registerLauncher: vi.fn() }),
    ).not.toThrow();
  });

  test("reports whether a session can take a call", async () => {
    const harness = register();
    const endpoint = published(harness)[0]!.data as LivePhoneEndpoint;
    expect(endpoint.status()).toEqual({ available: false, busy: false });
    await harness.registration.attachBridge(harness.ctx());
    expect(endpoint.status()).toEqual({ available: true, busy: false });
    enabled = false;
    expect(endpoint.status()).toEqual({ available: false, busy: false });
    enabled = true;
    mode = "rpc";
    await harness.registration.attachBridge(harness.ctx());
    expect(endpoint.status()).toEqual({ available: false, busy: false });
    mode = "tui";
    await harness.registration.attachBridge(harness.ctx());
    expect(endpoint.status().available).toBe(true);
    await harness.handlers.get("session_shutdown")!({}, harness.ctx());
    expect(endpoint.status()).toEqual({ available: false, busy: false });
  });

  async function connectCall(harness: ReturnType<typeof register>, options?: LivePhoneCallOptions) {
    await harness.registration.attachBridge(harness.ctx());
    const endpoint = published(harness)[0]!.data as LivePhoneEndpoint;
    return { endpoint, ...(await serve(endpoint, options)) };
  }

  test("runs a call from hello to ended, and is busy while it is on", async () => {
    const harness = register();
    const { endpoint, port } = await connectCall(harness);
    const phone = connectPhone(port);
    await phone.opened;
    phone.send({ type: "hello" });
    const open = await phone.next("request");
    expect(open).toMatchObject({ v: 1, method: "open" });
    phone.send({ type: "response", id: open.id, ok: true });
    const offer = await phone.next("request");
    expect(offer).toMatchObject({ method: "createOffer" });
    phone.send({ type: "response", id: offer.id, ok: true, sdp: "v=0" });
    expect(await phone.next("phase")).toMatchObject({ phase: "connecting" });
    expect(await phone.next("phase")).toMatchObject({ phase: "listening" });
    expect(harness.sessions).toHaveLength(1);
    expect(endpoint.status()).toEqual({ available: true, busy: true });

    // a second phone is told so, and the first call goes on
    const second = connectPhone(port);
    await second.opened;
    second.send({ type: "hello" });
    expect(await second.next("ended")).toEqual({ v: 1, type: "ended", code: "busy" });
    await second.closed;
    expect(phone.seen.some((frame) => frame.type === "ended")).toBe(false);

    phone.send({ type: "stop" });
    expect(await phone.next("ended")).toEqual({ v: 1, type: "ended" });
    await phone.closed;
    expect(harness.sessions[0]!.stop).toHaveBeenCalled();
    await vi.waitFor(() => expect(endpoint.status()).toEqual({ available: true, busy: false }));
    expect(harness.notify).not.toHaveBeenCalled();
  });

  test("carries a phone's features, and the park, usage and resume frames, across the relay", async () => {
    const harness = register();
    const { port } = await connectCall(harness);
    const phone = connectPhone(port);
    await phone.opened;
    phone.send({ type: "hello", features: ["park", "usage"] });
    const open = await phone.next("request");
    phone.send({ type: "response", id: open.id, ok: true });
    const offer = await phone.next("request");
    phone.send({ type: "response", id: offer.id, ok: true, sdp: "v=0" });
    await phone.next("phase");
    await phone.next("phase");

    const session = harness.sessions[0]!;
    expect(session.options.canPark?.()).toBe(true);
    await session.media!.park!();
    session.options.callbacks.onPhase("parked");
    session.options.callbacks.onUsage?.(20);
    expect(await phone.next("park")).toEqual({ v: 1, type: "park" });
    expect(await phone.next("phase")).toEqual({ v: 1, type: "phase", phase: "parked" });
    expect(await phone.next("usage")).toEqual({ v: 1, type: "usage", seconds: 20 });

    phone.send({ type: "resume" });
    await vi.waitFor(() => expect(session.resume).toHaveBeenCalledOnce());
    phone.send({ type: "stop" });
    expect(await phone.next("ended")).toEqual({ v: 1, type: "ended" });
  });

  test("takes the voice from the call's options", async () => {
    const harness = register();
    const { port } = await connectCall(harness, { voice: "vale" });
    const phone = connectPhone(port);
    await phone.opened;
    phone.send({ type: "hello" });
    const open = await phone.next("request");
    phone.send({ type: "response", id: open.id, ok: true });
    await phone.next("request");
    expect(harness.sessions[0]!.options.voice).toBe("vale");
  });

  test("ends a call when the host does, and the session stops", async () => {
    const harness = register();
    const { port, calls } = await connectCall(harness);
    const phone = connectPhone(port);
    await phone.opened;
    phone.send({ type: "hello" });
    const open = await phone.next("request");
    phone.send({ type: "response", id: open.id, ok: true });
    await phone.next("request");
    calls[0]!.end();
    expect(await phone.next("ended")).toEqual({ v: 1, type: "ended", code: "closed" });
    await vi.waitFor(() => expect(harness.sessions[0]!.stop).toHaveBeenCalled());
    await vi.waitFor(() => expect(harness.registration.isActive()).toBe(false));
  });

  test("tells a phone the session is not available once Pi shuts down", async () => {
    const harness = register();
    const { port } = await connectCall(harness);
    await harness.handlers.get("session_shutdown")!({}, harness.ctx());
    const phone = connectPhone(port);
    expect(await phone.next("ended")).toEqual({ v: 1, type: "ended", code: "unavailable" });
  });

  test("refuses a call when live voice was turned off after the session started", async () => {
    const harness = register();
    const { port } = await connectCall(harness);
    enabled = false;
    const phone = connectPhone(port);
    await phone.opened;
    phone.send({ type: "hello" });
    expect(await phone.next("ended")).toEqual({ v: 1, type: "ended", code: "unavailable" });
  });
});
