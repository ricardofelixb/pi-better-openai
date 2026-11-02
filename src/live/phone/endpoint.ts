import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { type RawData, WebSocketServer } from "ws";
import { MAX_FRAME_BYTES } from "../remote/protocol.ts";
import { hostFrameTypes } from "./protocol.ts";
import {
  type LivePhoneCall,
  type LivePhoneCallOptions,
  type LivePhonePeer,
  relayLivePhoneCall,
} from "./relay.ts";

export type { LivePhoneEndCode, LivePhoneHostFrame } from "./protocol.ts";
export type { LivePhoneCall, LivePhoneCallOptions, LivePhonePeer } from "./relay.ts";

/**
 * What another extension in this process hears on `pi.events` to take phone calls: the same
 * `LivePhoneEndpoint` object at load and at every session start. A package that installs apart
 * from this one cannot import it (it would load a second copy with no call running), so it keeps
 * its own copy of these types, and `version` is what protects that copy.
 */
export const LIVE_PHONE_EVENT = "pi-better-openai:live-phone";

/** How long a closing WebSocket gets to finish its handshake before the socket is cut. */
const CLOSE_GRACE_MS = 2_000;

export interface LivePhoneEndpoint {
  readonly version: 1;
  /** available: a TUI session is running and /live is enabled. busy: a call is on. */
  status(): { available: boolean; busy: boolean };
  /**
   * Upgrades a request the caller already authenticated and runs one call on it. Resolves once
   * the socket is open; rejects, with the socket destroyed, if the handshake fails.
   */
  upgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    options?: LivePhoneCallOptions,
  ): Promise<LivePhoneCall>;
  /** Runs one call on a socket the caller holds, such as Bun's; the caller reports into the call. */
  accept(peer: LivePhonePeer, options?: LivePhoneCallOptions): LivePhoneCall;
}

export interface LivePhoneEndpointOptions {
  status(): { available: boolean; busy: boolean };
  /** A new connection to this Pi's call handler; the returned stream is the relay's end of it. */
  openBridge(): Duplex;
}

export function createLivePhoneEndpoint(options: LivePhoneEndpointOptions): LivePhoneEndpoint {
  const accept = (peer: LivePhonePeer, callOptions: LivePhoneCallOptions = {}): LivePhoneCall => {
    const { voice, hostFrames, onHostFrame, onEnd } = callOptions;
    return relayLivePhoneCall(
      peer,
      async () => {
        if (!options.status().available) throw new Error("No Pi session can take a call.");
        return options.openBridge();
      },
      { voice, hostFrames, onHostFrame, onEnd, expectPid: process.pid },
    );
  };

  return {
    version: 1,
    status: () => options.status(),
    accept,
    upgrade(request, socket, head, callOptions) {
      return new Promise<LivePhoneCall>((resolve, reject) => {
        const fail = (cause: unknown) => {
          socket.destroy();
          reject(cause instanceof Error ? cause : new Error(String(cause)));
        };
        // ws answers a request it refuses (400, 405) itself and then closes the socket
        const refused = () => fail(new Error("The WebSocket handshake was refused."));
        try {
          hostFrameTypes(callOptions?.hostFrames);
          const server = new WebSocketServer({
            noServer: true,
            maxPayload: MAX_FRAME_BYTES,
            perMessageDeflate: false,
            clientTracking: false,
          });
          socket.once("close", refused);
          // the callback runs inside this call, so nothing the phone sends can arrive unheard
          server.handleUpgrade(request, socket, head, (ws) => {
            socket.off("close", refused);
            const call = accept(
              {
                send: (text) => ws.send(text, () => undefined),
                close: () => {
                  ws.close(1000);
                  setTimeout(() => ws.terminate(), CLOSE_GRACE_MS).unref();
                },
                ping: () => ws.ping(),
              },
              callOptions,
            );
            ws.on("message", (data, isBinary) =>
              call.message(isBinary ? new Uint8Array(0) : bytesOf(data).toString("utf8")),
            );
            ws.on("pong", () => call.pong());
            ws.on("close", () => call.closed());
            ws.on("error", () => undefined);
            resolve(call);
          });
        } catch (cause) {
          socket.off("close", refused);
          fail(cause);
        }
      });
    },
  };
}

function bytesOf(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  return Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
}

export function isLivePhoneEndpoint(value: unknown): value is LivePhoneEndpoint {
  if (typeof value !== "object" || value === null) return false;
  const endpoint = value as Partial<Record<keyof LivePhoneEndpoint, unknown>>;
  return (
    endpoint.version === 1 &&
    typeof endpoint.status === "function" &&
    typeof endpoint.upgrade === "function" &&
    typeof endpoint.accept === "function"
  );
}
