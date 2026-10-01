import {
  consumeLiveProviderTx2Authority,
  PostgresOutboxStore,
} from "../../postgres-outbox-store";
import { createStoreBoundPreparedDispatchChannel } from "../../prepared-dispatch-materialization";
import { sendPreparedEmail } from "../../mailer-transport-internal";
import { waitForFixtureStart } from "../../../../../scripts/__tests__/helpers/prepared-fixture.mjs";

void waitForFixtureStart().then(() => {
  const requiredExports = [
    PostgresOutboxStore,
    consumeLiveProviderTx2Authority,
    createStoreBoundPreparedDispatchChannel,
    sendPreparedEmail,
  ];

  if (
    !requiredExports.every((exportedValue) => typeof exportedValue === "function")
  ) {
    throw new Error("TX2 module cycle did not initialize its required exports.");
  }

  process.stdout.write("mail_tx2_module_cycle=PASS\n");
}).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
