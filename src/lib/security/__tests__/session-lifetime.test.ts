import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PERSISTENT_SESSION_LIFETIME } from "../session-lifetime";

const DAY_MS = 24 * 60 * 60 * 1000;
const ORIGIN = "https://learn.example.test";

function harness() {
  const store = { user: [], session: [], account: [], verification: [] };
  const auth = betterAuth({
    baseURL: ORIGIN,
    secret: "session-lifetime-test-secret-0123456789abcdef",
    database: memoryAdapter(store),
    emailAndPassword: { enabled: true },
    session: { ...PERSISTENT_SESSION_LIFETIME, cookieCache: { enabled: false } },
    advanced: { cookiePrefix: "learncoding", useSecureCookies: true },
    rateLimit: { enabled: false },
  });
  return auth;
}

function sessionCookie(response: Response) {
  const header = response.headers.getSetCookie()
    .find((cookie) => cookie.startsWith("__Secure-learncoding.session_token="));
  if (!header) throw new Error("No session cookie was set.");
  return header;
}

function cookiePair(setCookie: string) {
  return setCookie.split(";")[0]!;
}

async function signUpAndIn(auth: ReturnType<typeof harness>, rememberMe: boolean) {
  const credentials = { email: "learner@example.test", password: "correct-horse-battery" };
  await auth.api.signUpEmail({ body: { ...credentials, name: "Learner" } });
  return auth.api.signInEmail({ body: { ...credentials, rememberMe }, asResponse: true });
}

async function currentSession(auth: ReturnType<typeof harness>, cookie: string) {
  const response = await auth.api.getSession({
    headers: new Headers({ cookie }),
    asResponse: true,
  });
  return { response, body: await response.json() as { session?: { expiresAt: string } } | null };
}

afterEach(() => vi.useRealTimers());

describe("persistent session lifetime", () => {
  it("is a 30-day window refreshed daily", () => {
    expect(PERSISTENT_SESSION_LIFETIME).toEqual({ expiresIn: 30 * 24 * 60 * 60, updateAge: 24 * 60 * 60 });
  });

  it("a remembered sign-in sets a persistent, HttpOnly, Secure, SameSite cookie with a 30-day Max-Age", async () => {
    const cookie = sessionCookie(await signUpAndIn(harness(), true));
    expect(cookie).toMatch(/Max-Age=2592000/i);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it("an unticked 'keep me signed in' stays a browser-session cookie", async () => {
    const cookie = sessionCookie(await signUpAndIn(harness(), false));
    expect(cookie).not.toMatch(/Max-Age|Expires/i);
  });

  it("slides forward on use, so an active device outlives the original window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-09-01T00:00:00Z");
    vi.setSystemTime(start);
    const auth = harness();
    const cookie = cookiePair(sessionCookie(await signUpAndIn(auth, true)));

    // Next day, after updateAge: the session and its cookie are extended.
    vi.setSystemTime(new Date(start.getTime() + 2 * DAY_MS));
    const refreshed = await currentSession(auth, cookie);
    expect(refreshed.body?.session).toBeTruthy();
    expect(sessionCookie(refreshed.response)).toMatch(/Max-Age=2592000/i);

    // Past the original 30-day expiry, still signed in because it was used.
    vi.setSystemTime(new Date(start.getTime() + 31 * DAY_MS));
    expect((await currentSession(auth, cookie)).body?.session).toBeTruthy();
  });

  it("an explicit sign-out ends the session and clears the cookie", async () => {
    const auth = harness();
    const cookie = cookiePair(sessionCookie(await signUpAndIn(auth, true)));
    const signOut = await auth.api.signOut({
      headers: new Headers({ cookie, origin: ORIGIN }),
      asResponse: true,
    });
    expect(sessionCookie(signOut)).toMatch(/Max-Age=0/i);
    expect((await currentSession(auth, cookie)).body).toBeNull();
  });
});
