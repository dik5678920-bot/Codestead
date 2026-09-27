import * as Sentry from "@sentry/node";

import { errorMonitoringOptions } from "../../src/lib/observability/error-monitoring";

let state: "unconfigured" | "enabled" | "disabled" = "unconfigured";

function ensureInitialized() {
  if (state !== "unconfigured") return state === "enabled";
  const options = errorMonitoringOptions({
    runtime: "worker",
    dsn: process.env.SENTRY_DSN,
    release: process.env.SENTRY_RELEASE,
    environment: process.env.SENTRY_ENVIRONMENT,
  });
  if (!options) {
    state = "disabled";
    return false;
  }
  // Workers only report their own terminal failures: no automatic
  // instrumentation, tracing or global handlers beyond the error itself.
  Sentry.init({ ...options, defaultIntegrations: false, tracesSampleRate: 0 });
  state = "enabled";
  return true;
}

/**
 * Report a worker's terminal failure. A no-op unless SENTRY_DSN is set; never
 * throws, because monitoring must not change how a worker fails.
 */
export function reportWorkerTerminalFailure(worker: string, code: string, error: unknown) {
  try {
    if (!ensureInitialized()) return;
    Sentry.captureException(error, { tags: { worker, code }, level: "fatal" });
  } catch {
    // Best effort only.
  }
}

/** Test hook: forget the cached configuration decision. */
export function resetWorkerErrorMonitoringForTests() {
  state = "unconfigured";
}
