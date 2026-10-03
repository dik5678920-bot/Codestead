import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requireAuth = vi.fn();
vi.mock("@/lib/http/authz", () => ({ requireAuth }));
vi.mock("@/lib/security/rate-limit", () => ({
  rateLimitIp: () => "192.0.2.1",
  withRateLimit: (_checks: unknown, handler: () => Promise<Response>) => handler(),
}));

const { GET, POST } = await import("../route");

const signedIn = { session: { user: { id: "u1" } }, account: { status: "active" }, response: null };
const envelope = [
  JSON.stringify({ dsn: "https://browser@tunnel.invalid/1", event_id: "e1" }),
  JSON.stringify({ type: "event" }),
  JSON.stringify({ event_id: "e1" }),
].join("\n");

function post(body = envelope) {
  return POST(new NextRequest("https://learn.example.test/api/monitoring/envelope", { method: "POST", body }));
}

const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));

beforeEach(() => {
  requireAuth.mockReset().mockResolvedValue(signedIn);
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("SENTRY_RELEASE", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("monitoring envelope route", () => {
  it("requires a signed-in session", async () => {
    requireAuth.mockResolvedValue({ session: null, response: NextResponse.json({}, { status: 401 }) });
    expect((await GET()).status).toBe(401);
    expect((await post()).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports disabled and forwards nothing without SENTRY_BROWSER_DSN", async () => {
    vi.stubEnv("SENTRY_BROWSER_DSN", "");
    vi.stubEnv("SENTRY_RELEASE", "a".repeat(40));
    expect(await (await GET()).json()).toEqual({ enabled: false });
    expect((await post()).status).toBe(204);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the current deploy release at request time without exposing the DSN", async () => {
    vi.stubEnv("SENTRY_BROWSER_DSN", "https://serverkey@errors.example.test/9");
    for (const release of ["a".repeat(40), "b".repeat(40)]) {
      vi.stubEnv("SENTRY_RELEASE", ` ${release} `);
      const response = await GET();
      expect(await response.json()).toEqual({ enabled: true, release });
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
  });

  it("forwards a valid error envelope to the server-held DSN", async () => {
    vi.stubEnv("SENTRY_BROWSER_DSN", "https://serverkey@errors.example.test/9");
    expect(await (await GET()).json()).toEqual({ enabled: true });
    expect((await post()).status).toBe(202);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://errors.example.test/api/9/envelope/");
    expect(JSON.parse(String(init.body).split("\n")[0]!).dsn).toBe("https://serverkey@errors.example.test/9");
  });

  it("rejects envelopes that are not plain error events", async () => {
    vi.stubEnv("SENTRY_BROWSER_DSN", "https://serverkey@errors.example.test/9");
    expect((await post(envelope.replace('"event"}', '"replay_event"}'))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
