// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { modelCommandSchema, createModelProof, verifyModelProof, modelListUrl, parseModelList } from "../admin-models-domain";
const binding = { actorId: "admin", sessionId: "session", provider: "google" as const, model: "gemini-flash-latest", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", version: 3 };
const key = Buffer.alloc(32, 5);
afterEach(() => vi.useRealTimers());
describe("admin model authority", () => {
  it("rejects unknown actions, fake verification, unsafe model IDs and oversized prompts", () => {
    expect(modelCommandSchema.safeParse({ action: "save", provider: "google", model: "m", priority: 1, verified: true }).success).toBe(false);
    expect(modelCommandSchema.safeParse({ action: "save", provider: "google", model: "bad\nmodel", priority: 1, verification: "untested", version: 1 }).success).toBe(false);
    expect(modelCommandSchema.safeParse({ action: "test", provider: "google", model: "m", message: "a".repeat(4001), version: 1 }).success).toBe(false);
    expect(modelCommandSchema.safeParse({ action: "save", provider: "openai", model: "sk-proj-" + "a".repeat(40), priority: 1, verification: "untested", version: 0 }).success).toBe(false);
  });
  it("accepts a typed untested model without a key or proof", () => {
    expect(modelCommandSchema.safeParse({ action: "save", provider: "custom_openai_compatible", model: "vendor/model", priority: 2, verification: "untested", version: 1 }).success).toBe(true);
  });
  it("accepts only a current server-issued proof bound to the session, endpoint, model and connection revision", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-04T00:00:00Z"));
    const proof = createModelProof(binding, key);
    expect(verifyModelProof(proof, binding, key)).toBe(true);
    for (const change of [{ model: "other" }, { baseUrl: "https://other.example/v1" }, { version: 4 }, { actorId: "other" }, { sessionId: "other" }, { provider: "openai" as const }]) {
      expect(verifyModelProof(proof, { ...binding, ...change }, key)).toBe(false);
    }
    expect(verifyModelProof(proof + "tampered", binding, key)).toBe(false);
    vi.advanceTimersByTime(600001);
    expect(verifyModelProof(proof, binding, key)).toBe(false);
  });
  it("uses Google's native model API without putting the key in the URL", () => {
    expect(modelListUrl("google", binding.baseUrl)).toBe("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000");
    expect(modelListUrl("openrouter", "https://openrouter.ai/api/v1")).toBe("https://openrouter.ai/api/v1/models");
  });
  it("normalizes native and compatible lists with free badges", () => {
    expect(parseModelList("google", { models: [{ name: "models/gemini-flash-latest", displayName: "Flash", supportedGenerationMethods: ["generateContent"] }, { name: "models/embedding", supportedGenerationMethods: ["embedContent"] }] })).toEqual([{ id: "gemini-flash-latest", name: "Flash", free: false }]);
    expect(parseModelList("openrouter", { data: [{ id: "qwen/model:free", name: "Qwen" }] })).toEqual([{ id: "qwen/model:free", name: "Qwen", free: true }]);
  });
});
