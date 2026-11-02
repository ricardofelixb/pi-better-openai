import { describe, expect, test } from "vitest";
import {
  fiveHourUsedPercent,
  formatCallReadout,
  formatConnectedTime,
} from "../src/live/readout.ts";

describe("connected time", () => {
  test("reads as seconds, minutes and seconds, or hours and minutes", () => {
    expect(formatConnectedTime(0)).toBe("0s");
    expect(formatConnectedTime(45)).toBe("45s");
    expect(formatConnectedTime(60)).toBe("1m 00s");
    expect(formatConnectedTime(192)).toBe("3m 12s");
    expect(formatConnectedTime(3_900)).toBe("1h 05m");
  });
});

describe("the plan's five-hour window", () => {
  test("is the share used, read from the usage response", () => {
    expect(fiveHourUsedPercent({ rate_limit: { primary_window: { used_percent: 12 } } })).toBe(12);
    expect(fiveHourUsedPercent({ rate_limit: { primary_window: { used_percent: 12.6 } } })).toBe(
      13,
    );
    expect(fiveHourUsedPercent({})).toBeNull();
    expect(fiveHourUsedPercent(undefined)).toBeNull();
  });

  test("a plan with only a weekly window has no five-hour reading", () => {
    expect(
      fiveHourUsedPercent({
        rate_limit: { primary_window: { used_percent: 30, limit_window_seconds: 604_800 } },
      }),
    ).toBeNull();
  });
});

describe("the call readout", () => {
  test("says how long the call was connected and how far the window moved", () => {
    expect(formatCallReadout(192, 12, 14)).toBe(
      "Live call: 3m 12s connected · 5-hour window 12% → 14%",
    );
  });

  test("leaves out the window when either reading is missing", () => {
    expect(formatCallReadout(45, null, 14)).toBe("Live call: 45s connected");
    expect(formatCallReadout(45, 12, null)).toBe("Live call: 45s connected");
  });
});
