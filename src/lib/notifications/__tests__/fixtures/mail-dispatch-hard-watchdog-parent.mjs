import { writeSync } from "node:fs";
import { waitForFixtureStart } from "../../../../../scripts/__tests__/helpers/prepared-fixture.mjs";
import { awaitWatchdogReady } from "../../../../../scripts/__tests__/helpers/watchdog-fixture-clock.mjs";

import {
  startMailDispatchHardWatchdog,
} from "../../mail-dispatch-hard-watchdog.ts";

const watchdog = await awaitWatchdogReady(startMailDispatchHardWatchdog);
await waitForFixtureStart();
await watchdog.arm();

process.once("exit", () => {
  writeSync(1, "POOL_END\nHEALTH\nRETRY\nTELEMETRY\n");
});
writeSync(1, "ARMED\n");

try {
  const blocker = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(blocker, 0, 0);
} finally {
  writeSync(1, "FINALLY\nPOOL_END\nHEALTH\nRETRY\nTELEMETRY\n");
}
