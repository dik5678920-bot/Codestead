// @vitest-environment node
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), mfa: vi.fn(), execute: vi.fn(), list: vi.fn(), audit: vi.fn(), rate: vi.fn(), usage: vi.fn() }));
vi.mock("@/lib/ai/platform-quota", () => ({ todayPlatformUsage: mocks.usage }));
vi.mock("@/lib/http/authz", () => ({ requireAdmin: mocks.auth }));
vi.mock("@/lib/ai/admin-models-authorization", () => ({ adminModelMfaIsFresh: mocks.mfa }));
vi.mock("@/lib/ai/admin-models-service", () => ({ executeAdminModelCommand: mocks.execute, listAdminModels: mocks.list }));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.audit }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.rate }));
import { GET, POST } from "../route";
import { ProviderError } from "@/lib/ai/types";
const command = { action: "test", provider: "openai", version: 0, model: "model", message: "secret message" };
it.each([ ["AUTHENTICATION", 424], ["MODEL_NOT_FOUND", 424], ["UNAVAILABLE", 503], ["TIMEOUT", 503] ] as const)("returns JSON dependency status for %s", async (code, status) => {
 mocks.execute.mockRejectedValue(new ProviderError("unsafe upstream text", code, 502));
 const reply = await POST(request());
 expect(reply.status).toBe(status);
 expect(await reply.json()).toMatchObject({ code });
});
it("reports model not found and reasoning warnings without upstream text", async () => {
 for (const code of ["MODEL_NOT_FOUND", "REASONING_LEAK"] as const) {
  mocks.execute.mockRejectedValue(new ProviderError("private reasoning and system prompt", code));
  const reply = await POST(request());
  expect(reply.status).toBe(424);
  const body = await reply.json();
  expect(body.error).toContain(code === "MODEL_NOT_FOUND" ? "Model not found" : "This model returns reasoning text");
  expect(JSON.stringify(body)).not.toContain("private reasoning");
 }
});
it("logs safe exception classification without secret-bearing messages", async () => {
 mocks.execute.mockRejectedValue(new SyntaxError("https://example.com/?key=secret-platform-key"));
 const log = vi.spyOn(console, "warn").mockImplementation(() => {});
 try {
  expect((await POST(request())).status).toBe(503);
  expect(log).toHaveBeenCalledWith("Admin AI model unexpected error", { name: "SyntaxError", message: "Response could not be parsed as JSON." });
  expect(JSON.stringify(log.mock.calls)).not.toContain("secret-platform-key");
 } finally { log.mockRestore(); }
});
function request(body: unknown = command, origin = "https://app.example.com") { return new NextRequest("https://app.example.com/api/admin/ai-models", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) }); }
beforeEach(() => {
 vi.resetAllMocks(); vi.stubEnv("APP_URL", "https://app.example.com");
 mocks.auth.mockResolvedValue({ session: { user: { id: "admin" }, session: { id: "session" } } });
 mocks.mfa.mockResolvedValue(true); mocks.rate.mockImplementation(async (_options, fn) => fn()); mocks.audit.mockResolvedValue(undefined); mocks.execute.mockResolvedValue({ content: "hello" });
});
afterEach(() => vi.unstubAllEnvs());
it("returns today's usage only after admin authorization, without credential material", async () => {
 mocks.list.mockResolvedValue([{ provider: "openai", hasPlatformKey: true }]);
 mocks.usage.mockResolvedValue({ count: 17, date: "2026-10-05", dailyLimit: 25 });
 expect(await (await GET()).json()).toMatchObject({ platformUsage: { count: 17, dailyLimit: 25 } });
 mocks.auth.mockResolvedValue({ session: null, response: NextResponse.json({}, { status: 403 }) });
 await GET(); expect(mocks.usage).toHaveBeenCalledOnce();
});
it("requires admin authorization before reads or writes", async () => {
 mocks.auth.mockResolvedValue({ session: null, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) });
 expect((await GET()).status).toBe(403); expect((await POST(request())).status).toBe(403);
 expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
});
it("rejects foreign and missing origins even without cookies", async () => {
 expect((await POST(request(command, "https://evil.example"))).status).toBe(403);
 const missing = request(); missing.headers.delete("origin"); expect((await POST(missing)).status).toBe(403);
 expect(mocks.execute).not.toHaveBeenCalled();
});
it("requires durable fresh MFA before decrypting or changing a key", async () => {
 mocks.mfa.mockResolvedValue(false);
 const response = await POST(request({ action: "configure", provider: "openai", version: 0, baseUrl: "https://api.example.com/v1", platformKey: "secret-platform-key" }));
 expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ code: "FRESH_MFA_REQUIRED" }); expect(mocks.execute).not.toHaveBeenCalled();
 expect(mocks.mfa).toHaveBeenCalledWith("admin", "session"); expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("secret-platform-key");
});
it("validates strict commands and bounded bodies before executing", async () => {
 expect((await POST(request({ ...command, extra: true }))).status).toBe(400);
 expect((await POST(request({ ...command, message: "x".repeat(40000) }))).status).toBe(400);
 expect(mocks.execute).not.toHaveBeenCalled();
});
it("uses separate read, write and provider-test rate limits", async () => {
 mocks.list.mockResolvedValue([]); await GET(); await POST(request());
 expect(mocks.rate.mock.calls.map(([options]) => options.policy)).toEqual(["admin_ai_models_read", "admin_ai_models_write", "admin_ai_models_test"]);
});
it("never reflects failure bodies or secrets and logs only provider, code and HTTP status", async () => {
 mocks.execute.mockRejectedValue(new ProviderError("upstream leaked secret-platform-key and secret message", "AUTHENTICATION", 401));
 const log = vi.spyOn(console, "warn").mockImplementation(() => {});
 try {
  const response = await POST(request()); const body = JSON.stringify(await response.json());
  expect(body).not.toContain("secret-platform-key"); expect(body).not.toContain("secret message"); expect(body).toContain("AUTHENTICATION");
  expect(log).toHaveBeenCalledWith("Admin AI model operation failed", { provider: "openai", code: "AUTHENTICATION", httpStatus: 401 });
  expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("secret message"); expect(response.headers.get("cache-control")).toContain("no-store");
 } finally { log.mockRestore(); }
});
