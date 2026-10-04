import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { isProviderError, ProviderError } from "../types";

describe("stable provider error classification", () => {
  it.each(["AUTHENTICATION", "RATE_LIMIT", "TIMEOUT", "UNAVAILABLE", "BAD_RESPONSE", "MODEL_NOT_FOUND", "BAD_REQUEST", "POLICY", "UNKNOWN"] as const)("accepts local and foreign %s errors", (code) => {
    expect(isProviderError(new ProviderError("safe", code))).toBe(true);
    const foreign = runInNewContext('Object.assign(new Error("safe"), { name: "ProviderError", code })', { code });
    expect(foreign).not.toBeInstanceOf(ProviderError);
    expect(isProviderError(foreign)).toBe(true);
    expect(isProviderError({ name: "ProviderError", code })).toBe(true);
  });

  it.each([null, undefined, "ProviderError", 42, {}, { code: "AUTHENTICATION" }, { name: "Error", code: "AUTHENTICATION" }, { name: "ProviderError", code: "untrusted body" }, { name: "ProviderError", code: 401 }, { name: "ProviderError", code: "TIMEOUT", status: "401" }, { name: "ProviderError", code: "TIMEOUT", retryAfterSeconds: NaN }])("rejects malformed markers %#", (error) => {
    expect(isProviderError(error)).toBe(false);
  });
});
