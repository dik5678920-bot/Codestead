import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { WEB_BROWSER_TASKS, type BrowserVerificationCase } from "../content-seeds/web-executable-tranche";

const bank = JSON.parse(readFileSync("content/authored/assessment-banks/react.routing.routes.json", "utf8"));
const authored = JSON.parse(bank.items.find((item: { kind: string }) => item.kind === "code").tests[0].stdin) as BrowserVerificationCase;

afterEach(() => {
  document.body.innerHTML = "";
  history.replaceState({}, "", "/");
});

describe("web routing commit synchronization", () => {
  it.each([
    ["authoring seed", WEB_BROWSER_TASKS["react.routing.routes"].visible],
    ["committed case", authored],
  ] as const)("waits for the new route heading, not just the history URL (%s)", (_name, testCase) => {
    const wait = testCase.actions!.find((action) => action.type === "waitFor")!;
    history.replaceState({}, "", "/projects");
    document.body.innerHTML = "<main><h1>Home</h1></main>";
    const condition = new Function(`return (${wait.expression});`);
    expect(condition()).toBe(false);
    document.querySelector("h1")!.textContent = "Projects";
    expect(condition()).toBe(true);
    expect(wait.milliseconds).toBe(5_000);
    expect(new Function(`return (${testCase.assertions[0]!.expression});`)()).toBe(testCase.assertions[0]!.expected);
  });
});
