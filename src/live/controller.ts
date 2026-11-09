import type { CodexCredentials } from "../codex-auth.ts";
import { typedContext, withChat } from "./context.ts";
import { type LiveMediaFactory, OUTPUT_ACTIVE_LEVEL } from "./media.ts";
import { loadLiveNative, type LiveNativeBindings } from "./native.ts";
import {
  buildDelegationContextAppend,
  buildSessionClose,
  buildSessionContextAppend,
  chunkLiveContext,
  type LiveClientMessage,
  type LiveServerEvent,
} from "./protocol.ts";
import { CodexLiveTransport, type LiveTransportOptions } from "./transport.ts";
import { DEFAULT_LIVE_VOICE } from "./voices.ts";

const LIVE_INSTRUCTIONS = `# Role and Objective
You are Better OpenAI Live, the voice of the same assistant the user has been chatting with in this session's text pane, which is also a coding assistant. You and that chat are one assistant with one memory, not separate agents. The chat in the Context below is your own memory of what you and the user said and did, not background about someone else. Never say you don't have the earlier chat or ask the user to repeat it.

# Personality and Tone
The user is speaking to you. Respond directly, briefly, conversationally, and in speech-friendly language. Never use markdown, code blocks, or long lists unless the user explicitly asks you to read technical detail aloud.

# Tools
The client has the active repository context, coding model, and tools. Create a client delegation promptly when the answer needs fresh work or status the chat does not hold: coding, repository investigation, tool use, commands, verification, or finding out whether something has changed since the chat's latest turns. Include the complete request and relevant conversational context. Keep conversation natural while work runs.

Treat delegation context as your own internal progress and result. Never mention a backend, delegation, protocol, or another assistant. Commentary context is silent progress and must not be recited. Context beginning with "Agent Final Message": is the final visible answer from your execution surface; present its useful result naturally as your own.

For greetings, clarification, questions the chat already answers, or ordinary conversation that needs no tools, answer directly without delegating. Preserve one-assistant continuity: converse here, delegate execution, then communicate the returned result as your own.

# Long Context Behavior
These instructions and the Context below reach you as silent context when the call starts. Do not react to them, read them out or speak until the user does.

Current State holds the latest turns of the chat. Short or vague things the user says, such as "is it fixed", "how are we doing", "that thing", "are we done" or "what happened", are about it. Answer them from there, in your own words, as the one who was just in that conversation. Never ask what they mean or what you are talking about when the chat answers it. If the chat leaves it open, say what you last knew and what you take them to mean.

Historical or Background Sources holds the older chat. Use it for what was said or done earlier. When it conflicts with Current State, Current State wins.`;

export type LivePhase =
  | "standby"
  | "connecting"
  | "listening"
  | "working"
  | "speaking"
  | "muted"
  | "parked"
  | "error";

export interface LiveTranscript {
  role: "user" | "assistant";
  text: string;
  turn: number;
  final: boolean;
}

export interface LiveInstructionsEcho {
  sent: number;
  echoed: number;
}

export interface LiveSessionCallbacks {
  onPhase(phase: LivePhase): void;
  onLevels(input: number, output: number): void;
  onTranscript(transcript: LiveTranscript | undefined): void;
  onTerminal(error?: Error): void;
  /**
   * The instructions the server echoed in a session event, in characters, against what was sent,
   * so a cut it made without saying shows. Only when the server echoes them.
   */
  onInstructionsEcho?(echo: LiveInstructionsEcho): void;
  /**
   * The seconds this call has been connected, which is what a plan is billed, summed over its
   * sessions. On every server update and again when a session ends.
   */
  onUsage?(seconds: number): void;
}

export interface LiveTransport {
  connect(): Promise<void>;
  send(message: LiveClientMessage): Promise<void>;
  setMuted(muted: boolean): void;
  /** Absent on transports without playback control. */
  setPlaybackMuted?(muted: boolean): void;
  close(): Promise<void>;
  /** Like close, but media that can wait keeps its devices for the next session. */
  park?(): Promise<void>;
}

export interface LiveSessionControllerOptions {
  sessionId: string;
  getCredentials(signal?: AbortSignal): Promise<CodexCredentials | undefined>;
  delegate(request: string): void;
  callbacks: LiveSessionCallbacks;
  /**
   * The session's text chat so far, which the voice starts out knowing. A function is asked each
   * time a session opens, so one that follows a park hears what happened meanwhile.
   */
  chat?: string | (() => string);
  /** Seconds without speech or work after which the call hangs up as the user would; 0 never. */
  idleHangupSeconds?: number;
  /**
   * Seconds a delegation may run with nobody speaking before the session is closed, which stops
   * the meter; the call stays, and a fresh session says the result. 0 never.
   */
  parkAfterSeconds?: number;
  /** Whether the call can wait without its session. Asked each time; a phone says in its hello. */
  canPark?(): boolean;
  voice?: string;
  signal?: AbortSignal;
  native?: LiveNativeBindings;
  createTransport?: (options: LiveTransportOptions) => LiveTransport;
  /**
   * Chooses where the media of this session lives, each time it starts. Undefined keeps the
   * default, this computer; a refusal fails the start before anything is opened.
   */
  resolveMedia?(signal?: AbortSignal): Promise<LiveMediaFactory | undefined>;
}

type AssistantSnapshot = {
  text: string;
  stopReason: string | undefined;
  errorMessage: string | undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorFrom(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

export function extractAssistantSnapshot(message: unknown): AssistantSnapshot | undefined {
  if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
    return undefined;
  }
  const text = message.content
    .filter((item) => isRecord(item) && item.type === "text" && typeof item.text === "string")
    .map((item) => String(item.text))
    .join("\n")
    .trim();
  return {
    text,
    stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
    errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
  };
}

export class LiveSessionController {
  readonly #options: LiveSessionControllerOptions;
  readonly #callbacks: LiveSessionCallbacks;
  readonly #voice: string;
  readonly #createTransport: (options: LiveTransportOptions) => LiveTransport;
  #native: LiveNativeBindings | undefined;
  #transport: LiveTransport | undefined;
  #sendChain: Promise<void> = Promise.resolve();
  #stopPromise: Promise<void> | undefined;
  #started = false;
  #stopped = false;
  #terminalEmitted = false;
  #failure: Error | undefined;
  #muted = false;
  #awaitingUserSpeech = true;
  #phase: LivePhase = "connecting";
  #inputLevel = 0;
  #outputLevel = 0;
  #activeDelegationId: string | undefined;
  #pendingAgentFinal = "";
  #userTranscript = "";
  #assistantTranscript = "";
  #userTranscriptFinal = false;
  #assistantTranscriptFinal = false;
  #userTranscriptTurn = 0;
  #assistantTranscriptTurn = 0;
  #lastTranscript: LiveTranscript | undefined;
  #sessionNumber = 0;
  /** Connected and not parking: the session is there to be spoken to and is being billed. */
  #sessionLive = false;
  #parked = false;
  #resuming = false;
  /** A delegation of a session that has closed: its result goes in as plain context. */
  #delegationDetached = false;
  #pendingResult: string | undefined;
  #lastActivity = 0;
  #timer: NodeJS.Timeout | undefined;
  #billedSeconds = 0;
  #sessionStartedAt: number | undefined;
  #reportedMs = 0;
  #reportedAt = 0;
  #instructionsSent = 0;
  #instructionsEcho: LiveInstructionsEcho | undefined;

  constructor(options: LiveSessionControllerOptions) {
    this.#options = options;
    this.#callbacks = options.callbacks;
    this.#voice = options.voice?.trim() || DEFAULT_LIVE_VOICE;
    this.#native = options.native;
    this.#createTransport =
      options.createTransport ?? ((transportOptions) => new CodexLiveTransport(transportOptions));
  }

  get phase(): LivePhase {
    return this.#phase;
  }

  get muted(): boolean {
    return this.#muted;
  }

  /** The latest echo of the instructions the server reported; undefined until it has. */
  get instructionsEcho(): LiveInstructionsEcho | undefined {
    return this.#instructionsEcho;
  }

  get activeDelegationId(): string | undefined {
    return this.#activeDelegationId;
  }

  async start(): Promise<void> {
    if (this.#stopped) {
      throw this.#failure ?? new Error("This live session has already stopped.");
    }
    if (this.#started) return;
    this.#started = true;
    this.#emitPhase("connecting", true);
    this.#emitTranscript(undefined);

    try {
      await this.#openSession();
    } catch (cause) {
      const error = errorFrom(cause);
      this.#reportFailure(error);
      await this.stop();
      throw error;
    }
  }

  /** Brings a parked call back with a fresh session, ahead of the agent finishing. */
  resume(): void {
    if (!this.#parked) return;
    this.#delegationDetached = this.#activeDelegationId !== undefined;
    void this.#resume();
  }

  async #openSession(): Promise<void> {
    // Awaited only when there is something to wait for, so the default path keeps its timing.
    const createMedia = this.#options.resolveMedia
      ? await this.#options.resolveMedia(this.#options.signal)
      : undefined;
    if (this.#stopped) {
      throw this.#failure ?? new Error("The live session stopped while connecting.");
    }
    const native = this.#native ?? loadLiveNative();
    this.#native = native;
    const chat = this.#options.chat;
    const instructions = withChat(
      LIVE_INSTRUCTIONS,
      typeof chat === "function" ? chat() : (chat ?? ""),
    );
    this.#instructionsSent = instructions.length;
    this.#awaitingUserSpeech = true;
    const session = ++this.#sessionNumber;
    const transport = this.#createTransport({
      getCredentials: this.#options.getCredentials,
      sessionId: this.#options.sessionId,
      instructions,
      voice: this.#voice,
      signal: this.#options.signal,
      native,
      ...(createMedia ? { createMedia } : {}),
      callbacks: {
        onEvent: (event) => this.#guardEvent(session, () => this.#handleLiveEvent(event)),
        onLevels: (input, output) =>
          this.#guardEvent(session, () => this.#handleLevels(input, output)),
      },
    });
    this.#transport = transport;
    // before connecting, which is what opens the microphone: a muted call is never heard unmuted
    transport.setMuted(this.#muted);
    transport.setPlaybackMuted?.(true);
    await transport.connect();
    if (this.#stopped)
      throw this.#failure ?? new Error("The live session stopped while connecting.");
    this.#sessionStartedAt ??= Date.now();
    this.#sessionLive = true;
    this.#touch();
    // the endpoint does not act on the session's instructions (measured), but does on context
    for (const chunk of chunkLiveContext(instructions))
      this.#queueSend(buildSessionContextAppend(chunk, "commentary"));
    this.#sayPendingResult();
    this.#refreshAudioPhase();
    this.#armTimer();
  }

  async #resume(): Promise<void> {
    if (this.#resuming || this.#stopped) return;
    this.#resuming = true;
    this.#parked = false;
    this.#emitPhase("connecting");
    try {
      await this.#openSession();
    } catch (cause) {
      this.#reportFailure(errorFrom(cause));
    } finally {
      this.#resuming = false;
    }
  }

  /** Closes the session to stop the meter, and keeps the call for a fresh one. */
  async #park(): Promise<void> {
    const transport = this.#transport;
    if (!transport || !this.#sessionLive || this.#stopped) return;
    this.#sessionLive = false;
    this.#clearTimer();
    this.#transport = undefined;
    this.#endSession();
    this.#inputLevel = 0;
    this.#outputLevel = 0;
    this.#emitLevels();
    try {
      await this.#sendChain;
      await transport.send(buildSessionClose()).catch(() => undefined);
      await (transport.park ? transport.park() : transport.close());
    } catch (cause) {
      this.#reportFailure(errorFrom(cause));
      return;
    }
    if (this.#stopped) return;
    this.#parked = true;
    this.#emitPhase("parked", true);
    // the agent finished while the session was closing
    if (this.#pendingResult !== undefined) void this.#resume();
  }

  toggleMute(): void {
    if (this.#stopped) return;
    this.#muted = !this.#muted;
    if (this.#muted) {
      this.#inputLevel = 0;
      this.#emitLevels();
    }
    this.#refreshAudioPhase();
    try {
      this.#transport?.setMuted(this.#muted);
    } catch (cause) {
      this.#reportFailure(errorFrom(cause));
    }
  }

  handleAgentMessage(message: unknown): void {
    if (this.#stopped) return;
    const snapshot = extractAssistantSnapshot(message);
    if (!this.#activeDelegationId || !snapshot) {
      // typed in the chat, or answered there without the call asking: the voice knows, silently
      if (snapshot?.stopReason === "toolUse") return;
      const context = typedContext(message);
      if (context) {
        for (const chunk of chunkLiveContext(context))
          this.#queueSend(buildSessionContextAppend(chunk));
      }
      return;
    }
    if (snapshot.stopReason === "toolUse") {
      // a detached delegation belongs to a session that has closed, and the new one never heard of it
      if (!snapshot.text || this.#delegationDetached) return;
      for (const chunk of chunkLiveContext(snapshot.text)) {
        this.#queueSend(
          buildDelegationContextAppend(this.#activeDelegationId, chunk, "commentary"),
        );
      }
      return;
    }
    if (snapshot.text) this.#pendingAgentFinal = snapshot.text;
    else if (snapshot.errorMessage) this.#pendingAgentFinal = snapshot.errorMessage;
  }

  handleAgentSettled(): void {
    const delegationId = this.#activeDelegationId;
    if (!delegationId || this.#stopped) return;
    const finalText =
      this.#pendingAgentFinal || "The requested coding task ended without a final response.";
    const context = `"Agent Final Message":\n\n${finalText}`;
    const detached = this.#delegationDetached;
    this.#activeDelegationId = undefined;
    this.#delegationDetached = false;
    this.#pendingAgentFinal = "";
    if (this.#parked) {
      this.#pendingResult = context;
      void this.#resume();
    } else if (!this.#sessionLive) {
      this.#pendingResult = context;
    } else if (detached) {
      this.#sayResult(context);
    } else {
      for (const chunk of chunkLiveContext(context)) {
        this.#queueSend(buildDelegationContextAppend(delegationId, chunk));
      }
    }
    this.#touch();
    this.#refreshAudioPhase();
    this.#armTimer();
  }

  /** The result of work the session did not hear started, as context the voice says unprompted. */
  #sayResult(context: string): void {
    for (const chunk of chunkLiveContext(context)) {
      this.#queueSend(buildSessionContextAppend(chunk, "speakable"));
    }
  }

  #sayPendingResult(): void {
    const context = this.#pendingResult;
    this.#pendingResult = undefined;
    if (context !== undefined) this.#sayResult(context);
  }

  stop(): Promise<void> {
    if (!this.#stopPromise) this.#stopPromise = this.#stop();
    return this.#stopPromise;
  }

  async #stop(): Promise<void> {
    this.#stopped = true;
    let cleanupError: Error | undefined;
    // Stop forwarding the microphone now; the transport releases capture when it closes.
    try {
      this.#transport?.setMuted(true);
    } catch (cause) {
      cleanupError = errorFrom(cause);
    }

    this.#sessionLive = false;
    this.#clearTimer();
    await this.#sendChain;
    const transport = this.#transport;
    this.#transport = undefined;
    this.#endSession();
    if (transport) {
      try {
        await transport.send(buildSessionClose());
      } catch (cause) {
        cleanupError ??= errorFrom(cause);
      }
      try {
        await transport.close();
      } catch (cause) {
        cleanupError ??= errorFrom(cause);
      }
    }
    if (cleanupError) this.#emitPhaseSafely("error");
    this.#emitTerminal(this.#failure ?? cleanupError);
  }

  #guardEvent(session: number, handler: () => void): void {
    if (this.#stopped || session !== this.#sessionNumber) return;
    try {
      handler();
    } catch (cause) {
      this.#reportFailure(errorFrom(cause));
    }
  }

  #handleLiveEvent(event: LiveServerEvent): void {
    switch (event.type) {
      case "session.started":
        this.#sessionStartedAt ??= Date.now();
        this.#echoInstructions(event.session.instructions);
        this.#emitPhase("listening");
        break;
      case "session.usage.updated":
        this.#reportedMs = event.usage.audio_duration_ms;
        this.#reportedAt = Date.now();
        this.#emitUsage();
        break;
      case "input_transcript.added":
        this.#hearUser(event.item.text);
        this.#touch();
        this.#addTranscript("user", event.item.text);
        break;
      case "output_transcript.added":
        if (this.#awaitingUserSpeech) break;
        this.#touch();
        this.#addTranscript("assistant", event.item.text);
        break;
      case "turn.done":
        if (event.turn.role === "user") this.#hearUser(event.turn.transcript);
        else if (this.#awaitingUserSpeech) break;
        this.#touch();
        this.#finishTranscript(event.turn.role, event.turn.transcript);
        break;
      case "delegation.created":
        this.#handleDelegation(event);
        break;
      case "error":
        this.#reportFailure(new Error(event.message));
        break;
      case "session.updated":
        this.#echoInstructions(event.session.instructions);
        this.#touch();
        break;
      case "output_audio.delta":
        if (this.#awaitingUserSpeech) break;
        this.#touch();
        break;
      case "unknown":
        break;
    }
  }

  #hearUser(text: string): void {
    if (!this.#awaitingUserSpeech || !text.trim()) return;
    this.#awaitingUserSpeech = false;
    this.#transport?.setPlaybackMuted?.(false);
  }

  #echoInstructions(echoed: string | undefined): void {
    if (echoed === undefined) return;
    this.#instructionsEcho = {
      sent: this.#instructionsSent,
      echoed: echoed.length,
    };
    this.#callbacks.onInstructionsEcho?.(this.#instructionsEcho);
  }

  #handleDelegation(event: Extract<LiveServerEvent, { type: "delegation.created" }>): void {
    const request = event.item.content
      .filter((content) => content.type === "input_text")
      .map((content) => content.text)
      .join("\n")
      .trim();
    if (!request) return;
    this.#activeDelegationId = event.item.id;
    this.#pendingAgentFinal = "";
    this.#touch();
    this.#armTimer();
    this.#emitPhase("working");
    try {
      this.#options.delegate(request);
    } catch (cause) {
      this.#reportFailure(errorFrom(cause));
    }
  }

  #handleLevels(input: number, output: number): void {
    if (this.#awaitingUserSpeech) output = 0;
    const outputChanged = output !== this.#outputLevel;
    this.#inputLevel = input;
    this.#outputLevel = output;
    if (output > OUTPUT_ACTIVE_LEVEL) this.#touch();
    this.#emitLevels();
    if (outputChanged && !this.#activeDelegationId) this.#refreshAudioPhase();
  }

  #addTranscript(role: LiveTranscript["role"], text: string): void {
    if (!text) return;
    const current = role === "user" ? this.#userTranscript : this.#assistantTranscript;
    const wasFinal = role === "user" ? this.#userTranscriptFinal : this.#assistantTranscriptFinal;
    let next: string;
    if (!current) {
      this.#startTranscriptTurn(role);
      next = text;
    } else if (wasFinal) {
      if (text === current || current.endsWith(text)) return;
      this.#startTranscriptTurn(role);
      next = text;
    } else if (text.startsWith(current)) {
      next = text;
    } else if (current.endsWith(text)) {
      next = current;
    } else {
      next = current + text;
    }
    this.#storeTranscript(role, next, false);
  }

  #finishTranscript(role: LiveTranscript["role"], text: string): void {
    if (!text) return;
    const current = role === "user" ? this.#userTranscript : this.#assistantTranscript;
    const wasFinal = role === "user" ? this.#userTranscriptFinal : this.#assistantTranscriptFinal;
    if (!current) this.#startTranscriptTurn(role);
    else if (wasFinal) {
      if (text === current) return;
      this.#startTranscriptTurn(role);
    }
    const next =
      !wasFinal && current.startsWith(text) && current.length > text.length ? current : text;
    this.#storeTranscript(role, next, true);
  }

  #startTranscriptTurn(role: LiveTranscript["role"]): void {
    if (role === "user") this.#userTranscriptTurn += 1;
    else this.#assistantTranscriptTurn += 1;
  }

  #storeTranscript(role: LiveTranscript["role"], text: string, final: boolean): void {
    const normalized = text.trim();
    if (!normalized) return;
    const turn = role === "user" ? this.#userTranscriptTurn : this.#assistantTranscriptTurn;
    if (role === "user") {
      this.#userTranscript = normalized;
      this.#userTranscriptFinal = final;
    } else {
      this.#assistantTranscript = normalized;
      this.#assistantTranscriptFinal = final;
    }
    if (
      this.#lastTranscript?.role === role &&
      this.#lastTranscript.turn === turn &&
      this.#lastTranscript.text === normalized &&
      this.#lastTranscript.final === final
    ) {
      return;
    }
    this.#emitTranscript({ role, turn, text: normalized, final });
  }

  #queueSend(message: LiveClientMessage): void {
    const transport = this.#transport;
    if (!transport || !this.#sessionLive || this.#stopped) return;
    this.#sendChain = this.#sendChain
      .then(async () => {
        if (!this.#stopped) await transport.send(message);
      })
      .catch((cause) => this.#reportFailure(errorFrom(cause)));
  }

  #refreshAudioPhase(): void {
    // a parked or connecting call has its own phase; mute is remembered for the next session
    if (this.#stopped || this.#parked || !this.#sessionLive) return;
    if (this.#muted) this.#emitPhase("muted");
    else if (this.#activeDelegationId) this.#emitPhase("working");
    else if (this.#outputLevel > OUTPUT_ACTIVE_LEVEL) this.#emitPhase("speaking");
    else this.#emitPhase("listening");
  }

  /** Something was said, or work began or ended: the call is not idle. */
  #touch(): void {
    this.#lastActivity = Date.now();
  }

  #clearTimer(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /**
   * What the quiet is waiting to do: park while a delegation runs, hang up while nothing does.
   * Asked again when the timer fires, so a phone that cannot park never gets a park armed.
   */
  #quietAction(): { action: "park" | "hangup"; seconds: number } | undefined {
    if (!this.#sessionLive || this.#stopped) return undefined;
    if (this.#activeDelegationId !== undefined) {
      const seconds = this.#options.parkAfterSeconds ?? 0;
      return seconds > 0 && (this.#options.canPark?.() ?? true)
        ? { action: "park", seconds }
        : undefined;
    }
    const seconds = this.#options.idleHangupSeconds ?? 0;
    return seconds > 0 ? { action: "hangup", seconds } : undefined;
  }

  #armTimer(): void {
    this.#clearTimer();
    const quiet = this.#quietAction();
    if (!quiet) return;
    const left = this.#lastActivity + quiet.seconds * 1000 - Date.now();
    this.#timer = setTimeout(() => this.#onQuiet(), Math.max(0, left));
    this.#timer.unref?.();
  }

  #onQuiet(): void {
    this.#timer = undefined;
    const quiet = this.#quietAction();
    if (!quiet) return;
    // something was said since the timer was set: wait out what is left of the quiet
    if (Date.now() - this.#lastActivity < quiet.seconds * 1000) this.#armTimer();
    else if (quiet.action === "park") void this.#park();
    else void this.stop();
  }

  /** The seconds of the current session: the server's last count and the time since it came. */
  #sessionSeconds(): number {
    if (this.#sessionStartedAt === undefined) return 0;
    const now = Date.now();
    return Math.floor(
      this.#reportedAt > 0
        ? (this.#reportedMs + now - this.#reportedAt) / 1000
        : (now - this.#sessionStartedAt) / 1000,
    );
  }

  #emitUsage(): void {
    const seconds =
      this.#billedSeconds +
      (this.#reportedAt > 0 ? Math.floor(this.#reportedMs / 1000) : this.#sessionSeconds());
    try {
      this.#callbacks.onUsage?.(seconds);
    } catch (cause) {
      this.#reportFailure(errorFrom(cause));
    }
  }

  /** Banks the session's seconds, which are final once it is closing. */
  #endSession(): void {
    if (this.#sessionStartedAt === undefined) return;
    this.#billedSeconds += this.#sessionSeconds();
    this.#sessionStartedAt = undefined;
    this.#reportedMs = 0;
    this.#reportedAt = 0;
    this.#emitUsage();
  }

  #emitPhase(phase: LivePhase, force = false): void {
    if (!force && this.#phase === phase) return;
    this.#phase = phase;
    try {
      this.#callbacks.onPhase(phase);
    } catch (cause) {
      this.#reportFailure(errorFrom(cause));
    }
  }

  #emitPhaseSafely(phase: LivePhase): void {
    this.#phase = phase;
    try {
      this.#callbacks.onPhase(phase);
    } catch {
      // The terminal callback is the final UI error boundary.
    }
  }

  #emitLevels(): void {
    try {
      this.#callbacks.onLevels(this.#inputLevel, this.#outputLevel);
    } catch (cause) {
      this.#reportFailure(errorFrom(cause));
    }
  }

  #emitTranscript(transcript: LiveTranscript | undefined): void {
    this.#lastTranscript = transcript;
    try {
      this.#callbacks.onTranscript(transcript);
    } catch (cause) {
      this.#reportFailure(errorFrom(cause));
    }
  }

  #reportFailure(error: Error): void {
    if (this.#terminalEmitted) return;
    this.#failure = error;
    this.#emitPhaseSafely("error");
    this.#emitTerminal(error);
    void this.stop();
  }

  #emitTerminal(error?: Error): void {
    if (this.#terminalEmitted) return;
    this.#terminalEmitted = true;
    try {
      this.#callbacks.onTerminal(error);
    } catch {
      // Nothing remains above the terminal callback to receive its error.
    }
  }
}
