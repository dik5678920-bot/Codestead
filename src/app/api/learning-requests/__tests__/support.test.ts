import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), createSupportRequest: vi.fn() }));
vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/learning-requests/support-service", () => ({ createSupportRequest: mocks.createSupportRequest }));
import { POST } from "../route";
const body = { requestId: "10000000-0000-4000-8000-000000000001", kind: "support-ai", provider: "google", message: "The configured model fails validation" };
const post = (data: unknown, headers = {}) => new NextRequest("http://localhost:3000/api/learning-requests", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(data) });
describe("contact admin route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({ session: { user: { id: "learner" } } });
    mocks.createSupportRequest.mockResolvedValue(NextResponse.json({ ok: true }, { status: 201 }));
  });
  it("accepts support input and binds its owner to the session", async () => {
    expect((await POST(post(body))).status).toBe(201);
    expect(mocks.createSupportRequest).toHaveBeenCalledWith("learner", body);
  });
  it("rejects cookie-authenticated cross-origin writes before persistence", async () => {
    expect((await POST(post(body, { cookie: "session=stub", origin: "https://evil.test" }))).status).toBe(403);
    expect(mocks.createSupportRequest).not.toHaveBeenCalled();
  });
  it("rejects raw response bodies, prompts, credentials and forged owners", async () => {
    for (const invalid of [{ ...body, context: { prompt: "private" } }, { ...body, userId: "other" }, { ...body, message: "api_key=secretsecret" }]) {
      expect((await POST(post(invalid))).status).toBe(400);
    }
    expect(mocks.createSupportRequest).not.toHaveBeenCalled();
  });
});
