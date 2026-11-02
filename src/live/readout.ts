import { type CodexUsageResponse, parseUsageSnapshot } from "../usage.ts";

/** A call's connected time as people say it: 45s, 3m 12s, 1h 05m. */
export function formatConnectedTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const rest = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(rest).padStart(2, "0")}s`;
  return `${rest}s`;
}

/** How much of the plan's five-hour window is used, in whole percent; null when it has none. */
export function fiveHourUsedPercent(data: CodexUsageResponse | undefined): number | null {
  if (!data) return null;
  const left = parseUsageSnapshot(data, undefined).fiveHourLeftPercent;
  return left === null ? null : Math.round(100 - left);
}

/** What a call cost, for the notice when it ends; the window figures come from the plan's meter. */
export function formatCallReadout(
  seconds: number,
  usedBefore: number | null,
  usedAfter: number | null,
): string {
  const connected = `Live call: ${formatConnectedTime(seconds)} connected`;
  if (usedBefore === null || usedAfter === null) return connected;
  return `${connected} · 5-hour window ${usedBefore}% → ${usedAfter}%`;
}
