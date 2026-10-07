import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

// Run after npm run build. Uses the production CSS; no application data or screenshots.
const directory = ".next/static/chunks";
const css = readdirSync(directory).filter((name) => name.endsWith(".css"))
  .map((name) => readFileSync(join(directory, name), "utf8")).join("\n");
function className(module, name) {
  const match = css.match(new RegExp(`${module}-module__[\\w-]+__${name}(?![\\w-])`));
  assert.ok(match, `Missing built class: ${module}.${name}`);
  return match[0];
}
const shared = (name) => className("form", name);
const browser = await chromium.launch(process.env.FORM_BROWSER_EXECUTABLE
  ? { executablePath: process.env.FORM_BROWSER_EXECUTABLE } : {});
try {
  const page = await browser.newPage();
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [module, name] of [["product-pages", "form"], ["admin", "approveForm"], ["admin-ai-models", "fields"], ["milestones", "form"]]) {
      await page.setContent(`<style>${css}</style><form class="${className(module, name)} ${shared("form")}">
        <section class="${shared("section")}">
          <div class="${shared("field")}" id="first"><label for="name">Display name</label><input id="name" value="Learner"><small>Private display name</small></div>
          <div class="${shared("field")}" id="second"><label for="preference">Analogy preference</label><select id="preference"><option>When helpful</option></select><small>Choose your preference</small></div>
          <div class="${shared("field")}"><label for="bio">Bio</label><textarea id="bio">Learning</textarea><small>8/280</small></div>
        </section>
        <div class="${shared("actions")}" id="actions"><p role="status">Saved</p><button class="button button-primary" type="submit">Save profile</button><button class="button button-secondary" type="button">Cancel</button></div>
      </form>`);
      const measurements = await page.evaluate(() => {
        const form = document.querySelector("form");
        const input = document.querySelector("input");
        const select = document.querySelector("select");
        const label = document.querySelector("label");
        const first = document.querySelector("#first");
        const second = document.querySelector("#second");
        const style = (e) => { const s = getComputedStyle(e); return [s.minHeight, s.borderRadius, s.backgroundColor]; };
        return {
          formWidth: form.getBoundingClientRect().width,
          labelGap: input.getBoundingClientRect().top - label.getBoundingClientRect().bottom,
          fieldGap: second.getBoundingClientRect().top - first.getBoundingClientRect().bottom,
          input: style(input), select: style(select),
          buttons: [...document.querySelectorAll("button")].map((e) => e.getBoundingClientRect().height),
          align: getComputedStyle(document.querySelector("#actions")).justifyContent,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      assert.ok(measurements.formWidth <= 560, `${module}: bounded column`);
      assert.equal(measurements.labelGap, 8, `${module}: label gap`);
      assert.equal(measurements.fieldGap, 22, `${module}: field gap`);
      assert.deepEqual(measurements.select, measurements.input, `${module}: native control consistency`);
      assert.ok(measurements.buttons.every((height) => height >= 44), `${module}: button targets`);
      assert.equal(measurements.align, "flex-end");
      assert.equal(measurements.overflow, false, `${module}: ${width}px overflow`);
      for (const theme of ["light", "dark", "contrast"]) {
        await page.evaluate((value) => document.documentElement.dataset.interfaceTheme = value, theme);
        await page.locator("input").focus();
        const focus = await page.locator("input").evaluate((e) => {
          const s = getComputedStyle(e);
          const probe = document.createElement("span");
          probe.style.color = "var(--brand)";
          document.body.append(probe);
          const brand = getComputedStyle(probe).color;
          probe.remove();
          return [s.outlineWidth, s.outlineOffset, s.outlineColor, brand];
        });
        assert.equal(focus[0], "2px");
        assert.equal(focus[1], "2px");
        assert.equal(focus[2], focus[3]);
      }
    }
  }
} finally {
  await browser.close();
}
