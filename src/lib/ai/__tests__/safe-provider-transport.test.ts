// @vitest-environment node
import { EventEmitter } from "node:events";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mock.lookup }));
vi.mock("node:https", () => ({ request: mock.request }));
import { safeProviderRequest } from "../safe-provider-http";
let incoming: EventEmitter & { statusCode: number; headers: Record<string, string>; destroy: ReturnType<typeof vi.fn> };
let outgoing: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
beforeEach(() => {
 vi.resetAllMocks(); mock.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
 incoming = Object.assign(new EventEmitter(), { statusCode: 200, headers: { "content-type": "application/json" }, destroy: vi.fn() });
 outgoing = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
 mock.request.mockImplementation((_url, _options, callback) => { queueMicrotask(() => callback(incoming)); return outgoing; });
});
afterEach(() => vi.useRealTimers());
it("pins checked DNS into the HTTPS connection while preserving TLS hostname and query", async () => {
 const pending = safeProviderRequest("https://api.example.com/v1/models?pageSize=1000", { headers: { "x-goog-api-key": "secret" } });
 await vi.waitFor(() => expect(mock.request).toHaveBeenCalled());
 const [url, options] = mock.request.mock.calls[0];
 expect(url.hostname).toBe("api.example.com"); expect(url.search).toBe("?pageSize=1000"); expect(options.agent).toBe(false);
 const callback = vi.fn(); options.lookup("api.example.com", { all: true }, callback);
 expect(callback).toHaveBeenCalledWith(null, [{ address: "8.8.8.8", family: 4 }]);
 const single = vi.fn(); options.lookup("api.example.com", {}, single); expect(single).toHaveBeenCalledWith(null, "8.8.8.8", 4);
 incoming.emit("data", Buffer.from('{"data":[]}')); incoming.emit("end");
 expect(await (await pending).json()).toEqual({ data: [] }); expect(mock.lookup).toHaveBeenCalledTimes(1);
});
it("rejects private DNS before opening any socket", async () => {
 mock.lookup.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
 await expect(safeProviderRequest("https://api.example.com/models")).rejects.toMatchObject({ code: "POLICY" }); expect(mock.request).not.toHaveBeenCalled();
});
it("rejects redirects without following their Location", async () => {
 incoming.statusCode = 302; incoming.headers.location = "https://127.0.0.1/secret";
 await expect(safeProviderRequest("https://api.example.com/models")).rejects.toMatchObject({ code: "POLICY", status: 302 });
 expect(mock.request).toHaveBeenCalledTimes(1); expect(incoming.destroy).toHaveBeenCalled();
});
it("rejects oversized provider responses", async () => {
 const pending = safeProviderRequest("https://api.example.com/models"); const rejection = expect(pending).rejects.toMatchObject({ code: "MODEL_LIST_LIMIT" });
 await vi.waitFor(() => expect(mock.request).toHaveBeenCalled()); incoming.emit("data", Buffer.alloc(8_388_609));
 await rejection; expect(incoming.destroy).toHaveBeenCalled();
});
it("bounds DNS resolution by the request deadline", async () => {
 vi.useFakeTimers(); mock.lookup.mockReturnValue(new Promise(() => {}));
 const pending = safeProviderRequest("https://api.example.com/models"); const rejection = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
 await vi.advanceTimersByTimeAsync(60_000); await rejection; expect(mock.request).not.toHaveBeenCalled();
});

it("allows a large public model catalog while keeping chat responses bounded", async () => {
 const pending = safeProviderRequest("https://api.example.com/models");
 await vi.waitFor(() => expect(mock.request).toHaveBeenCalled());
 incoming.emit("data", Buffer.alloc(2_000_000, 32)); incoming.emit("end");
 expect((await pending).status).toBe(200);
});


it("rejects a chat response above the smaller response limit", async () => {
 const pending = safeProviderRequest("https://api.example.com/chat/completions", { method: "POST", body: "{}" });
 const rejection = expect(pending).rejects.toMatchObject({ code: "BAD_RESPONSE" });
 await vi.waitFor(() => expect(mock.request).toHaveBeenCalled()); incoming.emit("data", Buffer.alloc(1_048_577));
 await rejection;
});

it("rejects invalid HTTP status codes instead of throwing from the response callback", async () => {
 incoming.statusCode = 700;
 const pending = safeProviderRequest("https://api.example.com/models");
 const rejection = expect(pending).rejects.toMatchObject({ code: "BAD_RESPONSE", status: 700 });
 await vi.waitFor(() => expect(mock.request).toHaveBeenCalled());
 expect(() => incoming.emit("end")).not.toThrow();
 await rejection;
});
