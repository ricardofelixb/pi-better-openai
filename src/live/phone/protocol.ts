/**
 * The frames of a live call between a phone and this Pi, one JSON object per WebSocket message,
 * every one carrying `v`. The shapes are the phone protocol of Ovis (`shared/pi-voice.ts` in
 * https://github.com/ricardofelixb/ovis), moved here so that Ovis and this package's own phone
 * endpoint (`./endpoint.ts`) speak one definition.
 *
 * They sit on the bridge protocol (`../bridge/protocol.ts`, which Pi's call speaks) and the remote
 * media protocol (`../remote/protocol.ts`): the phone is the "media host", so its frames are the
 * host frames plus the bridge's `stop` and `set-muted`. Like both, there is no field for a
 * credential or for audio (the audio goes from the phone to OpenAI), unknown types and fields are
 * refused, and errors never repeat the offending content.
 */

import {
  type BridgeCallFrame,
  type BridgeInboundFrame,
  type BridgeOutboundFrame,
  MAX_ENDED_ERROR_LENGTH,
  MAX_TRANSCRIPT_LENGTH,
  parseBridgeInbound,
} from "../bridge/protocol.ts";
import type { LivePhase } from "../controller.ts";
import {
  type Check,
  type ClientFrame,
  isBoolean,
  LIVE_MEDIA_PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  parseClientFrame,
  parseObject,
  ProtocolError,
  type Shape,
  validate,
  withoutVersion,
} from "../remote/protocol.ts";
import type { LiveVoice } from "../voices.ts";

/**
 * Why the relay, not Pi, ended a call. `not_pi` is Ovis's, for a pane that runs no Pi; this
 * package's endpoint always has a Pi and never sends it.
 */
export type LivePhoneEndCode = "not_pi" | "unavailable" | "busy" | "closed";

/** What the phone may send Pi. The relay sends `start` itself, so the phone cannot. */
export type PhoneToPiFrame = Exclude<BridgeInboundFrame, { type: "start" }>;

/** What Pi may send the phone: its media requests, the call's state, and how it ended. */
export type PiToPhoneFrame =
  | ClientFrame
  | Exclude<BridgeCallFrame, { type: "ready" } | { type: "ended" }>
  | { type: "ended"; error?: string; code?: LivePhoneEndCode };

/** The relay's own frame to Pi, once it holds the connection: the voice the phone chose, if any. */
export type RelayToPiFrame = { type: "start"; voice?: LiveVoice };

/** A frame of a type the host handles itself, such as step 3's `tool-call`. */
export type LivePhoneHostFrame = { type: string; [field: string]: unknown };

/** Every type a call itself uses, whichever way it goes: a host frame may not take one. */
export const CALL_FRAME_TYPES: ReadonlySet<string> = new Set([
  "hello",
  "response",
  "event",
  "levels",
  "failure",
  "stop",
  "set-muted",
  "start",
  "request",
  "activate",
  "mute",
  "ping",
  "close",
  "ready",
  "phase",
  "transcript",
  "transcript-clear",
  "ended",
]);

const PHASES: ReadonlySet<unknown> = new Set<LivePhase>([
  "standby",
  "connecting",
  "listening",
  "working",
  "speaking",
  "muted",
  "error",
]);

const isPid: Check = (value) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const isTurn: Check = (value) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isPane: Check = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= 128;
const isPhase: Check = (value) => PHASES.has(value);
const isRole: Check = (value) => value === "user" || value === "assistant";
const isTranscript: Check = (value) =>
  typeof value === "string" && value.length <= MAX_TRANSCRIPT_LENGTH;
// Pi's own encoder may leave nothing of an error but an empty string.
const isEndedError: Check = (value) =>
  typeof value === "string" && value.length <= MAX_ENDED_ERROR_LENGTH;

/** The call frames the bridge protocol has no parser for, because Pi only ever wrote them. */
const CALL_SHAPES = new Map<string, Shape>([
  ["ready", { required: { pid: isPid, busy: isBoolean }, optional: { pane: isPane } }],
  ["phase", { required: { phase: isPhase } }],
  [
    "transcript",
    { required: { role: isRole, text: isTranscript, turn: isTurn, final: isBoolean } },
  ],
  ["transcript-clear", {}],
  ["ended", { optional: { error: isEndedError } }],
]);

function assertSize(text: string): void {
  if (Buffer.byteLength(text) > MAX_FRAME_BYTES) throw new ProtocolError("Frame is too large.");
}

/** A frame the phone sent: what the bridge accepts from a phone, minus `start`. */
export function parsePhoneFrame(text: string): PhoneToPiFrame {
  assertSize(text);
  const frame = parseBridgeInbound(text);
  if (frame.type === "start") throw new ProtocolError("A phone cannot start the call.");
  return frame;
}

/** A line Pi sent, or the `ready` it opens with. */
export function parsePiLine(text: string): BridgeOutboundFrame {
  assertSize(text);
  const frame = parseObject(text);
  const shape = CALL_SHAPES.get(typeof frame.type === "string" ? frame.type : "");
  if (!shape) return parseClientFrame(text);
  validate(frame, {}, shape);
  return withoutVersion<BridgeCallFrame>(frame);
}

/**
 * A frame of a type the host named in `types`. Nothing but the version, the type, the size and
 * being an object is checked here: the rest of the frame is the host's to judge.
 */
export function parsePhoneHostFrame(text: string, types: ReadonlySet<string>): LivePhoneHostFrame {
  assertSize(text);
  const frame = parseObject(text);
  if (typeof frame.type !== "string" || !types.has(frame.type)) {
    throw new ProtocolError("Unknown frame type.");
  }
  return withoutVersion<LivePhoneHostFrame>(frame);
}

/** The frame types a host handles, checked to be names no call frame already has. */
export function hostFrameTypes(types: readonly string[] | undefined): ReadonlySet<string> {
  for (const type of types ?? []) {
    if (typeof type !== "string" || type === "") {
      throw new TypeError("A host frame type must be a non-empty string.");
    }
    if (CALL_FRAME_TYPES.has(type)) {
      throw new TypeError(`"${type}" is a call frame and cannot be a host frame.`);
    }
  }
  return new Set(types);
}

/** One frame as a WebSocket message (to the phone) or, with a newline added, a line to Pi. */
export function encodePhoneFrame(
  frame: PhoneToPiFrame | PiToPhoneFrame | RelayToPiFrame | LivePhoneHostFrame,
): string {
  const text = JSON.stringify({ ...frame, v: LIVE_MEDIA_PROTOCOL_VERSION });
  assertSize(text);
  return text;
}
