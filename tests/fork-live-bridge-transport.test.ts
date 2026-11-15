import { beforeEach, expect, test, vi } from "vitest";
import {
  CodexLiveTransport,
  type LiveMedia,
  type LiveMediaCallbacks,
} from "../src/live/transport.ts";
import type { LiveNativeBindings } from "../src/live/native.ts";
import { LiveSessionController } from "../src/live/controller.ts";
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), attestation: vi.fn() }));
vi.mock("undici", () => ({
  fetch: mocks.fetch,
  ProxyAgent: class {
    close = async () => undefined;
  },
}));
vi.mock("../src/live/attestation.ts", () => ({ generateCodexAttestation: mocks.attestation }));
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    default: class extends EventEmitter {
      static CONNECTING = 0;
      static OPEN = 1;
      readyState = 0;
      constructor() {
        super();
        queueMicrotask(() => {
          this.readyState = 1;
          this.emit("open");
        });
      }
      send = vi.fn();
      close = vi.fn(() => {
        this.readyState = 3;
      });
      terminate = vi.fn();
    },
  };
});
const native = {
  AudioCapture: class {
    constructor() {
      throw new Error("must not capture local audio");
    }
  },
  LiveWebRtcPeer: class {
    constructor() {
      throw new Error("must not create local peer");
    }
  },
  deviceCheckGenerateToken: vi.fn(),
  __ompInstallTokioRuntime: vi.fn(),
} as unknown as LiveNativeBindings;
function fakeMedia() {
  let callbacks: LiveMediaCallbacks;
  const media: LiveMedia = {
    createOffer: vi.fn(async () => "offer-sdp"),
    acceptAnswer: vi.fn(async () => undefined),
    waitForOpen: vi.fn(async () => undefined),
    activate: vi.fn(),
    setMuted: vi.fn(),
    close: vi.fn(async () => undefined),
  };
  const createMedia = vi.fn((next: LiveMediaCallbacks, signal?: AbortSignal) => {
    callbacks = next;
    expect(signal).toBeInstanceOf(AbortSignal);
    return media;
  });
  return { media, createMedia, callbacks: () => callbacks };
}
function transportFor(fake: ReturnType<typeof fakeMedia>) {
  const callbacks = { onEvent: vi.fn(), onOutputLevel: vi.fn(), onInputLevel: vi.fn() };
  return {
    callbacks,
    transport: new CodexLiveTransport({
      getCredentials: async () => ({ accessToken: "secret-token", accountId: "acct_test" }),
      sessionId: "session",
      instructions: "brief",
      voice: "vale",
      native,
      createMedia: fake.createMedia,
      callbacks,
    }),
  };
}
beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.attestation.mockReset();
  mocks.attestation.mockResolvedValue("host-attestation");
  mocks.fetch.mockImplementation(
    async () =>
      new Response("answer-sdp", {
        status: 201,
        headers: { location: "https://api.openai.com/v1/live/rtc_call-1" },
      }),
  );
});
test("injected media negotiates SDP and activates without seeing credentials", async () => {
  const fake = fakeMedia();
  const { transport } = transportFor(fake);
  transport.setMuted(true);
  await transport.connect();
  expect(fake.createMedia).toHaveBeenCalledOnce();
  expect(fake.media.acceptAnswer).toHaveBeenCalledWith("answer-sdp");
  expect(fake.media.waitForOpen).toHaveBeenCalledOnce();
  expect(fake.media.activate).toHaveBeenCalledOnce();
  expect(fake.media.setMuted).toHaveBeenCalledWith(true);
  expect(mocks.attestation).toHaveBeenCalledWith(native);
  const [, init] = mocks.fetch.mock.calls[0]!;
  expect(init.headers.Authorization).toBe("Bearer secret-token");
  const seen = JSON.stringify([
    fake.createMedia.mock.calls.map(([cb]) => Object.keys(cb)),
    vi.mocked(fake.media.acceptAnswer).mock.calls,
  ]);
  expect(seen).not.toContain("secret-token");
  expect(seen).not.toContain("host-attestation");
  transport.setMuted(false);
  expect(fake.media.setMuted).toHaveBeenLastCalledWith(false);
  await transport.close();
  expect(fake.media.close).toHaveBeenCalledOnce();
});
test("injected levels and failures reach the controller boundary, but go quiet on close", async () => {
  const fake = fakeMedia();
  const { transport, callbacks } = transportFor(fake);
  await transport.connect();
  fake.callbacks().onLevels(0.25, 0.75);
  expect(callbacks.onInputLevel).toHaveBeenCalledWith(0.25);
  expect(callbacks.onOutputLevel).toHaveBeenCalledWith(0.75);
  fake.callbacks().onEvent('{"type":"session.started"}');
  expect(callbacks.onEvent).not.toHaveBeenCalled();
  fake.callbacks().onFailure("lost");
  fake.callbacks().onFailure("again");
  expect(callbacks.onEvent).toHaveBeenCalledExactlyOnceWith({ type: "error", message: "lost" });
  await transport.close();
  fake.callbacks().onLevels(0.5, 0.5);
  expect(callbacks.onInputLevel).toHaveBeenCalledTimes(1);
});
test("signaling failure closes the injected media without activating it", async () => {
  mocks.fetch.mockResolvedValueOnce(new Response("nope", { status: 500 }));
  const fake = fakeMedia();
  const { transport } = transportFor(fake);
  await expect(transport.connect()).rejects.toThrow("Codex live signaling failed (500)");
  expect(fake.media.close).toHaveBeenCalledOnce();
  expect(fake.media.activate).not.toHaveBeenCalled();
});
test("the controller passes media through and never opens native capture", async () => {
  const fake = fakeMedia();
  const callbacks = {
    onPhase: vi.fn(),
    onLevels: vi.fn(),
    onTranscript: vi.fn(),
    onTerminal: vi.fn(),
  };
  const controller = new LiveSessionController({
    sessionId: "session",
    getCredentials: async () => ({ accessToken: "secret-token", accountId: "acct_test" }),
    native,
    createMedia: fake.createMedia,
    delegate: vi.fn(),
    callbacks,
  });
  await controller.start();
  fake.callbacks().onLevels(0.25, 0.75);
  expect(callbacks.onLevels).toHaveBeenLastCalledWith(0.25, 0.75);
  controller.toggleMute();
  expect(fake.media.setMuted).toHaveBeenLastCalledWith(true);
  await controller.stop();
  expect(fake.media.close).toHaveBeenCalledOnce();
});
