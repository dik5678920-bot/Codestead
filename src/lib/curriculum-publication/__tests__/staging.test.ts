import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ContentRepository, type CourseManifest } from "@/lib/content";

const mocks = vi.hoisted(() => ({ repository: vi.fn(), connect: vi.fn() }));
vi.mock("@/lib/content", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/content")>(),
  createContentRepository: mocks.repository,
}));
vi.mock("@/lib/db/client", () => ({ pool: { connect: mocks.connect } }));

import { buildFilesystemCurriculumCandidates, stageFilesystemCurriculum } from "../staging";

const now = new Date("2026-10-01T07:00:00.000Z");
const request = {
  actorUserId: "admin-user",
  requestId: "10000000-0000-4000-8000-000000000001",
  reason: "Stage independently reviewed curriculum for publication.",
  now,
};
let course: CourseManifest;

async function persistenceFixture() {
  const [candidate] = await buildFilesystemCurriculumCandidates();
  const manifest = candidate!.artifacts[0]!;
  const state = {
    actorRows: [{ role: "admin", status: "active" }],
    courseRows: [{ id: "course-1", title: course.title, summary: course.summary, domain: "curriculum" }],
    insertVersion: true,
    versionRows: [{ id: "version-1", content_hash: candidate!.contentHash }],
    artifacts: [{ artifact_key: manifest.artifactKey, content_hash: manifest.contentHash, ai_assisted: false }],
    events: [] as Array<Record<string, unknown>>,
  };
  const release = vi.fn();
  const query = vi.fn(async (raw: string, values: unknown[] = []) => {
    const sql = raw.replace(/\s+/g, " ").trim();
    const result = (rows: unknown[] = []) => ({ rows, rowCount: rows.length });
    if (["begin", "commit", "rollback"].includes(sql) || sql.startsWith("select pg_advisory_xact_lock")) return result();
    if (sql.startsWith("select role, status")) return result(state.actorRows);
    if (sql.startsWith("insert into course (")) return result();
    if (sql.startsWith("select id, title, summary, domain")) return result(state.courseRows);
    if (sql.startsWith("insert into course_version")) return result(state.insertVersion ? [{ id: "version-1" }] : []);
    if (sql.startsWith("select id, content_hash from course_version")) return result(state.versionRows);
    if (sql.startsWith("insert into curriculum_artifact")) return result();
    if (sql.startsWith("select artifact_key, content_hash, ai_assisted")) return result(state.artifacts);
    if (sql.startsWith("select actor_user_id, course_version_id, event")) return result(state.events);
    if (sql.startsWith("insert into curriculum_publication_event")) {
      state.events.push({
        actor_user_id: values[2], course_version_id: values[1], event: "candidate_staged",
        reason: values[4], evidence_hash: values[6],
      });
      return result();
    }
    throw new Error(`Unhandled staging fixture SQL: ${sql}`);
  });
  mocks.connect.mockResolvedValue({ query, release });
  return { state, query, release };
}

describe("filesystem curriculum staging boundaries", () => {
  beforeAll(async () => {
    course = (await new ContentRepository().getCourse("programming-foundations"))!;
    expect(course.id).toBe("programming-foundations");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.repository.mockReturnValue({
      getSnapshot: async () => ({ courses: [course], catalog: { tracks: [] }, manifestPaths: {} }),
      getAuthoredContentSet: async () => ({ lessons: [], assessmentBanks: [] }),
    });
  });

  it.each([
    ["invalid date", { now: new Date("invalid") }],
    ["missing request", { requestId: undefined }],
    ["malformed request", { requestId: "not-a-uuid" }],
    ["missing reason", { reason: undefined }],
    ["blank reason", { reason: "   " }],
    ["short reason", { reason: "Too short" }],
    ["oversized reason", { reason: "x".repeat(2_001) }],
  ])("rejects %s before reading content or opening a transaction", async (_label, override) => {
    await expect(stageFilesystemCurriculum({ ...request, ...override })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(mocks.repository).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it.each(["missing", "non-admin", "inactive"])("rejects a %s administrator and rolls back", async (fault) => {
    const fixture = await persistenceFixture();
    if (fault === "missing") fixture.state.actorRows = [];
    if (fault === "non-admin") fixture.state.actorRows[0]!.role = "learner";
    if (fault === "inactive") fixture.state.actorRows[0]!.status = "disabled";
    await expect(stageFilesystemCurriculum(request)).rejects.toMatchObject({ code: "ADMIN_REQUIRED" });
    expect(fixture.query).toHaveBeenCalledWith("rollback");
    expect(fixture.query.mock.calls.some(([sql]) => sql.includes("insert into course"))).toBe(false);
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it.each(["missing", "title", "summary"])("rejects %s course metadata instead of staging a conflicting version", async (fault) => {
    const fixture = await persistenceFixture();
    if (fault === "missing") fixture.state.courseRows = [];
    if (fault === "title") fixture.state.courseRows[0]!.title = "A different course";
    if (fault === "summary") fixture.state.courseRows[0]!.summary = "A different scope";
    await expect(stageFilesystemCurriculum(request)).rejects.toMatchObject({ code: "COURSE_METADATA_CONFLICT" });
    expect(fixture.query.mock.calls.some(([sql]) => sql.includes("insert into course_version"))).toBe(false);
    expect(fixture.query).toHaveBeenCalledWith("rollback");
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it("reuses an existing version only when its immutable content hash matches", async () => {
    const fixture = await persistenceFixture();
    fixture.state.insertVersion = false;
    await expect(stageFilesystemCurriculum(request)).resolves.toEqual({
      courses: 1, artifacts: 1, aiAssistedArtifacts: 0, courseVersionIds: ["version-1"],
    });
    expect(fixture.query).toHaveBeenCalledWith(expect.stringContaining("from course_version where course_id = $1 and version = $2 for update"), ["course-1", course.version]);
    expect(fixture.state.events).toHaveLength(1);
    expect(fixture.query).toHaveBeenCalledWith("commit");
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it.each(["missing", "changed"])("rejects a %s existing version and preserves the original error if rollback fails", async (fault) => {
    const fixture = await persistenceFixture();
    fixture.state.insertVersion = false;
    if (fault === "missing") fixture.state.versionRows = [];
    else fixture.state.versionRows[0]!.content_hash = "a".repeat(64);
    const originalQuery = fixture.query.getMockImplementation()!;
    fixture.query.mockImplementation(async (sql, values) => {
      if (sql === "rollback") throw new Error("Rollback connection lost");
      return originalQuery(sql, values);
    });
    await expect(stageFilesystemCurriculum(request)).rejects.toMatchObject({ code: "CONTENT_VERSION_MUTATION" });
    expect(fixture.query).toHaveBeenCalledWith("rollback");
    expect(fixture.query.mock.calls.some(([sql]) => sql.includes("insert into curriculum_artifact"))).toBe(false);
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it.each(["missing", "changed"])("rejects %s stored artifacts instead of recording a successful staging event", async (fault) => {
    const fixture = await persistenceFixture();
    if (fault === "missing") fixture.state.artifacts = [];
    else fixture.state.artifacts[0]!.content_hash = "a".repeat(64);
    await expect(stageFilesystemCurriculum(request)).rejects.toMatchObject({ code: "ARTIFACT_VERSION_MUTATION" });
    expect(fixture.state.events).toEqual([]);
    expect(fixture.query).toHaveBeenCalledWith("rollback");
    expect(fixture.query).not.toHaveBeenCalledWith("commit");
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it("replays an identical staging request without appending another audit event", async () => {
    const fixture = await persistenceFixture();
    const first = await stageFilesystemCurriculum(request);
    fixture.state.insertVersion = false;
    fixture.query.mockClear();
    await expect(stageFilesystemCurriculum(request)).resolves.toEqual(first);
    expect(fixture.state.events).toHaveLength(1);
    expect(fixture.query.mock.calls.some(([sql]) => sql.includes("insert into curriculum_publication_event"))).toBe(false);
    expect(fixture.query).toHaveBeenCalledWith("commit");
    expect(fixture.release).toHaveBeenCalledTimes(2);
  });

  it.each(["actor_user_id", "course_version_id", "event", "reason", "evidence_hash"])("rejects request reuse with a different %s", async (field) => {
    const fixture = await persistenceFixture();
    await stageFilesystemCurriculum(request);
    fixture.state.events[0]![field] = "different-value";
    fixture.query.mockClear();
    await expect(stageFilesystemCurriculum(request)).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
    expect(fixture.state.events).toHaveLength(1);
    expect(fixture.query).toHaveBeenCalledWith("rollback");
    expect(fixture.query).not.toHaveBeenCalledWith("commit");
    expect(fixture.release).toHaveBeenCalledTimes(2);
  });
});
