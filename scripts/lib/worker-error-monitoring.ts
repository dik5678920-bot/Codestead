import { errorMonitoringOptions } from "../../src/lib/observability/error-monitoring";

type SentryNode = typeof import("@sentry/node");

// The SDK is loaded only when a DSN is configured. Importing it statically made
// every worker healthcheck (scripts/check-worker-health.ts, via worker-health.ts)
// load the whole SDK, which took longer than the 5s healthcheck timeout.
let sdk: Promise<SentryNode | null> | undefined;

function loadSdk(): Promise<SentryNode | null> {
  if (sdk) return sdk;
  const options = errorMonitoringOptions({
    runtime: "worker",
    dsn: process.env.SENTRY_DSN,
    release: process.env.SENTRY_RELEASE,
    environment: process.env.SENTRY_ENVIRONMENT,
  });
  if (!options) {
    sdk = Promise.resolve(null);
    return sdk;
  }
  sdk = import("@sentry/node").then((Sentry) => {
    // Workers only report their own terminal failures: no automatic
    // instrumentation, tracing or global handlers beyond the error itself.
    Sentry.init({ ...options, defaultIntegrations: false, tracesSampleRate: 0 });
    return Sentry;
  });
  return sdk;
}

/**
 * Report a worker's terminal failure. A no-op unless SENTRY_DSN is set; never
 * throws or rejects, because monitoring must not change how a worker fails.
 * The returned promise lets callers that can wait (tests) observe completion;
 * the event loop keeps the process alive until the report is sent.
 */
export function reportWorkerTerminalFailure(worker: string, code: string, error: unknown): Promise<void> {
  return loadSdk()
    .then((Sentry) => {
      Sentry?.captureException(error, { tags: { worker, code }, level: "fatal" });
    })
    .catch(() => undefined);
}

/** Test hook: forget the cached configuration decision. */
export function resetWorkerErrorMonitoringForTests() {
  sdk = undefined;
}
