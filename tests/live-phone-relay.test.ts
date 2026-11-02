import type { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { connectedPair } from "../src/live/bridge/socket.ts";
import {
  type LivePhoneCall,
  type LivePhoneRelayOptions,
  relayLivePhoneCall,
} from "../src/live/phone/relay.ts";
import { MAX_FRAME_BYTES } from "../src/live/remote/protocol.ts";

type Frame = Record<string, unknown> & { type: string };

const line = (body: Record<string, unknown>, v = 1) => `${JSON.stringify({ v, ...body })}\n`;
const text = (body: Record<string, unknown>) => JSON.stringify({ v: 1, ...body });

/** Pi's end of the connection: what the relay wrote to it, and what it can say back. */
function fakePi() {
  // the pair the endpoint hands the relay: a bare duplexPair() would not close one end with the other
  const [relaySide, piSide] = connectedPair();
  const lines: Frame[] = [];
  let buffered = "";
  let hungUp = false;
  piSide.setEncoding("utf8");
  piSide.on("data", (chunk: string) => {
    buffered += chunk;
    for (let end = buffered.indexOf("\n"); end !== -1; end = buffered.indexOf("\n")) {
      lines.push(JSON.parse(buffered.slice(0, end)) as Frame);
      buffered = buffered.slice(end + 1);
    }
  });
  piSide.on("end", () => (hungUp = true));
  piSide.on("close", () => (hungUp = true));
  piSide.on("error", () => undefined);
  return {
    relaySide,
    piSide,
    lines,
    get hungUp() {
      return hungUp;
    },
    say: (body: Record<string, unknown>) => piSide.write(line(body)),
    raw: (data: string | Buffer) => piSide.write(data),
    ready: (extra: Record<string, unknown> = {}) =>
      piSide.write(line({ type: "ready", pid: 42, busy: false, ...extra })),
  };
}

/** The phone's WebSocket as the relay sees it. */
function fakePhone() {
  const sent: Frame[] = [];
  let closes = 0;
  let pings = 0;
  return {
    sent,
    get closes() {
      return closes;
    },
    get pings() {
      return pings;
    },
    send: (data: string) => void sent.push(JSON.parse(data) as Frame),
    close: () => void closes++,
    ping: () => void pings++,
  };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

function start(
  options: LivePhoneRelayOptions = {},
  connect?: (pi: ReturnType<typeof fakePi>) => Promise<Duplex>,
) {
  const pi = fakePi();
  const phone = fakePhone();
  const ends: Array<Parameters<NonNullable<LivePhoneRelayOptions["onEnd"]>>[0]> = [];
  const call = relayLivePhoneCall(
    phone,
    () => (connect ? connect(pi) : Promise.resolve(pi.relaySide)),
    {
      expectPid: 42,
      ...options,
      onEnd: (end) => ends.push(end),
    },
  );
  return { pi, phone, call, ends };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a call that goes through", () => {
  test("holds the phone's hello until Pi is ready, then sends start and the hello", async () => {
    const { pi, phone, call } = start();
    call.message(text({ type: "hello" }));
    await settle();
    expect(pi.lines).toEqual([]);
    pi.ready({ pane: "w1:p1" });
    await settle();
    expect(pi.lines).toEqual([
      { v: 1, type: "start" },
      { v: 1, type: "hello" },
    ]);
    expect(phone.sent).toEqual([]);
    expect(call.ended).toBe(false);
  });

  test("starts the call in the voice the host chose", async () => {
    const { pi } = start({ voice: "vale" });
    pi.ready();
    await settle();
    expect(pi.lines).toEqual([{ v: 1, type: "start", voice: "vale" }]);
  });

  test("relays frames both ways, checked and re-serialized", async () => {
    const { pi, phone, call } = start();
    pi.ready();
    await settle();
    call.message(text({ type: "response", id: 1, ok: true, sdp: "v=0" }));
    call.message(`  ${text({ type: "levels", input: 0.5, output: 0 })}  `);
    pi.say({ type: "request", id: 1, method: "open" });
    pi.say({ type: "phase", phase: "listening" });
    pi.say({ type: "transcript", role: "user", text: "hi", turn: 1, final: false });
    await settle();
    expect(pi.lines.slice(1)).toEqual([
      { v: 1, type: "response", id: 1, ok: true, sdp: "v=0" },
      { v: 1, type: "levels", input: 0.5, output: 0 },
    ]);
    expect(phone.sent).toEqual([
      { v: 1, type: "request", id: 1, method: "open" },
      { v: 1, type: "phase", phase: "listening" },
      { v: 1, type: "transcript", role: "user", text: "hi", turn: 1, final: false },
    ]);
  });

  test("reads Pi's lines however its writes are cut up", async () => {
    const { pi, phone } = start();
    // the ready arrives with the next frame in the same read, and a character is split in two
    const frames = Buffer.from(
      line({ type: "ready", pid: 42, busy: false }) +
        line({ type: "transcript", role: "assistant", text: "5 €", turn: 2, final: true }) +
        line({ type: "ping" }),
    );
    const cut = frames.indexOf(Buffer.from("€")) + 1;
    pi.raw(frames.subarray(0, cut));
    await settle();
    pi.raw(frames.subarray(cut, cut + 7));
    await settle();
    pi.raw(frames.subarray(cut + 7));
    await settle();
    expect(phone.sent).toEqual([
      { v: 1, type: "transcript", role: "assistant", text: "5 €", turn: 2, final: true },
      { v: 1, type: "ping" },
    ]);
  });

  test("forwards stop and mute to Pi, which answers with ended", async () => {
    const { pi, phone, call, ends } = start();
    pi.ready();
    await settle();
    call.message(text({ type: "set-muted", muted: true }));
    call.message(text({ type: "stop" }));
    await settle();
    expect(pi.lines.slice(1)).toEqual([
      { v: 1, type: "set-muted", muted: true },
      { v: 1, type: "stop" },
    ]);
    expect(call.ended).toBe(false);
    pi.say({ type: "ended" });
    await settle();
    expect(phone.sent).toEqual([{ v: 1, type: "ended" }]);
    expect(phone.closes).toBe(1);
    expect(call.ended).toBe(true);
    expect(pi.hungUp).toBe(true);
    expect(ends).toEqual([{}]);
  });

  test("ends with Pi's error when Pi says why", async () => {
    const { pi, phone, ends } = start();
    pi.ready();
    await settle();
    pi.say({ type: "ended", error: "Codex live signaling failed (401)" });
    await settle();
    expect(phone.sent).toEqual([
      { v: 1, type: "ended", error: "Codex live signaling failed (401)" },
    ]);
    expect(ends).toEqual([{ error: "Codex live signaling failed (401)" }]);
  });
});

describe("the frames held while Pi is reached", () => {
  test("keeps sixteen, in order", async () => {
    const { pi, call } = start();
    for (let id = 0; id < 16; id += 1) call.message(text({ type: "response", id, ok: true }));
    await settle();
    expect(call.ended).toBe(false);
    pi.ready();
    await settle();
    expect(pi.lines.map((frame) => frame.type)).toEqual(["start", ...Array(16).fill("response")]);
    expect(pi.lines.slice(1).map((frame) => frame.id)).toEqual([...Array(16).keys()]);
  });

  test("ends quietly on the seventeenth", async () => {
    const { pi, phone, call, ends } = start();
    for (let id = 0; id < 17; id += 1) call.message(text({ type: "response", id, ok: true }));
    await settle();
    expect(call.ended).toBe(true);
    expect(phone.sent).toEqual([]);
    expect(phone.closes).toBe(1);
    expect(ends).toEqual([{}]);
    pi.ready();
    await settle();
    expect(pi.lines).toEqual([]);
  });
});

describe("a call that cannot start", () => {
  test("tells the phone it is busy when Pi's ready says so", async () => {
    const { pi, phone, call, ends } = start();
    call.message(text({ type: "hello" }));
    pi.ready({ busy: true });
    await settle();
    expect(phone.sent).toEqual([{ v: 1, type: "ended", code: "busy" }]);
    expect(phone.closes).toBe(1);
    expect(pi.lines).toEqual([]);
    expect(pi.hungUp).toBe(true);
    expect(ends).toEqual([{ code: "busy" }]);
  });

  test("is unavailable when Pi does not say ready in two seconds", async () => {
    const { pi, phone, ends } = start();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(phone.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(phone.sent).toEqual([{ v: 1, type: "ended", code: "unavailable" }]);
    expect(pi.hungUp).toBe(true);
    expect(ends).toEqual([{ code: "unavailable" }]);
  });

  test("waits as long as readyMs says", async () => {
    const { phone, pi } = start({ readyMs: 50 });
    await vi.advanceTimersByTimeAsync(49);
    expect(phone.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(phone.sent).toEqual([{ v: 1, type: "ended", code: "unavailable" }]);
    expect(pi.hungUp).toBe(true);
  });

  test("is unavailable when there is no connection to Pi", async () => {
    const { phone, ends } = start({}, () => Promise.reject(new Error("no pane")));
    await settle();
    expect(phone.sent).toEqual([{ v: 1, type: "ended", code: "unavailable" }]);
    expect(phone.closes).toBe(1);
    expect(ends).toEqual([{ code: "unavailable" }]);
  });

  test("is unavailable when what answers is not a ready, or not a frame", async () => {
    for (const first of [
      line({ type: "phase", phase: "listening" }),
      "garbage\n",
      line({ type: "ready", pid: 42 }),
    ]) {
      const { pi, phone } = start();
      pi.raw(first);
      await settle();
      expect(phone.sent).toEqual([{ v: 1, type: "ended", code: "unavailable" }]);
      expect(pi.lines).toEqual([]);
    }
  });

  test("is unavailable when it reached another process than it meant to", async () => {
    const { pi, phone } = start({ expectPid: 43 });
    pi.ready();
    await settle();
    expect(phone.sent).toEqual([{ v: 1, type: "ended", code: "unavailable" }]);
    expect(pi.lines).toEqual([]);
  });

  test("is unavailable when ready names another pane, and accepts one that names none", async () => {
    const wrong = start({ expectPane: "w1:p1" });
    wrong.pi.ready({ pane: "w1:p2" });
    await settle();
    expect(wrong.phone.sent).toEqual([{ v: 1, type: "ended", code: "unavailable" }]);

    const right = start({ expectPane: "w1:p1" });
    right.pi.ready({ pane: "w1:p1" });
    await settle();
    expect(right.pi.lines).toEqual([{ v: 1, type: "start" }]);

    const none = start({ expectPane: "w1:p1" });
    none.pi.ready();
    await settle();
    expect(none.pi.lines).toEqual([{ v: 1, type: "start" }]);
  });

  test("destroys a connection that arrives after the call ended", async () => {
    let connected!: (stream: Duplex) => void;
    const { pi, call } = start({}, () => new Promise<Duplex>((resolve) => (connected = resolve)));
    call.end();
    connected(pi.relaySide);
    await settle();
    expect(pi.hungUp).toBe(true);
  });
});

describe("a call that breaks", () => {
  async function live() {
    const harness = start();
    harness.pi.ready();
    await settle();
    return harness;
  }

  test("is closed on a second ready", async () => {
    const { pi, phone, ends } = await live();
    pi.ready();
    await settle();
    expect(phone.sent).toEqual([{ v: 1, type: "ended", code: "closed" }]);
    expect(phone.closes).toBe(1);
    expect(pi.hungUp).toBe(true);
    expect(ends).toEqual([{ code: "closed" }]);
  });

  test("is closed on a frame Pi may not send, and does not pass it on", async () => {
    for (const bad of [
      "garbage\n",
      line({ type: "hello" }),
      line({ type: "ping", extra: 1 }),
      line({ type: "ping" }, 2),
    ]) {
      const { pi, phone } = await live();
      pi.raw(bad);
      await settle();
      expect(phone.sent).toEqual([{ v: 1, type: "ended", code: "closed" }]);
    }
  });

  test("is closed on a line that never ends", async () => {
    const { pi, phone } = await live();
    pi.raw(Buffer.alloc(MAX_FRAME_BYTES + 1, 0x61));
    await settle();
    expect(phone.sent).toEqual([{ v: 1, type: "ended", code: "closed" }]);
  });

  test("is closed when Pi hangs up without saying ended", async () => {
    const { pi, phone, ends } = await live();
    pi.piSide.end();
    await settle();
    expect(phone.sent).toEqual([{ v: 1, type: "ended", code: "closed" }]);
    expect(ends).toEqual([{ code: "closed" }]);
  });

  test("is closed when Pi's connection is destroyed", async () => {
    const { pi, phone } = await live();
    pi.piSide.destroy();
    await settle();
    expect(phone.sent).toEqual([{ v: 1, type: "ended", code: "closed" }]);
  });

  test("ends quietly when the phone sends binary data", async () => {
    const { pi, phone, call, ends } = await live();
    call.message(new Uint8Array([1, 2, 3]));
    await settle();
    expect(phone.sent).toEqual([]);
    expect(phone.closes).toBe(1);
    expect(pi.hungUp).toBe(true);
    // Pi hears nothing of it but the end
    expect(pi.lines).toEqual([{ v: 1, type: "start" }]);
    expect(ends).toEqual([{}]);
  });

  test("ends quietly on a frame the phone may not send", async () => {
    for (const bad of [
      text({ type: "start" }),
      text({ type: "ready", pid: 42, busy: false }),
      text({ type: "ended" }),
      text({ type: "hello", extra: 1 }),
      text({ type: "tool-call" }),
      JSON.stringify({ v: 2, type: "hello" }),
      "garbage",
      "x".repeat(MAX_FRAME_BYTES + 1),
    ]) {
      const { pi, phone, call, ends } = await live();
      call.message(bad);
      await settle();
      expect(call.ended).toBe(true);
      expect(phone.sent).toEqual([]);
      expect(phone.closes).toBe(1);
      expect(pi.lines).toEqual([{ v: 1, type: "start" }]);
      expect(ends).toEqual([{}]);
    }
  });

  test("ends quietly when the phone's socket closes", async () => {
    const { pi, phone, call, ends } = await live();
    call.closed();
    await settle();
    expect(phone.sent).toEqual([]);
    expect(pi.hungUp).toBe(true);
    expect(ends).toEqual([{}]);
  });

  test("prints nothing, whatever the frames say", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const { pi, call } = await live();
    call.message(text({ type: "response", id: 1, ok: true, sdp: "v=0 c=IN IP4 10.1.2.3" }));
    call.message(text({ type: "response", id: 2, ok: true, sdp: "v=0", extra: "10.1.2.3" }));
    pi.say({ type: "request", id: 1, method: "acceptAnswer", sdp: "v=0 c=IN IP4 10.1.2.3" });
    pi.raw("10.1.2.3\n");
    await settle();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe("the host's frames", () => {
  const hostFrames = ["tool-call", "tool-result"];

  test("hands the host a phone frame of a type it named, and keeps it from Pi", async () => {
    const onHostFrame = vi.fn();
    const { pi, call } = start({ hostFrames, onHostFrame });
    pi.ready();
    await settle();
    call.message(text({ type: "tool-result", id: 1, ok: true, result: { any: ["thing"] } }));
    expect(onHostFrame).toHaveBeenCalledWith({
      type: "tool-result",
      id: 1,
      ok: true,
      result: { any: ["thing"] },
    });
    await settle();
    expect(pi.lines).toEqual([{ v: 1, type: "start" }]);
    expect(call.ended).toBe(false);
  });

  test("sends the phone a host frame", async () => {
    const { pi, phone, call } = start({ hostFrames });
    pi.ready();
    await settle();
    expect(call.send({ type: "tool-call", id: 7, name: "open", args: { app: "maps" } })).toBe(true);
    expect(phone.sent).toEqual([
      { v: 1, type: "tool-call", id: 7, name: "open", args: { app: "maps" } },
    ]);
    expect(pi.lines).toEqual([{ v: 1, type: "start" }]);
  });

  test("refuses to send a type it did not name, a call frame, or a frame it cannot encode", async () => {
    const { pi, phone, call } = start({ hostFrames });
    pi.ready();
    await settle();
    expect(call.send({ type: "other" })).toBe(false);
    expect(call.send({ type: "phase", phase: "listening" })).toBe(false);
    expect(call.send({ type: "tool-call", blob: "a".repeat(MAX_FRAME_BYTES) })).toBe(false);
    const cycle: Record<string, unknown> = { type: "tool-call" };
    cycle.self = cycle;
    expect(call.send(cycle as { type: string })).toBe(false);
    expect(phone.sent).toEqual([]);
    expect(call.ended).toBe(false);
  });

  test("refuses to send once the call is over", async () => {
    const { pi, phone, call } = start({ hostFrames });
    pi.ready();
    await settle();
    call.end();
    phone.sent.length = 0;
    expect(call.send({ type: "tool-call", id: 1 })).toBe(false);
    expect(phone.sent).toEqual([]);
  });

  test("ends the call on a phone frame that is not a call frame and not the host's", async () => {
    const { pi, phone, call } = start({ hostFrames });
    pi.ready();
    await settle();
    call.message(text({ type: "tool-use" }));
    expect(call.ended).toBe(true);
    expect(phone.sent).toEqual([]);
  });

  test("ends the call on a host frame that is not a v1 object", async () => {
    for (const bad of [JSON.stringify({ v: 2, type: "tool-result" }), '["tool-result"]', "nope"]) {
      const onHostFrame = vi.fn();
      const { pi, call } = start({ hostFrames, onHostFrame });
      pi.ready();
      await settle();
      call.message(bad);
      expect(call.ended).toBe(true);
      expect(onHostFrame).not.toHaveBeenCalled();
    }
  });

  test("holds a host frame with the rest while Pi is reached", async () => {
    const seen: string[] = [];
    const { pi, call } = start({ hostFrames, onHostFrame: (frame) => seen.push(frame.type) });
    call.message(text({ type: "hello" }));
    call.message(text({ type: "tool-result", id: 1 }));
    await settle();
    expect(seen).toEqual([]);
    pi.ready();
    await settle();
    expect(seen).toEqual(["tool-result"]);
    expect(pi.lines.map((frame) => frame.type)).toEqual(["start", "hello"]);
  });

  test("keeps going when the host's handler throws", async () => {
    const { pi, call } = start({
      hostFrames,
      onHostFrame: () => {
        throw new Error("boom");
      },
    });
    pi.ready();
    await settle();
    call.message(text({ type: "tool-result", id: 1 }));
    expect(call.ended).toBe(false);
  });

  test("throws for a host frame type that a call frame already has", () => {
    for (const type of ["levels", "ended", "start", "request", "stop"]) {
      const connect = vi.fn();
      expect(() =>
        relayLivePhoneCall(fakePhone(), connect, { hostFrames: ["tool-call", type] }),
      ).toThrow(type);
      expect(connect).not.toHaveBeenCalled();
    }
  });

  test("treats a type as a call frame when no host frames were named", async () => {
    const { pi, call } = start();
    pi.ready();
    await settle();
    call.message(text({ type: "tool-result" }));
    expect(call.ended).toBe(true);
    expect(call.send({ type: "tool-call" })).toBe(false);
  });
});

describe("the heartbeat", () => {
  test("pings the phone every five seconds while it answers", async () => {
    const { pi, phone, call } = start();
    pi.ready();
    await settle();
    for (let second = 0; second < 60; second += 5) {
      await vi.advanceTimersByTimeAsync(5_000);
      call.pong();
    }
    expect(phone.pings).toBe(12);
    expect(call.ended).toBe(false);
  });

  test("counts any message from the phone as a sign of life", async () => {
    const { pi, call } = start();
    pi.ready();
    await settle();
    for (let second = 0; second < 60; second += 10) {
      await vi.advanceTimersByTimeAsync(10_000);
      call.message(text({ type: "levels", input: 0, output: 0 }));
    }
    expect(call.ended).toBe(false);
  });

  test("ends the call twenty seconds after the last sign of life", async () => {
    const { pi, phone, call, ends } = start();
    pi.ready();
    await settle();
    await vi.advanceTimersByTimeAsync(10_000);
    call.pong();
    await vi.advanceTimersByTimeAsync(20_000);
    // the beats fall every five seconds: 30 s is exactly twenty after the pong, 35 s is past it
    expect(call.ended).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(call.ended).toBe(true);
    expect(phone.sent).toEqual([{ v: 1, type: "ended", code: "closed" }]);
    expect(phone.closes).toBe(1);
    expect(pi.hungUp).toBe(true);
    expect(ends).toEqual([{ code: "closed" }]);
  });

  test("also watches a phone that Pi has not answered yet", async () => {
    const { phone } = start({ readyMs: 60_000 });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(phone.sent).toEqual([{ v: 1, type: "ended", code: "closed" }]);
  });

  test("stops pinging once the call is over", async () => {
    const { pi, phone, call } = start();
    pi.ready();
    await settle();
    call.end();
    const pings = phone.pings;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(phone.pings).toBe(pings);
  });

  test("takes its clock from the options", async () => {
    let now = 0;
    const beats: Array<() => void> = [];
    const { pi, phone, call } = start({
      now: () => now,
      every: (run) => {
        beats.push(run);
        return () => undefined;
      },
    });
    pi.ready();
    await settle();
    now = 20_000;
    beats[0]!();
    expect(call.ended).toBe(false);
    expect(phone.pings).toBe(1);
    now = 20_001;
    beats[0]!();
    expect(call.ended).toBe(true);
  });
});

describe("ending it from the host", () => {
  test("tells the phone the call was closed, once", async () => {
    const { pi, phone, call, ends } = start();
    pi.ready();
    await settle();
    call.end();
    call.end();
    call.closed();
    call.message(text({ type: "stop" }));
    await settle();
    expect(phone.sent).toEqual([{ v: 1, type: "ended", code: "closed" }]);
    expect(phone.closes).toBe(1);
    expect(pi.hungUp).toBe(true);
    expect(call.ended).toBe(true);
    expect(ends).toEqual([{ code: "closed" }]);
  });

  test("works before Pi has answered", async () => {
    const { pi, phone, call, ends } = start();
    call.end();
    await settle();
    expect(phone.sent).toEqual([{ v: 1, type: "ended", code: "closed" }]);
    expect(ends).toEqual([{ code: "closed" }]);
    pi.ready();
    await settle();
    expect(pi.lines).toEqual([]);
  });

  test("ends once however many things go wrong together", async () => {
    const { pi, phone, call, ends } = start();
    pi.ready();
    await settle();
    pi.say({ type: "ended" });
    pi.piSide.end();
    call.message(new Uint8Array(1));
    call.closed();
    call.end();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ends).toHaveLength(1);
    expect(phone.closes).toBe(1);
  });

  test("survives a phone socket that throws and a handler that throws", async () => {
    const pi = fakePi();
    const phone = fakePhone();
    const call: LivePhoneCall = relayLivePhoneCall(
      {
        send: () => {
          throw new Error("socket is closing");
        },
        close: () => {
          throw new Error("socket is closing");
        },
        ping: phone.ping,
      },
      () => Promise.resolve(pi.relaySide),
      {
        expectPid: 42,
        onEnd: () => {
          throw new Error("boom");
        },
      },
    );
    pi.ready();
    await settle();
    pi.say({ type: "ended" });
    await settle();
    expect(call.ended).toBe(true);
    expect(pi.hungUp).toBe(true);
  });
});
