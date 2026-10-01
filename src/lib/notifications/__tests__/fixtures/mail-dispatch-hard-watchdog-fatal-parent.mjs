import { writeSync } from "node:fs";
import { waitForFixtureStart } from "../../../../../scripts/__tests__/helpers/prepared-fixture.mjs";

import { awaitWatchdogReady, controlWatchdogKillClock, advanceWatchdogKillClock } from "../../../../../scripts/__tests__/helpers/watchdog-fixture-clock.mjs";

import {
  disarmMailDispatchHardWatchdog,
  startMailDispatchHardWatchdog,
} from "../../mail-dispatch-hard-watchdog.ts";

const exitMode = process.env.MAIL_DISPATCH_WATCHDOG_TEST_EXIT_MODE;
const phase = process.env.MAIL_DISPATCH_WATCHDOG_TEST_FATAL_PHASE;
if (
  !["native", "return", "throw"].includes(exitMode)
  || !["arm", "armed", "disarm", "idle"].includes(phase)
) {
  process.exit(64);
}

if (exitMode === "return") {
  process.exit = () => undefined;
} else if (exitMode === "throw") {
  process.exit = () => {
    throw new Error("Injected process.exit failure.");
  };
}

process.on("uncaughtException", () => {
  writeSync(1, "UNCAUGHT\n");
});
process.on("unhandledRejection", () => {
  writeSync(1, "UNHANDLED\n");
});

if (phase === "armed") {
  controlWatchdogKillClock();
  const wait = Atomics.wait;
  Atomics.wait = (...args) => {
    advanceWatchdogKillClock(250);
    return wait(...args);
  };
}

// The idle fault begins at READY itself. Other faults begin after RUN, so their
// positive READY handshake belongs to fixture preparation.
let watchdog;
if (phase === "idle") {
  await waitForFixtureStart();
  watchdog = await awaitWatchdogReady(startMailDispatchHardWatchdog);
} else {
  watchdog = await awaitWatchdogReady(startMailDispatchHardWatchdog);
  await waitForFixtureStart();
}

try {
  if (phase === "arm") {
    await watchdog.arm();
  } else if (phase === "armed") {
    await watchdog.arm();
    writeSync(1, "ARMED\n");
    await new Promise(() => {});
  } else if (phase === "disarm") {
    const armed = await watchdog.arm();
    await disarmMailDispatchHardWatchdog(armed);
  } else {
    await new Promise(() => {});
  }
  writeSync(1, "SURVIVED\n");
} catch {
  writeSync(1, "CATCH\n");
} finally {
  writeSync(1, "FINALLY\n");
}
