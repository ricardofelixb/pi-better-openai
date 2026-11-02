import { describe, expect, test } from "vitest";
import {
  CALL_FRAME_TYPES,
  encodePhoneFrame,
  hostFrameTypes,
  parsePhoneFrame,
  parsePhoneHostFrame,
  parsePiLine,
} from "../src/live/phone/protocol.ts";
import {
  MAX_FRAME_BYTES,
  ProtocolError,
  ProtocolVersionError,
} from "../src/live/remote/protocol.ts";

const frame = (body: Record<string, unknown>, v = 1) => JSON.stringify({ v, ...body });

const PHONE_FRAMES: Array<Record<string, unknown>> = [
  { type: "hello" },
  { type: "response", id: 3, ok: true },
  { type: "response", id: 3, ok: true, sdp: "v=0" },
  { type: "response", id: 4, ok: false, error: "no" },
  { type: "event", payload: "{}" },
  { type: "levels", input: 0.2, output: 0 },
  { type: "failure", message: "mic lost" },
  { type: "stop" },
  { type: "set-muted", muted: true },
];

const PI_FRAMES: Array<Record<string, unknown>> = [
  { type: "ready", pid: 42, busy: false },
  { type: "ready", pid: 42, pane: "w1:p2", busy: true },
  { type: "request", id: 1, method: "open" },
  { type: "request", id: 2, method: "createOffer" },
  { type: "request", id: 3, method: "acceptAnswer", sdp: "v=0" },
  { type: "request", id: 4, method: "waitForOpen" },
  { type: "request", id: 4, method: "waitForOpen", timeoutMs: 10_000 },
  { type: "activate" },
  { type: "mute", muted: false },
  { type: "ping" },
  { type: "close" },
  { type: "phase", phase: "listening" },
  { type: "transcript", role: "assistant", text: "Hi.", turn: 2, final: false },
  { type: "transcript", role: "user", text: "", turn: 0, final: true },
  { type: "transcript-clear" },
  { type: "ended" },
  { type: "ended", error: "Codex live signaling failed (401)" },
];

describe("parsePhoneFrame", () => {
  test("accepts every frame the phone may send and returns it without the version", () => {
    for (const body of PHONE_FRAMES) expect(parsePhoneFrame(frame(body))).toEqual(body);
  });

  test("round-trips through encodePhoneFrame", () => {
    for (const body of PHONE_FRAMES) {
      expect(parsePhoneFrame(encodePhoneFrame(parsePhoneFrame(frame(body))))).toEqual(body);
    }
  });

  test("refuses start, which only the relay may send", () => {
    expect(() => parsePhoneFrame(frame({ type: "start" }))).toThrow(ProtocolError);
    expect(() => parsePhoneFrame(frame({ type: "start", voice: "vale" }))).toThrow(ProtocolError);
  });

  test("refuses the frames only Pi sends", () => {
    for (const body of PI_FRAMES) expect(() => parsePhoneFrame(frame(body))).toThrow(ProtocolError);
  });

  test("refuses unknown types, unknown fields and bad values", () => {
    for (const bad of [
      frame({ type: "tool-call", id: 1 }),
      frame({ type: "hello", extra: 1 }),
      frame({ type: "stop", extra: true }),
      frame({ type: "levels", input: 1.5, output: 0 }),
      frame({ type: "levels", input: 0 }),
      frame({ type: "response", id: 1, ok: false }),
      frame({ type: "response", id: -1, ok: true }),
      frame({ type: "set-muted", muted: "yes" }),
      frame({ type: "event", payload: "" }),
      frame({}),
      "[]",
      "null",
      "garbage",
    ]) {
      expect(() => parsePhoneFrame(bad)).toThrow(ProtocolError);
    }
  });

  test("refuses another version", () => {
    expect(() => parsePhoneFrame(frame({ type: "hello" }, 2))).toThrow(ProtocolVersionError);
    expect(() => parsePhoneFrame(JSON.stringify({ type: "hello" }))).toThrow(ProtocolError);
  });

  test("bounds the frame at one MiB, to the byte", () => {
    const overhead = Buffer.byteLength(frame({ type: "event", payload: "" }));
    const fits = frame({ type: "event", payload: "a".repeat(MAX_FRAME_BYTES - overhead) });
    expect(Buffer.byteLength(fits)).toBe(MAX_FRAME_BYTES);
    expect(parsePhoneFrame(fits)).toMatchObject({ type: "event" });
    expect(() =>
      parsePhoneFrame(
        frame({ type: "event", payload: "a".repeat(MAX_FRAME_BYTES - overhead + 1) }),
      ),
    ).toThrow("Frame is too large.");
    // bytes, not characters: three-byte characters overflow sooner than their count suggests
    expect(() =>
      parsePhoneFrame(frame({ type: "event", payload: "€".repeat(MAX_FRAME_BYTES / 3) })),
    ).toThrow("Frame is too large.");
  });

  test("never repeats the offending content in its error", () => {
    const secret = "sdp-with-an-address-10.1.2.3";
    try {
      parsePhoneFrame(frame({ type: "response", id: 1, ok: true, sdp: secret, extra: 1 }));
      expect.unreachable();
    } catch (cause) {
      expect((cause as Error).message).not.toContain(secret);
    }
  });
});

describe("parsePiLine", () => {
  test("accepts every frame Pi may send, ready included", () => {
    for (const body of PI_FRAMES) expect(parsePiLine(frame(body))).toEqual(body);
  });

  test("refuses the frames only the phone sends, and start", () => {
    for (const body of [...PHONE_FRAMES, { type: "start" }]) {
      expect(() => parsePiLine(frame(body))).toThrow(ProtocolError);
    }
  });

  test("refuses bad shapes", () => {
    for (const bad of [
      frame({ type: "ready", pid: 42 }),
      frame({ type: "ready", pid: 0, busy: false }),
      frame({ type: "ready", pid: 1.5, busy: false }),
      frame({ type: "ready", pid: 42, pane: "", busy: false }),
      frame({ type: "ready", pid: 42, pane: "p".repeat(129), busy: false }),
      frame({ type: "ready", pid: 42, busy: false, node: "n" }),
      frame({ type: "phase", phase: "dreaming" }),
      frame({ type: "phase" }),
      frame({ type: "transcript", role: "system", text: "x", turn: 1, final: true }),
      frame({ type: "transcript", role: "user", text: "x", turn: -1, final: true }),
      frame({ type: "transcript", role: "user", text: "x".repeat(4_097), turn: 1, final: true }),
      frame({ type: "transcript", role: "user", text: "x", turn: 1 }),
      frame({ type: "transcript-clear", extra: 1 }),
      frame({ type: "ended", code: "closed" }),
      frame({ type: "ended", error: "x".repeat(2_049) }),
      frame({ type: "request", id: 1, method: "teleport" }),
      frame({ type: "request", id: 1, method: "acceptAnswer" }),
      frame({ type: "mute" }),
      frame({ type: "ping", extra: 1 }),
    ]) {
      expect(() => parsePiLine(bad)).toThrow(ProtocolError);
    }
  });

  test("accepts what Pi's own encoder writes at its limits", () => {
    expect(
      parsePiLine(
        frame({ type: "transcript", role: "user", text: "x".repeat(4_096), turn: 1, final: true }),
      ),
    ).toMatchObject({ type: "transcript" });
    expect(parsePiLine(frame({ type: "ended", error: "x".repeat(2_048) }))).toMatchObject({
      type: "ended",
    });
    expect(parsePiLine(frame({ type: "ended", error: "" }))).toEqual({ type: "ended", error: "" });
  });

  test("refuses another version and an oversized line", () => {
    expect(() => parsePiLine(frame({ type: "ping" }, 2))).toThrow(ProtocolVersionError);
    expect(() =>
      parsePiLine(frame({ type: "activate", pad: "a".repeat(MAX_FRAME_BYTES) })),
    ).toThrow("Frame is too large.");
  });
});

describe("encodePhoneFrame", () => {
  test("writes one JSON object with the version and no newline", () => {
    expect(encodePhoneFrame({ type: "ping" })).toBe('{"type":"ping","v":1}');
    expect(JSON.parse(encodePhoneFrame({ type: "ended", code: "busy" }))).toEqual({
      v: 1,
      type: "ended",
      code: "busy",
    });
    expect(JSON.parse(encodePhoneFrame({ type: "start", voice: "vale" }))).toEqual({
      v: 1,
      type: "start",
      voice: "vale",
    });
    expect(JSON.parse(encodePhoneFrame({ type: "start" }))).toEqual({ v: 1, type: "start" });
  });

  test("keeps a frame's text on one line", () => {
    expect(encodePhoneFrame({ type: "event", payload: "a\nb" })).not.toContain("\n");
  });

  test("stamps its own version over a host frame's", () => {
    expect(JSON.parse(encodePhoneFrame({ type: "tool-call", v: 9, id: 1 }))).toEqual({
      v: 1,
      type: "tool-call",
      id: 1,
    });
  });

  test("refuses a frame over one MiB", () => {
    expect(() =>
      encodePhoneFrame({ type: "tool-call", blob: "a".repeat(MAX_FRAME_BYTES) }),
    ).toThrow("Frame is too large.");
  });
});

describe("CALL_FRAME_TYPES", () => {
  test("names every type either side of a call can send, and start", () => {
    const names = [...PHONE_FRAMES, ...PI_FRAMES, { type: "start" }].map((body) => body.type);
    expect([...CALL_FRAME_TYPES].sort()).toEqual([...new Set(names)].sort());
  });
});

describe("hostFrameTypes", () => {
  test("is empty without host frames", () => {
    expect(hostFrameTypes(undefined).size).toBe(0);
    expect(hostFrameTypes([]).size).toBe(0);
  });

  test("returns the names the host handles", () => {
    expect([...hostFrameTypes(["tool-call", "tool-result"])]).toEqual(["tool-call", "tool-result"]);
  });

  test("throws for a name a call frame already uses, or no name at all", () => {
    for (const type of CALL_FRAME_TYPES) expect(() => hostFrameTypes([type])).toThrow(/call frame/);
    expect(() => hostFrameTypes(["tool-call", "levels"])).toThrow(/levels/);
    expect(() => hostFrameTypes([""])).toThrow(TypeError);
  });
});

describe("parsePhoneHostFrame", () => {
  const types = hostFrameTypes(["tool-result"]);

  test("checks only the version, the type, the size and that it is an object", () => {
    expect(
      parsePhoneHostFrame(
        frame({ type: "tool-result", id: 1, ok: true, result: { any: [1] } }),
        types,
      ),
    ).toEqual({ type: "tool-result", id: 1, ok: true, result: { any: [1] } });
  });

  test("refuses other types, including call frames", () => {
    for (const body of [{ type: "tool-call" }, { type: "hello" }, { type: 3 }, {}]) {
      expect(() => parsePhoneHostFrame(frame(body), types)).toThrow(ProtocolError);
    }
  });

  test("refuses another version, a non-object and an oversized frame", () => {
    expect(() => parsePhoneHostFrame(frame({ type: "tool-result" }, 2), types)).toThrow(
      ProtocolVersionError,
    );
    expect(() => parsePhoneHostFrame("[]", types)).toThrow(ProtocolError);
    expect(() => parsePhoneHostFrame("nope", types)).toThrow(ProtocolError);
    expect(() =>
      parsePhoneHostFrame(frame({ type: "tool-result", blob: "a".repeat(MAX_FRAME_BYTES) }), types),
    ).toThrow("Frame is too large.");
  });
});
