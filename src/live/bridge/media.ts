import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import type { LiveMediaFactory } from "../media.ts";
import { createRemoteMediaFactory, type RemoteMediaProcess } from "../remote/client.ts";
import type { LiveBridgeConnection } from "./socket.ts";

/**
 * The phone as the remote media client's "process": the client writes its requests to the
 * connection and reads the phone's answers from it. The phone closes its own devices on the
 * `close` frame, so ending the input is all the exit this process has.
 */
export function bridgeMediaProcess(connection: LiveBridgeConnection): RemoteMediaProcess {
  const events = new EventEmitter();
  let exited = false;
  const exit = (code: number | null, signal: NodeJS.Signals | null) => {
    if (exited) return;
    exited = true;
    events.emit("exit", code, signal);
  };
  const stdin = new Writable({
    write(chunk: Buffer | string, _encoding, done) {
      connection.write(chunk.toString());
      done();
    },
    final(done) {
      exit(0, null);
      done();
    },
  });
  return {
    stdin,
    stdout: connection.output,
    stderr: null,
    kill(signal) {
      exit(null, signal ?? "SIGTERM");
      return true;
    },
    once(event: string, listener: Parameters<EventEmitter["once"]>[1]) {
      events.once(event, listener);
      return this;
    },
  } as RemoteMediaProcess;
}

/** Media over one phone connection; a connection carries one call. */
export function createBridgeMediaFactory(connection: LiveBridgeConnection): LiveMediaFactory {
  let used = false;
  return createRemoteMediaFactory(() => {
    if (used) throw new Error("The phone connection carries one call.");
    used = true;
    return bridgeMediaProcess(connection);
  });
}
