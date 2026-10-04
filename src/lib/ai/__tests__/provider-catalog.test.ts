import { afterEach, expect, it, vi } from "vitest";
import { defaultModelForProvider } from "../provider-catalog";
afterEach(() => vi.unstubAllEnvs());
it.each([
  ["google", "GOOGLE", "gemini-flash-latest"],
  ["openrouter", "OPENROUTER", "qwen/qwen3.8-27b:free"],
  ["nvidia_nim", "NVIDIA_NIM", "nvidia/nemotron-3.5-lightning-30b-a3b"],
  ["openai", "OPENAI", "gpt-4o-mini"],
  ["anthropic", "ANTHROPIC", "claude-haiku-4-5-20251001"],
  ["deepseek", "DEEPSEEK", "deepseek-chat"],
] as const)("uses %s defaults and trimmed tutor overrides", (provider, prefix, model) => {
  vi.stubEnv(`${prefix}_TUTOR_MODEL`, "");
  expect(defaultModelForProvider(provider)).toBe(model);
  vi.stubEnv(`${prefix}_TUTOR_MODEL`, " test/override ");
  expect(defaultModelForProvider(provider)).toBe("test/override");
});
