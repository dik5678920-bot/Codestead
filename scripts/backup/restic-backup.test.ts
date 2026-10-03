import { spawnSync } from "node:child_process";
import path from "node:path";

// Runs the hermetic shell suite for the restic -> R2 backup scripts so it is
// part of the unit gate. The suite stubs docker and needs GNU coreutils, flock
// and stat -c, so it runs on Linux only.
describe.skipIf(process.platform !== "linux")("restic R2 backup scripts", () => {
  it("passes infra/tests/restic-backup.test.sh", () => {
    const result = spawnSync(
      "bash",
      [path.resolve(process.cwd(), "infra/tests/restic-backup.test.sh")],
      { encoding: "utf8", timeout: 120_000 },
    );
    expect(result.stderr + result.stdout).toContain("restic backup tests passed");
    expect(result.status).toBe(0);
  }, 120_000);
});
