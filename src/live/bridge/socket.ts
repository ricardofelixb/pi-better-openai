import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { encodeFrame, FrameDecoder } from "../remote/protocol.ts";
import {
  type BridgeControlFrame,
  type BridgeInboundFrame,
  type BridgeOutboundFrame,
  encodeBridgeFrame,
  isBridgeControl,
  parseBridgeInbound,
} from "./protocol.ts";

const BRIDGE_DIRECTORY = "live-bridge";
// sun_path holds 104 bytes on macOS and 108 on Linux, terminator included.
const MAX_SOCKET_PATH_BYTES = 100;
const CLOSE_GRACE_MS = 2_000;

export function liveBridgeSocketPath(agentDir: string, pid: number = process.pid): string {
  return join(agentDir, BRIDGE_DIRECTORY, `${pid}.sock`);
}

/**
 * One phone's connection. Its media frames (hello, responses, events, levels, failure) come out
 * of `output` as the lines the remote media client reads; the control frames go to `onControl`,
 * so they never reach the media parser.
 */
export class LiveBridgeConnection {
  readonly output = new PassThrough();
  readonly #socket: net.Socket;
  readonly #decoder = new FrameDecoder(parseBridgeInbound);
  readonly #closeListeners: Array<() => void> = [];
  #control: ((frame: BridgeControlFrame) => void) | undefined;
  #started = false;
  #helloSeen = false;
  #ending = false;
  #closed = false;

  constructor(socket: net.Socket) {
    this.#socket = socket;
    socket.on("data", (chunk: Buffer) => this.#onData(chunk));
    socket.on("error", () => undefined);
    socket.on("close", () => this.#onClose());
  }

  get closed(): boolean {
    return this.#closed || this.#ending;
  }

  /** Sets who gets the control frames; the latest listener replaces the one before. */
  onControl(listener: (frame: BridgeControlFrame) => void): void {
    this.#control = listener;
  }

  onClose(listener: () => void): void {
    this.#closeListeners.push(listener);
  }

  send(frame: BridgeOutboundFrame): void {
    if (this.closed) return;
    try {
      this.#socket.write(encodeBridgeFrame(frame));
    } catch {
      this.#socket.destroy();
    }
  }

  /** Writes a line the remote media client already encoded. */
  write(line: string): void {
    if (this.closed) return;
    this.#socket.write(line);
  }

  /** Flushes what was sent, then closes; a peer that does not hang up is cut off after a moment. */
  close(): void {
    if (this.closed) return;
    this.#ending = true;
    this.#socket.end();
    setTimeout(() => this.#socket.destroy(), CLOSE_GRACE_MS).unref();
  }

  #onData(chunk: Buffer): void {
    let frames: BridgeInboundFrame[];
    try {
      frames = this.#decoder.push(chunk);
    } catch {
      this.#socket.destroy();
      return;
    }
    for (const frame of frames) {
      if (this.#closed) return;
      if (isBridgeControl(frame)) {
        // One call per connection: a second start is the peer misbehaving, not a request.
        if (frame.type === "start" && this.#started) return void this.#socket.destroy();
        if (frame.type === "start") this.#started = true;
        this.#control?.(frame);
        continue;
      }
      // Until start, only the phone's hello may wait here for the media to appear.
      if (!this.#started && (frame.type !== "hello" || this.#helloSeen)) {
        return void this.#socket.destroy();
      }
      if (frame.type === "hello") this.#helloSeen = true;
      this.output.write(encodeFrame(frame));
    }
  }

  #onClose(): void {
    this.#closed = true;
    // Listeners first: the call should end quietly before the media notices its device is gone.
    for (const listener of this.#closeListeners) {
      try {
        listener();
      } catch {
        // One listener's failure must not keep the others from hearing it.
      }
    }
    this.output.end();
  }
}

export interface LiveBridgeServerOptions {
  agentDir: string;
  pid?: number;
  /** The Herdr pane this Pi runs in, so the relay can check it reached the pane it meant to. */
  pane?: string | undefined;
  isBusy(): boolean;
  onConnection(connection: LiveBridgeConnection): void;
}

/**
 * Listens on `<agentDir>/live-bridge/<pid>.sock`, reachable only by this user: the directory is
 * private and the socket is mode 0600. Nothing happens on a connection until it sends `start`.
 */
export class LiveBridgeServer {
  readonly #options: LiveBridgeServerOptions;
  readonly #path: string;
  readonly #connections = new Set<LiveBridgeConnection>();
  #server: net.Server | undefined;

  constructor(options: LiveBridgeServerOptions) {
    this.#options = options;
    this.#path = liveBridgeSocketPath(options.agentDir, options.pid);
  }

  /** False when the socket cannot be made safely; the bridge is then simply not offered. */
  async listen(): Promise<boolean> {
    if (this.#server) return true;
    if (Buffer.byteLength(this.#path) > MAX_SOCKET_PATH_BYTES) return false;
    if (!prepareDirectory(dirname(this.#path)) || !clearStaleSocket(this.#path)) return false;
    const server = net.createServer((socket) => this.#accept(socket));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.#path, () => {
          server.off("error", reject);
          resolve();
        });
      });
      chmodSync(this.#path, 0o600);
    } catch {
      server.close();
      removeQuietly(this.#path);
      return false;
    }
    server.on("error", () => undefined);
    this.#server = server;
    return true;
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    for (const connection of this.#connections) connection.close();
    server?.close();
    removeQuietly(this.#path);
  }

  #accept(socket: net.Socket): void {
    const connection = new LiveBridgeConnection(socket);
    this.#connections.add(connection);
    connection.onClose(() => this.#connections.delete(connection));
    this.#options.onConnection(connection);
    connection.send({
      type: "ready",
      pid: this.#options.pid ?? process.pid,
      ...(this.#options.pane ? { pane: this.#options.pane } : {}),
      busy: this.#options.isBusy(),
    });
  }
}

function prepareDirectory(directory: string): boolean {
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    return stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

/** A socket file at this pid's path is left by an earlier process with the same pid. */
function clearStaleSocket(path: string): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isSocket() || stat.uid !== process.getuid?.()) return false;
    unlinkSync(path);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
}
