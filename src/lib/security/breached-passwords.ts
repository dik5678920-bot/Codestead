import { haveIBeenPwned, isPasswordCompromised } from "better-auth/plugins/haveibeenpwned";
import { APIError } from "better-auth/api";

import { BREACHED_PASSWORD_MESSAGE } from "./password-messages";
export { BREACHED_PASSWORD_MESSAGE } from "./password-messages";

export function isBreachedPasswordError(error: unknown): boolean {
  return error instanceof APIError && error.body?.code === "PASSWORD_COMPROMISED";
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
            if (hashing || !(error instanceof APIError) || error.statusCode !== 500) throw error;
            logUnavailable();
            return originalHash(password);
          }
        },
      } } };
    },
  };
}
export async function requireUnbreachedPassword(password: string) {
  let compromised: boolean;
  try {
    compromised = await isPasswordCompromised(password);
  } catch (error) {
    if (!(error instanceof APIError) || error.statusCode !== 500) throw error;
    logUnavailable();
    return;
  }
  if (compromised) {
    throw new APIError("BAD_REQUEST", { code: "PASSWORD_COMPROMISED", message: BREACHED_PASSWORD_MESSAGE });
  }
}
