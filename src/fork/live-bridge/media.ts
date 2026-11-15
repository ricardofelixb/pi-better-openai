import type { LiveMedia, LiveMediaCallbacks, LiveTransportOptions } from "../../live/transport.ts";
import {
  type ClientFrame,
  type HostFrame,
  LIVE_MEDIA_PING_MS,
  MAX_REQUEST_TIMEOUT_MS,
} from "./protocol.ts";
import type { LiveBridgeConnection } from "./socket.ts";

type Pending = { resolve(sdp?: string): void; reject(error: Error): void; timer: NodeJS.Timeout };
/** The client owns the devices and peer; Pi retains credentials, signaling and the sideband. */
export function createBridgeMediaFactory(
  connection: LiveBridgeConnection,
): NonNullable<LiveTransportOptions["createMedia"]> {
  return (callbacks, signal) => new BridgeMedia(connection, callbacks, signal);
}
class BridgeMedia implements LiveMedia {
  readonly #connection: LiveBridgeConnection;
  readonly #callbacks: LiveMediaCallbacks;
  readonly #pending = new Map<number, Pending>();
  readonly #ready: Promise<void>;
  readonly #hello: { resolve(): void; reject(error: Error): void };
  readonly #timer: NodeJS.Timeout;
  readonly #signal: AbortSignal | undefined;
  readonly #abort = () => {
    void this.close();
  };
  #helloSeen = false;
  #closed = false;
  #nextId = 1;
  #pinger: NodeJS.Timeout | undefined;
  constructor(
    connection: LiveBridgeConnection,
    callbacks: LiveMediaCallbacks,
    signal?: AbortSignal,
  ) {
    this.#connection = connection;
    this.#callbacks = callbacks;
    this.#signal = signal;
    let hello!: { resolve(): void; reject(error: Error): void };
    const greeting = new Promise<void>((resolve, reject) => {
      hello = { resolve, reject };
    });
    this.#hello = hello;
    this.#timer = setTimeout(() => this.#fail("Live media client did not start in time."), 30_000);
    this.#timer.unref();
    this.#ready = greeting.then(async () => {
      await this.#request({ type: "request", method: "open" });
    });
    this.#ready.catch(() => undefined);
    connection.onMedia((frame) => {
      if (!this.#closed) this.#onFrame(frame);
    });
    connection.onClose(() => this.#fail("Live media client disconnected."));
    if (signal?.aborted) this.#abort();
    else signal?.addEventListener("abort", this.#abort, { once: true });
  }
  async createOffer(): Promise<string> {
    await this.#ready;
    const sdp = await this.#request({ type: "request", method: "createOffer" });
    if (!sdp) throw new Error("Live media client returned no SDP offer.");
    return sdp;
  }
  async acceptAnswer(sdp: string): Promise<void> {
    await this.#ready;
    await this.#request({ type: "request", method: "acceptAnswer", sdp });
  }
  async waitForOpen(timeoutMs = 60_000): Promise<void> {
    await this.#ready;
    const bounded = Number.isFinite(timeoutMs)
      ? Math.min(MAX_REQUEST_TIMEOUT_MS, Math.max(1, Math.round(timeoutMs)))
      : 60_000;
    await this.#request(
      { type: "request", method: "waitForOpen", timeoutMs: bounded },
      bounded + 30_000,
    );
  }
  activate(): void {
    this.#notify({ type: "activate" });
  }
  setMuted(muted: boolean): void {
    this.#notify({ type: "mute", muted });
  }
  #notify(frame: ClientFrame): void {
    void this.#ready.then(
      () => {
        if (!this.#closed) this.#write(frame);
      },
      () => undefined,
    );
  }
  #write(frame: ClientFrame): void {
    this.#connection.send(frame);
  }
  #request(
    frame: Omit<Extract<ClientFrame, { type: "request" }>, "id"> & {
      sdp?: string;
      timeoutMs?: number;
    },
    timeoutMs = 30_000,
  ): Promise<string | undefined> {
    if (this.#closed) return Promise.reject(new Error("Live media is closed."));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.#fail(`Live media client did not answer ${frame.method} in time.`),
        timeoutMs,
      );
      timer.unref();
      this.#pending.set(id, { resolve, reject, timer });
      this.#write({ ...frame, id } as ClientFrame);
    });
  }
  #onFrame(frame: HostFrame): void {
    if (!this.#helloSeen) {
      if (frame.type !== "hello")
        return this.#fail("Live media client sent a frame before its hello.");
      this.#helloSeen = true;
      clearTimeout(this.#timer);
      this.#hello.resolve();
      this.#pinger = setInterval(() => this.#write({ type: "ping" }), LIVE_MEDIA_PING_MS);
      this.#pinger.unref();
      return;
    }
    switch (frame.type) {
      case "hello":
        return this.#fail("Live media client sent a second hello.");
      case "response": {
        const pending = this.#pending.get(frame.id);
        if (!pending) return this.#fail("Live media client answered a request that was not asked.");
        clearTimeout(pending.timer);
        this.#pending.delete(frame.id);
        if (frame.ok) pending.resolve(frame.sdp);
        else pending.reject(new Error(frame.error));
        break;
      }
      case "event":
        this.#callbacks.onEvent(frame.payload);
        break;
      case "levels":
        this.#callbacks.onLevels(frame.input, frame.output);
        break;
      case "failure":
        this.#fail(frame.message);
        break;
    }
  }
  #fail(message: string): void {
    if (this.#closed) return;
    void this.close();
    this.#callbacks.onFailure(message);
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#signal?.removeEventListener("abort", this.#abort);
    clearTimeout(this.#timer);
    clearInterval(this.#pinger);
    const error = new Error("Live media is closed.");
    this.#hello.reject(error);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#write({ type: "close" });
  }
}
