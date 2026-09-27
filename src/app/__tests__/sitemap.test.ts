import { describe, expect, it } from "vitest";

import robots from "../robots";
import sitemap from "../sitemap";

function disallowedPaths(): string[] {
  const result = robots();
  const rules = Array.isArray(result.rules) ? result.rules[0] : result.rules;
  const disallow = rules?.disallow;
  return Array.isArray(disallow) ? disallow : disallow ? [disallow] : [];
}

describe("robots", () => {
  it("disallows the core protected paths and points to the sitemap", () => {
    const disallow = disallowedPaths();
    for (const path of ["/api/", "/learn/", "/onboarding/", "/two-factor/"]) expect(disallow).toContain(path);
    expect(robots().sitemap).toMatch(/\/sitemap\.xml$/);
  });
});

describe("sitemap", () => {
  it("lists no path that robots disallows", () => {
    const protectedPaths = disallowedPaths();
    expect(protectedPaths.length).toBeGreaterThan(0);
    for (const entry of sitemap()) {
      const path = `${new URL(entry.url).pathname.replace(/\/$/, "")}/`;
      for (const protectedPath of protectedPaths) expect(path.startsWith(protectedPath)).toBe(false);
    }
  });
});
