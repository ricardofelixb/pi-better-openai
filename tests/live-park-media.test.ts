import { describe, expect, test, vi } from "vitest";
import { createBridgeMediaFactory } from "../src/live/bridge/media.ts";
import { connectedPair, LiveBridgeConnection } from "../src/live/bridge/socket.ts";
import type { LiveMediaCallbacks } from "../src/live/media.ts";

type Frame = Record<string, unknown> & { type: string };

/** A phone on the far end of a bridge connection: it answers every request, and logs what it hears. */
function phone(features?: string[]) {
  const [far, near] = connectedPair();
  const connection = new LiveBridgeConnection(near);
  const heard: Frame[] = [];
  let buffered = "";
  const say = (frame: Record<string, unknown>) => far.write(`${JSON.stringify({ v: 1, ...frame })}\n`);
  far.setEncoding("utf8");
  far.on("data", (chunk: string) => {
    buffered += chunk;
    for (let end = buffered.indexOf("\n"); end !== -1; end = buffered.indexOf("\n")) {
      const frame = JSON.parse(buffered.slice(0, end)) as Frame;
      buffered = buffered.slice(end + 1);
      heard.push(frame);
      if (frame.type === "request") {
        say({
          type: "response",
          id: frame.id,
          ok: true,
          ...(frame.method === "createOffer" ? { sdp: "offer-sdp" } : {}),
        });
      }
    }
  });
  say({ type: "start" });
  say(features === undefined ? { type: "hello" } : { type: "hello", features });
  const types = () => heard.map((frame) => frame.type);
  const methods = () => heard.filter((frame) => frame.type === "request").map((f) => f.method);
  return { connection, say, heard, types, methods };
}

function callbacks(): LiveMediaCallbacks & { events: string[]; failures: string[] } {
  const events: string[] = [];
  const failures: string[] = [];
  return {
    events,
    failures,
    onEvent: (payload) => void events.push(payload),
    onLevels: vi.fn(),
    onFailure: (message) => void failures.push(message),
  };
}

describe("what the phone says it can do", () => {
  test("is known once its hello has been heard, and is nothing before", async () => {
    const quiet = phone(["park", "usage", "something-new"]);
    expect([...quiet.connection.features]).toEqual([]);
    await vi.waitFor(() =>
      expect([...quiet.connection.features]).toEqual(["park", "usage", "something-new"]),
    );

    const old = phone();
    createBridgeMediaFactory(old.connection)(callbacks());
    await vi.waitFor(() => expect(old.types()).toContain("request"));
    expect([...old.connection.features]).toEqual([]);
  });
});

describe("media that a phone parks", () => {
  test("tells the phone to park, and brings the same devices back without opening again", async () => {
    const far = phone(["park"]);
    const factory = createBridgeMediaFactory(far.connection);
    const first = callbacks();
    const media = factory(first);
    expect(await media.createOffer()).toBe("offer-sdp");
    media.activate();
    await vi.waitFor(() => expect(far.types()).toContain("activate"));

    await media.park!();
    await vi.waitFor(() => expect(far.types()).toContain("park"));
    expect(far.types()).not.toContain("close");

    const second = callbacks();
    const again = factory(second);
    expect(again).toBe(media);
    expect(await again.createOffer()).toBe("offer-sdp");
    again.activate();
    await vi.waitFor(() => expect(far.types().filter((type) => type === "activate")).toHaveLength(2));
    expect(far.methods()).toEqual(["open", "createOffer", "createOffer"]);

    // the session that parked hears nothing more; the fresh one hears the phone
    far.say({ type: "event", payload: "after-resume" });
    await vi.waitFor(() => expect(second.events).toEqual(["after-resume"]));
    expect(first.events).toEqual([]);

    await again.close();
    expect(far.types()).toContain("close");
  });

  test("ignores what the phone sends while parked, and a failure then ends the media", async () => {
    const far = phone(["park"]);
    const factory = createBridgeMediaFactory(far.connection);
    const first = callbacks();
    const media = factory(first);
    await media.createOffer();
    await media.park!();

    far.say({ type: "event", payload: "late" });
    far.say({ type: "levels", input: 0.5, output: 0 });
    far.say({ type: "failure", message: "microphone lost" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(first.events).toEqual([]);
    expect(first.failures).toEqual([]);

    expect(() => factory(callbacks())).toThrow("microphone lost");
  });

  test("carries one call at a time, and a parked one is not carried over a closed connection", async () => {
    const far = phone(["park"]);
    const factory = createBridgeMediaFactory(far.connection);
    const media = factory(callbacks());
    await media.createOffer();
    // not parked: a second session on the same devices is a mistake, not a resume
    expect(() => factory(callbacks())).toThrow("The phone connection carries one call.");

    await media.close();
    expect(() => factory(callbacks())).toThrow();
  });
});
