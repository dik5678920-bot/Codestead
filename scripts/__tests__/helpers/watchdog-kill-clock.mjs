// Test preload for the real watchdog child. Only its configured hard kill
// deadline uses logical time; real IPC, protocol validation and process.kill
// still execute in the production module.
const timeout = Number(process.env.MAIL_DISPATCH_WATCHDOG_TEST_TIMEOUT_MS);
if (process.env.NODE_ENV !== "test" || timeout !== 250) {
  throw new Error("Unexpected controlled watchdog fixture deadline.");
}
let now = 0;
const pending = new Set();
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (callback, delay, ...args) => {
  if (delay !== timeout) return originalSetTimeout(callback, delay, ...args);
  const timer = { at: now + delay, callback, args, unref() { return this; } };
  pending.add(timer);
  return timer;
};
globalThis.clearTimeout = (timer) => {
  if (!pending.delete(timer)) originalClearTimeout(timer);
};
const originalEmit = process.emit;
process.emit = function (event, ...args) {
  const message = args[0];
  if (event === "message" && message?.fixtureClockAdvance !== undefined) {
    if (Reflect.ownKeys(message).length !== 1 || message.fixtureClockAdvance !== timeout) {
      throw new Error("Unexpected fixture clock command.");
    }
    if (pending.size !== 1) throw new Error("Expected one armed hard deadline.");
    now += message.fixtureClockAdvance;
    for (const timer of pending) {
      if (timer.at <= now) { pending.delete(timer); timer.callback(...timer.args); }
    }
    return true;
  }
  return originalEmit.call(this, event, ...args);
};
