import { describe, expect, it } from "vitest";

import robots from "../robots";
import sitemap from "../sitemap";

const PROTECTED_PATHS = ["/api/", "/admin/", "/learn/", "/settings/", "/onboarding/", "/two-factor/"];

describe("sitemap", () => {
  it("lists no protected path", () => {
    const paths = sitemap().map((entry) => new URL(entry.url).pathname);
    for (const path of paths) {
      for (const protectedPath of PROTECTED_PATHS) {
        expect(`${path}/`.startsWith(protectedPath)).toBe(false);
      }
    }
  });
});

describe("robots", () => {
  it("disallows every protected path and points to the sitemap", () => {
    const result = robots();
    const rules = Array.isArray(result.rules) ? result.rules[0] : result.rules;
    const disallow = Array.isArray(rules?.disallow) ? rules.disallow : [rules?.disallow];
    for (const protectedPath of PROTECTED_PATHS) expect(disallow).toContain(protectedPath);
    expect(result.sitemap).toMatch(/\/sitemap\.xml$/);
  });
});
