import { describe, expect, test } from "vitest";
import { LIVE_DELEGATION_MESSAGE_TYPE, recentChat, withChat } from "../src/live/context.ts";

const message = (role: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  type: "message",
  message: { role, content, ...extra },
});

test("the voice gets the conversation, not the work behind it", () => {
  const chat = recentChat([
    { type: "compaction", summary: "We set up the dock." },
    message("user", "Fix the scroll."),
    message("assistant", [
      { type: "thinking", thinking: "hm" },
      { type: "toolCall", id: "1", name: "bash", arguments: {} },
    ]),
    message("toolResult", [{ type: "text", text: "lots of output" }]),
    message("assistant", [{ type: "text", text: "Scroll fixed." }]),
    {
      type: "custom_message",
      customType: LIVE_DELEGATION_MESSAGE_TYPE,
      content: "Merge it.",
      display: true,
    },
    { type: "custom_message", customType: "something-else", content: "noise", display: true },
  ]);
  expect(chat).toBe(
    [
      "Summary of the earlier conversation: We set up the dock.",
      "User: Fix the scroll.",
      "Assistant: Scroll fixed.",
      "User (by voice): Merge it.",
    ].join("\n\n"),
  );
});

test("over the budget, the newest turns stay", () => {
  const entries = [
    message("user", "a".repeat(50)),
    message("user", "old"),
    message("user", "b".repeat(20)),
  ];
  expect(recentChat(entries, 40)).toBe(`User: old\n\nUser: ${"b".repeat(20)}`);
  expect(recentChat(entries, 10)).toBe(`…${"b".repeat(9)}`);
});

describe("withChat", () => {
  const turns = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      index % 2 === 0 ? `User: question ${index}` : `Assistant: answer ${index}`,
    );

  test("leaves the instructions alone when there is no chat", () => {
    expect(withChat("Be brief.", "")).toBe("Be brief.");
  });

  test("puts the newest turns first, then the whole history after them", () => {
    const chat = turns(8).join("\n\n");
    const text = withChat("Be brief.", chat);
    const [before, rest] = text.split("### Current State");
    const [stand, history] = rest!.split("### Historical or Background Sources");
    expect(before).toBe("Be brief.\n\n## Context\n\n");
    expect(stand).toContain(
      "User: question 4\n\nAssistant: answer 5\n\nUser: question 6\n\nAssistant: answer 7",
    );
    expect(stand).not.toContain("question 2");
    expect(history).toContain("User: question 0");
    expect(history!.endsWith(`${chat}`)).toBe(true);
  });

  test("a turn of several paragraphs counts as one turn", () => {
    const chat = [
      "User: one",
      "Assistant: two",
      "User: three",
      "Assistant: four\n\nstill four\n\nand more four",
    ].join("\n\n");
    const stand = withChat("x", chat).split("### Historical or Background Sources")[0]!;
    expect(stand).toContain("User: one");
    expect(stand).toContain("Assistant: four\n\nstill four\n\nand more four");
  });

  test("caps the newest turns, cutting the start of one that alone is too long", () => {
    const chat = ["User: old", `Assistant: ${"a".repeat(900)}`, `User: ${"b".repeat(900)}`].join(
      "\n\n",
    );
    const stand = withChat("x", chat)
      .split("### Current State")[1]!
      .split("### Historical or Background Sources")[0]!;
    expect(stand).toContain("b".repeat(900));
    expect(stand).not.toContain("a".repeat(900));
    expect(stand).not.toContain("User: old");
    expect(stand.length).toBeLessThan(1_800);

    const huge = withChat("x", `User: ${"c".repeat(5_000)}`)
      .split("### Current State")[1]!
      .split("### Historical or Background Sources")[0]!;
    expect(huge).toContain(`…${"c".repeat(100)}`);
    expect(huge.length).toBeLessThan(1_800);
  });
});
