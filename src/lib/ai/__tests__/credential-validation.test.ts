import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const limit = vi.fn();
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const values = vi.fn();
  const insert = vi.fn(() => ({ values }));
  return { limit, orderBy, where, from, select, values, insert, callProvider: vi.fn() };
});

vi.mock("@/lib/db/client", () => ({
  db: { select: mocks.select, insert: mocks.insert },
}));
vi.mock("@/lib/ai/providers", () => ({ callProvider: mocks.callProvider }));

import { validateProviderCredential } from "../credential-validation";
import { ProviderError } from "../types";

const base = {
  userId: "learner-1",
  credentialId: "credential-1",
  provider: "nvidia_nim" as const,
  secret: "synthetic-test-credential",
};

describe("provider credential validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.limit.mockReset().mockResolvedValue([]);
    mocks.values.mockResolvedValue(undefined);
    mocks.callProvider.mockResolvedValue({
      provider: "nvidia_nim",
      model: "test/model",
      content: "OK",
      inputTokens: 2,
      outputTokens: 1,
      latencyMs: 5,
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("uses the safe default NIM probe and records hashes, never the secret", async () => {
    await expect(validateProviderCredential(base)).resolves.toMatchObject({
      status: "active",
      failureCode: null,
      model: "test/model",
    });
    expect(mocks.callProvider).toHaveBeenCalledWith(expect.objectContaining({
      provider: "nvidia_nim",
      apiKey: base.secret,
      maxOutputTokens: 256,
    }));
    expect(mocks.values).toHaveBeenCalledWith(expect.objectContaining({
      credentialId: "credential-1",
      operation: "credential_validation",
      status: "succeeded",
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      responseHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(console.warn).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.values.mock.calls)).not.toContain(base.secret);
  });

  it("finishes as unreachable without transmitting an unconfigured custom provider key", async () => {
    const result = await validateProviderCredential({ ...base, provider: "custom_openai_compatible" });
    expect(result).toEqual({ status: "unreachable", failureCode: "POLICY", model: null });
    expect(mocks.callProvider).not.toHaveBeenCalled();
    expect(mocks.values).not.toHaveBeenCalled();
  });

  it("validates a self-serve provider with no admin policy row using its built-in default model", async () => {
    mocks.callProvider.mockResolvedValueOnce({
      provider: "google",
      model: "gemini-2.5-flash",
      content: "OK",
      inputTokens: 2,
      outputTokens: 1,
      latencyMs: 5,
    });
    const result = await validateProviderCredential({ ...base, provider: "google" });
    expect(result).toMatchObject({ status: "active", model: "gemini-2.5-flash" });
    expect(mocks.callProvider).toHaveBeenCalledWith(expect.objectContaining({
      provider: "google",
      model: "gemini-2.5-flash",
      apiKey: base.secret,
    }));
  });

  it("classifies rate limits without logging key material", async () => {
    mocks.callProvider.mockRejectedValueOnce(
      new ProviderError("Rate limited", "RATE_LIMIT", 429),
    );
    await expect(validateProviderCredential(base)).resolves.toMatchObject({
      status: "unreachable",
      failureCode: "RATE_LIMIT",
    });
    expect(mocks.values).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      errorCode: "RATE_LIMIT",
    }));
    expect(JSON.stringify(mocks.values.mock.calls)).not.toContain(base.secret);
  });

  it.each(["UNAVAILABLE", "TIMEOUT", "BAD_RESPONSE", "POLICY", "UNKNOWN"] as const)("finishes %s as unreachable with a reason", async (code) => {
    mocks.callProvider.mockRejectedValueOnce(
      new ProviderError("Synthetic provider failure", code),
    );
    await expect(validateProviderCredential(base)).resolves.toMatchObject({
      status: "unreachable",
      failureCode: code,
    });
  });

  it.each(["AUTHENTICATION", "RATE_LIMIT", "TIMEOUT"] as const)("preserves foreign-realm %s failures in validation and model-call rows", async (code) => {
    const foreignError = runInNewContext(
      'Object.assign(new Error("private provider body"), { name: "ProviderError", code })',
      { code },
    );
    expect(foreignError).not.toBeInstanceOf(ProviderError);
    mocks.callProvider.mockRejectedValueOnce(foreignError);
    await expect(validateProviderCredential(base)).resolves.toMatchObject({
      status: code === "AUTHENTICATION" ? "invalid" : "unreachable",
      failureCode: code,
    });
    expect(mocks.values).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", errorCode: code }));
    expect(console.warn).toHaveBeenCalledExactlyOnceWith("Provider credential validation failed", { provider: base.provider, code });
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(base.secret);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("private provider body");
  });

  it("logs only UNKNOWN for an unrecognized error marker", async () => {
    mocks.callProvider.mockRejectedValueOnce({ name: "ProviderError", code: "private provider body", message: base.secret });
    await expect(validateProviderCredential(base)).resolves.toMatchObject({ status: "unreachable", failureCode: "UNKNOWN" });
    expect(console.warn).toHaveBeenCalledExactlyOnceWith("Provider credential validation failed", { provider: base.provider, code: "UNKNOWN" });
    expect(mocks.values).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "UNKNOWN" }));
  });

  it("marks only an explicit provider authentication rejection as invalid", async () => {
    mocks.callProvider.mockRejectedValueOnce(
      new ProviderError("Unauthorized", "AUTHENTICATION", 401),
    );
    await expect(validateProviderCredential(base)).resolves.toMatchObject({
      status: "invalid",
      failureCode: "AUTHENTICATION",
    });
  });

  it("propagates a persistence failure after a successful probe instead of mislabeling the key", async () => {
    mocks.values.mockRejectedValueOnce(new Error("model-call write unavailable"));
    await expect(validateProviderCredential(base)).rejects.toThrow("model-call write unavailable");
    expect(mocks.callProvider).toHaveBeenCalledTimes(1);
    expect(mocks.values).toHaveBeenCalledTimes(1);
  });
});
