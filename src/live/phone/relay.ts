import type { Duplex } from "node:stream";
import type { BridgeOutboundFrame } from "../bridge/protocol.ts";
import {
  FrameDecoder,
  LIVE_MEDIA_LEASE_MS,
  LIVE_MEDIA_PING_MS,
  ProtocolError,
} from "../remote/protocol.ts";
import type { LiveVoice } from "../voices.ts";
import {
  encodePhoneFrame,
  hostFrameTypes,
  type LivePhoneEndCode,
  type LivePhoneHostFrame,
  parsePhoneFrame,
  parsePhoneHostFrame,
  parsePiLine,
} from "./protocol.ts";

/**
 * The relay between a phone and a Pi, ported from Ovis (`server/pi-voice.ts`, `PiVoiceRelay` and
 * `PiVoiceHub`): it checks and re-serializes every frame in both directions, holds the phone's
 * first frames while Pi is reached, keeps the heartbeat, and ends both sides exactly once. The
 * frames themselves are never logged: an SDP carries addresses.
 */

const READY_MS = 2_000;
/** the phone sends its hello at once, before Pi has answered; nothing else may wait */
const MAX_WAITING = 16;

/** A phone's connection, as the relay needs it. */
export interface LivePhonePeer {
  send(text: string): void;
  close(): void;
  /** A WebSocket-level ping; the caller reports the pong with call.pong(). */
  ping(): void;
}

export interface LivePhoneCallOptions {
  /** The voice for this call; Pi's setting otherwise. */
  voice?: LiveVoice;
  /**
   * Frame types the host handles itself, such as step 3's "tool-call" and "tool-result". Naming a
   * call frame throws.
   */
  hostFrames?: readonly string[];
  /** A phone frame of one of hostFrames, checked only for v, type, size and being an object. */
  onHostFrame?(frame: LivePhoneHostFrame): void;
  /** Called once, however the call ends. */
  onEnd?(end: { code?: LivePhoneEndCode; error?: string }): void;
}

export interface LivePhoneCall {
  readonly ended: boolean;
  /** accept() only: a message from the phone. Binary data ends the call. */
  message(data: string | Uint8Array): void;
  pong(): void;
  /** accept() only: the phone's socket closed. */
  closed(): void;
  /** Sends a host frame. False once the call is over or if the type isn't in hostFrames. */
  send(frame: LivePhoneHostFrame): boolean;
  /** Ends the call from the host, for example when a device is revoked: the phone gets ended {code: "closed"}. */
  end(): void;
}

export interface LivePhoneRelayOptions extends LivePhoneCallOptions {
  /** The process Pi's ready must name: a connection that says otherwise is not the Pi asked for. */
  expectPid?: number;
  /** The pane Pi's ready must name, when it names one. */
  expectPane?: string;
  /** How long Pi has to say ready. */
  readyMs?: number;
  every?: (run: () => void, ms: number) => () => void;
  now?: () => number;
}

type Held = { line: string } | { host: LivePhoneHostFrame };

const everyInterval = (run: () => void, ms: number): (() => void) => {
  const timer = setInterval(run, ms);
  timer.unref?.();
  return () => clearInterval(timer);
};

/** A socket or handler that fails must not keep the call from ending. */
function attempt(action: () => void): void {
  try {
    action();
  } catch {
    // Nothing to tell: the other side is gone, or the host's code is its own to fix.
  }
}

/**
 * Runs one call between `peer` and the Pi that `connect()` reaches, a duplex stream carrying the
 * bridge's newline-delimited frames. The call is told what happens to the phone (`message`,
 * `pong`, `closed`) and ends both sides when anything is wrong.
 */
export function relayLivePhoneCall(
  peer: LivePhonePeer,
  connect: () => Promise<Duplex>,
  options: LivePhoneRelayOptions = {},
): LivePhoneCall {
  return new PhoneCallRelay(peer, connect, options);
}

class PhoneCallRelay implements LivePhoneCall {
  readonly #peer: LivePhonePeer;
  readonly #options: LivePhoneRelayOptions;
  readonly #hostTypes: ReadonlySet<string>;
  readonly #now: () => number;
  readonly #decoder = new FrameDecoder(parsePiLine);
  readonly #waiting: Held[] = [];
  readonly #stopTimer: () => void;
  #link: Duplex | undefined;
  #readyTimer: NodeJS.Timeout | undefined;
  #lastSeen: number;
  #live = false;
  #done = false;

  constructor(peer: LivePhonePeer, connect: () => Promise<Duplex>, options: LivePhoneRelayOptions) {
    this.#hostTypes = hostFrameTypes(options.hostFrames);
    this.#peer = peer;
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#lastSeen = this.#now();
    // A phone that has not started its script answers nothing but WebSocket pings, so the lease
    // runs from the first moment, not from when Pi answers.
    this.#stopTimer = (options.every ?? everyInterval)(() => {
      if (this.#now() - this.#lastSeen > LIVE_MEDIA_LEASE_MS) this.#end("closed", true);
      else attempt(() => peer.ping());
    }, LIVE_MEDIA_PING_MS);
    new Promise<Duplex>((resolve) => resolve(connect())).then(
      (link) => this.#linked(link),
      () => this.#end("unavailable", true),
    );
  }

  get ended(): boolean {
    return this.#done;
  }

  message(data: string | Uint8Array): void {
    if (this.#done) return;
    this.#lastSeen = this.#now();
    let held: Held;
    try {
      if (typeof data !== "string") throw new ProtocolError("A phone sends text frames only.");
      held = this.#classify(data);
    } catch {
      // the phone broke the protocol: Pi hears nothing of it but the end
      this.#end(undefined, false);
      return;
    }
    if (this.#live) this.#deliver(held);
    else if (this.#waiting.length < MAX_WAITING) this.#waiting.push(held);
    else this.#end(undefined, false);
  }

  pong(): void {
    if (!this.#done) this.#lastSeen = this.#now();
  }

  closed(): void {
    this.#end(undefined, false);
  }

  send(frame: LivePhoneHostFrame): boolean {
    if (this.#done || !this.#hostTypes.has(frame.type)) return false;
    try {
      this.#peer.send(encodePhoneFrame(frame));
      return true;
    } catch {
      return false;
    }
  }

  end(): void {
    this.#end("closed", true);
  }

  #classify(data: string): Held {
    try {
      return { line: `${encodePhoneFrame(parsePhoneFrame(data))}\n` };
    } catch (cause) {
      if (this.#hostTypes.size === 0) throw cause;
      return { host: parsePhoneHostFrame(data, this.#hostTypes) };
    }
  }

  #deliver(held: Held): void {
    if ("host" in held) attempt(() => this.#options.onHostFrame?.(held.host));
    else this.#link?.write(held.line);
  }

  #linked(link: Duplex): void {
    if (this.#done || link.destroyed) {
      link.destroy();
      if (!this.#done) this.#end("unavailable", true);
      return;
    }
    this.#link = link;
    link.on("data", (chunk: Buffer) => this.#fromPi(chunk));
    link.on("end", () => this.#end("closed", true));
    link.on("close", () => this.#end("closed", true));
    link.on("error", () => undefined);
    this.#readyTimer = setTimeout(
      () => this.#end("unavailable", true),
      this.#options.readyMs ?? READY_MS,
    );
    this.#readyTimer.unref?.();
  }

  #fromPi(chunk: Buffer): void {
    if (this.#done) return;
    let frames: BridgeOutboundFrame[];
    try {
      frames = this.#decoder.push(chunk);
    } catch {
      this.#end(this.#live ? "closed" : "unavailable", true);
      return;
    }
    for (const frame of frames) {
      if (this.#done) return;
      if (!this.#live) this.#begin(frame);
      else if (frame.type === "ready") this.#end("closed", true);
      else this.#toPhone(frame);
    }
  }

  /** Pi's first frame, which must be a ready from the Pi that was asked for. */
  #begin(first: BridgeOutboundFrame): void {
    const { expectPid, expectPane, voice } = this.#options;
    if (
      first.type !== "ready" ||
      (expectPid !== undefined && first.pid !== expectPid) ||
      // the pane is the one asked for, or none is named: a ready that says otherwise is not this pane's Pi
      (expectPane !== undefined && first.pane !== undefined && first.pane !== expectPane)
    ) {
      this.#end("unavailable", true);
      return;
    }
    if (first.busy) {
      this.#end("busy", true);
      return;
    }
    clearTimeout(this.#readyTimer);
    this.#live = true;
    this.#link?.write(
      `${encodePhoneFrame(voice ? { type: "start", voice } : { type: "start" })}\n`,
    );
    for (const held of this.#waiting.splice(0)) {
      if (this.#done) return;
      this.#deliver(held);
    }
  }

  #toPhone(frame: Exclude<BridgeOutboundFrame, { type: "ready" }>): void {
    try {
      this.#peer.send(encodePhoneFrame(frame));
    } catch {
      this.#end("closed", false);
      return;
    }
    if (frame.type === "ended") this.#end(undefined, true, frame.error);
  }

  /** Ends both sides once; `code` is told to the phone first, when it is still there to hear it. */
  #end(code: LivePhoneEndCode | undefined, phoneStillThere: boolean, error?: string): void {
    if (this.#done) return;
    this.#done = true;
    this.#stopTimer();
    clearTimeout(this.#readyTimer);
    if (phoneStillThere && code) {
      attempt(() => this.#peer.send(encodePhoneFrame({ type: "ended", code })));
    }
    attempt(() => this.#peer.close());
    this.#link?.end();
    this.#link?.destroy();
    attempt(() => this.#options.onEnd?.(code ? { code } : error !== undefined ? { error } : {}));
  }
}
