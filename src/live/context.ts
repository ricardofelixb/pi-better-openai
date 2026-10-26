// What the voice knows of the pane's text chat. GPT-Live's Codex endpoint rejects `session.input`
// (measured: "Unknown parameter: 'input'"), so the chat so far goes into the instructions, under a
// heading of its own, and what is typed during the call goes in as silent context.

export const LIVE_DELEGATION_MESSAGE_TYPE = "better-openai-live-delegation";
export const LIVE_TRANSCRIPT_MESSAGE_TYPE = "better-openai-live-transcript";
/** The first line of a saved call, so it reads as one wherever it lands. */
export const LIVE_TRANSCRIPT_HEADING = "Live voice call:";

/** About 6,000 tokens of chat, well inside the 16,384 the instructions may take. */
export const LIVE_HISTORY_BUDGET = 24_000;
/** One message typed during the call, before it is cut. */
export const LIVE_TYPED_BUDGET = 2_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("\n")
    .trim();
}

/** A message as one line of the voice's view of the chat, or undefined when it holds no prose. */
export function chatLine(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  const text = textOf(message.content);
  if (!text) return undefined;
  if (message.role === "user") return `User: ${text}`;
  // tool calls and their results stay out: the voice needs the conversation, not the work
  if (message.role === "assistant") return `Assistant: ${text}`;
  if (message.role !== "custom") return undefined;
  if (message.customType === LIVE_DELEGATION_MESSAGE_TYPE) return `User (by voice): ${text}`;
  if (message.customType === LIVE_TRANSCRIPT_MESSAGE_TYPE) return text;
  return undefined;
}

function entryLine(entry: unknown): string | undefined {
  if (!isRecord(entry)) return undefined;
  if (entry.type === "message") return chatLine(entry.message);
  if (entry.type === "custom_message") return chatLine({ ...entry, role: "custom" });
  if (
    (entry.type === "compaction" || entry.type === "branch_summary") &&
    typeof entry.summary === "string"
  ) {
    return entry.summary.trim()
      ? `Summary of the earlier conversation: ${entry.summary.trim()}`
      : undefined;
  }
  return undefined;
}

/**
 * The newest lines that fit `budget` characters, oldest first. The newest alone too long loses its
 * start; an older line that does not fit ends the history there.
 */
export function recentChat(entries: readonly unknown[], budget = LIVE_HISTORY_BUDGET): string {
  const kept: string[] = [];
  let left = budget;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const line = entryLine(entries[index]);
    if (!line) continue;
    if (line.length > left) {
      if (kept.length === 0) kept.push(`…${line.slice(line.length - left + 1)}`);
      break;
    }
    kept.push(line);
    left -= line.length + 2;
  }
  return kept.reverse().join("\n\n");
}

/** The session's instructions with the chat so far after them, when there is any. */
export function withChat(instructions: string, chat: string): string {
  if (!chat) return instructions;
  return `${instructions}

# Conversation so far
Background from this session's text chat before the call, oldest first. Use it to follow what the user refers to. It is not a new request, and the latest turns are the current state.

${chat}`;
}

/** A message typed in the chat during the call, as silent context; undefined when it holds no prose. */
export function typedContext(message: unknown): string | undefined {
  const line = chatLine(message);
  if (!line || !isRecord(message) || (message.role !== "user" && message.role !== "assistant"))
    return undefined;
  const clipped =
    line.length <= LIVE_TYPED_BUDGET ? line : `${line.slice(0, LIVE_TYPED_BUDGET - 1)}…`;
  return `Typed in the chat during the call. Do not read it out unless asked.\n${clipped}`;
}
