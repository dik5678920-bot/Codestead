import { runnerHealth } from "@/lib/runner/health";

export const runtime = "nodejs";
export async function GET() {
  const result = await runnerHealth();
  return Response.json({ status: result.status, latencyMs: result.latencyMs }, {
    status: result.status === "ready" ? 200 : 503,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(result.status === "unavailable" ? { "Retry-After": "30" } : {}),
    },
  });
}
