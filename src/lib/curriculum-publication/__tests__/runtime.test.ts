import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@/lib/db/client", () => ({ pool: { query: mocks.query } }));

import { listPublishedExamCourses } from "../runtime";

function pointerRow(overrides: Record<string, unknown> = {}) {
  return {
    pointer_course_id: "10000000-0000-4000-8000-000000000001",
    version_course_id: "10000000-0000-4000-8000-000000000001",
    course_slug: "reviewed-course",
    course_version_id: "20000000-0000-4000-8000-000000000001",
    course_version: "1.0.0",
    course_stage: "beta",
    version_content_hash: "a".repeat(64),
    approved_by: "admin-user",
    published_at: new Date("2026-07-12T07:00:00.000Z"),
    publication_event_exists: true,
    release_evidence_exists: true,
    artifact_key: null,
    artifact_type: null,
    skill_key: null,
    content: null,
    content_hash: null,
    publication_stage: null,
    review_status: null,
    review_event_exists: false,
    ...overrides,
  };
}

describe("published curriculum runtime fail-closed boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("returns no reviewed publications only when no publication pointer exists", async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    await expect(listPublishedExamCourses()).resolves.toEqual([]);
  });

  it.each([
    ["missing artifacts", {}],
    ["cross-course pointer", { version_course_id: "10000000-0000-4000-8000-000000000099" }],
    ["draft target", { course_stage: "draft" }],
    ["missing publish event", { publication_event_exists: false }],
  ])("excludes and flags a pointer with %s", async (_label, overrides) => {
    mocks.query.mockResolvedValue({ rows: [pointerRow(overrides)] });
    await expect(listPublishedExamCourses()).resolves.toEqual([]);
    expect(console.error).toHaveBeenCalledWith("Curriculum publication excluded from exams", {
      courseId: pointerRow().pointer_course_id,
      courseVersionId: pointerRow().course_version_id,
      code: "PUBLICATION_POINTER_INVALID",
    });
  });

  it("leaves owner-published courses without release evidence out of the exam catalog", async () => {
    mocks.query.mockResolvedValue({ rows: [pointerRow({ release_evidence_exists: false })] });
    await expect(listPublishedExamCourses()).resolves.toEqual([]);
  });


  it("selects the latest review before checking approval, including later rejecting events", async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    await listPublishedExamCourses();
    const sql = mocks.query.mock.calls[0]![0] as string;
    expect(sql).toContain("left join lateral");
    expect(sql).toContain("order by resulting_version desc, id desc");
    expect(sql).toContain("limit 1");
    expect(sql).not.toMatch(/decision\s*=\s*'approved'/);
    expect(sql).not.toMatch(/reviewer_kind\s*=\s*'human'/);
  });
});
