import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

const RETRYABLE_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN",
  "57P01", "57P02", "57P03", "53300", "WORKER_DATABASE_PROBE_TIMEOUT",
]);

function startupError(code: string) {
  return Object.assign(new Error(code), { code });
}

export async function probeWorkerDatabase(timeoutMs: number): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw startupError("WORKER_DATABASE_URL_REQUIRED");
  const client = new Client({ connectionString });
  // A socket failure can also emit outside the pending query. The query or
  // bounded probe rejects it; never allow an unhandled EventEmitter error.
  client.on("error", () => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        await client.connect();
        await client.query("SELECT 1");
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(startupError("WORKER_DATABASE_PROBE_TIMEOUT")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await client.end();
  }
}

/** Wait only for initial connectivity. Runtime failures retain worker policy. */
export async function waitForWorkerDatabase({
  probe = probeWorkerDatabase,
  now = () => performance.now(),
  sleep: pause = sleep,
}: {
  probe?: (timeoutMs: number) => Promise<void>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<unknown>;
} = {}): Promise<void> {
  const deadline = now() + 90_000;
  let backoff = 1_000;
  while (now() < deadline) {
    try {
      await probe(Math.min(5_000, deadline - now()));
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (typeof code !== "string" || !RETRYABLE_CODES.has(code)) throw error;
      const remaining = deadline - now();
      if (remaining <= 0) break;
      await pause(Math.min(backoff, remaining));
      backoff = Math.min(backoff * 2, 5_000);
    }
  }
  throw startupError("WORKER_DATABASE_STARTUP_TIMEOUT");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  waitForWorkerDatabase().catch(() => {
    // Never log database URLs, credentials, or driver diagnostics.
    console.error(JSON.stringify({ event: "worker.database_startup_failed", code: "WORKER_DATABASE_STARTUP_FAILED" }));
    process.exitCode = 1;
  });
}
