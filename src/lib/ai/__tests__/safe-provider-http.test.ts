// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { isPublicAddress, resolvePublicProviderUrl } from "../safe-provider-http";

describe("provider SSRF boundary", () => {
  it.each(["127.0.0.1", "10.2.3.4", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "192.0.2.1", "::1", "::", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "2001:db8::1", "2002:7f00:1::"]) ("blocks non-public %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"])("accepts public %s", (ip) => expect(isPublicAddress(ip)).toBe(true));
  it.each(["http://api.example/v1", "https://user:password@api.example/v1", "https://api.example/v1?key=x", "https://api.example/v1#fragment", "https://localhost/v1", "https://127.0.0.1/v1", "https://[::1]/v1", "https://2130706433/v1"])("rejects unsafe URL %s before DNS", async (url) => {
    const lookup = vi.fn();
    await expect(resolvePublicProviderUrl(url, lookup)).rejects.toMatchObject({ code: "POLICY" });
    expect(lookup).not.toHaveBeenCalled();
  });
  it("rejects DNS with any private answer", async () => {
    await expect(resolvePublicProviderUrl("https://api.example/v1", async () => [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }])).rejects.toMatchObject({ code: "POLICY" });
  });
  it("returns public resolved addresses for the pinned connection", async () => {
    const resolved = await resolvePublicProviderUrl("https://api.example/v1", async () => [{ address: "8.8.8.8", family: 4 }]);
    expect(resolved.addresses).toEqual([{ address: "8.8.8.8", family: 4 }]);
  });
});
