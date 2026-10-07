import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_ENVELOPE_BYTES } from "@/lib/observability/envelope-tunnel";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  account: vi.fn(),
  query: vi.fn(),
  counters: new Map<string, number>(),
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock("@/lib/db/client", () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: mocks.account }) }) }) },
  pool: {},
}));
vi.mock("@/lib/exams/capability-gate", () => ({ gateClosedBookCapability: vi.fn() }));
vi.mock("@/lib/security/rate-limit", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/security/rate-limit")>();
  return {
    ...original,
    withRateLimit: (checks: Parameters<typeof original.withRateLimit>[0], handler: () => Promise<Response>) =>
      original.withRateLimit(checks, handler, {
        store: new original.FlexiblePostgresRateLimitStore({ query: mocks.query }, Infinity),
        now: () => new Date("2026-10-03T00:00:10Z"),
        secret: "monitoring-test-rate-limit-secret-32-bytes",
      }),
  };
});

const { GET, POST } = await import("../route");
const envelope = '{}\n{"type":"event"}\n{}';
const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
  .mockImplementation(async () => new Response(null, { status: 200 }));
const session = (id = "learner-1", mfaVerifiedAt: Date | null = new Date()) => ({
  user: { id }, session: { id: "session-1", userId: id, mfaVerifiedAt },
});
const post = (ip = "192.0.2.1", body: BodyInit = envelope) => POST(new NextRequest(
  "https://learn.example.test/api/monitoring/envelope",
  { method: "POST", headers: { "x-real-ip": ip }, body },
));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.counters.clear();
  mocks.getSession.mockResolvedValue(session());
  mocks.account.mockResolvedValue([{
    status: "active", role: "learner", twoFactorEnabled: true, mustChangePassword: false,
  }]);
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-03T00:00:10Z"));
  mocks.query.mockImplementation(async (command) => {
    const key = command.values[0];
    const count = (mocks.counters.get(key) ?? 0) + 1;
    mocks.counters.set(key, count);
    return { rows: [{ points: count, expire: command.values[2] }] };
  });
  vi.stubEnv("SENTRY_BROWSER_DSN", "https://serverkey@errors.example.test/9");
  vi.stubEnv("RATE_LIMIT_TRUSTED_IP_HEADER", "x-real-ip");
  vi.stubEnv("RATE_LIMIT_OVERRIDES_JSON", "");
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("monitoring relay security", () => {
  it("denies a password-only session before reading or forwarding its envelope", async () => {
    mocks.getSession.mockResolvedValue(session("learner-1", null));
    const request = new NextRequest("https://learn.example.test/api/monitoring/envelope", {
      method: "POST", body: envelope,
    });
    expect((await GET()).status).toBe(403);
    const response = await POST(request);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "MFA_CHALLENGE_REQUIRED" });
    expect(request.bodyUsed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: "pending", twoFactorEnabled: true, mustChangePassword: false }, "ACCOUNT_SETUP_REQUIRED"],
    [{ status: "active", twoFactorEnabled: false, mustChangePassword: false }, "MFA_REQUIRED"],
    [{ status: "active", twoFactorEnabled: true, mustChangePassword: true }, "PASSWORD_CHANGE_REQUIRED"],
  ])("denies accounts that have not completed protected-feature setup (%j)", async (account, code) => {
    mocks.account.mockResolvedValue([{ ...account, role: "learner" }]);
    expect((await GET()).status).toBe(403);
    const response = await post();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("limits one user to 30 envelopes per minute even across IPs", async () => {
    for (let index = 0; index < 30; index++) expect((await post(`192.0.2.${index + 1}`)).status).toBe(202);
    const blocked = await post("192.0.2.99");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("50");
    expect(fetchMock).toHaveBeenCalledTimes(30);
    const request = new NextRequest("https://learn.example.test/api/monitoring/envelope", {
      method: "POST", body: envelope,
    });
    expect((await POST(request)).status).toBe(429);
    expect(request.bodyUsed).toBe(false);
  });

  it("limits one trusted IP to 30 envelopes across different users", async () => {
    for (let index = 0; index < 30; index++) {
      mocks.getSession.mockResolvedValue(session(`learner-${index}`));
      expect((await post()).status).toBe(202);
    }
    mocks.getSession.mockResolvedValue(session("another-learner"));
    expect((await post()).status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(30);
  });

  it("fails closed when the limiter store is unavailable", async () => {
    mocks.query.mockRejectedValue(new Error("store unavailable"));
    expect((await post()).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancels an oversized chunked body without reading the remaining chunks", async () => {
    const cancel = vi.fn();
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      if (pull.mock.calls.length === 1) controller.enqueue(new Uint8Array(MAX_ENVELOPE_BYTES + 1));
      else controller.close();
    });
    const body = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
    const request = new NextRequest("https://learn.example.test/api/monitoring/envelope", {
      method: "POST", body, duplex: "half",
    } as ConstructorParameters<typeof NextRequest>[1]);
    expect((await POST(request)).status).toBe(413);
    expect(pull).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("counts actual bytes even when Content-Length understates a multibyte body", async () => {
    const body = '{}\n{"type":"event"}\n' + JSON.stringify({ message: "é".repeat(MAX_ENVELOPE_BYTES / 2) });
    expect(body.length).toBeLessThan(MAX_ENVELOPE_BYTES);
    const response = await POST(new NextRequest("https://learn.example.test/api/monitoring/envelope", {
      method: "POST", headers: { "content-length": "1" }, body,
    }));
    expect(response.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards an exactly capped envelope with UTF-8 split across chunks", async () => {
    const base = '{}\n{"type":"event"}\n' + JSON.stringify({ message: "é" });
    const body = base.replace("é", "é" + "x".repeat(MAX_ENVELOPE_BYTES - Buffer.byteLength(base)));
    const bytes = new TextEncoder().encode(body);
    const split = bytes.indexOf(0xc3) + 1;
    const stream = new ReadableStream({ start(controller) {
      controller.enqueue(bytes.slice(0, split));
      controller.enqueue(bytes.slice(split));
      controller.close();
    } });
    expect(bytes.byteLength).toBe(MAX_ENVELOPE_BYTES);
    expect((await post("192.0.2.1", stream)).status).toBe(202);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const [, itemHeader, payload] = String(init?.body).split("\n");
    expect(JSON.parse(itemHeader!)).toEqual({ type: "event", length: Buffer.byteLength(payload!) });
    // The event is rebuilt by the scrubber (text is length-capped), but the
    // multi-byte character split across chunks must decode intact.
    expect(JSON.parse(payload!).message.startsWith("éxxx")).toBe(true);
  });
});
