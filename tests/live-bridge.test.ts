import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { LiveSessionControllerOptions } from "../src/live/controller.ts";
import { registerOpenAILive } from "../src/live/index.ts";
import type { ResolvedConfig } from "../src/config.ts";
import { makeResolvedConfig } from "./helpers.ts";

type Frame = Record<string, unknown> & { type: string };

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

/** A Pi session's `ctx.ui.custom`: runs the factory like Pi does and resolves when it calls done. */
function makeCustom() {
  const captured: { component?: Component & { dispose?(): void } } = {};
  const custom = vi.fn(async (factory: unknown) => {
    const tui = {
      requestRender: vi.fn(),
      terminal: { write: vi.fn() },
      addInputListener: vi.fn(() => vi.fn()),
    };
    const result = await new Promise<unknown>((resolve) => {
      captured.component = (
        factory as (
          tui: unknown,
          theme: Theme,
          keybindings: object,
          done: (value: unknown) => void,
        ) => Component & { dispose?(): void }
      )(tui, theme, {}, resolve);
    });
    captured.component?.dispose?.();
    return result;
  });
  return { captured, custom };
}

/** The phone's side of the socket. */
function connectHost(path: string) {
  const seen: Frame[] = [];
  let buffered = "";
  const socket = net.connect(path);
  const waiters = new Set<() => void>();
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffered += chunk;
    for (;;) {
      const end = buffered.indexOf("\n");
      if (end === -1) break;
      seen.push(JSON.parse(buffered.slice(0, end)) as Frame);
      buffered = buffered.slice(end + 1);
    }
    for (const wake of waiters) wake();
  });
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  socket.on("error", () => undefined);
  const consumed = new Map<string, number>();
  return {
    seen,
    closed,
    send: (frame: Record<string, unknown>) =>
      socket.write(`${JSON.stringify({ v: 1, ...frame })}\n`),
    sendRaw: (text: string) => socket.write(text),
    end: () => socket.end(),
    /** The next frame of this type that was not returned before, whatever else arrived between. */
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

let scratch: string;
let agentDir: string;
const live: Array<{ stop(): Promise<void> }> = [];
const hosts: Array<ReturnType<typeof connectHost>> = [];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pbo-bridge-"));
  agentDir = join(scratch, "agent");
  mkdirSync(agentDir);
});

afterEach(async () => {
  for (const host of hosts.splice(0)) host.end();
  for (const run of live.splice(0)) await run.stop().catch(() => undefined);
  rmSync(scratch, { recursive: true, force: true });
});

function socketPath(): string {
  return join(agentDir, "live-bridge", `${process.pid}.sock`);
}

type SessionStub = ReturnType<typeof makeSession>;

/** Stands in for LiveSessionController; drives its media like the controller's transport does. */
function makeSession(options: LiveSessionControllerOptions) {
  let muted = false;
  const stub = {
    options,
    offer: undefined as string | undefined,
    media: undefined as undefined | { close(): Promise<void> },
    start: vi.fn(async () => {
      options.callbacks.onPhase("connecting");
      const factory = await options.resolveMedia!();
      const media = factory!({ onEvent: vi.fn(), onLevels: vi.fn(), onFailure: vi.fn() });
      stub.media = media;
      stub.offer = await media.createOffer();
      options.callbacks.onPhase("listening");
      options.callbacks.onTranscript({ role: "user", text: "hello there", turn: 1, final: true });
    }),
    stop: vi.fn(async () => {
      await stub.media?.close();
    }),
    toggleMute: vi.fn(() => {
      muted = !muted;
      options.callbacks.onPhase(muted ? "muted" : "listening");
    }),
    handleAgentMessage: vi.fn(),
    handleAgentSettled: vi.fn(),
  };
  return stub;
}

async function setup(
  overrides: {
    config?: () => ResolvedConfig;
    env?: NodeJS.ProcessEnv;
    mode?: string;
    sessionFor?: (options: LiveSessionControllerOptions) => SessionStub;
  } = {},
) {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const pi = {
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    registerMessageRenderer: vi.fn(),
    on: vi.fn((event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
      handlers.set(event, handler),
    ),
    sendMessage: vi.fn(),
  } as unknown as ExtensionAPI;
  const sessions: SessionStub[] = [];
  const createArbiter = vi.fn();
  const registration = registerOpenAILive(
    pi,
    overrides.config ??
      (() => makeResolvedConfig({ live: { enabled: true, voice: "sol", audioHost: "" } })),
    {
      createSession: (options) => {
        const stub = (overrides.sessionFor ?? makeSession)(options);
        sessions.push(stub);
        return stub;
      },
      createArbiter,
      registerLauncher: vi.fn(),
      bridgeAgentDir: agentDir,
      env: overrides.env ?? { HERDR_PANE_ID: "p_1" },
    },
  );
  live.push(registration);
  const { captured, custom } = makeCustom();
  const notify = vi.fn();
  const ctx = {
    mode: overrides.mode ?? "tui",
    cwd: "/project",
    ui: { custom, notify, select: vi.fn() },
    sessionManager: { getSessionId: () => "session-7" },
    modelRegistry: {},
  } as unknown as ExtensionCommandContext;
  await registration.attachBridge(ctx);
  return { registration, handlers, sessions, captured, custom, notify, ctx, createArbiter };
}

async function open() {
  const host = connectHost(socketPath());
  hosts.push(host);
  return { host, ready: await host.next("ready") };
}

describe("the live bridge socket", () => {
  test("listens in a private directory and says ready first", async () => {
    await setup();
    expect(statSync(join(agentDir, "live-bridge")).mode & 0o777).toBe(0o700);
    expect(statSync(socketPath()).mode & 0o777).toBe(0o600);
    const { host, ready } = await open();
    expect(ready).toEqual({ v: 1, type: "ready", pid: process.pid, pane: "p_1", busy: false });
    expect(host.seen[0]).toBe(ready);
  });

  test("does not listen outside a Herdr pane, outside the TUI, or with live voice off", async () => {
    await setup({ env: {} });
    expect(existsSync(socketPath())).toBe(false);
    await setup({ mode: "rpc" });
    expect(existsSync(socketPath())).toBe(false);
    await setup({
      config: () => makeResolvedConfig({ live: { enabled: false, voice: "sol", audioHost: "" } }),
    });
    expect(existsSync(socketPath())).toBe(false);
  });

  test("refuses a directory other users could enter", async () => {
    const dir = join(agentDir, "live-bridge");
    mkdirSync(dir);
    chmodSync(dir, 0o770);
    await setup();
    expect(existsSync(socketPath())).toBe(false);
  });

  test("replaces a stale socket left by a process with the same pid", async () => {
    const dir = join(agentDir, "live-bridge");
    mkdirSync(dir, { mode: 0o700 });
    const child = spawn(
      process.execPath,
      [
        "-e",
        "require('net').createServer().listen(process.argv[1], () => console.log('up'))",
        socketPath(),
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    expect(existsSync(socketPath())).toBe(true);
    await setup();
    expect((await open()).ready.type).toBe("ready");
  });

  test("closes and unlinks on session shutdown, and listens again on the next session", async () => {
    const { handlers, ctx, registration } = await setup();
    const { host } = await open();
    await handlers.get("session_shutdown")!({}, ctx);
    await host.closed;
    expect(existsSync(socketPath())).toBe(false);
    await registration.attachBridge(ctx);
    expect(existsSync(socketPath())).toBe(true);
  });

  test("drops a connection that sends something the protocol does not allow", async () => {
    await setup();
    for (const bad of [
      '{"v":1,"type":"ready","pid":1,"busy":false}\n',
      '{"v":1,"type":"request","id":1,"method":"open"}\n',
      '{"v":2,"type":"start"}\n',
      "garbage\n",
    ]) {
      const { host } = await open();
      host.sendRaw(bad);
      await host.closed;
    }
  });

  test("lets only a hello through before start", async () => {
    await setup();
    const { host } = await open();
    host.send({ type: "hello" });
    host.send({ type: "event", payload: "{}" });
    await host.closed;
  });
});

describe("a call started from the socket", () => {
  test("runs a session whose media is the connection, and reports the call", async () => {
    const { sessions, createArbiter, custom } = await setup();
    const { host } = await open();
    host.send({ type: "hello" });
    host.send({ type: "start" });
    const open_ = await host.next("request");
    expect(open_).toMatchObject({ v: 1, method: "open" });
    host.send({ type: "response", id: open_.id, ok: true });
    const offer = await host.next("request");
    expect(offer).toMatchObject({ method: "createOffer" });
    host.send({ type: "response", id: offer.id, ok: true, sdp: "v=0" });
    expect(await host.next("phase")).toMatchObject({ phase: "connecting" });
    expect(await host.next("phase")).toMatchObject({ phase: "listening" });
    expect(await host.next("transcript")).toMatchObject({
      role: "user",
      text: "hello there",
      turn: 1,
      final: true,
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.offer).toBe("v=0");
    expect(custom).toHaveBeenCalledOnce();
    expect(createArbiter).not.toHaveBeenCalled();
    expect(sessions[0]!.options.delegate).toBeTypeOf("function");
  });

  test("the control frames never reach the media", async () => {
    const { sessions } = await setup();
    const { host } = await open();
    host.send({ type: "hello" });
    host.send({ type: "start" });
    const request = await host.next("request");
    host.send({ type: "response", id: request.id, ok: true });
    host.send({ type: "set-muted", muted: true });
    host.send({ type: "stop" });
    await host.next("ended");
    expect(sessions[0]!.toggleMute).toHaveBeenCalledOnce();
  });

  async function startCall() {
    const harness = await setup();
    const { host } = await open();
    host.send({ type: "hello" });
    host.send({ type: "start" });
    const request = await host.next("request");
    host.send({ type: "response", id: request.id, ok: true });
    const offer = await host.next("request");
    host.send({ type: "response", id: offer.id, ok: true, sdp: "v=0" });
    await host.next("phase");
    await host.next("phase");
    return { ...harness, host };
  }

  test("a stop frame ends the call with an empty ended", async () => {
    const { host, sessions, notify } = await startCall();
    host.send({ type: "stop" });
    expect(await host.next("ended")).toEqual({ v: 1, type: "ended" });
    await host.closed;
    expect(sessions[0]!.stop).toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  test("the phone going away ends the call without an error", async () => {
    const { host, sessions, notify, registration } = await startCall();
    host.end();
    await host.closed;
    await vi.waitFor(() => expect(sessions[0]!.stop).toHaveBeenCalled());
    await vi.waitFor(() => expect(registration.isActive()).toBe(false));
    expect(notify).not.toHaveBeenCalled();
  });

  test("ending it in the terminal tells the phone", async () => {
    const { host, captured, sessions } = await startCall();
    captured.component!.handleInput!("\u001b");
    expect(await host.next("ended")).toEqual({ v: 1, type: "ended" });
    await host.closed;
    expect(sessions[0]!.stop).toHaveBeenCalled();
  });

  test("a failing session ends the call with its error", async () => {
    const { host, sessions, notify } = await startCall();
    sessions[0]!.options.callbacks.onTerminal(new Error("Codex live signaling failed (401)"));
    expect(await host.next("ended")).toEqual({
      v: 1,
      type: "ended",
      error: "Codex live signaling failed (401)",
    });
    expect(notify).toHaveBeenCalledWith("Codex live signaling failed (401)", "error");
  });

  test("mutes only when the phone asks for a different state", async () => {
    const { host, sessions } = await startCall();
    host.send({ type: "set-muted", muted: true });
    await host.next("phase");
    host.send({ type: "set-muted", muted: true });
    host.send({ type: "set-muted", muted: false });
    await vi.waitFor(() => expect(sessions[0]!.toggleMute).toHaveBeenCalledTimes(2));
  });

  test("a second start is refused while one call is on, and ready says so", async () => {
    const { host } = await startCall();
    const second = await open();
    expect(second.ready).toMatchObject({ busy: true });
    second.host.send({ type: "hello" });
    second.host.send({ type: "start" });
    expect(await second.host.next("ended")).toEqual({
      v: 1,
      type: "ended",
      error: "Live voice is already on in this Pi.",
    });
    await second.host.closed;
    expect(host.seen.some((frame) => frame.type === "ended")).toBe(false);
  });

  test("refuses to start when live voice was turned off after Pi started", async () => {
    let enabled = true;
    await setup({
      config: () => makeResolvedConfig({ live: { enabled, voice: "sol", audioHost: "" } }),
    });
    const { host } = await open();
    enabled = false;
    host.send({ type: "start" });
    expect(await host.next("ended")).toEqual({
      v: 1,
      type: "ended",
      error: "Live voice is disabled. Enable it in /openai-settings.",
    });
  });

  test("the session ending at shutdown still tells the phone", async () => {
    const { host, handlers, ctx } = await startCall();
    await handlers.get("session_shutdown")!({}, ctx);
    expect(await host.next("ended")).toEqual({ v: 1, type: "ended" });
    await host.closed;
  });
});
