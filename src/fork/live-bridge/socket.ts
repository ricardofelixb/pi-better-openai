import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import type { BridgeControlFrame, BridgeOutboundFrame, HostFrame } from "./protocol.ts";
import {
  encodeBridgeFrame,
  FrameDecoder,
  isBridgeControl,
  parseBridgeInbound,
} from "./protocol.ts";

export function liveBridgeSocketPath(agentDir: string, pid = process.pid): string {
  return join(agentDir, "live-bridge", `${pid}.sock`);
}
/** Separates call controls from media, keeping at most one hello until media attaches. */
export class LiveBridgeConnection {
  readonly #socket: net.Socket;
  readonly #decoder = new FrameDecoder(parseBridgeInbound);
  readonly #closeListeners: Array<() => void> = [];
  #control: ((frame: BridgeControlFrame) => void) | undefined;
  #media: ((frame: HostFrame) => void) | undefined;
  #hello: HostFrame | undefined;
  #helloSeen = false;
  #started = false;
  #closed = false;
  #closeTimer: NodeJS.Timeout | undefined;
  constructor(socket: net.Socket) {
    this.#socket = socket;
    socket.on("data", (chunk: Buffer) => this.#onData(chunk));
    socket.on("error", () => undefined);
    socket.on("close", () => {
      this.#closed = true;
      clearTimeout(this.#closeTimer);
      for (const listener of this.#closeListeners) listener();
    });
  }
  onControl(listener: (frame: BridgeControlFrame) => void): void {
    this.#control = listener;
  }
  onMedia(listener: (frame: HostFrame) => void): void {
    this.#media = listener;
    if (this.#hello) {
      listener(this.#hello);
      this.#hello = undefined;
    }
  }
  onClose(listener: () => void): void {
    this.#closeListeners.push(listener);
  }
  send(frame: BridgeOutboundFrame): void {
    if (this.#closed) return;
    try {
      const line = encodeBridgeFrame(frame);
      // Bound queued output when a client stops reading.
      if (this.#socket.writableLength + Buffer.byteLength(line) > 2_097_152) this.#socket.destroy();
      else this.#socket.write(line);
    } catch {
      this.#socket.destroy();
    }
  }
  /** Flush ended before closing, but do not let a client keep the connection alive. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.end();
    this.#closeTimer = setTimeout(() => this.#socket.destroy(), 2_000);
    this.#closeTimer.unref();
  }
  #onData(chunk: Buffer): void {
    try {
      for (const frame of this.#decoder.push(chunk)) {
        if (this.#closed) return;
        if (isBridgeControl(frame)) {
          if (frame.type === "start" && this.#started) return void this.#socket.destroy();
          if (frame.type === "start") this.#started = true;
          this.#control?.(frame);
        } else {
          if (frame.type === "hello") {
            if (this.#helloSeen) return void this.#socket.destroy();
            this.#helloSeen = true;
          } else if (!this.#started || !this.#media) return void this.#socket.destroy();
          if (this.#media) this.#media(frame);
          else this.#hello = frame;
        }
      }
    } catch {
      this.#socket.destroy();
    }
  }
}
export interface LiveBridgeServerOptions {
  agentDir: string;
  pid?: number;
  pane?: string | undefined;
  isBusy(): boolean;
  onConnection(connection: LiveBridgeConnection): void;
}
/** A user-private socket. Unsafe directories, symlinks and non-socket files are never replaced. */
export class LiveBridgeServer {
  readonly #options: LiveBridgeServerOptions;
  readonly #path: string;
  readonly #connections = new Set<LiveBridgeConnection>();
  #server: net.Server | undefined;
  constructor(options: LiveBridgeServerOptions) {
    this.#options = options;
    this.#path = liveBridgeSocketPath(options.agentDir, options.pid);
  }
  async listen(): Promise<boolean> {
    if (this.#server) return true;
    // sun_path holds 104 bytes on macOS and 108 on Linux, terminator included.
    if (
      Buffer.byteLength(this.#path) > 100 ||
      !prepareDirectory(dirname(this.#path)) ||
      !clearStaleSocket(this.#path)
    )
      return false;
    const server = net.createServer((socket) => {
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
    });
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
      return false;
    }
    server.on("error", () => undefined);
    this.#server = server;
    return true;
  }
  async close(): Promise<void> {
    for (const connection of this.#connections) connection.close();
    if (!this.#server) return;
    this.#server.close();
    this.#server = undefined;
    try {
      unlinkSync(this.#path);
    } catch {
      /* Already gone. */
    }
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
