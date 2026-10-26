/**
 * Wire protocol between this Pi and Ovis, which relays a phone's microphone and speaker to the
 * pane Pi runs in: newline-delimited JSON over a local unix socket, one frame per line, every
 * frame carrying the version of the remote media protocol (`../remote/protocol.ts`).
 *
 * The bridge reuses that protocol for the audio device (the phone is the "media host") and adds
 * control and call-state frames around it. Like it, the bridge has no field for credentials,
 * attestation or audio, and unknown fields are rejected, so none can be added by accident.
 * Ovis keeps a copy of these shapes in `shared/pi-voice.ts`; the shared `v` catches drift.
 */

import type { LivePhase } from "../controller.ts";
import { sanitizeDiagnosticError } from "../../format.ts";
import {
  type ClientFrame,
  encodeFrame,
  type HostFrame,
  isBoolean,
  LIVE_MEDIA_PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  ProtocolError,
  parseHostFrame,
  parseObject,
  type Shape,
  validate,
  withoutVersion,
} from "../remote/protocol.ts";
import { sanitizeTranscript } from "../visualizer.ts";

export const MAX_TRANSCRIPT_LENGTH = 4_096;
export const MAX_ENDED_ERROR_LENGTH = 2_048;

/** What the phone may ask of the call itself, as opposed to its audio device. */
export type BridgeControlFrame =
  | { type: "start" }
  | { type: "stop" }
  | { type: "set-muted"; muted: boolean };

export type BridgeInboundFrame = BridgeControlFrame | HostFrame;

/** Pi's own frames; the media requests (`ClientFrame`) go out on the same connection. */
export type BridgeCallFrame =
  | { type: "ready"; pid: number; pane?: string; busy: boolean }
  | { type: "phase"; phase: LivePhase }
  | {
      type: "transcript";
      role: "user" | "assistant";
      text: string;
      turn: number;
      final: boolean;
    }
  | { type: "transcript-clear" }
  | { type: "ended"; error?: string };

export type BridgeOutboundFrame = BridgeCallFrame | ClientFrame;

const CONTROL_SHAPES = new Map<string, Shape>([
  ["start", {}],
  ["stop", {}],
  ["set-muted", { required: { muted: isBoolean } }],
]);

export function isBridgeControl(frame: BridgeInboundFrame): frame is BridgeControlFrame {
  return CONTROL_SHAPES.has(frame.type);
}

export function parseBridgeInbound(text: string): BridgeInboundFrame {
  const frame = parseObject(text);
  const type = typeof frame.type === "string" ? frame.type : "";
  const shape = CONTROL_SHAPES.get(type);
  if (!shape) return parseHostFrame(text);
  validate(frame, {}, shape);
  return withoutVersion<BridgeControlFrame>(frame);
}

export function encodeBridgeFrame(frame: BridgeOutboundFrame): string {
  switch (frame.type) {
    case "transcript":
      return encodeCallFrame({ ...frame, text: boundedTranscript(frame.text) });
    case "ended":
      return encodeCallFrame(
        frame.error === undefined
          ? { type: "ended" }
          : { type: "ended", error: sanitizeDiagnosticError(frame.error, MAX_ENDED_ERROR_LENGTH) },
      );
    case "ready":
    case "phase":
    case "transcript-clear":
      return encodeCallFrame(frame);
    default:
      return encodeFrame(frame);
  }
}

/** The latest words are what a listener follows, so an over-long turn loses its start. */
function boundedTranscript(text: string): string {
  return sanitizeTranscript(text).slice(-MAX_TRANSCRIPT_LENGTH);
}

function encodeCallFrame(frame: BridgeCallFrame): string {
  const text = JSON.stringify({ v: LIVE_MEDIA_PROTOCOL_VERSION, ...frame });
  if (Buffer.byteLength(text) > MAX_FRAME_BYTES) throw new ProtocolError("Frame is too large.");
  return `${text}\n`;
}
