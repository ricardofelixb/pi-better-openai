import type { LivePhase, LiveTranscript } from "../../live/controller.ts";
import { isLiveVoice, type LiveVoice } from "../../live/voices.ts";
import { sanitizeDiagnosticError, stripAnsi } from "../../format.ts";

// Shared with the client's pi-voice protocol. No credentials or audio travel here.
export const LIVE_MEDIA_PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 1_048_576;
export const MAX_TRANSCRIPT_LENGTH = 4_096;
export const MAX_ENDED_ERROR_LENGTH = 2_048;
export const MAX_REQUEST_TIMEOUT_MS = 120_000;
export const LIVE_MEDIA_PING_MS = 5_000;

export type ClientFrame =
  | { type: "request"; id: number; method: "open" | "createOffer" }
  | { type: "request"; id: number; method: "acceptAnswer"; sdp: string }
  | { type: "request"; id: number; method: "waitForOpen"; timeoutMs?: number }
  | { type: "activate" | "ping" | "close" }
  | { type: "mute"; muted: boolean };
export type HostFrame =
  | { type: "hello"; features?: string[] }
  | { type: "response"; id: number; ok: true; sdp?: string }
  | { type: "response"; id: number; ok: false; error: string }
  | { type: "event"; payload: string }
  | { type: "levels"; input: number; output: number }
  | { type: "failure"; message: string };
export type BridgeControlFrame =
  | { type: "start"; voice?: LiveVoice }
  | { type: "stop" }
  | { type: "resume" }
  | { type: "set-muted"; muted: boolean };
export type BridgeInboundFrame = BridgeControlFrame | HostFrame;
export type BridgeOutboundFrame =
  | ClientFrame
  | { type: "ready"; pid: number; pane?: string; busy: boolean }
  | { type: "phase"; phase: LivePhase }
  | ({ type: "transcript" } & LiveTranscript)
  | { type: "transcript-clear" }
  | { type: "ended"; error?: string };

export class ProtocolError extends Error {}
export class ProtocolVersionError extends ProtocolError {}
type Check = (value: unknown) => boolean;
type Shape = { required?: Record<string, Check>; optional?: Record<string, Check> };
const isBoolean: Check = (value) => typeof value === "boolean";
const isId: Check = (value) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isText: Check = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_FRAME_BYTES;
const isMessage: Check = (value) =>
  isText(value) && (value as string).length <= MAX_ENDED_ERROR_LENGTH;
const isLevel: Check = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const isFeatures: Check = (value) =>
  Array.isArray(value) &&
  value.length <= 8 &&
  value.every((name) => typeof name === "string" && name.length <= 32);
const CONTROLS = new Map<string, Shape>([
  ["start", { optional: { voice: isLiveVoice } }],
  ["stop", {}],
  ["resume", {}],
  ["set-muted", { required: { muted: isBoolean } }],
]);
const HOST = new Map<string, Shape>([
  ["hello", { optional: { features: isFeatures } }],
  ["event", { required: { payload: isText } }],
  ["levels", { required: { input: isLevel, output: isLevel } }],
  ["failure", { required: { message: isMessage } }],
]);

function parseObject(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text) > MAX_FRAME_BYTES) throw new ProtocolError("Frame is too large.");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProtocolError("Frame is not valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ProtocolError("Frame is not a JSON object.");
  const frame = value as Record<string, unknown>;
  if (frame.v !== LIVE_MEDIA_PROTOCOL_VERSION)
    throw new ProtocolVersionError("Unsupported live bridge protocol version.");
  return frame;
}
function validate(frame: Record<string, unknown>, shape: Shape | undefined): void {
  if (!shape) throw new ProtocolError("Unknown frame type.");
  const fields = { ...shape.required, ...shape.optional };
  for (const key of Object.keys(frame)) {
    if (key !== "v" && key !== "type" && !Object.hasOwn(fields, key))
      throw new ProtocolError("Unexpected field in frame.");
  }
  for (const [key, check] of Object.entries(fields)) {
    const present = Object.hasOwn(frame, key);
    if (!present && Object.hasOwn(shape.required ?? {}, key))
      throw new ProtocolError(`Frame is missing ${key}.`);
    if (present && !check(frame[key])) throw new ProtocolError(`Frame has an invalid ${key}.`);
  }
}
function withoutVersion<T>(frame: Record<string, unknown>): T {
  const { v: _version, ...rest } = frame;
  return rest as T;
}
export function isBridgeControl(frame: BridgeInboundFrame): frame is BridgeControlFrame {
  return CONTROLS.has(frame.type);
}
export function parseHostFrame(text: string): HostFrame {
  const frame = parseObject(text);
  const shape =
    frame.type === "response"
      ? {
          required: {
            id: isId,
            ok: isBoolean,
            ...(frame.ok === false ? { error: isMessage } : {}),
          },
          optional: frame.ok === true ? { sdp: isText } : {},
        }
      : HOST.get(String(frame.type));
  validate(frame, shape);
  return withoutVersion(frame);
}
export function parseBridgeInbound(text: string): BridgeInboundFrame {
  const frame = parseObject(text);
  const shape = CONTROLS.get(String(frame.type));
  if (!shape) return parseHostFrame(text);
  validate(frame, shape);
  return withoutVersion(frame);
}
export function encodeFrame(frame: HostFrame | BridgeOutboundFrame): string {
  const text = JSON.stringify({ v: LIVE_MEDIA_PROTOCOL_VERSION, ...frame });
  if (Buffer.byteLength(text) > MAX_FRAME_BYTES) throw new ProtocolError("Frame is too large.");
  return `${text}\n`;
}
export function encodeBridgeFrame(frame: BridgeOutboundFrame): string {
  if (frame.type === "transcript") {
    const text = stripAnsi(frame.text)
      // eslint-disable-next-line no-control-regex -- client transcript text must not carry terminal controls
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(-MAX_TRANSCRIPT_LENGTH);
    return encodeFrame({ ...frame, text });
  }
  if (frame.type === "ended" && frame.error !== undefined)
    return encodeFrame({
      ...frame,
      error: sanitizeDiagnosticError(frame.error, MAX_ENDED_ERROR_LENGTH),
    });
  return encodeFrame(frame);
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
/** Bounded NDJSON decoding, including fragmented UTF-8 and multiple frames per chunk. */
export class FrameDecoder<T> {
  readonly #parse: (text: string) => T;
  #pending: Buffer[] = [];
  #pendingBytes = 0;
  #failure: Error | undefined;
  constructor(parse: (text: string) => T) {
    this.#parse = parse;
  }
  push(chunk: Uint8Array | string): T[] {
    if (this.#failure) throw this.#failure;
    try {
      return this.#push(Buffer.from(chunk));
    } catch (cause) {
      this.#failure = cause instanceof Error ? cause : new ProtocolError(String(cause));
      throw this.#failure;
    }
  }
  #push(data: Buffer): T[] {
    const frames: T[] = [];
    let start = 0;
    for (;;) {
      const end = data.indexOf(0x0a, start);
      const bytes = this.#pendingBytes + (end === -1 ? data.length : end) - start;
      if (bytes > MAX_FRAME_BYTES) throw new ProtocolError("Frame is too large.");
      if (end === -1) {
        if (start < data.length) this.#pending.push(Buffer.from(data.subarray(start)));
        this.#pendingBytes = bytes;
        return frames;
      }
      const line = Buffer.concat([...this.#pending, data.subarray(start, end)]);
      this.#pending = [];
      this.#pendingBytes = 0;
      start = end + 1;
      let text: string;
      try {
        text = utf8.decode(line);
      } catch {
        throw new ProtocolError("Frame is not valid UTF-8.");
      }
      if (text.trim()) frames.push(this.#parse(text));
    }
  }
}
