import { expect, test } from "vitest";
import { LIVE_DELEGATION_MESSAGE_TYPE, recentChat } from "../src/live/context.ts";

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
