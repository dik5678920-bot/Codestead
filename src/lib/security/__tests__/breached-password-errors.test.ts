// @vitest-environment node
import { runInNewContext } from "node:vm";
import { APIError } from "better-auth/api";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock("better-auth/plugins/haveibeenpwned", () => ({
  isPasswordCompromised: mocks.check,
  haveIBeenPwned: () => ({
    init(ctx: { password: { hash: (password: string) => Promise<string> } }) {
      return { context: { password: {
        ...ctx.password,
        async hash(password: string) {
          await mocks.check(password);
          return ctx.password.hash(password);
        },
      } } };
    },
  }),
}));

import { breachedPasswordPlugin, isBreachedPasswordError, requireUnbreachedPassword } from "../breached-passwords";

function foreignError(fields: Record<string, unknown>) {
  const error: unknown = runInNewContext(
    'Object.assign(new Error("private credential, hash and transport detail"), fields)',
    { fields },
  );
  expect(error).not.toBeInstanceOf(APIError);
  expect(error).not.toBeInstanceOf(Error);
  return error;
}

function setup() {
  const originalHash = vi.fn(async () => "stored-hash");
  const ctx = { password: { hash: originalHash } } as unknown as Parameters<ReturnType<typeof breachedPasswordPlugin>["init"]>[0];
  const hash = breachedPasswordPlugin().init(ctx).context.password.hash;
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  return { hash, originalHash, log };
}

afterEach(() => { vi.restoreAllMocks(); mocks.check.mockReset(); });

describe("password errors across realms and server bundles", () => {
  it("recognizes a foreign breached-password error", () => {
    const error = foreignError({ name: "APIError", statusCode: 400, body: { code: "PASSWORD_COMPROMISED" } });
    expect(isBreachedPasswordError(error)).toBe(true);
  });

  it.each([null, undefined, "PASSWORD_COMPROMISED", {}, { name: "Error", body: { code: "PASSWORD_COMPROMISED" } }, { name: "APIError", body: { code: "OTHER" } }])(
    "does not classify an unrelated value as a breach: %j", (error) => {
      expect(isBreachedPasswordError(error)).toBe(false);
    },
  );

  describe.each(["plugin", "custom"] as const)("%s password flow", (flow) => {
    function run(hash: (password: string) => Promise<string>) {
      return flow === "plugin" ? hash("synthetic-password") : requireUnbreachedPassword("synthetic-password");
    }

    it.each([{ statusCode: 500, status: "INTERNAL_SERVER_ERROR" }, { status: 500 }])(
      "fails open on a foreign API outage with numeric status %j and a sanitized log", async (status) => {
        const { hash, originalHash, log } = setup();
        mocks.check.mockRejectedValue(foreignError({ name: "APIError", ...status }));
        await expect(run(hash)).resolves.toBe(flow === "plugin" ? "stored-hash" : undefined);
        expect(originalHash).toHaveBeenCalledTimes(flow === "plugin" ? 1 : 0);
        expect(log.mock.calls).toEqual([["HIBP password check unavailable; proceeding without breach screening."]]);
      },
    );

    it.each([
      { name: "APIError", statusCode: 400, body: { code: "PASSWORD_COMPROMISED" } },
      { name: "APIError", statusCode: 403 },
      { name: "APIError", statusCode: 503 },
      { name: "Error", statusCode: 500 },
      { name: "APIError", statusCode: "500" },
      { name: "APIError", status: "500" },
      { name: "APIError", statusCode: 403, status: 500 },
      { name: "APIError", statusCode: Number.NaN, status: 500 },
    ])("rethrows other foreign errors unchanged without logging: %j", async (fields) => {
      const { hash, originalHash, log } = setup();
      const error = foreignError(fields);
      mocks.check.mockRejectedValue(error);
      await expect(run(hash)).rejects.toBe(error);
      expect(originalHash).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    });

    it("does not log successful screening", async () => {
      const { hash, log } = setup();
      mocks.check.mockResolvedValue(false);
      await run(hash);
      expect(log).not.toHaveBeenCalled();
    });
  });

  it("does not fail open on a foreign APIError from password hashing", async () => {
    const { hash, originalHash, log } = setup();
    mocks.check.mockResolvedValue(false);
    const error = foreignError({ name: "APIError", statusCode: 500 });
    originalHash.mockRejectedValue(error);
    await expect(hash("synthetic-password")).rejects.toBe(error);
    expect(originalHash).toHaveBeenCalledOnce();
    expect(log).not.toHaveBeenCalled();
  });
});
