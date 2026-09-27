import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdkLoaded = vi.fn();
const init = vi.fn();
const captureException = vi.fn();
vi.mock("@sentry/node", () => {
  sdkLoaded();
  return { init, captureException };
});

const { reportWorkerTerminalFailure, resetWorkerErrorMonitoringForTests } = await import("./worker-error-monitoring");

beforeEach(() => {
  init.mockReset();
  captureException.mockReset();
  resetWorkerErrorMonitoringForTests();
});
afterEach(() => vi.unstubAllEnvs());

describe("reportWorkerTerminalFailure", () => {
  it("never loads the SDK at module load (worker healthchecks import this module)", async () => {
    vi.resetModules();
    sdkLoaded.mockClear();
    await import("./worker-health");
    await import("./worker-error-monitoring");
    expect(sdkLoaded).not.toHaveBeenCalled();
  });

  it("is a no-op that never loads the SDK without SENTRY_DSN", async () => {
    vi.stubEnv("SENTRY_DSN", "");
    sdkLoaded.mockClear();
    await reportWorkerTerminalFailure("mail-worker", "WORKER_OPERATION_FAILED", new Error("boom"));
    expect(sdkLoaded).not.toHaveBeenCalled();
    expect(init).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  it("initializes once with scrubbing and reports with allow-listed tags", async () => {
    vi.stubEnv("SENTRY_DSN", "https://key@errors.example.test/2");
    vi.stubEnv("SENTRY_RELEASE", "abc1234");
    const error = new Error("boom");
    await reportWorkerTerminalFailure("mail-worker", "WORKER_OPERATION_FAILED", error);
    await reportWorkerTerminalFailure("mail-worker", "WORKER_OPERATION_FAILED", error);
    expect(init).toHaveBeenCalledOnce();
    expect(init.mock.calls[0]![0]).toMatchObject({
      dsn: "https://key@errors.example.test/2",
      release: "abc1234",
      sendDefaultPii: false,
      defaultIntegrations: false,
      tracesSampleRate: 0,
    });
    expect(captureException).toHaveBeenCalledWith(error, {
      tags: { worker: "mail-worker", code: "WORKER_OPERATION_FAILED" },
      level: "fatal",
    });
  });

  it("never throws or rejects when the SDK fails", async () => {
    vi.stubEnv("SENTRY_DSN", "https://key@errors.example.test/2");
    captureException.mockImplementation(() => {
      throw new Error("sdk down");
    });
    await expect(reportWorkerTerminalFailure("mail-worker", "X", new Error("boom"))).resolves.toBeUndefined();
  });
});
