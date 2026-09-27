import type { Instrumentation } from "next";

import { errorMonitoringOptions } from "@/lib/observability/error-monitoring";

function serverOptions(runtime: "nodejs" | "edge") {
  return errorMonitoringOptions({
    runtime,
    dsn: process.env.SENTRY_DSN,
    release: process.env.SENTRY_RELEASE,
    environment: process.env.SENTRY_ENVIRONMENT,
    tracesSampleRate: process.env.SENTRY_TRACES_SAMPLE_RATE,
  });
}

let enabled = false;

/** Error monitoring is initialized only when SENTRY_DSN is configured. */
export async function register() {
  const runtime = process.env.NEXT_RUNTIME === "edge" ? "edge" : "nodejs";
  const options = serverOptions(runtime);
  if (!options) return;
  const Sentry = await import("@sentry/nextjs");
  Sentry.init(options);
  enabled = true;
}

export const onRequestError: Instrumentation.onRequestError = async (...args) => {
  if (!enabled) return;
  const Sentry = await import("@sentry/nextjs");
  Sentry.captureRequestError(...args);
};
