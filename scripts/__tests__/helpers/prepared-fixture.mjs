// Cold imports belong to fixture preparation, before the timed scenario begins.
export async function waitForFixtureStart() {
  if (typeof process.send !== "function") return;
  await new Promise((resolve, reject) => {
    process.once("message", (message) => {
      if (message?.type !== "FIXTURE_RUN") {
        reject(new Error("Unexpected prepared-fixture command."));
        return;
      }
      process.disconnect();
      resolve();
    });
    process.send({ type: "FIXTURE_READY" });
  });
}
