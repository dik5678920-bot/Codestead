import { beforeEach, describe, expect, it, vi } from "vitest";

import { hashAppealEvidence } from "@/lib/appeals/evidence";
import { EXAM_POLICY_VERSION, type ExamResult } from "@/lib/exams/contracts";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ pool: { query: mocks.query } }));

import { assembleTrophyCabinet, listOwnTrophyCabinet, validIndependentMasteryTrophy } from "../trophy-cabinet";

const learnerId = "learner-1";
const mastery = {
  id: "award-1",
  title: "Mastery: Variables",
  description: "Independent mastery evidence.",
  icon: "medal",
  awarded_at: new Date("2026-07-14T09:00:00.000Z"),
  revoked_at: null,
  visibility: "private",
  evidence_id: "exam-attempt:attempt-1",
  rule_version: "exam-mastery-v1",
  event: "exam_mastery",
  course_id: "python",
  module_id: "variables",
  minimum_score_percent: "95",
  critical_requirements_required: "true",
  attempt_id: "attempt-1",
  attempt_score: 0.95,
  attempt_status: "graded",
  mastery_awarded: true,
  assistance_level: "A0",
  solution_revealed: false,
  attempt_user_id: learnerId,
  selected: false,
  portfolio_published: false,
  portfolio_slug: null,
};

function result(overrides: Partial<ExamResult> = {}): ExamResult {
  return {
    schemaVersion: 1, gradingStatus: "graded", outcome: "MASTERED", officialScorePercent: 100,
    earnedPoints: 10, possiblePoints: 10, pendingReviewItemIds: [], failedCriticalClusters: [],
    masteryBlockingCodingItems: [], compilationGatePassed: true, infrastructureFailure: false,
    finalizedAt: "2026-09-30T12:00:00.000Z", finalizedBy: "learner-submit",
    policyVersion: EXAM_POLICY_VERSION, remediation: { required: false, targets: [] },
    ...overrides,
  };
}

function correctedRow(current = result(), original = result({ outcome: "NOT_PASSED", officialScorePercent: 50, earnedPoints: 5 })) {
  const resultHash = hashAppealEvidence(current);
  const decision = {
    schemaVersion: 1, correctionId: "correction-1", impactId: "impact-1", sourceAppealId: null,
    priorResultHash: hashAppealEvidence(original), correctedResultHash: resultHash,
    runnerEvidenceHash: "a".repeat(64), faultyEvidenceHash: "b".repeat(64),
    replacementEvidenceHash: "c".repeat(64), reviewHash: "d".repeat(64),
    revision: 2, deterministic: true, aiRole: "none",
  };
  return {
    ...mastery, attempt_score: 0.5, mastery_awarded: false,
    effective_attempt_id: mastery.attempt_id, effective_user_id: learnerId,
    effective_outcome_id: "outcome-2", effective_revision: 2,
    effective_result: current, effective_result_hash: resultHash,
    outcome_id: "outcome-2", outcome_attempt_id: mastery.attempt_id, outcome_user_id: learnerId,
    outcome_revision: 2, outcome_correction_id: "correction-1", outcome_impact_id: "impact-1",
    outcome_course_id: mastery.course_id, outcome_module_id: mastery.module_id,
    outcome_result: current, outcome_result_hash: resultHash,
    outcome_original_result: original, outcome_original_result_hash: hashAppealEvidence(original),
    outcome_decision_evidence: decision, outcome_decision_evidence_hash: hashAppealEvidence(decision),
  };
}

describe("trophy cabinet evidence boundaries", () => {
  it("accepts only exact independent mastery evidence", () => {
    expect(validIndependentMasteryTrophy(mastery, learnerId)).toBe(true);
    expect(validIndependentMasteryTrophy({ ...mastery, assistance_level: "A1" }, learnerId)).toBe(false);
    expect(validIndependentMasteryTrophy({ ...mastery, solution_revealed: true }, learnerId)).toBe(false);
    expect(validIndependentMasteryTrophy({ ...mastery, attempt_user_id: "other" }, learnerId)).toBe(false);
    expect(validIndependentMasteryTrophy({ ...mastery, evidence_id: "exam-attempt:other" }, learnerId)).toBe(false);
    expect(validIndependentMasteryTrophy({ ...mastery, attempt_score: 0.94 }, learnerId)).toBe(false);
  });

  it("preserves revocation and explicit portfolio visibility without minting currency", () => {
    const cabinet = assembleTrophyCabinet({
      userId: learnerId,
      certificateRows: [{
        id: "certificate-1",
        course_title: "Python",
        course_version_label: "1.0.0",
        issued_at: new Date("2026-07-13T09:00:00.000Z"),
        verification_id: "abcdefghijklmnopqrstuvwxyz123456",
        revoked_at: new Date("2026-07-14T10:00:00.000Z"),
        selected: true,
        portfolio_published: true,
        portfolio_slug: "learner-one",
      }],
      masteryRows: [{ ...mastery, selected: true, portfolio_published: true }],
    });
    expect(cabinet.summary).toEqual({ earned: 1, revoked: 1, shared: 1 });
    expect(cabinet.rewards).toMatchObject({ coinsEnabled: false, coins: 0 });
    expect(cabinet.trophies.find((item) => item.kind === "course_completion")?.status).toBe("revoked");
  });

  it("drops malformed or non-independent achievement rows", () => {
    const cabinet = assembleTrophyCabinet({
      userId: learnerId,
      certificateRows: [],
      masteryRows: [
        { ...mastery, id: "invalid-1", mastery_awarded: false },
        { ...mastery, id: "invalid-2", event: "practice_completed" },
        { ...mastery, id: "invalid-3", attempt_status: "in_progress" },
      ],
    });
    expect(cabinet.trophies).toEqual([]);
  });
});

describe("N09 authoritative corrected trophy evidence", () => {
  beforeEach(() => vi.clearAllMocks());

  it("loads a correction-earned trophy despite the immutable original failed score", async () => {
    const row = correctedRow();
    mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("from user_achievement") ? [row] : [] }));
    const before = structuredClone(row);
    const cabinet = await listOwnTrophyCabinet(learnerId);
    expect(cabinet.trophies).toMatchObject([{ id: "mastery:award-1", status: "earned" }]);
    expect(cabinet.summary).toEqual({ earned: 1, revoked: 0, shared: 0 });
    expect(row).toEqual(before);
  });

  it("uses corrected grading status rather than the original pending state", () => {
    expect(validIndependentMasteryTrophy({ ...correctedRow(), attempt_status: "submitted" }, learnerId)).toBe(true);
  });

  it("preserves revoked history after a corrected failure without counting it earned or shared", () => {
    const row = {
      ...correctedRow(result({ outcome: "NOT_PASSED", officialScorePercent: 50, earnedPoints: 5 }), result()),
      revoked_at: new Date("2026-09-30T12:00:00.000Z"), selected: true, portfolio_published: true,
    };
    const cabinet = assembleTrophyCabinet({ userId: learnerId, certificateRows: [], masteryRows: [row] });
    expect(cabinet.trophies).toMatchObject([{ status: "revoked" }]);
    expect(cabinet.summary).toEqual({ earned: 0, revoked: 1, shared: 0 });
  });

  it("does not fall back to an original pass when the latest correction fails", () => {
    const row = { ...correctedRow(result({ outcome: "NOT_PASSED", officialScorePercent: 50, earnedPoints: 5 }), result()), attempt_score: 1, mastery_awarded: true };
    expect(validIndependentMasteryTrophy(row, learnerId)).toBe(false);
  });

  it("keeps the original-result path only when there is no effective projection", () => {
    expect(validIndependentMasteryTrophy({ ...mastery, effective_attempt_id: null }, learnerId)).toBe(true);
    expect(validIndependentMasteryTrophy({ ...mastery, effective_attempt_id: null, attempt_score: 0.5 }, learnerId)).toBe(false);
  });

  it.each([
    ["foreign effective owner", { effective_user_id: "other" }],
    ["foreign effective attempt", { effective_attempt_id: "other" }],
    ["missing outcome", { outcome_id: null }],
    ["wrong outcome pointer", { effective_outcome_id: "other" }],
    ["foreign outcome owner", { outcome_user_id: "other" }],
    ["foreign outcome attempt", { outcome_attempt_id: "other" }],
    ["wrong course", { outcome_course_id: "other" }],
    ["wrong module", { outcome_module_id: "other" }],
    ["stale outcome revision", { outcome_revision: 1 }],
    ["tampered effective hash", { effective_result_hash: "f".repeat(64) }],
    ["tampered outcome hash", { outcome_result_hash: "f".repeat(64) }],
    ["tampered decision hash", { outcome_decision_evidence_hash: "f".repeat(64) }],
    ["missing result", { effective_result: null }],
    ["assisted attempt", { assistance_level: "A1" }],
    ["revealed solution", { solution_revealed: true }],
  ])("rejects %s even if the original fields claim mastery", (_label, overrides) => {
    expect(validIndependentMasteryTrophy({ ...correctedRow(), attempt_score: 1, mastery_awarded: true, ...overrides }, learnerId)).toBe(false);
  });

  it.each([
    ["pending", { gradingStatus: "pending-review", outcome: "PENDING_REVIEW", officialScorePercent: null }],
    ["infrastructure failure", { infrastructureFailure: true }],
    ["low score", { officialScorePercent: 94 }],
    ["invalid score", { officialScorePercent: Number.POSITIVE_INFINITY }],
    ["critical failure", { failedCriticalClusters: ["critical-1"] }],
    ["blocked coding item", { masteryBlockingCodingItems: ["code-1"] }],
    ["failed compilation", { compilationGatePassed: false }],
    ["ungraded item", { pendingReviewItemIds: ["item-1"] }],
  ] as const)("rejects a hash-bound result with %s", (_label, overrides) => {
    expect(validIndependentMasteryTrophy(correctedRow(result(overrides)), learnerId)).toBe(false);
  });

  it("rejects non-deterministic correction provenance even when its hash matches", () => {
    const row = correctedRow();
    row.outcome_decision_evidence.deterministic = false;
    row.outcome_decision_evidence_hash = hashAppealEvidence(row.outcome_decision_evidence);
    expect(validIndependentMasteryTrophy(row, learnerId)).toBe(false);
  });

  it("does not manufacture revoked history when no prior result supports mastery", () => {
    const row = { ...correctedRow(result({ outcome: "NOT_PASSED", officialScorePercent: 50, earnedPoints: 5 })), revoked_at: new Date() };
    expect(validIndependentMasteryTrophy(row, learnerId)).toBe(false);
  });

  it("joins the existing effective-result/outcome schema and remains owner-scoped", async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    await listOwnTrophyCabinet(learnerId);
    const [sql, params] = mocks.query.mock.calls.find(([query]) => String(query).includes("from user_achievement"))!;
    expect(sql).toContain("assessment_attempt_effective_result");
    expect(sql).toContain("assessment_regrade_outcome");
    expect(sql).toContain("assessment_correction_impact");
    expect(sql).toContain("effective.attempt_id=evidence_attempt.id");
    expect(sql).toContain("corrected.id=effective.outcome_id");
    expect(sql).toContain("evidence_attempt.user_id=owned.user_id");
    expect(sql).toContain("where owned.user_id=$1");
    expect(params).toEqual([learnerId, mastery.rule_version]);
  });
});
