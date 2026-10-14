// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";

const mocks = vi.hoisted(() => ({ registration: vi.fn(), assertion: vi.fn(), options: vi.fn(), limit: vi.fn(), audit: vi.fn() }));
vi.mock("@simplewebauthn/server", () => ({
  generateRegistrationOptions: async () => ({ challenge: "registration-challenge", rp: { name: "Codestead", id: "localhost" }, user: { id: "user-handle", name: "owner" }, pubKeyCredParams: [{ type: "public-key", alg: -7 }] }),
  generateAuthenticationOptions: async () => ({ challenge: "authentication-challenge", rpId: "localhost" }),
  verifyRegistrationResponse: mocks.registration, verifyAuthenticationResponse: mocks.assertion,
}));
vi.mock("@/lib/db/client", () => ({ db: { select: () => ({ from: () => ({ innerJoin: () => ({ where: () => ({ limit: mocks.limit }) }) }) }) } }));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.audit, writeAuditEventInTransaction: vi.fn() }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: (_checks: unknown, run: () => unknown) => run() }));
import { createPasskeyPlugin } from "../passkey-plugin";

describe("Better Auth passkey ceremonies with mocked WebAuthn cryptography", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("APP_URL", "http://localhost:3000");
    mocks.registration.mockResolvedValue({ verified: true, registrationInfo: { userVerified: true, credential: { id: "credential", publicKey: new Uint8Array([1, 2, 3]), counter: 0 }, aaguid: "", credentialDeviceType: "singleDevice", credentialBackedUp: false } });
    mocks.assertion.mockResolvedValue({ verified: true, authenticationInfo: { userVerified: true, newCounter: 1 } });
    mocks.limit.mockResolvedValue([{ credential: { id: "passkey", userId: "owner" }, account: { id: "owner", status: "active", emailVerified: true, twoFactorEnabled: true, banned: false, mustChangePassword: false } }]);
  });
  async function fixture() {
    const data = { user: [], session: [], account: [], verification: [], passkey: [] };
    const auth = betterAuth({ baseURL: "http://localhost:3000", secret: "test-secret-with-at-least-thirty-two-characters", database: memoryAdapter(data), emailAndPassword: { enabled: true }, plugins: [createPasskeyPlugin()], rateLimit: { enabled: false } });
    const signup = await auth.api.signUpEmail({ body: { email: "owner@example.test", password: "long-test-password", name: "Owner" }, asResponse: true });
    const cookie = signup.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const headers = { cookie, origin: "http://localhost:3000" };
    const registerOptions = await auth.api.generatePasskeyRegistrationOptions({ headers, asResponse: true });
    const challengeCookie = registerOptions.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const registered = await auth.api.verifyPasskeyRegistration({ headers: { ...headers, cookie: cookie + "; " + challengeCookie }, body: { response: { id: "credential", response: { transports: [] } }, name: "Laptop" }, asResponse: true });
    return { auth, registered };
  }
  it("registers a user-verified passkey and signs in using it", async () => {
    const { auth, registered } = await fixture();
    expect(registered.status).toBe(200);
    const options = await auth.api.generatePasskeyAuthenticationOptions({ asResponse: true });
    const cookie = options.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const response = await auth.api.verifyPasskeyAuthentication({ headers: { cookie, origin: "http://localhost:3000" }, body: { response: { id: "credential", rawId: "credential", type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: "mock", authenticatorData: "mock", signature: "mock" } } }, asResponse: true });
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie().join(";")).toContain("session_token");
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "passkey.use", outcome: "allowed" }));
  });
  it("refuses registration without the signed UV flag", async () => {
    mocks.registration.mockResolvedValue({ verified: true, registrationInfo: { userVerified: false, credential: { id: "credential", publicKey: new Uint8Array([1]), counter: 0 } } });
    expect((await fixture()).registered.status).toBe(403);
  });
  it("refuses sign-in without user verification", async () => {
    const { auth } = await fixture();
    mocks.assertion.mockResolvedValue({ verified: true, authenticationInfo: { userVerified: false, newCounter: 1 } });
    const options = await auth.api.generatePasskeyAuthenticationOptions({ asResponse: true });
    const cookie = options.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const response = await auth.api.verifyPasskeyAuthentication({ headers: { cookie, origin: "http://localhost:3000" }, body: { response: { id: "credential", rawId: "credential", type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: "mock", authenticatorData: "mock", signature: "mock" } } }, asResponse: true });
    expect(response.status).toBe(403);
    expect(response.headers.getSetCookie().join(";")).not.toContain("session_token");
  });
  it("refuses a disabled credential", async () => {
    const { auth } = await fixture();
    mocks.limit.mockResolvedValueOnce([]);
    const options = await auth.api.generatePasskeyAuthenticationOptions({ asResponse: true });
    const cookie = options.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const response = await auth.api.verifyPasskeyAuthentication({ headers: { cookie, origin: "http://localhost:3000" }, body: { response: { id: "credential", rawId: "credential", type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: "mock", authenticatorData: "mock", signature: "mock" } } }, asResponse: true });
    expect(response.status).toBe(401);
  });
});
