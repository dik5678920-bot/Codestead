import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({ connect: vi.fn(), query: vi.fn(), end: vi.fn(), on: vi.fn() }));
vi.mock("pg", () => ({ Client: class {
  connect = client.connect;
  query = client.query;
  end = client.end;
  on = client.on;
} }));

import { probeWorkerDatabase, waitForWorkerDatabase } from "./worker-database-startup";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

function clock() {
  let elapsed = 0;
  const sleep = vi.fn(async (milliseconds: number) => { elapsed += milliseconds; });
  return { now: () => elapsed, sleep };
}

describe("worker database startup", () => {
  it("closes its probe connection after an authenticated readiness query", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://fixture:fixture@localhost/fixture");
    client.connect.mockResolvedValue(undefined);
    client.query.mockResolvedValue({ rows: [{ ready: 1 }] });
    client.end.mockResolvedValue(undefined);
    await probeWorkerDatabase(5_000);
    expect(client.query).toHaveBeenCalledExactlyOnceWith("SELECT 1");
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("closes a stalled probe at its deadline", async () => {
    vi.useFakeTimers();
    vi.stubEnv("DATABASE_URL", "postgresql://fixture:fixture@localhost/fixture");
    client.connect.mockImplementation(() => new Promise(() => {}));
    client.end.mockResolvedValue(undefined);
    const result = expect(probeWorkerDatabase(1_000)).rejects.toMatchObject({ code: "WORKER_DATABASE_PROBE_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(1_000);
    await result;
    expect(client.end).toHaveBeenCalledOnce();
    expect(client.query).not.toHaveBeenCalled();
  });
  it("survives connection refusal and database recovery before starting work", async () => {
    const probe = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("secret URL"), { code: "ECONNREFUSED" }))
      .mockRejectedValueOnce(Object.assign(new Error("database starting"), { code: "57P03" }))
      .mockResolvedValue(undefined);
    const time = clock();
    await waitForWorkerDatabase({ probe, ...time });
    expect(probe).toHaveBeenCalledTimes(3);
    expect(time.sleep.mock.calls).toEqual([[1_000], [2_000]]);
  });

  it("uses capped backoff and stops at the startup deadline", async () => {
    const probe = vi.fn().mockRejectedValue(Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }));
    const time = clock();
    await expect(waitForWorkerDatabase({ probe, ...time })).rejects.toMatchObject({ code: "WORKER_DATABASE_STARTUP_TIMEOUT" });
    expect(time.now()).toBe(90_000);
    expect(time.sleep.mock.calls.every(([delay]) => delay <= 5_000)).toBe(true);
    expect(probe).toHaveBeenCalledTimes(20);
  });

  it.each(["28P01", "28000", "42501", "3D000", "42601", undefined])(
    "does not retry permanent or unknown errors (%s)", async (code) => {
      const error = Object.assign(new Error("secret credential in diagnostic"), { code });
      const probe = vi.fn().mockRejectedValue(error);
      const time = clock();
      await expect(waitForWorkerDatabase({ probe, ...time })).rejects.toBe(error);
      expect(probe).toHaveBeenCalledOnce();
      expect(time.sleep).not.toHaveBeenCalled();
    },
  );

  it("limits a probe to the remaining startup budget", async () => {
    let elapsed = 89_000;
    const probe = vi.fn(async () => { elapsed += 1_000; throw Object.assign(new Error(), { code: "WORKER_DATABASE_PROBE_TIMEOUT" }); });
    const sleep = vi.fn();
    const now = vi.fn().mockReturnValueOnce(0).mockImplementation(() => elapsed);
    await expect(waitForWorkerDatabase({ probe, sleep, now })).rejects.toMatchObject({ code: "WORKER_DATABASE_STARTUP_TIMEOUT" });
    expect(probe).toHaveBeenCalledExactlyOnceWith(1_000);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("checks database readiness after file secrets, before exec, for workers only", () => {
    const entrypoint = readFileSync("infra/docker/entrypoint.sh", "utf8");
    const check = entrypoint.indexOf("node --import tsx /app/scripts/lib/worker-database-startup.ts");
    expect(check).toBeGreaterThan(entrypoint.indexOf('unset restore_credential_master_key_path'));
    expect(check).toBeLessThan(entrypoint.indexOf('exec "$@"'));
    expect(entrypoint).toContain('[ -n "${WORKER_HEALTH_ID:-}" ]');
    const workerStage = readFileSync("Dockerfile", "utf8").split("FROM final-base AS worker")[1]!.split("FROM worker AS operations")[0]!;
    expect(workerStage).toContain("COPY --chown=node:node scripts/lib/worker-database-startup.ts ./scripts/lib/worker-database-startup.ts");
  });
});
