import { createHash } from "node:crypto";
import { haveIBeenPwned } from "better-auth/plugins/haveibeenpwned";
import { APIError } from "better-auth/api";

import { BREACHED_PASSWORD_MESSAGE } from "./password-messages";
export { BREACHED_PASSWORD_MESSAGE } from "./password-messages";

export function isBreachedPasswordError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: unknown; body?: { code?: unknown } | null };
  return candidate.name === "APIError" && candidate.body?.code === "PASSWORD_COMPROMISED";
}

function isHibpUnavailableError(error: unknown): boolean {
  // Next server chunks can contain distinct copies of the APIError constructor.
  // Prefer statusCode; only fall back to a numeric status when it is absent.
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as Record<string, unknown>;
  const status = candidate.statusCode === undefined ? candidate.status : candidate.statusCode;
  return candidate.name === "APIError" && typeof status === "number" && status === 500;
}

function logUnavailable() {
  // Never include credentials, hashes, HIBP response bodies or transport errors.
  console.warn("HIBP password check unavailable; proceeding without breach screening.");
}

export function breachedPasswordPlugin() {
  const plugin = haveIBeenPwned({ customPasswordCompromisedMessage: BREACHED_PASSWORD_MESSAGE });
  return {
    ...plugin,
    init(ctx: Parameters<typeof plugin.init>[0]) {
      const originalHash = ctx.password.hash;
      return { context: { password: {
        ...ctx.password,
        async hash(password: string) {
          // Keep this flag per invocation: concurrent password requests must
          // not mistake a hashing failure for an unavailable HIBP check.
          let hashing = false;
          const checked = plugin.init({ ...ctx, password: {
            ...ctx.password,
            hash(value: string) { hashing = true; return originalHash(value); },
          } }).context.password.hash;
          try {
            return await checked(password);
          } catch (error) {
            if (hashing || !isHibpUnavailableError(error)) throw error;
            logUnavailable();
            return originalHash(password);
          }
        },
      } } };
    },
  };
}
export async function requireUnbreachedPassword(password: string) {
  // Custom routes have no Better Auth endpoint context. Keep their screening
  // independent of the plugin's context-aware password hasher.
  const digest = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
  const prefix = digest.slice(0, 5);
  const suffix = digest.slice(5);
  let compromised = false;
  try {
    const response = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { "Add-Padding": "true", "User-Agent": "Codestead Password Checker", Accept: "text/plain" },
      signal: AbortSignal.timeout(5_000),
      // Do not disclose even the prefix to a redirect destination or cache it.
      redirect: "error",
      cache: "no-store",
    });
    if (!response.ok) throw new Error("HIBP unavailable");
    const body = (await response.text()).trim();
    if (!body) throw new Error("Invalid HIBP range response");
    for (const line of body.split(/\r?\n/u)) {
      const entry = /^([a-f0-9]{35}):(0|[1-9]\d*)$/iu.exec(line);
      const count = entry ? Number(entry[2]) : Number.NaN;
      if (!entry || !Number.isSafeInteger(count)) throw new Error("Invalid HIBP range response");
      // Padded entries have zero occurrences and must never reject a password.
      if (entry[1].toUpperCase() === suffix && count > 0) {
        compromised = true;
        break;
      }
    }
  } catch {
    // Only transport/response handling lives in this try block. The local
    // breach rejection below must not be swallowed by fail-open handling.
    logUnavailable();
    return;
  }
  if (compromised) {
    throw new APIError("BAD_REQUEST", { code: "PASSWORD_COMPROMISED", message: BREACHED_PASSWORD_MESSAGE });
  }
}
