import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

const tmpfiles = read("infra/tmpfiles.d/learncoding-postgres.conf");
const preparer = read("infra/ops/prepare-postgres-control-socket.sh");
const installer = read("infra/ops/install-systemd.sh");
const releaseFixture = read("infra/tests/release-production.test.sh");

function entries(source: string): string[][] {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split(/\s+/u));
}

describe("postgres control-socket tmpfiles", () => {
  it("recreates exactly the preparer's socket root with its owner and mode", () => {
    const socketRoot = /readonly socket_root="([^"]+)"/u.exec(preparer)?.[1];
    expect(socketRoot).toBe("/run/learncoding-postgres");
    // The preparer accepts only POSTGRES_UID:POSTGRES_GID with mode 700.
    expect(preparer).toContain('"${expected_uid}:${expected_gid}:700"');
    const uid = /^POSTGRES_UID=(\d+)$/mu.exec(releaseFixture)?.[1];
    const gid = /^POSTGRES_GID=(\d+)$/mu.exec(releaseFixture)?.[1];
    expect(entries(tmpfiles)).toEqual([["d", socketRoot, "0700", uid, gid, "-"]]);
  });

  it("is installed by the host installer's tmpfiles.d loop", () => {
    expect(installer).toContain('for definition in "$repo_root"/infra/tmpfiles.d/*; do');
  });
});
