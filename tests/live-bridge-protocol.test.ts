import { describe, expect, test } from "vitest";
import {
  encodeBridgeFrame,
  isBridgeControl,
  MAX_ENDED_ERROR_LENGTH,
  MAX_TRANSCRIPT_LENGTH,
  parseBridgeInbound,
} from "../src/live/bridge/protocol.ts";
import {
  FrameDecoder,
  MAX_FRAME_BYTES,
  ProtocolError,
  ProtocolVersionError,
  parseHostFrame,
} from "../src/live/remote/protocol.ts";

const frame = (body: Record<string, unknown>, v = 1) => JSON.stringify({ v, ...body });

describe("parseBridgeInbound", () => {
  test("accepts the three control frames the phone may send", () => {
    expect(parseBridgeInbound(frame({ type: "start" }))).toEqual({ type: "start" });
    expect(parseBridgeInbound(frame({ type: "start", voice: "arbor" }))).toEqual({
      type: "start",
      voice: "arbor",
    });
    expect(() => parseBridgeInbound(frame({ type: "start", voice: "alloy" }))).toThrow(
      ProtocolError,
    );
    expect(parseBridgeInbound(frame({ type: "stop" }))).toEqual({ type: "stop" });
    expect(parseBridgeInbound(frame({ type: "set-muted", muted: true }))).toEqual({
      type: "set-muted",
      muted: true,
    });
  });

  test("hands every media frame to the remote host parser unchanged", () => {
    for (const body of [
      { type: "hello" },
      { type: "response", id: 3, ok: true, sdp: "v=0" },
      { type: "response", id: 4, ok: false, error: "no" },
      { type: "event", payload: "{}" },
      { type: "levels", input: 0.2, output: 0 },
      { type: "failure", message: "mic lost" },
    ]) {
      expect(parseBridgeInbound(frame(body))).toEqual(parseHostFrame(frame(body)));
    }
  });

  test("keeps control frames away from the media parser", () => {
    for (const type of ["start", "stop"]) {
      expect(() => parseHostFrame(frame({ type }))).toThrow(ProtocolError);
    }
    expect(isBridgeControl(parseBridgeInbound(frame({ type: "stop" })))).toBe(true);
    expect(isBridgeControl(parseBridgeInbound(frame({ type: "hello" })))).toBe(false);
  });

  test("rejects frames the phone has no business sending", () => {
    for (const body of [
      { type: "ready", pid: 1, busy: false },
      { type: "request", id: 1, method: "open" },
      { type: "phase", phase: "listening" },
      { type: "ended" },
      { type: "mystery" },
    ]) {
      expect(() => parseBridgeInbound(frame(body))).toThrow(ProtocolError);
    }
  });

  test("rejects an unknown field, so a credential cannot ride along", () => {
    expect(() => parseBridgeInbound(frame({ type: "start", token: "x" }))).toThrow(
      "Unexpected field",
    );
    expect(() => parseBridgeInbound(frame({ type: "hello", accountId: "x" }))).toThrow(
      "Unexpected field",
    );
    expect(() => parseBridgeInbound(frame({ type: "set-muted", muted: true, extra: 1 }))).toThrow(
      "Unexpected field",
    );
  });

  test("rejects the wrong version, a missing field and out-of-range values", () => {
    expect(() => parseBridgeInbound(frame({ type: "start" }, 2))).toThrow(ProtocolVersionError);
    expect(() => parseBridgeInbound(JSON.stringify({ type: "start" }))).toThrow(ProtocolError);
    expect(() => parseBridgeInbound(frame({ type: "set-muted" }))).toThrow("missing muted");
    expect(() => parseBridgeInbound(frame({ type: "set-muted", muted: "yes" }))).toThrow(
      "invalid muted",
    );
    expect(() => parseBridgeInbound(frame({ type: "levels", input: 1.5, output: 0 }))).toThrow(
      "invalid input",
    );
    expect(() => parseBridgeInbound("not json")).toThrow(ProtocolError);
  });

  test("a frame decoder over it refuses an oversized line", () => {
    const decoder = new FrameDecoder(parseBridgeInbound);
    expect(() => decoder.push("x".repeat(MAX_FRAME_BYTES + 1))).toThrow("too large");
  });
});

describe("encodeBridgeFrame", () => {
  const decoded = (text: string) => {
    expect(text.endsWith("\n")).toBe(true);
    return JSON.parse(text) as Record<string, unknown>;
  };

  test("versions every frame and ends it with a newline", () => {
    expect(decoded(encodeBridgeFrame({ type: "ready", pid: 7, pane: "p_1", busy: false }))).toEqual(
      {
        v: 1,
        type: "ready",
        pid: 7,
        pane: "p_1",
        busy: false,
      },
    );
    expect(decoded(encodeBridgeFrame({ type: "phase", phase: "listening" }))).toEqual({
      v: 1,
      type: "phase",
      phase: "listening",
    });
    expect(decoded(encodeBridgeFrame({ type: "transcript-clear" }))).toEqual({
      v: 1,
      type: "transcript-clear",
    });
    expect(decoded(encodeBridgeFrame({ type: "mute", muted: true }))).toEqual({
      v: 1,
      type: "mute",
      muted: true,
    });
  });

  test("bounds and cleans transcript text, keeping the latest words", () => {
    const text = `\u001b[31mhi\u001b[0m\u0007 there\n${"a".repeat(MAX_TRANSCRIPT_LENGTH * 2)}`;
    const out = decoded(
      encodeBridgeFrame({ type: "transcript", role: "assistant", text, turn: 2, final: false }),
    );
    expect(out.role).toBe("assistant");
    expect(out.turn).toBe(2);
    expect(String(out.text).length).toBeLessThanOrEqual(MAX_TRANSCRIPT_LENGTH);
    expect(String(out.text)).toMatch(/^a+$/);
    const small = decoded(
      encodeBridgeFrame({
        type: "transcript",
        role: "user",
        text: "\u001b[31mhi\u0007  there\n",
        turn: 1,
        final: true,
      }),
    );
    expect(small.text).toBe("hi there");
  });

  test("bounds ended.error and strips control characters", () => {
    const out = decoded(
      encodeBridgeFrame({ type: "ended", error: `boom\u0000\u001b[2J ${"x".repeat(5000)}` }),
    );
    expect(String(out.error).length).toBeLessThanOrEqual(MAX_ENDED_ERROR_LENGTH);
    expect([...String(out.error)].every((character) => character.charCodeAt(0) > 31)).toBe(true);
    expect(decoded(encodeBridgeFrame({ type: "ended" }))).toEqual({ v: 1, type: "ended" });
  });

  test("passes the media requests through the existing encoder", () => {
    expect(decoded(encodeBridgeFrame({ type: "request", id: 1, method: "open" }))).toEqual({
      v: 1,
      type: "request",
      id: 1,
      method: "open",
    });
  });
});
