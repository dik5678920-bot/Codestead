// @vitest-environment node
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const authRequire = createRequire(createRequire(import.meta.url).resolve("better-auth"));
const { runWithEndpointContext } = await import(pathToFileURL(authRequire.resolve("@better-auth/core/context")).href);
import type { GenericEndpointContext } from "better-auth";
const endpoint = { path: "/sign-up/email" };
import { breachedPasswordPlugin, requireUnbreachedPassword } from "../breached-passwords";

const password = "synthetic-test-passphrase";
const digest = createHash("sha1").update(password).digest("hex").toUpperCase();
function setup(response: string | Error, status = 200) {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    void _url; void _init;
    if (response instanceof Error) throw response;
    return new Response(response, { status, headers: { "content-type": "text/plain" } });
  });
  vi.stubGlobal("fetch", fetch);
  const originalHash = vi.fn(async () => "stored-hash");
  const ctx = { password: { hash: originalHash } } as unknown as Parameters<ReturnType<typeof breachedPasswordPlugin>["init"]>[0];
  const checkedHash = breachedPasswordPlugin().init(ctx).context.password.hash;
  const hash = (password: string) => runWithEndpointContext(endpoint as GenericEndpointContext, () => checkedHash(password));
  return { fetch, originalHash, hash };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("breached password protection", () => {
  it.each(["/sign-up/email", "/change-password", "/reset-password"])("rejects breached passwords on %s", async (path) => {
    endpoint.path = path;
    const { hash, originalHash } = setup(`${digest.slice(5)}:42\r\n`);
    await expect(hash(password)).rejects.toMatchObject({ body: { code: "PASSWORD_COMPROMISED" } });
    expect(originalHash).not.toHaveBeenCalled();
  });
  it("sends only five SHA-1 characters, with padding enabled", async () => {
    endpoint.path = "/sign-up/email";
    const { fetch, hash } = setup(`${digest.slice(5)}:0\r\n`);
    await expect(hash(password)).resolves.toBe("stored-hash");
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0][0])).toBe(`https://api.pwnedpasswords.com/range/${digest.slice(0, 5)}`);
    expect(JSON.stringify(fetch.mock.calls)).not.toContain(password);
    expect(JSON.stringify(fetch.mock.calls)).not.toContain(digest);
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get("Add-Padding")).toBe("true");
  });
  it.each([new Error("private transport detail"), "service unavailable"])("fails open with a sanitized log on an outage", async (response) => {
    endpoint.path = "/change-password";
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { hash, originalHash } = setup(response, 503);
    await expect(hash(password)).resolves.toBe("stored-hash");
    expect(originalHash).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith("HIBP password check unavailable; proceeding without breach screening.");
  });
  it("does not mask password hashing failures", async () => {
    endpoint.path = "/change-password";
    const { hash, originalHash } = setup("");
    originalHash.mockRejectedValue(new Error("hash failed"));
    await expect(hash(password)).rejects.toThrow("hash failed");
    expect(originalHash).toHaveBeenCalledOnce();
  });
  it("checks custom password flows with the same breach rejection", async () => {
    setup(`${digest.slice(5)}:1\r\n`);
    await expect(requireUnbreachedPassword(password)).rejects.toMatchObject({ body: { code: "PASSWORD_COMPROMISED" } });
  });
  it("allows custom password flows during an outage and logs without sensitive details", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    setup(new Error("private transport detail"));
    await expect(requireUnbreachedPassword(password)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("HIBP password check unavailable; proceeding without breach screening.");
  });
  it("does not screen a sign-in password", async () => {
    endpoint.path = "/sign-in/email";
    const { fetch, hash } = setup("");
    await expect(hash(password)).resolves.toBe("stored-hash");
    expect(fetch).not.toHaveBeenCalled();
  });
});
