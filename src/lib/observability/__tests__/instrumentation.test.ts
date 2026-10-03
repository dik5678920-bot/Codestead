import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { init, sdkLoaded } = vi.hoisted(() => ({ init: vi.fn(), sdkLoaded: vi.fn() }));
vi.mock("@sentry/nextjs", () => {
  sdkLoaded();
  return {
    init,
    globalHandlersIntegration: () => ({ name: "GlobalHandlers" }),
    linkedErrorsIntegration: () => ({ name: "LinkedErrors" }),
    dedupeIntegration: () => ({ name: "Dedupe" }),
  };
});

const release = "a".repeat(40);

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("runtime error-monitoring release", () => {
  it.each(["nodejs", "edge"].flatMap((runtime) =>
    [undefined, "", " \t "].flatMap((appUrl) =>
      ["", "https://serverkey@errors.example.test/9"].map((dsn) => ({ runtime, appUrl, dsn })))),
  )("rejects production startup before monitoring initialization: %j", async ({ runtime, appUrl, dsn }) => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_RUNTIME", runtime);
    vi.stubEnv("APP_URL", appUrl);
    vi.stubEnv("SENTRY_DSN", dsn);
    const server = await import("../../../instrumentation");
    await expect(server.register()).rejects.toThrow("APP_URL is required in production");
    if (runtime === "nodejs") {
      expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining("APP_URL is required in production"));
    } else {
      expect(process.exit).not.toHaveBeenCalled();
    }
    expect(sdkLoaded).not.toHaveBeenCalled();
    expect(init).not.toHaveBeenCalled();
  });

  it.each(["development", "test"])("allows the localhost default outside production (%s)", async (nodeEnv) => {
    vi.stubEnv("NODE_ENV", nodeEnv);
    vi.stubEnv("APP_URL", undefined);
    vi.stubEnv("SENTRY_DSN", "");
    const server = await import("../../../instrumentation");
    await expect(server.register()).resolves.toBeUndefined();
    expect(process.exit).not.toHaveBeenCalled();
    expect(sdkLoaded).not.toHaveBeenCalled();
  });

  it("allows production startup with an explicit APP_URL when monitoring is disabled", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_URL", "https://learn.example.test");
    vi.stubEnv("SENTRY_DSN", "");
    const server = await import("../../../instrumentation");
    await expect(server.register()).resolves.toBeUndefined();
    expect(process.exit).not.toHaveBeenCalled();
    expect(sdkLoaded).not.toHaveBeenCalled();
  });

  it.each(["nodejs", "edge"])("reads SENTRY_RELEASE when the %s server initializes", async (runtime) => {
    vi.stubEnv("NEXT_RUNTIME", runtime);
    vi.stubEnv("SENTRY_DSN", "https://serverkey@errors.example.test/9");
    const server = await import("../../../instrumentation");
    expect(sdkLoaded).not.toHaveBeenCalled();
    vi.stubEnv("SENTRY_RELEASE", release);
    await server.register();
    expect(init).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      release, initialScope: { tags: { runtime } }, sendDefaultPii: false,
    }));
  });

  it.each([release, undefined, null, 42])("initializes the browser with the runtime status release (%j)", async (statusRelease) => {
    // Browser release comes from runtime status, never a build-time env value.
    vi.stubEnv("SENTRY_RELEASE", "build-time-stale");
    const fetchStatus = vi.fn().mockResolvedValue(new Response(JSON.stringify({ enabled: true, release: statusRelease })));
    vi.stubGlobal("fetch", fetchStatus);
    await import("../../../instrumentation-client");
    await vi.waitFor(() => expect(init).toHaveBeenCalledOnce());
    expect(fetchStatus).toHaveBeenCalledExactlyOnceWith("/api/monitoring/envelope", {
      cache: "no-store", credentials: "same-origin",
    });
    const options = init.mock.calls[0]![0];
    expect(options).toMatchObject({
      dsn: "https://browser@tunnel.invalid/1", tunnel: "/api/monitoring/envelope",
      initialScope: { tags: { runtime: "browser" } }, sendDefaultPii: false, tracesSampleRate: 0,
    });
    if (typeof statusRelease === "string") expect(options.release).toBe(release);
    else expect(options).not.toHaveProperty("release");
  });
});
