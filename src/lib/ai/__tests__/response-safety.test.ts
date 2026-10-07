import { describe, expect, it } from "vitest";

import { safeTutorResponse } from "../response-safety";

describe("reasoning label detection", () => {
  it.each([
    "Here's the idea.\n\n**Analysis:** binary search is O(log n)",
    "Here's the idea.\n\nAnalysis: binary search is O(log n)",
    "Here's the idea.\n\n## Analysis\nBinary search is O(log n).",
    "A system prompt sets the assistant's behavior.\nSystem instructions: describe its role and constraints.",
    "A system prompt contains system instructions that guide an assistant.",
    "Analysis:",
    "**Analysis**",
    "**Analysis:**",
    "**Analysis**:",
    "## Analysis",
  ])("allows legitimate teaching content: %s", (content) => {
    expect(safeTutorResponse(content).content).toBe(content);
  });

  it.each([
    "analysis: the user wants…\nfinal answer",
    "\n\n**Analysis:** the user wants an explanation.\nfinal answer",
    "**Analysis**\nThe user wants an explanation.\nfinal answer",
    "## Analysis\nThe user wants an explanation.\nfinal answer",
    "internal reasoning: choose a response.\nfinal answer",
    "chain of thought: choose a response.\nfinal answer",
  ])("blocks a leading reasoning label followed by text: %s", (content) => {
    expect(() => safeTutorResponse(content)).toThrow(expect.objectContaining({ code: "REASONING_LEAK" }));
  });
});
