// What the voice knows of the pane's text chat. GPT-Live's Codex endpoint rejects `session.input`
// (measured: "Unknown parameter: 'input'"), so the chat so far goes into the instructions, under a
// heading of its own. The endpoint does not act on the instructions either (measured: a rule in them
// is not followed, the same text as session context is), so the controller sends them as silent
// context too. What is typed during the call goes in as silent context.

export const LIVE_DELEGATION_MESSAGE_TYPE = "better-openai-live-delegation";
export const LIVE_TRANSCRIPT_MESSAGE_TYPE = "better-openai-live-transcript";
/** The first line of a saved call, so it reads as one wherever it lands. */
export const LIVE_TRANSCRIPT_HEADING = "Live voice call:";

/** About 6,000 tokens of chat, well inside the 16,384 the instructions may take. */
export const LIVE_HISTORY_BUDGET = 24_000;
/** The newest turns the voice reads first: at most this many turns, in about this many characters. */
export const LIVE_STAND_TURNS = 4;
export const LIVE_STAND_BUDGET = 1_500;
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

/** The voice's own saved lines are not memory: replaying them makes startup filler snowball. */
function userCallContext(text: string): string | undefined {
  const turns = text
    .split(/\n(?=(?:User|Assistant): )/)
    .filter((turn) => turn.startsWith("User: "))
    .map((turn) => turn.trim());
  return turns.length ? `${LIVE_TRANSCRIPT_HEADING}\n${turns.join("\n")}` : undefined;
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
  if (message.customType === LIVE_TRANSCRIPT_MESSAGE_TYPE) return userCallContext(text);
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
 * The newest of `lines` that fit `budget` characters, and `limit` lines, oldest first. The newest
 * alone too long loses its start; an older line that does not fit ends the history there.
 */
function newest(lines: readonly string[], budget: number, limit = Infinity): string {
  const kept: string[] = [];
  let left = budget;
  for (let index = lines.length - 1; index >= 0 && kept.length < limit; index -= 1) {
    const line = lines[index]!;
    if (line.length > left) {
      if (kept.length === 0) kept.push(`…${line.slice(line.length - left + 1)}`);
      break;
    }
    kept.push(line);
    left -= line.length + 2;
  }
  return kept.reverse().join("\n\n");
}

/** The newest lines of the chat that fit `budget` characters, oldest first. */
export function recentChat(entries: readonly unknown[], budget = LIVE_HISTORY_BUDGET): string {
  return newest(
    entries.flatMap((entry) => entryLine(entry) ?? []),
    budget,
  );
}

// where a turn of `recentChat` begins; a turn of several paragraphs stays whole
const TURN_START =
  /\n\n(?=(?:User(?: \(by voice\))?|Assistant): |Summary of the earlier conversation: |Live voice call:)/;

/**
 * The session's instructions with the chat so far after them, when any, in the structure OpenAI's
 * voice prompting guide gives long context: the current state first, the older history marked as
 * background that loses to it.
 * https://developers.openai.com/api/docs/guides/voice-prompting
 */
export function withChat(instructions: string, chat: string): string {
  if (!chat) return instructions;
  const stand = newest(chat.split(TURN_START), LIVE_STAND_BUDGET, LIVE_STAND_TURNS);
  return `${instructions}

## Context

### Current State
- **Latest known state:** the newest turns of this session's chat, oldest first. What the user says next is about them unless they say otherwise.

${stand}

### Historical or Background Sources
- **Source:** this session's text chat before the call, oldest first, ending with the turns in Current State. Your own memory, not a new request.
- **Status:** background
- **Note:** Do not use for current decisions if it conflicts with Current State.

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
