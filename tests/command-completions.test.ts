import { describe, expect, test, vi } from "vitest";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import {
  openAIDecisionsArgumentCompletions,
  openAITierArgumentCompletions,
} from "../src/command-completions.ts";

const classifiers = [
  { provider: "typesafe", id: "jev-latest", name: "Jev" },
  { provider: "openai-decisions", id: "gpt-6-luna", name: "Luna" },
  { provider: "openrouter", id: "typesafe/jev-1.13" },
];

describe("slash-command argument completions", () => {
  test("suggests all tiers and keeps the Ultrafast cost warning", () => {
    expect(openAITierArgumentCompletions("")?.map((item) => item.value)).toEqual([
      "standard",
      "fast",
      "ultrafast",
    ]);
    expect(openAITierArgumentCompletions("  FA")?.map((item) => item.value)).toEqual(["fast"]);
    expect(openAITierArgumentCompletions("ultra")?.[0]?.description).toContain("6x");
  });

  test.each(["unknown", "fast ", "fast extra"])(
    "rejects unsupported tier arguments: %s",
    (prefix) => {
      expect(openAITierArgumentCompletions(prefix)).toBeNull();
    },
  );

  test("completes subcommands without querying the model catalog", () => {
    const getModels = vi.fn(() => classifiers);
    expect(openAIDecisionsArgumentCompletions("", getModels)?.map((item) => item.value)).toEqual([
      "models",
      "use ",
      "off",
    ]);
    expect(openAIDecisionsArgumentCompletions("  M", getModels)?.map((item) => item.value)).toEqual(
      ["models"],
    );
    expect(getModels).not.toHaveBeenCalled();
  });

  test("replaces the entire argument prefix with use plus a qualified classifier ID", () => {
    expect(
      openAIDecisionsArgumentCompletions("use ", () => classifiers)?.map((item) => item.value),
    ).toEqual([
      "use openai-decisions/gpt-6-luna",
      "use openrouter/typesafe/jev-1.13",
      "use typesafe/jev-latest",
    ]);
    expect(openAIDecisionsArgumentCompletions("  use   openai-d", () => classifiers)).toEqual([
      {
        value: "use openai-decisions/gpt-6-luna",
        label: "openai-decisions/gpt-6-luna",
        description: "Luna",
      },
    ]);
    expect(
      openAIDecisionsArgumentCompletions("use openrouter/typesafe/", () => classifiers)?.[0]?.value,
    ).toBe("use openrouter/typesafe/jev-1.13");
  });

  test.each(["unknown", "models ", "off ", "use missing/", "use typesafe/jev-latest extra"])(
    "returns no suggestions for %s",
    (prefix) => {
      expect(openAIDecisionsArgumentCompletions(prefix, () => classifiers)).toBeNull();
    },
  );

  test("pi inserts a full Decisions command and advances from use to the model catalog", async () => {
    const provider = new CombinedAutocompleteProvider(
      [
        {
          name: "openai-decisions",
          getArgumentCompletions: (prefix) =>
            openAIDecisionsArgumentCompletions(prefix, () => classifiers),
        },
      ],
      process.cwd(),
    );
    const line = "/openai-decisions us";
    const options = { signal: new AbortController().signal };
    const suggestions = await provider.getSuggestions([line], 0, line.length, options);
    expect(suggestions?.items[0]?.value).toBe("use ");
    const next = provider.applyCompletion(
      [line],
      0,
      line.length,
      suggestions!.items[0]!,
      suggestions!.prefix,
    );
    expect(next.lines).toEqual(["/openai-decisions use "]);
    const models = await provider.getSuggestions(next.lines, 0, next.cursorCol, options);
    const item = models!.items.find((item) => item.value === "use openai-decisions/gpt-6-luna")!;
    const selected = provider.applyCompletion(next.lines, 0, next.cursorCol, item, models!.prefix);
    expect(selected.lines).toEqual(["/openai-decisions use openai-decisions/gpt-6-luna"]);
    expect(selected.cursorCol).toBe(selected.lines[0]!.length);
  });

  test("queries the current catalog each time, including when it is empty", () => {
    const getModels = vi.fn().mockReturnValueOnce([]).mockReturnValueOnce(classifiers);
    expect(openAIDecisionsArgumentCompletions("use ", getModels)).toBeNull();
    expect(openAIDecisionsArgumentCompletions("use ", getModels)).toHaveLength(3);
  });
});
