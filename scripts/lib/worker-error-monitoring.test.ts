import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const init = vi.fn();
const captureException = vi.fn();
vi.mock("@sentry/node", () => ({ init, captureException }));

const { reportWorkerTerminalFailure, resetWorkerErrorMonitoringForTests } = await import("./worker-error-monitoring");

beforeEach(() => {
  init.mockReset();
  captureException.mockReset();
  resetWorkerErrorMonitoringForTests();
});
afterEach(() => vi.unstubAllEnvs());

describe("reportWorkerTerminalFailure", () => {
  it("is a no-op without SENTRY_DSN", () => {
    vi.stubEnv("SENTRY_DSN", "");
    reportWorkerTerminalFailure("mail-worker", "WORKER_OPERATION_FAILED", new Error("boom"));
    expect(init).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  it("initializes once with scrubbing and reports with allow-listed tags", () => {
    vi.stubEnv("SENTRY_DSN", "https://key@errors.example.test/2");
    vi.stubEnv("SENTRY_RELEASE", "abc1234");
    const error = new Error("boom");
    reportWorkerTerminalFailure("mail-worker", "WORKER_OPERATION_FAILED", error);
    reportWorkerTerminalFailure("mail-worker", "WORKER_OPERATION_FAILED", error);
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

  it("never throws when the SDK fails", () => {
    vi.stubEnv("SENTRY_DSN", "https://key@errors.example.test/2");
    captureException.mockImplementation(() => {
      throw new Error("sdk down");
    });
    expect(() => reportWorkerTerminalFailure("mail-worker", "X", new Error("boom"))).not.toThrow();
  });
});
