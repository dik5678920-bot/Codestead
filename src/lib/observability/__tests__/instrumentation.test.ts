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
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("runtime error-monitoring release", () => {
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
