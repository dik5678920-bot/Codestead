import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

// Freeze only the positive READY handshake while the real OS child boots. The
// fixture's post-READY faults keep their original controller deadlines.
export async function awaitWatchdogReady(start) {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = new Set();
  globalThis.setTimeout = (callback, delay, ...args) => {
    const timer = { callback, delay, args, unref() { return this; } };
    timers.add(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    if (!timers.delete(timer)) originalClearTimeout(timer);
  };
  try { return await start(); } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    if (timers.size !== 0) throw new Error("READY left an unresolved fixture timer.");
  }
}

let watchdogChild;
export function controlWatchdogKillClock() {
  const originalFork = childProcess.fork;
  childProcess.fork = (modulePath, args, options) => {
    watchdogChild = originalFork(modulePath, args, {
      ...options,
      execArgv: [...(options.execArgv ?? []), "--import", new URL("./watchdog-kill-clock.mjs", import.meta.url).href],
    });
    return watchdogChild;
  };
  syncBuiltinESMExports();
}

export function advanceWatchdogKillClock(milliseconds) {
  if (!watchdogChild?.connected) throw new Error("Expected the real armed watchdog child.");
  watchdogChild.send({ fixtureClockAdvance: milliseconds });
}
