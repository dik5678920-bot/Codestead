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

/** Validate startup configuration before optionally initializing monitoring. */
export async function register() {
  if (process.env.NODE_ENV === "production" && !process.env.APP_URL?.trim()) {
    const error = new Error("APP_URL is required in production. Set it to the public HTTPS origin before starting the server.");
    if (process.env.NEXT_RUNTIME !== "edge") {
      // Next can catch a rejected prepare hook without terminating its listener.
      // Startup configuration failure must stop the Node process itself.
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
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
