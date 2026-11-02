import { createModels, InMemoryCredentialStore, type Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, test, vi } from "vitest";
import { createOpenAIDecisionsProvider } from "../src/openai-decisions.ts";
import { evaluateDecision } from "../src/decisions.ts";
import { makeResolvedConfig } from "./helpers.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const input = {
  state: { approved: true },
  questions: {
    approved: {
      type: "bool" as const,
      instructions: "Is it approved?",
      criteria: { true: "Approved", false: "Not approved" },
    },
  },
};

async function setup(env: Record<string, string | undefined> = {}, storedKey?: string) {
  const native = builtinProviders().find((p) => p.id === "openai")!;
  const provider = createOpenAIDecisionsProvider(native);
  const credentials = new InMemoryCredentialStore();
  const oauth = {
    type: "oauth" as const,
    access: "synthetic-subscription-token",
    refresh: "synthetic-refresh",
    expires: Date.now() + 3600000,
    clientId: "synthetic-client",
    scopes: ["chatgpt.tokens.use.direct"],
  };
  await credentials.modify("openai", async () => oauth);
  if (storedKey) {
    await credentials.modify("openai-decisions", async () => ({ type: "api_key", key: storedKey }));
  }
  const registry = createModels({
    credentials,
    authContext: { env: async (key) => env[key], fileExists: async () => false },
  });
  registry.setProvider(native);
  registry.setProvider(provider);
  return { native, provider, credentials, registry, oauth };
}

function transport() {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    Response.json({
      answers: [{ name: "approved", type: "predicate", probability: 0.9 }],
      usage: { input_tokens: 20, output_tokens: 0 },
    }),
  );
}

describe("separate OpenAI Decisions billing", () => {
  test.each([
    {
      env: { OPENAI_DECISIONS_API_KEY: "decisions-key", OPENAI_API_KEY: "general-key" },
      expected: "decisions-key",
    },
    { env: { OPENAI_API_KEY: "general-key" }, expected: "general-key" },
    {
      env: { OPENAI_DECISIONS_API_KEY: "env-key" },
      storedKey: "stored-key",
      expected: "stored-key",
    },
  ])("keeps chat OAuth while resolving Decisions key: %j", async ({ env, storedKey, expected }) => {
    const { native, provider, credentials, registry, oauth } = await setup(env, storedKey);
    expect(provider.auth.oauth).toBeUndefined();
    expect(provider.getModels()).toEqual([]);
    expect(provider.getAllModels!()).toHaveLength(1);
    const model = registry.getModelOfType("classifier", "openai-decisions", "gpt-6-luna")!;
    expect(model).toMatchObject({ api: "openai-decisions", baseUrl: "https://api.openai.com/v1" });
    expect(await registry.getAvailableOfType("classifier", "openai-decisions")).toEqual([model]);
    expect(await registry.getAvailableOfType("classifier", "openai")).toEqual([]);
    expect(await registry.getAvailableOfType("chat", "openai-decisions")).toEqual([]);
    expect(
      (await registry.getAvailableOfType("chat", "openai")).some((m) => m.id === "gpt-6-astra"),
    ).toBe(true);
    const fetch = transport();
    const ctx = {
      modelRegistry: {
        getModelOfType: registry.getModelOfType.bind(registry),
        classify: (m, c, o) => registry.classify(m, c, { ...o, fetch }),
      },
    } as ExtensionContext;
    const cfg = makeResolvedConfig({
      decisions: { enabled: true, model: "openai-decisions/gpt-6-luna", timeoutMs: 1000 },
    });
    const result = await evaluateDecision(ctx, cfg, input);
    expect(result.structuredContent).toMatchObject({
      status: "ok",
      provider: "openai-decisions",
      model: "gpt-6-luna",
      answers: { approved: { type: "bool", probability: 0.9 } },
    });
    expect(result.usage?.input).toBe(20);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://api.openai.com/v1/decisions");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${expected}`);
    expect(JSON.parse(String(init?.body)).model).toBe("gpt-6-luna");
    expect((await credentials.read("openai"))?.type).toBe("oauth");
    expect((await registry.getAuth("openai"))?.auth.apiKey).toBe(oauth.access);
    expect(await credentials.read("openai")).toEqual(oauth);
    expect(native.auth.oauth).toBeDefined();
  });

  test("never borrows chat OAuth or Codex credentials when the Decisions key is missing", async () => {
    const { registry, credentials } = await setup();
    await credentials.modify("openai-codex", async () => ({
      type: "api_key",
      key: "wrong-provider-key",
    }));
    expect(await registry.getAvailableOfType("classifier", "openai-decisions")).toEqual([]);
    const fetch = transport();
    const model = registry.getModelOfType("classifier", "openai-decisions", "gpt-6-luna")!;
    const result = await registry.classify(model, input, { fetch });
    expect(result.stopReason).toBe("error");
    expect(fetch).not.toHaveBeenCalled();
    expect((await credentials.read("openai"))?.type).toBe("oauth");
  });

  test("delegates to the host adapter and retains fallback support on older hosts", async () => {
    const native = builtinProviders().find((p) => p.id === "openai")!;
    const classify = vi.fn(native.classify!);
    const provider = createOpenAIDecisionsProvider({ ...native, classify });
    const model = provider.getAllModels!()[0]!;
    const fetch = transport();
    await provider.classify!(model as Parameters<NonNullable<Provider["classify"]>>[0], input, {
      apiKey: "synthetic-key",
      fetch,
    });
    expect(classify).toHaveBeenCalledOnce();
    const older: Provider = {
      ...native,
      classify: undefined,
      getAllModels: () => native.getModels(),
    };
    const fallback = createOpenAIDecisionsProvider(older);
    const fallbackModel = fallback.getAllModels!()[0]!;
    const result = await fallback.classify!(
      fallbackModel as Parameters<NonNullable<Provider["classify"]>>[0],
      input,
      { apiKey: "synthetic-key", fetch },
    );
    expect(result.stopReason).toBe("stop");
    expect(result.provider).toBe("openai-decisions");
  });
});
