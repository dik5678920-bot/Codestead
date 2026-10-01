import { describe, expect, it } from "vitest";

import { recordedConsoleErrors } from "./web-console-noise";

const inspectorNoise = "Failed to load resource: net::ERR_BLOCKED_BY_CLIENT.Inspector";

describe("recordedConsoleErrors", () => {
  it("records the same evidence whether or not Chromium emits Inspector noise", () => {
    expect(recordedConsoleErrors([inspectorNoise, inspectorNoise])).toEqual([]);
    expect(recordedConsoleErrors([])).toEqual([]);
  });

  it("keeps real page console errors so a changed error still changes the evidence", () => {
    const real = "Failed to load resource: the server responded with a status of 500 ()";
    expect(recordedConsoleErrors([inspectorNoise, real])).toEqual([real]);
    expect(recordedConsoleErrors([real])).not.toEqual(recordedConsoleErrors([]));
  });

  it("drops only the exact Inspector message, not lookalikes", () => {
    const lookalikes = [
      "Failed to load resource: net::ERR_BLOCKED_BY_CLIENT",
      `${inspectorNoise} extra`,
      `Uncaught Error: ${inspectorNoise}`,
    ];
    expect(recordedConsoleErrors(lookalikes)).toEqual(lookalikes);
  });
});
