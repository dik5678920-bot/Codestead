import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repository = process.cwd();
const evidencePath = "docs/evidence/architecture-import-boundaries-2026-07-12.json";
type Issue = { file: string; import: string; rule: string; chain?: string[] };

async function inspect(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codestead-import-boundaries-"));
  try {
    const existing = JSON.parse(await readFile(path.join(repository, evidencePath), "utf8")) as {
      documentedExceptions: { file: string; import: string }[];
    };
    const sources: Record<string, string> = {};
    for (const exception of existing.documentedExceptions) {
      sources[exception.file] = (sources[exception.file] ?? "") + `import ${JSON.stringify(exception.import)};\n`;
      sources[`${exception.import.replace("@/", "src/")}.ts`] ??= "export {};\n";
    }
    await mkdir(path.join(root, "docs/evidence"), { recursive: true });
    for (const [file, source] of Object.entries({ ...sources, ...files })) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), source);
    }
    const run = spawnSync(process.execPath, [
      path.join(repository, "node_modules/tsx/dist/cli.mjs"),
      path.join(repository, "scripts/verify-import-boundaries.ts"), "--apply",
    ], { cwd: root, encoding: "utf8", timeout: 20_000 });
    if (run.error) throw run.error;
    const evidence = JSON.parse(await readFile(path.join(root, evidencePath), "utf8")) as {
      violations: Issue[]; documentedExceptions: unknown[]; staleExceptions: unknown[]; passed: boolean;
    };
    return { ...evidence, status: run.status, stderr: run.stderr };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("import boundary checker", () => {
  it("rejects a relative database import from a client module", async () => {
    const result = await inspect({
      "src/lib/browser/entry.ts": '"use client";\nimport { db } from "../db/client";',
      "src/lib/db/client.ts": "export const db = 1;",
    });
    expect(result.violations).toContainEqual(expect.objectContaining({
      file: "src/lib/browser/entry.ts", import: "../db/client", rule: "client-module-must-not-import-server-runtime",
    }));
    expect(result.status).toBe(1);
  });

  it("detects the client directive after leading comments and whitespace", async () => {
    const result = await inspect({
      "src/lib/browser/entry.ts": '\n/* license */\n// client entry\n"use client";\nimport { db } from "@/lib/db/client";',
      "src/lib/db/client.ts": "export const db = 1;",
    });
    expect(result.violations).toContainEqual(expect.objectContaining({
      file: "src/lib/browser/entry.ts", rule: "client-module-must-not-import-server-runtime",
    }));
    expect(result.status).toBe(1);
  });

  it("reports a transitive server import with its full chain", async () => {
    const result = await inspect({
      "src/lib/browser/entry.ts": '"use client";\nimport { helper } from "./helper";',
      "src/lib/browser/helper.ts": 'import fs from "node:fs";\nexport const helper = fs;',
    });
    expect(result.violations).toContainEqual(expect.objectContaining({
      file: "src/lib/browser/entry.ts", rule: "client-module-must-not-import-server-runtime",
      chain: ["src/lib/browser/entry.ts", "src/lib/browser/helper.ts", "node:fs"],
    }));
    expect(result.stderr).toContain("src/lib/browser/entry.ts -> src/lib/browser/helper.ts -> node:fs");
    expect(result.status).toBe(1);
  });

  it("preserves all ten documented exceptions", async () => {
    const result = await inspect({});
    expect(result.documentedExceptions).toHaveLength(10);
    expect(result.staleExceptions).toEqual([]);
    expect(result.violations).toEqual([]);
    expect(result.status).toBe(0);
  });

  it("resolves alias and relative index imports across a cycle", async () => {
    const result = await inspect({
      "src/lib/browser/entry.ts": '"use client";\nimport "@/lib/browser/helpers";',
      "src/lib/browser/helpers/index.ts": 'import "../entry";\nexport { db } from "../../db";',
      "src/lib/db/index.ts": "export const db = 1;",
    });
    expect(result.violations).toContainEqual(expect.objectContaining({
      chain: ["src/lib/browser/entry.ts", "src/lib/browser/helpers/index.ts", "src/lib/db/index.ts"],
    }));
    expect(result.status).toBe(1);
  });

  it("does not treat a directive after an ordinary statement as a client entry", async () => {
    const result = await inspect({
      "src/lib/browser/entry.ts": 'const value = 1;\n"use client";\nimport fs from "node:fs";\nexport { value, fs };',
    });
    expect(result.violations).toEqual([]);
    expect(result.status).toBe(0);
  });

  it("follows JavaScript dependencies outside src and catches bare Node subpaths", async () => {
    const result = await inspect({
      "src/lib/browser/entry.ts": '"use client";\nimport "../../../shared/helper.mjs";',
      "shared/helper.mjs": 'export { readFile } from "fs/promises";',
    });
    expect(result.violations).toContainEqual(expect.objectContaining({
      chain: ["src/lib/browser/entry.ts", "shared/helper.mjs", "fs/promises"],
    }));
    expect(result.status).toBe(1);
  });

  it("detects a client directive in the directive prologue", async () => {
    const result = await inspect({
      "src/lib/browser/entry.ts": '"use strict";\n"use client";\nimport fs from "node:fs";',
    });
    expect(result.violations).toContainEqual(expect.objectContaining({
      file: "src/lib/browser/entry.ts", rule: "client-module-must-not-import-server-runtime",
    }));
    expect(result.status).toBe(1);
  });

  it("does not traverse an erased type-only dependency", async () => {
    const result = await inspect({
      "src/lib/browser/entry.ts": '"use client";\nimport type { Helper } from "./helper";',
      "src/lib/browser/helper.ts": 'import fs from "node:fs";\nexport type Helper = typeof fs;',
    });
    expect(result.violations).toEqual([]);
    expect(result.status).toBe(0);
  });

  it("recognizes an auth directory index as a server boundary", async () => {
    const result = await inspect({
      "src/lib/browser/entry.ts": '"use client";\nimport "../auth";',
      "src/lib/auth/index.ts": "export {};",
    });
    expect(result.violations).toContainEqual(expect.objectContaining({
      file: "src/lib/browser/entry.ts", rule: "client-module-must-not-import-server-runtime",
    }));
    expect(result.status).toBe(1);
  });
});
