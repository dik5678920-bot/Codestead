import { describe, expect, it } from "vitest";
import { supportRequestSchema, encodeSupportDetails, decodeSupportDetails } from "../support-contract";

const base = { requestId: "10000000-0000-4000-8000-000000000001", kind: "support-ai", message: "Model validation fails", provider: "google" };

describe("contact admin input boundary", () => {
  it("requires an AI provider even when diagnostic attachment is disabled", () => {
    expect(supportRequestSchema.safeParse({ ...base, provider: undefined }).success).toBe(false);
    expect(supportRequestSchema.safeParse(base).success).toBe(true);
  });
  it("bounds messages and rejects secrets and unknown context fields", () => {
    for (const input of [
      { ...base, message: "x".repeat(1001) },
      { ...base, message: "api_key=supersecretvalue" },
      { ...base, context: { provider: "google", prompt: "private" } },
      { ...base, context: { provider: "google", errorCode: "sk-secret-value" } },
      { ...base, context: { provider: "google", httpStatus: 900 } },
      { ...base, context: { provider: "openai" } },
      { ...base, secret: "hidden" },
    ]) expect(supportRequestSchema.safeParse(input).success).toBe(false);
  });
  it("round trips only message and allowlisted diagnostics", () => {
    const parsed = supportRequestSchema.parse({ ...base, context: { provider: "google", errorCode: "MODEL_NOT_FOUND", httpStatus: 404 } });
    expect(decodeSupportDetails(encodeSupportDetails(parsed))).toEqual({ message: base.message, context: parsed.context });
    expect(decodeSupportDetails("not json")).toBeNull();
  });
  it("accepts other requests without provider diagnostics", () => {
    expect(supportRequestSchema.safeParse({ requestId: base.requestId, kind: "support-other", message: "Help" }).success).toBe(true);
  });
});
