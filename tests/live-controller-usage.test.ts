import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type LivePhase,
  LiveSessionController,
  type LiveSessionControllerOptions,
} from "../src/live/controller.ts";
import type { LiveNativeBindings } from "../src/live/native.ts";
import {
  chunkLiveContext,
  type LiveClientMessage,
  type LiveServerEvent,
} from "../src/live/protocol.ts";
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
  for (let index = 0; index < 50; index += 1) await Promise.resolve();
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
    getCredentials: vi.fn(async () => ({
      accessToken: "token",
      accountId: "account",
    })),
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
        setPlaybackMuted: vi.fn((muted: boolean) => void session.calls.push(`playback:${muted}`)),
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

/** What a session was sent after its opening memory, which is its instructions as silent context. */
const sentAfterMemory = (session: FakeSession) =>
  session.sent.slice(chunkLiveContext(session.options.instructions).length);

const seconds = async (count: number) => {
  await vi.advanceTimersByTimeAsync(count * 1000);
  await settle();
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("gates playback and assistant transcripts until user speech, rearming on resume", async () => {
  const onTranscript = vi.fn();
  const onLevels = vi.fn();
  const { controller, sessions } = harness({
    parkAfterSeconds: 20,
    callbacks: { onPhase: vi.fn(), onLevels, onTranscript, onTerminal: vi.fn() },
  });
  await controller.start();
  const first = sessions[0]!;
  expect(first.calls).toEqual(["mute:false", "playback:true", "connect"]);
  first.emit({ type: "output_audio.delta", audio: "startup" });
  first.options.callbacks.onLevels(0, 0.8);
  first.emit({ type: "output_transcript.added", item: { text: "Good morning" } });
  first.emit({ type: "turn.done", turn: { role: "assistant", transcript: "I'm ChatGPT" } });
  expect(onTranscript.mock.calls).toEqual([[undefined]]);
  expect(onLevels).toHaveBeenLastCalledWith(0, 0);
  expect(controller.phase).toBe("listening");
  first.emit({ type: "input_transcript.added", item: { text: "" } });
  expect(first.calls).not.toContain("playback:false");

  first.options.callbacks.onLevels(0.1, 0);
  first.emit({ type: "input_transcript.added", item: { text: "Hello" } });
  first.emit({ type: "input_transcript.added", item: { text: "Hello there" } });
  expect(first.calls.filter((call) => call === "playback:false")).toHaveLength(1);
  first.emit({ type: "output_transcript.added", item: { text: "Hi" } });
  first.emit({ type: "turn.done", turn: { role: "assistant", transcript: "Hi there" } });
  expect(onTranscript).toHaveBeenLastCalledWith({
    role: "assistant",
    text: "Hi there",
    turn: 1,
    final: true,
  });
  first.options.callbacks.onLevels(0.1, 0.5);
  expect(onLevels).toHaveBeenLastCalledWith(0.1, 0.5);

  first.emit(DELEGATION);
  await seconds(20);
  expect(controller.phase).toBe("parked");
  controller.resume();
  await settle();
  const second = sessions[1]!;
  expect(second.calls).toEqual(["mute:false", "playback:true", "connect"]);
  const count = onTranscript.mock.calls.length;
  first.emit({ type: "input_transcript.added", item: { text: "stale speech" } });
  second.emit({
    type: "output_transcript.added",
    item: { text: "Thanks, I'll look into that with you" },
  });
  second.emit({ type: "turn.done", turn: { role: "assistant", transcript: "In Ovis" } });
  expect(onTranscript).toHaveBeenCalledTimes(count);
  expect(second.calls).not.toContain("playback:false");
  second.emit({ type: "input_transcript.added", item: { text: "Any news?" } });
  expect(second.calls.at(-1)).toBe("playback:false");
  second.emit({ type: "turn.done", turn: { role: "assistant", transcript: "Still working" } });
  expect(onTranscript).toHaveBeenLastCalledWith({
    role: "assistant",
    text: "Still working",
    turn: 2,
    final: true,
  });
  await controller.stop();
});

test.each(["input_transcript.added", "turn.done"] as const)(
  "requires recent microphone speech before opening the gate on %s",
  async (type) => {
    const onTranscript = vi.fn();
    const { controller, sessions } = harness({
      callbacks: { onPhase: vi.fn(), onLevels: vi.fn(), onTranscript, onTerminal: vi.fn() },
    });
    const transcript = (text: string): LiveServerEvent =>
      type === "turn.done"
        ? { type, turn: { role: "user", transcript: text } }
        : { type, item: { text } };
    await controller.start();
    const first = sessions[0]!;
    first.options.callbacks.onLevels(0, 0);
    first.emit(transcript("the image displays"));
    const count = onTranscript.mock.calls.length;
    first.emit({ type: "output_transcript.added", item: { text: "Sure thing" } });
    first.emit({ type: "turn.done", turn: { role: "assistant", transcript: "Sure thing" } });
    expect(onTranscript).toHaveBeenCalledTimes(count);
    expect(first.calls).not.toContain("playback:false");

    first.options.callbacks.onLevels(0.04, 0);
    first.emit(transcript("Okay"));
    expect(first.calls).not.toContain("playback:false");
    first.options.callbacks.onLevels(0.1, 0);
    first.options.callbacks.onLevels(0, 0);
    await seconds(3);
    first.emit(transcript("Okay"));
    expect(first.calls).not.toContain("playback:false");
    expect(first.sent.length).toBe(chunkLiveContext(first.options.instructions).length);

    first.options.callbacks.onLevels(0.1, 0);
    first.options.callbacks.onLevels(0, 0);
    await seconds(2);
    first.emit(transcript("Is it ready?"));
    await settle();
    expect(first.calls.at(-1)).toBe("playback:false");
    expect(first.sent).toEqual(
      chunkLiveContext(first.options.instructions).map((text) => ({
        type: "session.context.append",
        channel: "commentary",
        content: [{ type: "input_text", text }],
      })),
    );
    first.emit({ type: "turn.done", turn: { role: "assistant", transcript: "It is ready." } });
    expect(onTranscript).toHaveBeenLastCalledWith({
      role: "assistant",
      text: "It is ready.",
      turn: 1,
      final: true,
    });
    await controller.stop();
  },
);

test("sends opening memory at connect before queued chat and again on resume", async () => {
  const { controller, sessions } = harness({
    chat: "User: Is the image ready?",
    parkAfterSeconds: 20,
  });
  await controller.start();
  await settle();
  const first = sessions[0]!;
  const memory = chunkLiveContext(first.options.instructions).map((text) => ({
    type: "session.context.append",
    channel: "commentary",
    content: [{ type: "input_text", text }],
  }));
  expect(first.sent).toEqual(memory);
  expect(first.calls).not.toContain("playback:false");
  controller.handleAgentMessage({ role: "user", content: "Check the image." });
  await settle();
  expect(first.sent.slice(0, memory.length)).toEqual(memory);
  expect(sentAfterMemory(first)).toEqual([
    {
      type: "session.context.append",
      content: [{ type: "input_text", text: expect.stringContaining("Check the image.") }],
    },
  ]);

  first.emit(DELEGATION);
  await seconds(20);
  controller.resume();
  await settle();
  const second = sessions[1]!;
  expect(second.calls).toEqual(["mute:false", "playback:true", "connect"]);
  expect(second.sent).toEqual(memory);
  await controller.stop();
});

describe("billed seconds", () => {
  test("follow the server's report and count the time since the last one when a session ends", async () => {
    const { controller, sessions, usage } = harness({ idleHangupSeconds: 0 });
    await controller.start();
    await seconds(15);
    sessions[0]!.emit({
      type: "session.usage.updated",
      usage: { audio_duration_ms: 13_400 },
    });
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
    sessions[1]!.emit({
      type: "session.usage.updated",
      usage: { audio_duration_ms: 15_000 },
    });
    expect(usage.at(-1)).toBe(35);
  });
});

describe("idle hang-up", () => {
  test("ends the call like a hang-up once nobody has spoken or worked for the limit", async () => {
    const { controller, sessions, terminal } = harness({
      idleHangupSeconds: 120,
    });
    await controller.start();
    await seconds(119);
    expect(terminal).not.toHaveBeenCalled();

    await seconds(1);
    expect(terminal).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(sessions[0]!.sent.at(-1)).toEqual({ type: "session.close" });
    expect(sessions[0]!.closed).toBe(true);
  });

  test("starts over whenever the user or the voice says something", async () => {
    const { controller, sessions, terminal } = harness({
      idleHangupSeconds: 120,
    });
    await controller.start();
    await seconds(100);
    sessions[0]!.emit({
      type: "input_transcript.added",
      item: { text: "Hello" },
    });
    await seconds(100);
    sessions[0]!.emit({
      type: "output_transcript.added",
      item: { text: "Hi there" },
    });
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
    const onTranscript = vi.fn();
    const onLevels = vi.fn();
    const { controller, sessions, phases, terminal, delegate } = harness({
      chat: () => chat,
      parkAfterSeconds: 20,
      idleHangupSeconds: 120,
      callbacks: {
        onPhase: (phase) => phases.push(phase),
        onLevels,
        onTranscript,
        onTerminal: (error) => terminal(error),
      },
    });
    await controller.start();
    sessions[0]!.emit({ type: "input_transcript.added", item: { text: "Count the tests." } });
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
    expect(sentAfterMemory(sessions[1]!)).toEqual([
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
    expect(sessions[1]!.calls).toEqual([
      "mute:false",
      "playback:true",
      "connect",
      "playback:false",
    ]);
    // Result activity must refresh the idle deadline, not just opening the session.
    await seconds(100);
    sessions[1]!.emit({ type: "output_transcript.added", item: { text: "There are" } });
    expect(onTranscript).toHaveBeenLastCalledWith({
      role: "assistant",
      text: "There are",
      turn: 1,
      final: false,
    });
    sessions[1]!.emit({
      type: "turn.done",
      turn: { role: "assistant", transcript: "There are forty-three test files." },
    });
    expect(onTranscript).toHaveBeenLastCalledWith({
      role: "assistant",
      text: "There are forty-three test files.",
      turn: 1,
      final: true,
    });
    sessions[1]!.options.callbacks.onLevels(0, 0.5);
    expect(onLevels).toHaveBeenLastCalledWith(0, 0.5);

    // the idle limit starts over once the result is out
    await seconds(119);
    expect(terminal).not.toHaveBeenCalled();
    await seconds(1);
    expect(terminal).toHaveBeenCalledOnce();
  });

  test("waits for quiet: speech either way postpones it", async () => {
    const { controller, sessions } = harness({
      parkAfterSeconds: 20,
      idleHangupSeconds: 0,
    });
    await controller.start();
    sessions[0]!.emit(DELEGATION);
    await seconds(15);
    sessions[0]!.emit({ type: "input_transcript.added", item: { text: "Any news?" } });
    sessions[0]!.emit({
      type: "output_transcript.added",
      item: { text: "Looking into it" },
    });
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

    const fixed = harness({
      parkAfterSeconds: 20,
      idleHangupSeconds: 0,
      canPark: () => false,
    });
    await fixed.controller.start();
    fixed.sessions[0]!.emit(DELEGATION);
    await seconds(600);
    expect(fixed.sessions[0]!.parked).toBe(false);
    expect(fixed.sessions[0]!.closed).toBe(false);
  });

  test("resumes early on request, and the result still reaches the fresh session when it comes", async () => {
    const onTranscript = vi.fn();
    const { controller, sessions, phases } = harness({
      chat: () => "User (by voice): Count the tests.",
      parkAfterSeconds: 20,
      idleHangupSeconds: 0,
      callbacks: {
        onPhase: (phase) => phases.push(phase),
        onLevels: vi.fn(),
        onTranscript,
        onTerminal: vi.fn(),
      },
    });
    await controller.start();
    sessions[0]!.emit({ type: "input_transcript.added", item: { text: "Count the tests." } });
    sessions[0]!.emit(DELEGATION);
    await seconds(20);
    expect(phases.at(-1)).toBe("parked");

    controller.resume();
    await settle();
    expect(sessions).toHaveLength(2);
    expect(sessions[1]!.options.instructions).toContain("Count the tests.");
    expect(phases).toContain("connecting");
    expect(sessions[1]!.calls).toEqual(["mute:false", "playback:true", "connect"]);
    const count = onTranscript.mock.calls.length;
    sessions[1]!.emit({ type: "output_transcript.added", item: { text: "Good morning" } });
    sessions[1]!.emit({
      type: "turn.done",
      turn: { role: "assistant", transcript: "I'm ChatGPT" },
    });
    expect(onTranscript).toHaveBeenCalledTimes(count);

    controller.handleAgentMessage(FINAL);
    controller.handleAgentSettled();
    await settle();
    // the new session has no such delegation, so the result goes in as plain context
    expect(sentAfterMemory(sessions[1]!).map((message) => message.type)).toEqual([
      "session.context.append",
    ]);
    expect(sentAfterMemory(sessions[1]!)[0]).toMatchObject({
      channel: "speakable",
    });
    expect(sessions[1]!.calls.at(-1)).toBe("playback:false");
    sessions[1]!.emit({ type: "output_transcript.added", item: { text: "There are" } });
    expect(onTranscript).toHaveBeenLastCalledWith({
      role: "assistant",
      text: "There are",
      turn: 1,
      final: false,
    });
    sessions[1]!.emit({
      type: "turn.done",
      turn: { role: "assistant", transcript: "There are forty-three test files." },
    });
    expect(onTranscript).toHaveBeenLastCalledWith({
      role: "assistant",
      text: "There are forty-three test files.",
      turn: 1,
      final: true,
    });
  });

  test("a muted call stays muted through the park: the fresh session is told before it connects", async () => {
    const { controller, sessions } = harness({
      parkAfterSeconds: 20,
      idleHangupSeconds: 0,
    });
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
    const { controller, sessions } = harness({
      parkAfterSeconds: 20,
      idleHangupSeconds: 0,
    });
    await controller.start();
    await settle();
    expect(sessions[0]!.sent.length).toBe(
      chunkLiveContext(sessions[0]!.options.instructions).length,
    );
    sessions[0]!.emit(DELEGATION);
    // the timer fires and the park starts; the agent settles before it has finished
    await vi.advanceTimersByTimeAsync(20_000);
    controller.handleAgentMessage(FINAL);
    controller.handleAgentSettled();
    await settle();
    expect(sessions).toHaveLength(2);
    expect(sessions[1]!.calls.at(-1)).toBe("playback:false");
    expect(sessions[1]!.sent.slice(0, -1)).toEqual(
      chunkLiveContext(sessions[1]!.options.instructions).map((text) => ({
        type: "session.context.append",
        channel: "commentary",
        content: [{ type: "input_text", text }],
      })),
    );
    expect(sentAfterMemory(sessions[1]!)).toHaveLength(1);
    expect(sentAfterMemory(sessions[1]!)[0]).toMatchObject({ channel: "speakable" });

    // A later resume also sends memory before any new speech.
    sessions[1]!.options.callbacks.onLevels(0.1, 0);
    sessions[1]!.emit({ type: "input_transcript.added", item: { text: "Thanks. Count again." } });
    sessions[1]!.emit(DELEGATION);
    await seconds(20);
    controller.resume();
    await settle();
    expect(sessions).toHaveLength(3);
    expect(sessions[2]!.sent.length).toBe(
      chunkLiveContext(sessions[2]!.options.instructions).length,
    );
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
