import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

function declarations(file: string, selector: string) {
  const values: Record<string, string> = {};
  postcss.parse(readFileSync(resolve(file), "utf8")).walkRules(selector, (rule) => {
    if (rule.parent?.type !== "root") return;
    rule.walkDecls((decl) => { values[decl.prop] = decl.value; });
  });
  return values;
}
const shell = "src/components/shell/app-shell.module.css";
const product = "src/components/product/product-pages.module.css";
const admin = "src/components/admin/admin.module.css";

describe("UI polish layout and accessibility", () => {
  it("uses the approved global focus ring", () => {
    expect(declarations("src/app/globals.css", ":focus-visible")).toMatchObject({ outline: "2px solid var(--brand)", "outline-offset": "2px" });
  });
  it("puts search focus on the pill and prevents icon shrink", () => {
    expect(declarations(shell, ".searchBox:focus-within").outline).toBe("2px solid var(--brand)");
    expect(declarations(shell, ".searchBox input:focus-visible").outline).toBe("none");
    expect(declarations(shell, ".searchBox > svg")).toMatchObject({ "flex-shrink": "0", width: "16px", height: "16px" });
  });
  it("keeps settings and curriculum navigation at the header offset", () => {
    for (const [file, selector] of [[product, ".settingsNav"], [admin, ".curriculumQueue"]]) {
      expect(declarations(file, selector)).toMatchObject({ position: "sticky", top: "var(--page-header-offset)", "align-self": "start" });
    }
    expect(declarations(product, ".settingsNav button:hover").background).toContain("var(--signal-cyan-soft)");
  });
  it("keeps device controls readable without squeezing their labels", () => {
    expect(declarations(product, ".deviceSession")["grid-template-columns"]).toBe("42px minmax(0, 1fr) auto auto");
    expect(declarations(product, ".deviceSession > button")).toMatchObject({ "white-space": "nowrap", "min-height": "44px" });
  });
  it("replaces oversized exam cards with a compact information strip", () => {
    expect(declarations("src/components/exams/exams.module.css", ".heroPrinciples > span")["min-height"]).toBe("0");
    expect(declarations("src/components/exams/exams.module.css", ".catalogToolbar").padding).toBe("8px 12px");
  });
});
