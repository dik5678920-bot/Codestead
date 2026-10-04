import { expect, it, vi } from "vitest";

it("initializes and validates browser support contracts without compiling code", async () => {
  vi.resetModules();
  const compile = vi.fn(() => { throw new EvalError("CSP blocks dynamic code"); });
  vi.stubGlobal("Function", compile);
  try {
    const { supportRequestSchema, decodeSupportDetails } = await import("../support-contract");
    expect(supportRequestSchema.safeParse({
      requestId: "10000000-0000-4000-8000-000000000001",
      kind: "support-ai", provider: "google", message: "Model validation fails",
      context: { provider: "google", errorCode: "MODEL_NOT_FOUND", httpStatus: 404 },
    }).success).toBe(true);
    expect(decodeSupportDetails('{"message":"Help","context":{"httpStatus":404}}')).toEqual({
      message: "Help", context: { httpStatus: 404 },
    });
    expect(decodeSupportDetails('{"message":"Help","context":{"prompt":"private"}}')).toBeNull();
    expect(compile).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
