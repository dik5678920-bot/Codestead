import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import postcss from "postcss";

const globalCss = readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8");

describe("global accessibility styling contract", () => {
  it("keeps the page bounded at the supported viewport and honors system accessibility modes", () => {
    expect(globalCss).toContain("min-width: 320px");
    expect(globalCss).toContain("overflow-x: clip");
    expect(globalCss).toContain("@media (prefers-contrast: more)");
    expect(globalCss).toContain("@media (forced-colors: active)");
    expect(globalCss).toContain("html[data-reduce-motion=\"true\"] *");
  });

  it("retains visible focus and full-size global actions", () => {
    expect(globalCss).toContain(":focus-visible");
    expect(globalCss).toContain("outline: 2px solid var(--brand)");
    expect(globalCss).toContain("outline-offset: 2px");
    expect(globalCss).toContain("min-height: 44px");
    expect(globalCss).toContain("touch-action: manipulation");
  });

  it("keeps the approved brand focus ring at 3:1 contrast on light and high-contrast surfaces", () => {
    const css = postcss.parse(globalCss);
    function tokens(selector: string) {
      const values: Record<string, string> = {};
      css.walkRules(selector, (rule) => {
        if (rule.parent?.type !== "root") return;
        rule.walkDecls((decl) => { values[decl.prop] = decl.value; });
      });
      return values;
    }
    function luminance(hex: string) {
      expect(hex).toMatch(/^#[0-9a-f]{6}$/i);
      const rgb = hex.slice(1).match(/../g)!.map((value) => {
        const channel = parseInt(value, 16) / 255;
        return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
      });
      return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
    }
    for (const selector of [":root", ':root[data-interface-theme="contrast"]']) {
      const theme = tokens(selector);
      const ring = luminance(theme["--brand"]);
      for (const surface of ["--canvas", "--surface-solid", "--surface-muted", "--brand-soft"]) {
        const background = luminance(theme[surface]);
        expect((Math.max(ring, background) + .05) / (Math.min(ring, background) + .05), `${selector} ${surface}`).toBeGreaterThanOrEqual(3);
      }
    }
    expect(globalCss).toContain("outline-color: Highlight");
  });
});
