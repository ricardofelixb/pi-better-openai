import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ClassifierApi,
  ClassifierModel,
  ClassifierResult,
  Usage,
} from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  RegisteredCommand,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  evaluateDecision,
  registerOpenAIDecisions,
  validateDecisionAnswers,
  validateDecisionRequest,
  MAX_DECISION_BYTES,
} from "../src/decisions.ts";
import { configPaths, readRawConfig, resolveConfig, writeConfig } from "../src/config.ts";
import { makeResolvedConfig } from "./helpers.ts";

const model = {
  type: "classifier",
  provider: "typesafe",
  id: "jev-latest",
  api: "typesafe-system-one",
} as ClassifierModel<ClassifierApi>;
const input = {
  state: { failures: ["timeout connecting to test database"] },
  questions: {
    route: {
      type: "choice" as const,
      instructions: "Select a test-failure category.",
      criteria: { environment: "An environment problem", code: "A code defect" },
    },
    retry: {
      type: "bool" as const,
      instructions: "Would retrying help?",
      criteria: { true: "Transient problem", false: "Persistent problem" },
    },
    urgency: {
      type: "score" as const,
      instructions: "How urgently does this need review?",
      criteria: ["routine", "urgent"],
    },
  },
};
const usage: Usage = {
  input: 24,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 24,
  cost: { input: 0.000001, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.000001 },
};
const result: ClassifierResult = {
  api: "typesafe-system-one",
  provider: "typesafe",
  model: "jev-latest",
  stopReason: "stop",
  timestamp: 1,
  usage,
  answers: {
    route: {
      type: "choice",
      choice: "environment",
      probabilities: { environment: 0.9, code: 0.1 },
      confidence: 0.8,
    },
    retry: { type: "bool", probability: 0.7 },
    urgency: { type: "score", score: 0.3, confidence: 0.6 },
  },
};

function harness() {
  const cfg = makeResolvedConfig({
    decisions: { enabled: true, model: "typesafe/jev-latest", timeoutMs: 1000 },
  });
  const classify = vi.fn(async () => structuredClone(result));
  const ctx = {
    modelRegistry: {
      classify,
      getModelOfType: vi.fn((type: string, provider: string, id: string) =>
        type === "classifier" && provider === model.provider && id === model.id ? model : undefined,
      ),
      getModelsOfType: vi.fn(() => [model]),
    },
    ui: { notify: vi.fn() },
    tools: [],
    executeTool: vi.fn(),
  } as unknown as ExtensionToolContext;
  return { ctx, cfg, classify };
}

const scratch: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("native typed decisions", () => {
  test("uses only the explicitly selected native classifier and preserves answers and usage", async () => {
    const { ctx, cfg, classify } = harness();
    const response = await evaluateDecision(ctx, cfg, input);
    expect(classify).toHaveBeenCalledExactlyOnceWith(model, input, {
      signal: expect.any(AbortSignal),
      maxRetries: 0,
    });
    expect(response.structuredContent).toEqual({
      status: "ok",
      provider: "typesafe",
      model: "jev-latest",
      answers: result.answers,
    });
    expect(response.usage).toEqual(usage);
    expect(response.isError).toBeUndefined();
    expect(response.content[0]!.text).not.toContain("timeout connecting");
  });

  test("is disabled by default and never auto-selects a provider or chat fallback", async () => {
    const { ctx, cfg, classify } = harness();
    for (const decisions of [
      makeResolvedConfig().decisions,
      { ...cfg.decisions, model: "" },
      { ...cfg.decisions, model: "openai/gpt-6-luna" },
      { ...cfg.decisions, model: "openai-codex/gpt-6.1-sol" },
    ]) {
      expect((await evaluateDecision(ctx, { ...cfg, decisions }, input)).isError).toBe(true);
    }
    expect(classify).not.toHaveBeenCalled();
  });

  test("rejects excessive, malformed, and non-JSON inputs before classification", async () => {
    const { ctx, cfg, classify } = harness();
    const bad = [
      { ...input, state: "not an object" },
      { ...input, state: { text: "x".repeat(MAX_DECISION_BYTES) } },
      { ...input, state: { bad: Infinity } },
      { ...input, state: { bad: undefined } },
      { ...input, extra: true },
      { ...input, questions: {} },
      {
        ...input,
        questions: Object.fromEntries(
          Array.from({ length: 33 }, (_, i) => [String(i), input.questions.retry]),
        ),
      },
      { ...input, questions: { q: { ...input.questions.retry, type: "text" } } },
      { ...input, questions: { q: { ...input.questions.retry, instructions: " " } } },
      {
        ...input,
        questions: { q: { ...input.questions.retry, criteria: { yes: "yes", no: "no" } } },
      },
      { ...input, questions: { q: { ...input.questions.urgency, criteria: ["only one"] } } },
      {
        ...input,
        questions: JSON.parse(
          '{"__proto__":{"type":"bool","instructions":"test","criteria":{"true":"yes","false":"no"}}}',
        ),
      },
    ];
    for (const request of bad)
      expect((await evaluateDecision(ctx, cfg, request)).isError).toBe(true);
    expect(classify).not.toHaveBeenCalled();
  });

  test("rejects malformed answers without exposing returned state; retains billed usage", async () => {
    const { ctx, cfg, classify } = harness();
    classify.mockResolvedValue({
      ...result,
      answers: { ...result.answers, retry: { type: "bool", probability: 2 } },
      errorMessage: "secret provider echo",
    });
    const response = await evaluateDecision(ctx, cfg, input);
    expect(response.isError).toBe(true);
    expect(response.usage).toEqual(usage);
    expect(JSON.stringify(response)).not.toContain("secret provider echo");
  });

  test("validates answer types, labels, probabilities, and exact question coverage", () => {
    for (const answers of [
      {},
      { ...result.answers, other: result.answers.retry },
      { ...result.answers, retry: { type: "score", score: 0.5, confidence: 0.5 } },
      { ...result.answers, route: { ...result.answers.route, choice: "invented" } },
      {
        ...result.answers,
        route: { ...result.answers.route, probabilities: { environment: 0.9, code: 0.9 } },
      },
      { ...result.answers, urgency: { type: "score", score: NaN, confidence: 0.2 } },
    ])
      expect(() => validateDecisionAnswers(answers, input)).toThrow("invalid typed answers");
    const extra = {
      ...result.answers,
      retry: { ...result.answers.retry, secret: "must not escape" },
    };
    expect(validateDecisionAnswers(extra, input)).toEqual(result.answers);
    expect(
      validateDecisionAnswers(
        { ...result.answers, urgency: { type: "score", score: 4, confidence: 3 } },
        input,
      ).urgency,
    ).toMatchObject({ score: 4 });
    expect(validateDecisionRequest(input)).toEqual(input);
  });

  test("does not leak provider error text or silently change providers", async () => {
    const { ctx, cfg, classify } = harness();
    classify.mockResolvedValue({
      ...result,
      stopReason: "error",
      errorMessage: "Bearer sk-super-secret account private submitted state",
    });
    const failed = await evaluateDecision(ctx, cfg, input);
    expect(failed.isError).toBe(true);
    expect(failed.usage).toEqual(usage);
    expect(JSON.stringify(failed)).not.toContain("sk-super-secret");
    classify.mockRejectedValue(new Error("Bearer sk-super-secret"));
    expect(JSON.stringify(await evaluateDecision(ctx, cfg, input))).not.toContain(
      "sk-super-secret",
    );
    classify.mockResolvedValue({ ...result, provider: "unexpected" });
    expect((await evaluateDecision(ctx, cfg, input)).isError).toBe(true);
    expect(classify).toHaveBeenCalledTimes(3);
  });

  test("honors cancellation before and during a request", async () => {
    const { ctx, cfg, classify } = harness();
    const aborted = AbortSignal.abort();
    expect((await evaluateDecision(ctx, cfg, input, aborted)).structuredContent).toMatchObject({
      status: "error",
      error: "Decision request aborted.",
    });
    expect(classify).not.toHaveBeenCalled();
    classify.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = evaluateDecision(ctx, cfg, input, controller.signal);
    controller.abort();
    expect((await pending).structuredContent).toMatchObject({ error: "Decision request aborted." });
    const options = vi.mocked(ctx.modelRegistry.classify).mock.calls[0]![2]!;
    expect(options.signal?.aborted).toBe(true);
  });

  test("enforces a deadline even if an adapter ignores cancellation, without retries", async () => {
    vi.useFakeTimers();
    const { ctx, cfg, classify } = harness();
    classify.mockImplementation(() => new Promise(() => {}));
    const pending = evaluateDecision(ctx, cfg, input);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).structuredContent).toMatchObject({
      status: "error",
      error: "Decision request timed out.",
    });
    expect(classify).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("registers a callable structured tool and explicit model-selection commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-decisions-"));
    scratch.push(dir);
    const path = configPaths(dir).project;
    writeConfig(path, { unknown: true, decisions: { enabled: false, unknown: "keep" } });
    const { ctx, classify } = harness();
    const tools = new Map<string, ToolDefinition>();
    type Command = {
      handler: (args: string, ctx: ExtensionContext) => Promise<void>;
      getArgumentCompletions?: RegisteredCommand["getArgumentCompletions"];
    };
    const commands = new Map<string, Command>();
    const on = vi.fn();
    const pi = {
      on,
      registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
      registerCommand: (name: string, cmd: Command) => commands.set(name, cmd),
    } as unknown as ExtensionAPI;
    registerOpenAIDecisions(
      pi,
      () => resolveConfig(dir),
      () => resolveConfig(dir),
    );
    const command = commands.get("openai-decisions")!;
    const complete = command.getArgumentCompletions!;
    expect(await complete("use ")).toBeNull();
    const start = on.mock.calls.find(([event]) => event === "session_start")![1];
    start({}, ctx);
    expect(await complete("use ")).toEqual([
      expect.objectContaining({ value: "use typesafe/jev-latest" }),
    ]);
    expect(ctx.modelRegistry.getModelsOfType).toHaveBeenCalledWith("classifier");
    vi.mocked(ctx.modelRegistry.getModelsOfType).mockReturnValueOnce([]);
    expect(await complete("use ")).toBeNull();
    expect(readRawConfig(path).decisions).toMatchObject({ enabled: false });
    expect(classify).not.toHaveBeenCalled();
    expect(tools.get("openai_decide")!.exposure).toBe("hidden");
    await command.handler("models", ctx);
    expect(classify).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("typesafe/jev-latest"),
      "info",
    );
    await command.handler("use openai/gpt-6-luna", ctx);
    expect(readRawConfig(path).decisions).toMatchObject({ enabled: false });
    expect(tools.get("openai_decide")!.exposure).toBe("hidden");
    await command.handler("use typesafe/jev-latest", ctx);
    expect(readRawConfig(path)).toMatchObject({
      unknown: true,
      decisions: { enabled: true, model: "typesafe/jev-latest", unknown: "keep" },
    });
    const tool = tools.get("openai_decide")!;
    expect(tool.exposure).toBe("direct");
    expect(tool.outputSchema).toBeDefined();
    expect(
      (await tool.execute("decision", input, undefined, undefined, ctx)).structuredContent,
    ).toMatchObject({ status: "ok" });
    await command.handler("off", ctx);
    expect(tools.get("openai_decide")!.exposure).toBe("hidden");
    expect((await tool.execute("decision", input, undefined, undefined, ctx)).isError).toBe(true);
    expect(classify).toHaveBeenCalledOnce();
  });
});
