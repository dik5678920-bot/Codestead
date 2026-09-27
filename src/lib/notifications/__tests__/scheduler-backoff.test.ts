import { describe, expect, it } from "vitest";
import { SchedulerBackoff } from "../scheduler-backoff";

describe("SchedulerBackoff", () => {
  it("runs immediately, then on the base interval while healthy", () => {
    const backoff = new SchedulerBackoff(60_000);
    expect(backoff.due(0)).toBe(true);
    backoff.record(0, true);
    expect(backoff.due(59_999)).toBe(false);
    expect(backoff.due(60_000)).toBe(true);
  });

  it("doubles the wait after each failure, caps at one hour, and resets on success", () => {
    const backoff = new SchedulerBackoff(60_000);
    backoff.record(0, false);
    expect(backoff.currentDelayMs()).toBe(120_000);
    backoff.record(0, false);
    expect(backoff.currentDelayMs()).toBe(240_000);
    for (let index = 0; index < 40; index += 1) backoff.record(0, false);
    expect(backoff.currentDelayMs()).toBe(3_600_000);
    expect(backoff.due(3_599_999)).toBe(false);
    backoff.record(0, true);
    expect(backoff.currentDelayMs()).toBe(60_000);
  });
});
