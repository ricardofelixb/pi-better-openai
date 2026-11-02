// Measures how a live call draws on the Codex plan. Runs one scenario of a real gpt-live-1-codex
// call fed scripted speech, hands delegations to a local pi model, and logs every raw server event
// and the plan meter. Usage:
//   node scripts/live-usage-bench.ts <scenario> [--minutes 10] [--out dir] [--model strata/qwen3.8-flash-next]
// Scenarios: baseline (no call), silent (room noise), muted (muted after connecting), nopush
// (connected, no audio sent), talk, talk-bigctx, talk-nocommentary.
// Needs `piper` on PATH and PIPER_VOICE pointing at an .onnx voice.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getCodexCredentials } from "../src/codex-auth.ts";
import { LiveSessionController, type LivePhase } from "../src/live/controller.ts";
import type { LiveMedia, LiveMediaCallbacks } from "../src/live/media.ts";
import { OUTPUT_ACTIVE_LEVEL } from "../src/live/media.ts";
import { loadLiveNative, type LiveNativeBindings } from "../src/live/native.ts";
import { CodexLiveTransport } from "../src/live/transport.ts";
import { requestCodexUsage } from "../src/usage.ts";

const SCENARIOS = [
  "baseline",
  "silent",
  "muted",
  "nopush",
  "talk",
  "talk-bigctx",
  "talk-nocommentary",
] as const;
type Scenario = (typeof SCENARIOS)[number];

const SAMPLE_RATE = 16_000;
const FRAME_SAMPLES = 320; // 20 ms
const NOISE_LEVEL = 0.002;
const METER_INTERVAL_MS = 30_000;
const TURN_GAP_MS = 8_000;
const BIG_CHAT_CHARS = 56_000;

// The same lines, in order, for every talk scenario, so their costs compare.
const SCRIPT = [
  "Hey there. What does this repository do?",
  "Which file sets up the voice connection?",
  "Nice. How's your day going?",
  "Can you count how many test files there are?",
  "What is the default voice set to?",
  "Okay, cool. Give me a one sentence summary of what we found so far.",
  "Is there a changelog in the repo? What's the latest entry?",
];

function argValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

const scenario = process.argv[2] as Scenario;
if (!SCENARIOS.includes(scenario)) {
  console.error(`usage: live-usage-bench.ts <${SCENARIOS.join("|")}> [--minutes n] [--out dir]`);
  process.exit(2);
}
const minutes = Number(argValue("--minutes", "10"));
const model = argValue("--model", "strata/qwen3.8-flash-next");
const repo = resolve(argValue("--repo", process.cwd()));
const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
const outDir = resolve(argValue("--out", join("bench-results", `${stamp}-${scenario}`)));
mkdirSync(outDir, { recursive: true });
const startedAt = Date.now();
const elapsed = () => Math.round((Date.now() - startedAt) / 100) / 10;

function log(file: string, record: Record<string, unknown>): void {
  appendFileSync(join(outDir, file), `${JSON.stringify({ t: elapsed(), ...record })}\n`);
}

async function readMeter(label: string): Promise<void> {
  try {
    const usage = (await requestCodexUsage()) as Record<string, unknown> | undefined;
    const limit = usage?.rate_limit as Record<string, Record<string, unknown> | null> | undefined;
    const credits = usage?.credits as Record<string, unknown> | undefined;
    const record = {
      label,
      fiveHour: limit?.primary_window?.used_percent ?? null,
      weekly: limit?.secondary_window?.used_percent ?? null,
      fiveHourResetIn: limit?.primary_window?.reset_after_seconds ?? null,
      credits: credits?.balance ?? null,
    };
    log("meter.jsonl", record);
    console.log(`[${elapsed()}s] meter ${label}: 5h ${record.fiveHour}% weekly ${record.weekly}%`);
  } catch (cause) {
    log("meter.jsonl", { label, error: String(cause) });
  }
}

function speech(text: string, index: number): Float32Array {
  const voice = process.env.PIPER_VOICE;
  if (!voice) throw new Error("Set PIPER_VOICE to a piper .onnx voice.");
  const wav = join(outDir, `line-${index}.wav`);
  const piper = spawnSync("piper", ["-m", voice, "-f", wav], { input: text });
  if (piper.status !== 0) throw new Error(`piper failed: ${piper.stderr}`);
  const ffmpeg = spawnSync(
    "ffmpeg",
    ["-loglevel", "error", "-i", wav, "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "-"],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  if (ffmpeg.status !== 0) throw new Error(`ffmpeg failed: ${ffmpeg.stderr}`);
  const bytes = ffmpeg.stdout;
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4).slice();
}

/** A microphone that plays queued speech and otherwise sends quiet room noise, gated like the real one. */
class ScriptedMedia implements LiveMedia {
  readonly #peer;
  readonly #queue: Float32Array[] = [];
  #timer: NodeJS.Timeout | undefined;
  #active = false;
  #muted = false;
  #outputLevel = 0;
  speechSeconds = 0;
  noiseSeconds = 0;
  sendNoise = true;

  constructor(native: LiveNativeBindings, callbacks: LiveMediaCallbacks) {
    this.#peer = new native.LiveWebRtcPeer(
      (error, payload) => (error ? callbacks.onFailure(error.message) : callbacks.onEvent(payload)),
      (error, level) => {
        if (error) return callbacks.onFailure(error.message);
        this.#outputLevel = level;
        callbacks.onLevels(0, level);
      },
      (error, message) => callbacks.onFailure(error?.message ?? message),
    );
  }

  say(samples: Float32Array): void {
    for (let offset = 0; offset < samples.length; offset += FRAME_SAMPLES) {
      this.#queue.push(samples.slice(offset, offset + FRAME_SAMPLES));
    }
  }

  get speaking(): boolean {
    return this.#queue.length > 0;
  }

  get outputActive(): boolean {
    return this.#outputLevel > OUTPUT_ACTIVE_LEVEL;
  }

  createOffer() {
    return this.#peer.createOffer();
  }
  acceptAnswer(sdp: string) {
    return this.#peer.acceptAnswer(sdp);
  }
  waitForOpen(timeoutMs?: number) {
    return this.#peer.waitForOpen(timeoutMs);
  }
  activate(): void {
    this.#active = true;
    this.#timer = setInterval(() => this.#tick(), 20);
  }
  setMuted(muted: boolean): void {
    this.#muted = muted;
    this.#peer.setMuted(muted);
  }
  async close(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#active = false;
    await this.#peer.close().catch(() => undefined);
  }

  #tick(): void {
    if (!this.#active || this.#muted) return;
    const frame = this.#queue.shift();
    if (frame) {
      this.speechSeconds += frame.length / SAMPLE_RATE;
      this.#peer.pushAudio(frame);
      return;
    }
    // the real client drops quiet input while the reply plays
    if (this.outputActive || !this.sendNoise) return;
    const noise = new Float32Array(FRAME_SAMPLES);
    for (let index = 0; index < noise.length; index += 1) {
      noise[index] = (Math.random() * 2 - 1) * NOISE_LEVEL;
    }
    this.noiseSeconds += FRAME_SAMPLES / SAMPLE_RATE;
    this.#peer.pushAudio(noise);
  }
}

function bigChat(): string {
  const source = readFileSync(join(repo, "README.md"), "utf8").replaceAll(/\s+/g, " ");
  const lines: string[] = [];
  let length = 0;
  for (let turn = 0; length < BIG_CHAT_CHARS; turn += 1) {
    const slice = source.slice(
      (turn * 700) % Math.max(1, source.length - 700),
      ((turn * 700) % Math.max(1, source.length - 700)) + 700,
    );
    const line = turn % 2 === 0 ? `User: tell me about this part: ${slice}` : `Assistant: ${slice}`;
    lines.push(line);
    length += line.length + 2;
  }
  return lines.join("\n\n").slice(0, BIG_CHAT_CHARS);
}

const summary: Record<string, unknown> = {
  scenario,
  minutes,
  model,
  repo,
  startedAt: new Date(startedAt).toISOString(),
};
const eventCounts: Record<string, number> = {};
let sentMessages = 0;
let sentChars = 0;

async function runCall(): Promise<void> {
  const native = loadLiveNative();
  let media: ScriptedMedia | undefined;
  let phase: LivePhase = "connecting";
  let lastAssistantDone = 0;
  let delegations = 0;
  let backend: ReturnType<typeof spawn> | undefined;
  const talking = scenario.startsWith("talk");
  const dropCommentary = scenario === "talk-nocommentary";
  const lines = talking
    ? SCRIPT.map((text, index) => ({ text, samples: speech(text, index) }))
    : [];
  let terminal: ((error?: Error) => void) | undefined;
  const ended = new Promise<Error | undefined>((resolveEnd) => (terminal = resolveEnd));

  const controller: LiveSessionController = new LiveSessionController({
    sessionId: crypto.randomUUID(),
    getCredentials: (signal) => getCodexCredentials(undefined, signal),
    chat: scenario === "talk-bigctx" ? bigChat() : "",
    native,
    resolveMedia: async () => (callbacks) => (media = new ScriptedMedia(native, callbacks)),
    createTransport: (options) => {
      const transport = new CodexLiveTransport({
        ...options,
        callbacks: {
          ...options.callbacks,
          onRawEvent: (source, payload) => {
            let type = "?";
            try {
              type = String((JSON.parse(payload) as { type?: unknown }).type);
            } catch {}
            eventCounts[`${source}:${type}`] = (eventCounts[`${source}:${type}`] ?? 0) + 1;
            if (type === "session.usage.updated" && source === "sideband") {
              const usage = (JSON.parse(payload) as { usage?: Record<string, unknown> }).usage;
              summary.serverUsage = usage;
              log("usage.jsonl", { usage });
            }
            // audio frames are large and only their count matters
            const audio = type.endsWith("audio.delta") || type.endsWith("input_audio.append");
            log("events.jsonl", audio ? { source, type } : { source, payload });
          },
        },
      });
      const send = transport.send.bind(transport);
      transport.send = async (message) => {
        sentMessages += 1;
        sentChars += JSON.stringify(message).length;
        log("sent.jsonl", { message });
        return send(message);
      };
      return transport;
    },
    delegate: (request) => {
      delegations += 1;
      log("delegations.jsonl", { request });
      console.log(`[${elapsed()}s] delegation: ${request.slice(0, 120)}`);
      backend = spawn(
        "pi",
        [
          "--mode",
          "json",
          "-p",
          "--no-session",
          "--no-extensions",
          "--no-mcp",
          "-t",
          "read,bash",
          "--model",
          model,
          request,
        ],
        { cwd: repo, stdio: ["ignore", "pipe", "ignore"] },
      );
      let buffer = "";
      backend.stdout!.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          let event: { type?: string; message?: { role?: string; stopReason?: string } };
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          if (event.type === "message_end") {
            if (dropCommentary && event.message?.stopReason === "toolUse") continue;
            controller.handleAgentMessage(event.message);
          } else if (event.type === "agent_settled") {
            controller.handleAgentSettled();
          }
        }
      });
    },
    callbacks: {
      onPhase: (next) => {
        phase = next;
        log("phases.jsonl", { phase: next });
      },
      onLevels: () => undefined,
      onTranscript: (transcript) => {
        if (!transcript?.final) return;
        if (transcript.role === "assistant") lastAssistantDone = Date.now();
        log("transcript.jsonl", { ...transcript });
        console.log(`[${elapsed()}s] ${transcript.role}: ${transcript.text}`);
      },
      onTerminal: (error) => terminal?.(error),
    },
  });

  await controller.start();
  if (scenario === "muted") controller.toggleMute();
  if (scenario === "nopush" && media) media.sendNoise = false;
  const connectedAt = Date.now();
  log("phases.jsonl", { phase: "connected" });
  const deadline = startedAt + minutes * 60_000;
  let next = 0;
  let spokeAt = 0;
  const loop = setInterval(() => {
    if (!media || next >= lines.length || media.speaking || media.outputActive) return;
    if (phase !== "listening" || Date.now() - lastAssistantDone < TURN_GAP_MS) return;
    if (spokeAt > lastAssistantDone) return; // still waiting for the reply to the last line
    console.log(`[${elapsed()}s] user (scripted): ${lines[next]!.text}`);
    media.say(lines[next]!.samples);
    spokeAt = Date.now();
    next += 1;
  }, 500);
  const error = await Promise.race([
    ended,
    new Promise<undefined>((done) => setTimeout(done, Math.max(0, deadline - Date.now()))),
  ]);
  clearInterval(loop);
  const connectedSeconds = Math.round((Date.now() - connectedAt) / 1000);
  backend?.kill();
  await controller.stop().catch(() => undefined);
  Object.assign(summary, {
    connectedSeconds,
    linesSpoken: next,
    delegations,
    speechSeconds: Math.round(media?.speechSeconds ?? 0),
    noiseSeconds: Math.round(media?.noiseSeconds ?? 0),
    sentMessages,
    sentChars,
    error: error?.message,
  });
}

await readMeter("start");
const meter = setInterval(() => void readMeter("tick"), METER_INTERVAL_MS);
try {
  if (scenario === "baseline") {
    await new Promise((done) => setTimeout(done, minutes * 60_000));
  } else {
    await runCall();
  }
} finally {
  clearInterval(meter);
  // the meter can lag the call, so read it once more after a pause
  await new Promise((done) => setTimeout(done, 60_000));
  await readMeter("end");
  summary.eventCounts = eventCounts;
  summary.endedAt = new Date().toISOString();
  writeFileSync(join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}
