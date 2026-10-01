// Chromium sometimes, but not always, logs a console error for the internal
// Inspector request that the verifier's route handler aborts. Recording it
// would make the committed web runtime evidence nondeterministic, so only
// this exact browser-internal message is left out of the record. Every other
// console error is still recorded, and the pass/fail allowlist is unchanged.
const BROWSER_INTERNAL_CONSOLE_NOISE: ReadonlySet<string> = new Set([
  "Failed to load resource: net::ERR_BLOCKED_BY_CLIENT.Inspector",
]);

export function recordedConsoleErrors(consoleErrors: readonly string[]): readonly string[] {
  return consoleErrors.filter((message) => !BROWSER_INTERNAL_CONSOLE_NOISE.has(message));
}
