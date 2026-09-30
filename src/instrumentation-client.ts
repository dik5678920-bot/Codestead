import { errorMonitoringOptions } from "@/lib/observability/error-monitoring";

const ENVELOPE_ROUTE = "/api/monitoring/envelope";
// Placeholder the server replaces with its own DSN; the browser never holds
// the real one and only ever talks to this origin.
const TUNNEL_DSN = "https://browser@tunnel.invalid/1";

async function startBrowserErrorMonitoring() {
  // The SDK is only downloaded when the server says monitoring is on for this
  // signed-in session; anonymous pages and unconfigured deployments skip it.
  const response = await fetch(ENVELOPE_ROUTE, { cache: "no-store", credentials: "same-origin" });
  if (!response.ok) return;
  const status = (await response.json().catch(() => null)) as { enabled?: unknown; release?: unknown } | null;
  if (status?.enabled !== true) return;
  const options = errorMonitoringOptions({
    runtime: "browser", dsn: TUNNEL_DSN,
    release: typeof status.release === "string" ? status.release : undefined,
  });
  if (!options) return;
  const Sentry = await import("@sentry/nextjs");
  Sentry.init({
    ...options,
    tunnel: ENVELOPE_ROUTE,
    // No session replay, performance tracing or default browser integrations
    // that record user activity; only uncaught errors and rejections.
    defaultIntegrations: false,
    integrations: [Sentry.globalHandlersIntegration(), Sentry.linkedErrorsIntegration(), Sentry.dedupeIntegration()],
    tracesSampleRate: 0,
  });
}

if (typeof window !== "undefined") {
  void startBrowserErrorMonitoring().catch(() => undefined);
}
