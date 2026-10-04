import { expect, it } from "vitest";
import { CREDENTIAL_VALUE_PATTERNS } from "../credential-patterns";
it.each(["AIza", "AQ."])("detects %s Google keys at text and repository boundaries", (prefix) => {
  const pattern = CREDENTIAL_VALUE_PATTERNS.find((entry) => entry.detector === "google-api-key");
  const key = prefix + "syntheticValue".repeat(3);
  expect(new RegExp(pattern!.expression).test(key)).toBe(true);
  expect(new RegExp(pattern!.scanExpression!).test(key)).toBe(true);
});
