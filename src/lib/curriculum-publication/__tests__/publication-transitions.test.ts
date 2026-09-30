import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * In-memory model of the tables and locks the publication transitions touch.
 * Advisory locks and FOR UPDATE row locks block until the holding transaction
 * ends; writes are staged and become visible only at COMMIT (READ COMMITTED).
 */
type Version = { id: string; course_id: string; stage: string; publication_revision: number };
type Pointer = { course_id: string; current_course_version_id: string; row_version: number };
type Event = {
  course_id: string; course_version_id: string; actor_user_id: string; event: string;
  request_id: string; reason: string; evidence: Record<string, unknown>;
};

const hooks = vi.hoisted(() => ({
  connect: vi.fn(),
  gate: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ pool: { connect: () => hooks.connect() } }));
vi.mock("../gate", () => ({ evaluateCurriculumPublicationGate: hooks.gate }));

import {
  CurriculumAdminError,
  retireCurriculumVersion,
  rollbackCurriculumPointer,
} from "../admin-service";

const ADMIN_1 = "a1000000-0000-4000-8000-000000000001";
const ADMIN_2 = "a1000000-0000-4000-8000-000000000002";
const COURSE = "c1000000-0000-4000-8000-000000000001";
const VERSION_A = "e1000000-0000-4000-8000-00000000000a";
const VERSION_B = "e1000000-0000-4000-8000-00000000000b";
const REQUEST_1 = "f1000000-0000-4000-8000-000000000001";
const REQUEST_2 = "f1000000-0000-4000-8000-000000000002";
const REASON = "Operational change with a sufficiently long reason.";
const NOW = new Date("2026-09-30T12:00:00.000Z");

function fakeDatabase() {
  const state = {
    versions: new Map<string, Version>(),
    pointers: new Map<string, Pointer>(),
    events: [] as Event[],
    writes: [] as string[],
  };
  const held = new Map<string, { owner: number; released: Promise<void> }>();
  let nextClient = 0;
  const pauses: Array<{ match: (sql: string, values: unknown[]) => boolean; reached: () => void; resume: Promise<void> }> = [];

  function pauseAfter(match: (sql: string, values: unknown[]) => boolean) {
    let reached!: () => void;
    let resume!: () => void;
    const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
    const resumePromise = new Promise<void>((resolve) => { resume = resolve; });
    pauses.push({ match, reached, resume: resumePromise });
    return { reached: reachedPromise, resume };
  }

  function connect() {
    const id = ++nextClient;
    const releases: Array<() => void> = [];
    let staged: Array<() => void> = [];
    async function lock(key: string) {
      for (;;) {
        const current = held.get(key);
        if (!current || current.owner === id) break;
        await current.released;
      }
      if (held.get(key)?.owner === id) return;
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      held.set(key, { owner: id, released });
      releases.push(() => { held.delete(key); release(); });
    }
    function end(apply: boolean) {
      if (apply) staged.forEach((fn) => fn());
      staged = [];
      releases.splice(0).forEach((fn) => fn());
    }
    async function run(statement: string, values: unknown[] = []) {
      const sql = statement.replace(/\s+/g, " ").trim().toLowerCase();
      if (sql === "begin") return { rows: [], rowCount: 0 };
      if (sql === "commit") { end(true); return { rows: [], rowCount: 0 }; }
      if (sql === "rollback") { end(false); return { rows: [], rowCount: 0 }; }
      if (sql.includes("pg_advisory_xact_lock")) { await lock(`advisory:${values[0]}`); return { rows: [], rowCount: 1 }; }
      if (sql.startsWith('select role, status from "user"')) {
        await lock(`user:${values[0]}`);
        return { rows: [{ role: "admin", status: "active" }], rowCount: 1 };
      }
      if (sql.includes("from course_version where id = $1")) {
        if (sql.includes("for update")) await lock(`version:${values[0]}`);
        const row = state.versions.get(String(values[0]));
        const visible = row && (!sql.includes("course_id = $2") || row.course_id === values[1]);
        return { rows: visible ? [{ ...row }] : [], rowCount: visible ? 1 : 0 };
      }
      if (sql.includes("from curriculum_publication_pointer where course_id = $1")) {
        if (sql.includes("for update")) await lock(`pointer:${values[0]}`);
        const row = state.pointers.get(String(values[0]));
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
      }
      if (sql.includes("from curriculum_publication_event where course_id = $1 and request_id = $2")) {
        const rows = state.events.filter((event) => event.course_id === values[0] && event.request_id === values[1]);
        return { rows: rows.map((row) => ({ ...row })), rowCount: rows.length };
      }
      if (sql.startsWith("update course_version set stage")) {
        await lock(`version:${values[0]}`);
        const row = state.versions.get(String(values[0]));
        const retire = sql.includes("stage = 'retired'");
        const expected = retire ? values[2] : values[4];
        if (!row || row.publication_revision !== expected) return { rows: [], rowCount: 0 };
        const stage = retire ? "retired" : String(values[1]);
        state.writes.push(`version:${row.id}:${stage}`);
        staged.push(() => { row.stage = stage; row.publication_revision += 1; });
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("update curriculum_publication_pointer")) {
        await lock(`pointer:${values[0]}`);
        const row = state.pointers.get(String(values[0]));
        if (!row || row.row_version !== values[5]) return { rows: [], rowCount: 0 };
        state.writes.push(`pointer:${values[1]}`);
        staged.push(() => { row.current_course_version_id = String(values[1]); row.row_version += 1; });
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("insert into curriculum_publication_pointer")) {
        await lock(`pointer:${values[0]}`);
        state.writes.push(`pointer:${values[1]}`);
        staged.push(() => {
          const row = state.pointers.get(String(values[0]));
          if (row) { row.current_course_version_id = String(values[1]); row.row_version += 1; }
          else state.pointers.set(String(values[0]), { course_id: String(values[0]), current_course_version_id: String(values[1]), row_version: 1 });
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("insert into curriculum_publication_event")) {
        const literal = sql.match(/values \(\$1,\$2,\$3,'(\w+)'/);
        const event: Event = literal
          ? { course_id: String(values[0]), course_version_id: String(values[1]), actor_user_id: String(values[2]), event: literal[1], request_id: String(values[3]), reason: String(values[4]), evidence: JSON.parse(String(values[5])) }
          : { course_id: String(values[0]), course_version_id: String(values[1]), actor_user_id: String(values[2]), event: String(values[3]), request_id: String(values[4]), reason: String(values[5]), evidence: JSON.parse(String(values[6])) };
        state.writes.push(`event:${event.event}:${event.course_version_id}`);
        staged.push(() => state.events.push(event));
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
    return {
      release: vi.fn(),
      query: vi.fn(async (statement: string, values: unknown[] = []) => {
        const result = await run(statement, values);
        const sql = statement.replace(/\s+/g, " ").trim().toLowerCase();
        const index = pauses.findIndex((pause) => pause.match(sql, values));
        if (index >= 0) {
          const [pause] = pauses.splice(index, 1);
          pause.reached();
          await pause.resume;
        }
        return result;
      }),
    };
  }

  return { state, connect, pauseAfter };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

let db: ReturnType<typeof fakeDatabase>;

beforeEach(() => {
  vi.clearAllMocks();
  db = fakeDatabase();
  hooks.connect.mockImplementation(async () => db.connect());
  hooks.gate.mockResolvedValue({ allowed: true, targetStage: "beta", blockers: [] });
});

function seedRollbackScenario() {
  // Pointer is B; older A is a still-eligible beta version.
  db.state.versions.set(VERSION_A, { id: VERSION_A, course_id: COURSE, stage: "beta", publication_revision: 2 });
  db.state.versions.set(VERSION_B, { id: VERSION_B, course_id: COURSE, stage: "verified", publication_revision: 3 });
  db.state.pointers.set(COURSE, { course_id: COURSE, current_course_version_id: VERSION_B, row_version: 4 });
}

function rollbackToA(actor = ADMIN_1) {
  return rollbackCurriculumPointer({
    actorUserId: actor, courseId: COURSE, targetCourseVersionId: VERSION_A,
    requestId: REQUEST_1, expectedPointerVersion: 4, reason: REASON, now: NOW,
  });
}

function retireA(actor = ADMIN_2) {
  return retireCurriculumVersion({
    actorUserId: actor, courseVersionId: VERSION_A, requestId: REQUEST_2,
    expectedVersion: 2, reason: REASON, now: NOW,
  });
}

function pointerTargetStage() {
  const pointer = db.state.pointers.get(COURSE)!;
  return db.state.versions.get(pointer.current_course_version_id)!.stage;
}

describe("N11 rollback vs concurrent retirement", () => {
  it("never leaves the pointer at a retired version when retirement runs after rollback's target lookup", async () => {
    seedRollbackScenario();
    const paused = db.pauseAfter((sql, values) => sql.includes("from course_version where id = $1") && values[0] === VERSION_A && sql.includes("course_id = $2"));
    const rollback = rollbackToA().then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
    await paused.reached;
    const retirement = retireA().then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
    await settle();
    paused.resume();
    const [rolled, retired] = await Promise.all([rollback, retirement]);

    expect(pointerTargetStage()).not.toBe("retired");
    // Serialized: rollback wins, and retirement then sees A as current.
    expect(rolled.ok).toBe(true);
    expect(retired.ok).toBe(false);
    expect((retired as { error: CurriculumAdminError }).error.code).toBe("CURRENT_VERSION_CANNOT_RETIRE");
    expect(db.state.pointers.get(COURSE)).toMatchObject({ current_course_version_id: VERSION_A, row_version: 5 });
  });

  it("rejects rollback to a version whose retirement committed first", async () => {
    seedRollbackScenario();
    await expect(retireA()).resolves.toMatchObject({ stage: "retired", replayed: false });
    await expect(rollbackToA()).rejects.toMatchObject({ code: "ROLLBACK_TARGET_INVALID" });
    expect(db.state.pointers.get(COURSE)).toMatchObject({ current_course_version_id: VERSION_B, row_version: 4 });
  });

  it("locks and rechecks the target version before touching the pointer, in retirement's order", async () => {
    seedRollbackScenario();
    const client = db.connect();
    hooks.connect.mockResolvedValueOnce(client);
    await rollbackToA();
    const statements = client.query.mock.calls.map(([sql, values]) => [String(sql).replace(/\s+/g, " ").toLowerCase(), values] as const);
    const versionLock = statements.findIndex(([sql, values]) => sql.includes("pg_advisory_xact_lock") && (values as unknown[])[0] === `curriculum-version:${VERSION_A}`);
    const targetRow = statements.findIndex(([sql]) => sql.includes("from course_version where id = $1") && sql.includes("for update"));
    const pointerRow = statements.findIndex(([sql]) => sql.includes("from curriculum_publication_pointer") && sql.includes("for update"));
    expect(versionLock).toBeGreaterThanOrEqual(0);
    expect(versionLock).toBeLessThan(targetRow);
    expect(targetRow).toBeLessThan(pointerRow);
  });

  it("still refuses to retire the current version", async () => {
    seedRollbackScenario();
    await rollbackToA();
    await expect(retireA()).rejects.toMatchObject({ code: "CURRENT_VERSION_CANNOT_RETIRE" });
    expect(db.state.versions.get(VERSION_A)?.stage).toBe("beta");
  });

  it("keeps uncontended rollback and pointer CAS conflicts", async () => {
    seedRollbackScenario();
    await expect(rollbackCurriculumPointer({
      actorUserId: ADMIN_1, courseId: COURSE, targetCourseVersionId: VERSION_A,
      requestId: REQUEST_1, expectedPointerVersion: 3, reason: REASON, now: NOW,
    })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await expect(rollbackToA()).resolves.toEqual({ courseId: COURSE, currentCourseVersionId: VERSION_A, pointerVersion: 5, replayed: false });
    await expect(rollbackToA()).resolves.toMatchObject({ replayed: true, pointerVersion: 5 });
  });
});
