import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type LivePhase,
  LiveSessionController,
  type LiveSessionControllerOptions,
} from "../src/live/controller.ts";
import type { LiveNativeBindings } from "../src/live/native.ts";
import type { LiveClientMessage, LiveServerEvent } from "../src/live/protocol.ts";
import type { LiveTransportOptions } from "../src/live/transport.ts";

type FakeSession = {
  options: LiveTransportOptions;
  sent: LiveClientMessage[];
  closed: boolean;
  parked: boolean;
  /** What the controller asked of the transport, in order. */
  calls: string[];
  emit(event: LiveServerEvent): void;
};

const DELEGATION: LiveServerEvent = {
  type: "delegation.created",
  item: {
    type: "delegation",
    target: "client",
    id: "delegation-1",
    content: [{ type: "input_text", text: "Count the tests." }],
  },
};

const settle = async () => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

function harness(overrides: Partial<LiveSessionControllerOptions> = {}) {
  const sessions: FakeSession[] = [];
  const phases: LivePhase[] = [];
  const usage: number[] = [];
  const terminal = vi.fn();
  const delegate = vi.fn();
  const controller = new LiveSessionController({
    sessionId: "session-1",
    native: {} as LiveNativeBindings,
    getCredentials: vi.fn(async () => ({ accessToken: "token", accountId: "account" })),
    delegate,
    createTransport: (options) => {
      const session: FakeSession = {
        options,
        sent: [],
        closed: false,
        parked: false,
        calls: [],
        emit: (event) => options.callbacks.onEvent(event),
      };
      sessions.push(session);
      return {
        connect: vi.fn(async () => void session.calls.push("connect")),
        send: vi.fn(async (message: LiveClientMessage) => void session.sent.push(message)),
        setMuted: vi.fn((muted: boolean) => void session.calls.push(`mute:${muted}`)),
        close: vi.fn(async () => void (session.closed = true)),
        park: vi.fn(async () => void (session.parked = true)),
      };
    },
    callbacks: {
      onPhase: (phase) => phases.push(phase),
      onLevels: vi.fn(),
      onTranscript: vi.fn(),
      onTerminal: terminal,
      onUsage: (seconds) => usage.push(seconds),
    },
    ...overrides,
  });
  return { controller, sessions, phases, usage, terminal, delegate };
}

const seconds = async (count: number) => {
  await vi.advanceTimersByTimeAsync(count * 1000);
  await settle();
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("billed seconds", () => {
  test("follow the server's report and count the time since the last one when a session ends", async () => {
    const { controller, sessions, usage } = harness({ idleHangupSeconds: 0 });
    await controller.start();
    await seconds(15);
    sessions[0]!.emit({ type: "session.usage.updated", usage: { audio_duration_ms: 13_400 } });
    expect(usage).toEqual([13]);

    await seconds(7);
    await controller.stop();
    expect(usage.at(-1)).toBe(20);
  });

  test("sum over the sessions of a call, and a parked call stops counting", async () => {
    const { controller, sessions, usage } = harness({
      idleHangupSeconds: 0,
      parkAfterSeconds: 20,
    });
    await controller.start();
    sessions[0]!.emit(DELEGATION);
    await seconds(20);
    expect(sessions[0]!.parked).toBe(true);
    expect(usage.at(-1)).toBe(20);

    await seconds(300);
    controller.handleAgentMessage({
      role: "assistant",
      content: [{ type: "text", text: "Forty-three." }],
      stopReason: "stop",
    });
    controller.handleAgentSettled();
    await settle();
    expect(sessions).toHaveLength(2);
    sessions[1]!.emit({ type: "session.usage.updated", usage: { audio_duration_ms: 15_000 } });
    expect(usage.at(-1)).toBe(35);
  });
});

describe("idle hang-up", () => {
  test("ends the call like a hang-up once nobody has spoken or worked for the limit", async () => {
    const { controller, sessions, terminal } = harness({ idleHangupSeconds: 120 });
    await controller.start();
    await seconds(119);
    expect(terminal).not.toHaveBeenCalled();

    await seconds(1);
    expect(terminal).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(sessions[0]!.sent.at(-1)).toEqual({ type: "session.close" });
    expect(sessions[0]!.closed).toBe(true);
  });

  test("starts over whenever the user or the voice says something", async () => {
    const { controller, sessions, terminal } = harness({ idleHangupSeconds: 120 });
    await controller.start();
    await seconds(100);
    sessions[0]!.emit({ type: "input_transcript.added", item: { text: "Hello" } });
    await seconds(100);
    sessions[0]!.emit({ type: "output_transcript.added", item: { text: "Hi there" } });
    await seconds(119);
    expect(terminal).not.toHaveBeenCalled();

    await seconds(1);
    expect(terminal).toHaveBeenCalledOnce();
  });

  test("does not hang up on work in progress, and a limit of 0 never hangs up", async () => {
    const working = harness({ idleHangupSeconds: 120, parkAfterSeconds: 0 });
    await working.controller.start();
    working.sessions[0]!.emit(DELEGATION);
    await seconds(3600);
    expect(working.terminal).not.toHaveBeenCalled();
    await working.controller.stop();

    const off = harness({ idleHangupSeconds: 0 });
    await off.controller.start();
    await seconds(3600);
    expect(off.terminal).not.toHaveBeenCalled();
    await off.controller.stop();
  });
});

describe("parking", () => {
  const FINAL = {
    role: "assistant",
    content: [{ type: "text", text: "There are forty-three test files." }],
    stopReason: "stop",
  };

  test("closes the session, keeps the call, and speaks the result in a fresh session", async () => {
    let chat = "User: hello";
    const { controller, sessions, phases, terminal, delegate } = harness({
      chat: () => chat,
      parkAfterSeconds: 20,
      idleHangupSeconds: 120,
    });
    await controller.start();
    sessions[0]!.emit(DELEGATION);
    expect(delegate).toHaveBeenCalledWith("Count the tests.");

    await seconds(19);
    expect(sessions[0]!.parked).toBe(false);
    await seconds(1);
    expect(sessions[0]!.sent.at(-1)).toEqual({ type: "session.close" });
    expect(sessions[0]!.parked).toBe(true);
    expect(sessions[0]!.closed).toBe(false);
    expect(phases.at(-1)).toBe("parked");
    expect(terminal).not.toHaveBeenCalled();

    // parked time is not idle time
    await seconds(600);
    expect(terminal).not.toHaveBeenCalled();
    expect(sessions).toHaveLength(1);

    chat = "User: hello\n\nAssistant: There are forty-three test files.";
    controller.handleAgentMessage(FINAL);
    controller.handleAgentSettled();
    await settle();

    expect(sessions).toHaveLength(2);
    expect(sessions[1]!.options.instructions).toContain("forty-three test files");
    expect(sessions[1]!.sent).toEqual([
      {
        type: "session.context.append",
        channel: "speakable",
        content: [
          {
            type: "input_text",
            text: '"Agent Final Message":\n\nThere are forty-three test files.',
          },
        ],
      },
    ]);
    expect(phases.at(-1)).toBe("listening");

    // the idle limit starts over once the result is out
    await seconds(119);
    expect(terminal).not.toHaveBeenCalled();
    await seconds(1);
    expect(terminal).toHaveBeenCalledOnce();
  });

  test("waits for quiet: speech either way postpones it", async () => {
    const { controller, sessions } = harness({ parkAfterSeconds: 20, idleHangupSeconds: 0 });
    await controller.start();
    sessions[0]!.emit(DELEGATION);
    await seconds(15);
    sessions[0]!.emit({ type: "output_transcript.added", item: { text: "Looking into it" } });
    await seconds(19);
    expect(sessions[0]!.parked).toBe(false);
    await seconds(1);
    expect(sessions[0]!.parked).toBe(true);
  });

  test("is off at 0, and never happens to a phone that cannot be parked", async () => {
    const off = harness({ parkAfterSeconds: 0, idleHangupSeconds: 0 });
    await off.controller.start();
    off.sessions[0]!.emit(DELEGATION);
    await seconds(600);
    expect(off.sessions[0]!.parked).toBe(false);

    const fixed = harness({ parkAfterSeconds: 20, idleHangupSeconds: 0, canPark: () => false });
    await fixed.controller.start();
    fixed.sessions[0]!.emit(DELEGATION);
    await seconds(600);
    expect(fixed.sessions[0]!.parked).toBe(false);
    expect(fixed.sessions[0]!.closed).toBe(false);
  });

  test("resumes early on request, and the result still reaches the fresh session when it comes", async () => {
    const { controller, sessions, phases } = harness({
      chat: () => "User (by voice): Count the tests.",
      parkAfterSeconds: 20,
      idleHangupSeconds: 0,
    });
    await controller.start();
    sessions[0]!.emit(DELEGATION);
    await seconds(20);
    expect(phases.at(-1)).toBe("parked");

    controller.resume();
    await settle();
    expect(sessions).toHaveLength(2);
    expect(sessions[1]!.options.instructions).toContain("Count the tests.");
    expect(phases).toContain("connecting");

    controller.handleAgentMessage(FINAL);
    controller.handleAgentSettled();
    await settle();
    // the new session has no such delegation, so the result goes in as plain context
    expect(sessions[1]!.sent.map((message) => message.type)).toEqual(["session.context.append"]);
    expect(sessions[1]!.sent[0]).toMatchObject({ channel: "speakable" });
  });

  test("a muted call stays muted through the park: the fresh session is told before it connects", async () => {
    const { controller, sessions } = harness({ parkAfterSeconds: 20, idleHangupSeconds: 0 });
    await controller.start();
    controller.toggleMute();
    sessions[0]!.emit(DELEGATION);
    await seconds(20);

    controller.resume();
    await settle();
    expect(sessions).toHaveLength(2);
    // connecting is what opens the microphone, so the mute has to be there first
    expect(sessions[1]!.calls.indexOf("mute:true")).toBeGreaterThanOrEqual(0);
    expect(sessions[1]!.calls.indexOf("mute:true")).toBeLessThan(
      sessions[1]!.calls.indexOf("connect"),
    );
    expect(sessions[1]!.calls).not.toContain("mute:false");
  });

  test("an agent that settles while the session is closing is still spoken", async () => {
    const { controller, sessions } = harness({ parkAfterSeconds: 20, idleHangupSeconds: 0 });
    await controller.start();
    sessions[0]!.emit(DELEGATION);
    // the timer fires and the park starts; the agent settles before it has finished
    await vi.advanceTimersByTimeAsync(20_000);
    controller.handleAgentMessage(FINAL);
    controller.handleAgentSettled();
    await settle();
    expect(sessions).toHaveLength(2);
    expect(sessions[1]!.sent).toHaveLength(1);
  });

  test("ending a parked call is a normal stop that closes nothing twice", async () => {
    const { controller, sessions, terminal } = harness({
      parkAfterSeconds: 20,
      idleHangupSeconds: 0,
    });
    await controller.start();
    sessions[0]!.emit(DELEGATION);
    await seconds(20);
    await controller.stop();
    expect(terminal).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.closed).toBe(false);
  });
});
