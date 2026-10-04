import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("passes every tutor and validation model override to the app", () => {
  const compose = readFileSync("compose.yaml", "utf8").replaceAll("\r\n", "\n").split("  app:\n")[1]?.split(/\n  (?=\S)/)[0] ?? "";
  for (const provider of ["GOOGLE", "OPENAI", "ANTHROPIC", "OPENROUTER", "DEEPSEEK", "NVIDIA_NIM"]) {
    for (const operation of ["TUTOR", "VALIDATION"]) {
      const key = `${provider}_${operation}_MODEL`;
      expect(compose).toContain(`${key}: $` + `{${key}:-}`);
    }
  }
});
