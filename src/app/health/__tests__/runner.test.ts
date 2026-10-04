import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ health: vi.fn() }));
vi.mock("@/lib/runner/health", () => ({ runnerHealth: mocks.health }));
import { GET } from "../runner/route";
afterEach(() => vi.clearAllMocks());
it.each(["ready", "unavailable"])("returns only generic %s and probe latency without authentication", async (status) => {
  mocks.health.mockResolvedValue({ status, latencyMs: 12 });
  const response = await GET(); expect(response.status).toBe(status === "ready" ? 200 : 503);
  expect(await response.json()).toEqual({ status, latencyMs: 12 });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
});
it("returns generic 503 plus Retry-After for the request limit", async () => {
  mocks.health.mockResolvedValue({ status: "unavailable", latencyMs: 0, limited: true });
  const response = await GET(); expect(response.status).toBe(503); expect(response.headers.get("retry-after")).toBe("30");
  expect(await response.json()).toEqual({ status: "unavailable", latencyMs: 0 });
});
