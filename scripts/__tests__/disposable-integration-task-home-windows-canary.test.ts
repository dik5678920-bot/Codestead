import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createDisposableIntegrationTaskHome } from
  "../lib/disposable-integration-task-home";

// Real token/ACL setup can involve several cold OS commands. Keep their native
// security deadlines while preparing the fixture before the assertion budget.
const preparedHome = process.platform === "win32"
  ? createDisposableIntegrationTaskHome()
  : undefined;
afterAll(() => preparedHome?.cleanup());

describe("disposable integration task-home Windows ACL canary", () => {
  it.runIf(process.platform === "win32")(
    "uses the real token ACL for write access and exact cleanup",
    () => {
      let home: ReturnType<
        typeof createDisposableIntegrationTaskHome
      > | undefined;
      let homePath: string | undefined;
      try {
        home = preparedHome!;
        homePath = home.path;
        const canaryPath = path.join(
          home.path,
          "tmp",
          "write-canary.txt",
        );
        writeFileSync(canaryPath, "canary", {
          encoding: "utf8",
          flag: "wx",
        });
        expect(existsSync(canaryPath)).toBe(true);
      } finally {
        home?.cleanup();
      }
      expect(homePath).toBeDefined();
      if (homePath !== undefined) {
        expect(existsSync(homePath)).toBe(false);
      }
    },
  );
});
