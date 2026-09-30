import { describe, expect, it, vi } from "vitest";

import {
  lockUserAuthorityOnPgClient,
  userAuthorityLockKey,
} from "@/lib/security/user-authority-lock";

import { PostgresUploadReceiptRepository } from "../upload-repository";
import {
  createDurableUpload,
  UploadOwnerUnavailableError,
} from "../upload-service";

const OWNER = "d1000000-0000-4000-8000-000000000001";
const KEY = "d2000000-0000-4000-8000-000000000001";
const OBJECT_ID = "d3000000-0000-4000-8000-000000000001";
const STORAGE_KEY = `${"d".repeat(64)}/${OBJECT_ID}`;

type Row = Record<string, unknown>;

/**
 * Minimal in-memory model of the rows and transaction-scoped advisory locks
 * the upload commit and account deletion touch. Advisory locks block until
 * the holding transaction commits or rolls back, like pg_advisory_xact_lock.
 */
function fakeDatabase() {
  const state = {
    userStatus: "active" as string,
    storedObjects: [] as Row[],
    quotaLedger: [] as Row[],
    receipts: [] as Row[],
    lockLog: [] as string[],
  };
  const held = new Map<string, Promise<void>>();

  function connect() {
    const releases: Array<() => void> = [];
    let staged: Array<() => void> = [];
    const finish = (apply: boolean) => {
      if (apply) staged.forEach((fn) => fn());
      staged = [];
      releases.splice(0).forEach((release) => release());
    };
    const query = vi.fn(async (statement: string, values: unknown[] = []) => {
      const sql = statement.replace(/\s+/g, " ").trim().toLowerCase();
      if (sql === "begin") return { rows: [], rowCount: 0 };
      if (sql === "commit") { finish(true); return { rows: [], rowCount: 0 }; }
      if (sql === "rollback") { finish(false); return { rows: [], rowCount: 0 }; }
      if (sql.includes("pg_advisory_xact_lock")) {
        const key = String(values[0]);
        while (held.has(key)) await held.get(key);
        let release!: () => void;
        held.set(key, new Promise<void>((resolve) => {
          release = () => { held.delete(key); resolve(); };
        }));
        releases.push(release);
        state.lockLog.push(key);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('from "user"')) {
        return { rows: [{ status: state.userStatus }], rowCount: 1 };
      }
      if (sql.includes("from upload_receipt") && sql.includes("join stored_object")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("quota_bytes") && sql.includes("used_bytes")) {
        return { rows: [{ quota_bytes: "1000", used_bytes: "0" }], rowCount: 1 };
      }
      if (sql.startsWith("select id, storage_key from stored_object")) {
        return { rows: state.storedObjects.filter((row) => row.owner_user_id === values[0]), rowCount: 0 };
      }
      if (sql.startsWith("insert into stored_object")) {
        staged.push(() => state.storedObjects.push({ id: values[0], owner_user_id: values[1], storage_key: values[2] }));
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("insert into quota_ledger")) {
        staged.push(() => state.quotaLedger.push({ user_id: values[0], object_id: values[1] }));
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("insert into upload_receipt")) {
        staged.push(() => state.receipts.push({ owner_user_id: values[0], object_id: values[3] }));
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    return { query, release: vi.fn() };
  }

  const pool = {
    connect: vi.fn(async () => connect()),
    query: vi.fn((statement: string, values?: unknown[]) => connect().query(statement, values)),
  };
  return { state, pool, connect };
}

/** The deletion steps relevant to N06, using deletion.ts's shared lock helper. */
async function runAccountDeletion(database: ReturnType<typeof fakeDatabase>) {
  const client = database.connect();
  await client.query("begin");
  await lockUserAuthorityOnPgClient(client, OWNER);
  database.state.userStatus = "deletion_pending";
  const snapshot = await client.query(
    "select id, storage_key from stored_object where owner_user_id = $1 order by id for update",
    [OWNER],
  );
  await client.query("commit");
  database.state.userStatus = "deleted";
  return snapshot.rows.map((row) => row.storage_key);
}

function gatedStore() {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const store = {
    create: vi.fn(async () => {
      await gate;
      return { storageKey: STORAGE_KEY };
    }),
    remove: vi.fn(async () => undefined),
  };
  return { store, open };
}

function upload(database: ReturnType<typeof fakeDatabase>, store: ReturnType<typeof gatedStore>["store"]) {
  return createDurableUpload({
    ownerUserId: OWNER,
    idempotencyKey: KEY,
    originalName: "main.py",
    mediaType: "text/plain",
    scanStatus: "pending",
    bytes: Buffer.from("hello"),
  }, {
    store,
    repository: new PostgresUploadReceiptRepository(database.pool as never),
    objectId: () => OBJECT_ID,
  });
}

describe("N06 upload commit fenced against account deletion", () => {
  it("rejects a slow upload that resumes after deletion completed and removes its unpublished bytes", async () => {
    const database = fakeDatabase();
    const { store, open } = gatedStore();
    const pending = upload(database, store);

    const erased = await runAccountDeletion(database);
    expect(erased).toEqual([]);
    open();

    await expect(pending).rejects.toBeInstanceOf(UploadOwnerUnavailableError);
    expect(store.remove).toHaveBeenCalledWith(STORAGE_KEY);
    expect(database.state.storedObjects).toEqual([]);
    expect(database.state.receipts).toEqual([]);
    expect(database.state.quotaLedger).toEqual([]);
  });

  it.each(["deletion_pending", "suspended", "pending"])(
    "rejects publication for a %s owner",
    async (status) => {
      const database = fakeDatabase();
      database.state.userStatus = status;
      const { store, open } = gatedStore();
      open();
      await expect(upload(database, store)).rejects.toBeInstanceOf(UploadOwnerUnavailableError);
      expect(store.remove).toHaveBeenCalledWith(STORAGE_KEY);
      expect(database.state.storedObjects).toEqual([]);
    },
  );

  it("takes the shared user-authority lock before the owner quota lock", async () => {
    const database = fakeDatabase();
    const { store, open } = gatedStore();
    open();
    await upload(database, store);
    expect(database.state.lockLog).toEqual([userAuthorityLockKey(OWNER), OWNER]);
  });

  it("serializes a commit already in flight with deletion: the snapshot includes the committed object", async () => {
    const database = fakeDatabase();
    const repository = new PostgresUploadReceiptRepository(database.pool as never);
    // Hold the commit inside its transaction right after it takes the lock.
    let resumeCommit!: () => void;
    const commitParked = new Promise<void>((resolve) => { resumeCommit = resolve; });
    let parked!: () => void;
    const isParked = new Promise<void>((resolve) => { parked = resolve; });
    const connect = database.pool.connect;
    database.pool.connect = vi.fn(async () => {
      const client = await connect();
      const inner = client.query;
      client.query = vi.fn(async (statement: string, values?: unknown[]) => {
        const result = await inner(statement, values);
        if (statement.includes("pg_advisory_xact_lock") && values?.[0] === OWNER) {
          parked();
          await commitParked;
        }
        return result;
      }) as never;
      return client;
    });
    const commit = repository.commit({
      ownerUserId: OWNER,
      idempotencyKey: KEY,
      requestHash: `v1:${"a".repeat(64)}`,
      object: {
        id: OBJECT_ID,
        name: "main.py",
        mediaType: "text/plain",
        sizeBytes: 5,
        storageKey: STORAGE_KEY,
        sha256: "b".repeat(64),
        scanStatus: "pending",
      },
    });
    await isParked;
    const deletion = runAccountDeletion(database);
    await Promise.resolve();
    // Deletion must be blocked on the user-authority lock, not snapshotting.
    expect(database.state.userStatus).toBe("active");
    resumeCommit();

    await expect(commit).resolves.toMatchObject({ disposition: "created" });
    await expect(deletion).resolves.toEqual([STORAGE_KEY]);
  });
});
