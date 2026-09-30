import { EXAM_MASTERY_RULE_VERSION } from "@/lib/achievements/exam-mastery";
import { hashAppealEvidence } from "@/lib/appeals/evidence";
import { pool } from "@/lib/db/client";
import type { ExamResult } from "@/lib/exams/contracts";

export const TROPHY_PRESENTATION_POLICY = "evidence-trophy-cabinet-2026-07-14.v1";

type CertificateTrophyRow = {
  id: string;
  course_title: string;
  course_version_label: string;
  issued_at: Date;
  verification_id: string;
  revoked_at: Date | null;
  selected: boolean;
  portfolio_published: boolean;
  portfolio_slug: string | null;
};

type MasteryTrophyRow = {
  id: string;
  title: string;
  description: string;
  icon: string;
  awarded_at: Date;
  revoked_at: Date | null;
  visibility: string;
  evidence_id: string;
  rule_version: string;
  event: string | null;
  course_id: string | null;
  module_id: string | null;
  minimum_score_percent: string | null;
  critical_requirements_required: string | null;
  attempt_id: string | null;
  attempt_score: number | null;
  attempt_status: string | null;
  mastery_awarded: boolean | null;
  assistance_level: string | null;
  solution_revealed: boolean | null;
  attempt_user_id: string | null;
  effective_attempt_id?: string | null;
  effective_user_id?: string | null;
  effective_outcome_id?: string | null;
  effective_revision?: number | null;
  effective_result?: unknown;
  effective_result_hash?: string | null;
  outcome_id?: string | null;
  outcome_attempt_id?: string | null;
  outcome_user_id?: string | null;
  outcome_revision?: number | null;
  outcome_correction_id?: string | null;
  outcome_impact_id?: string | null;
  outcome_course_id?: string | null;
  outcome_module_id?: string | null;
  outcome_result?: unknown;
  outcome_result_hash?: string | null;
  outcome_original_result?: unknown;
  outcome_original_result_hash?: string | null;
  outcome_decision_evidence?: unknown;
  outcome_decision_evidence_hash?: string | null;
  selected: boolean;
  portfolio_published: boolean;
  portfolio_slug: string | null;
};

export type Trophy = {
  id: string;
  kind: "course_completion" | "module_mastery";
  title: string;
  description: string;
  icon: string;
  earnedAt: string;
  status: "earned" | "revoked";
  visibility: "private" | "portfolio";
  evidenceLabel: string;
  verificationPath: string | null;
};

function certificateTrophy(row: CertificateTrophyRow): Trophy {
  return {
    id: `certificate:${row.id}`,
    kind: "course_completion",
    title: `${row.course_title} completed`,
    description: `Verified completion of version ${row.course_version_label}.`,
    icon: "trophy",
    earnedAt: row.issued_at.toISOString(),
    status: row.revoked_at ? "revoked" : "earned",
    visibility: row.selected && row.portfolio_published ? "portfolio" : "private",
    evidenceLabel: `Certificate ${row.verification_id.slice(0, 10)}…`,
    verificationPath: `/verify/${row.verification_id}`,
  };
}

type TrophyResult = Pick<ExamResult,
  "schemaVersion" | "gradingStatus" | "outcome" | "officialScorePercent" |
  "pendingReviewItemIds" | "failedCriticalClusters" | "masteryBlockingCodingItems" |
  "compilationGatePassed" | "infrastructureFailure">;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finalTrophyResult(value: unknown): value is TrophyResult {
  const result = record(value);
  return result !== null
    && result.schemaVersion === 1
    && result.gradingStatus === "graded"
    && ["MASTERED", "PASSED", "NOT_PASSED"].includes(String(result.outcome))
    && result.infrastructureFailure === false
    && typeof result.officialScorePercent === "number"
    && Number.isFinite(result.officialScorePercent)
    && result.officialScorePercent >= 0 && result.officialScorePercent <= 100
    && Array.isArray(result.pendingReviewItemIds) && result.pendingReviewItemIds.length === 0
    && Array.isArray(result.failedCriticalClusters) && result.failedCriticalClusters.every((item) => typeof item === "string")
    && Array.isArray(result.masteryBlockingCodingItems) && result.masteryBlockingCodingItems.every((item) => typeof item === "string")
    && typeof result.compilationGatePassed === "boolean";
}

function supportsMastery(result: TrophyResult): boolean {
  return result.outcome === "MASTERED"
    && result.officialScorePercent! >= 95
    && result.failedCriticalClusters.length === 0
    && result.masteryBlockingCodingItems.length === 0
    && result.compilationGatePassed === true;
}

function boundCorrection(row: MasteryTrophyRow, userId: string): boolean {
  const decision = record(row.outcome_decision_evidence);
  return row.effective_attempt_id === row.attempt_id
    && row.effective_user_id === userId
    && Boolean(row.effective_outcome_id) && row.effective_outcome_id === row.outcome_id
    && row.outcome_attempt_id === row.attempt_id && row.outcome_user_id === userId
    && typeof row.effective_revision === "number" && Number.isSafeInteger(row.effective_revision)
    && row.effective_revision >= 1 && row.effective_revision === row.outcome_revision
    && row.outcome_course_id === row.course_id && row.outcome_module_id === row.module_id
    && row.effective_result_hash === row.outcome_result_hash
    && hashAppealEvidence(row.effective_result) === row.effective_result_hash
    && hashAppealEvidence(row.outcome_result) === row.outcome_result_hash
    && hashAppealEvidence(row.outcome_original_result) === row.outcome_original_result_hash
    && decision?.schemaVersion === 1 && decision.deterministic === true && decision.aiRole === "none"
    && decision.correctionId === row.outcome_correction_id && decision.impactId === row.outcome_impact_id
    && decision.revision === row.effective_revision
    && decision.correctedResultHash === row.effective_result_hash
    && decision.priorResultHash === row.outcome_original_result_hash
    && hashAppealEvidence(decision) === row.outcome_decision_evidence_hash;
}

export function validIndependentMasteryTrophy(row: MasteryTrophyRow, userId: string): boolean {
  const independentEvidence = row.rule_version === EXAM_MASTERY_RULE_VERSION
    && row.event === "exam_mastery"
    && Boolean(row.course_id)
    && Boolean(row.module_id)
    && row.minimum_score_percent === "95"
    && row.critical_requirements_required === "true"
    && Boolean(row.attempt_id)
    && row.evidence_id === `exam-attempt:${row.attempt_id}`
    && row.attempt_user_id === userId
    && row.assistance_level === "A0"
    && row.solution_revealed === false;
  if (!independentEvidence) return false;

  if (row.effective_attempt_id != null || row.effective_result != null) {
    // A present but invalid/negative correction must never revive the raw pass.
    if (!finalTrophyResult(row.effective_result) || !boundCorrection(row, userId)) return false;
    if (supportsMastery(row.effective_result)) return true;
    // Revoked history requires the prior official result to prove the award.
    return row.revoked_at !== null
      && finalTrophyResult(row.outcome_original_result)
      && supportsMastery(row.outcome_original_result);
  }
  return row.attempt_status === "graded"
    && row.mastery_awarded === true
    && typeof row.attempt_score === "number" && Number.isFinite(row.attempt_score)
    && Math.round(row.attempt_score * 10_000) / 10_000 >= 0.95;
}

function masteryTrophy(row: MasteryTrophyRow): Trophy {
  return {
    id: `mastery:${row.id}`,
    kind: "module_mastery",
    title: row.title,
    description: row.description,
    icon: row.icon,
    earnedAt: row.awarded_at.toISOString(),
    status: row.revoked_at ? "revoked" : "earned",
    visibility: row.selected && row.portfolio_published ? "portfolio" : "private",
    evidenceLabel: "Independent closed-book mastery exam",
    verificationPath: null,
  };
}

export function assembleTrophyCabinet(input: {
  userId: string;
  certificateRows: CertificateTrophyRow[];
  masteryRows: MasteryTrophyRow[];
}) {
  const trophies = [
    ...input.certificateRows.map(certificateTrophy),
    ...input.masteryRows
      .filter((row) => validIndependentMasteryTrophy(row, input.userId))
      .map(masteryTrophy),
  ].sort((left, right) => right.earnedAt.localeCompare(left.earnedAt) || left.id.localeCompare(right.id));
  return {
    policyVersion: TROPHY_PRESENTATION_POLICY,
    rewards: {
      xpSource: "authoritative_reward_ledger" as const,
      coinsEnabled: false as const,
      coins: 0 as const,
      notice: "Projects and trophy views never mint XP, coins, badges, mastery, or certificates.",
    },
    summary: {
      earned: trophies.filter((item) => item.status === "earned").length,
      revoked: trophies.filter((item) => item.status === "revoked").length,
      shared: trophies.filter((item) => item.status === "earned" && item.visibility === "portfolio").length,
    },
    trophies,
  };
}

export async function listOwnTrophyCabinet(userId: string) {
  const [certificates, mastery] = await Promise.all([
    pool.query<CertificateTrophyRow>(
      `select certificate.id,certificate.course_title,certificate.course_version_label,
              certificate.issued_at,certificate.verification_id,revocation.revoked_at,
              (selection.certificate_id is not null) selected,
              coalesce(portfolio.is_published,false) portfolio_published,portfolio.slug portfolio_slug
         from course_certificate certificate
         left join certificate_revocation revocation on revocation.certificate_id=certificate.id
         left join public_portfolio portfolio on portfolio.user_id=certificate.user_id
         left join public_portfolio_certificate selection
           on selection.user_id=certificate.user_id and selection.certificate_id=certificate.id
        where certificate.user_id=$1
        order by certificate.issued_at desc,certificate.id`,
      [userId],
    ),
    pool.query<MasteryTrophyRow>(
      `select owned.id,badge.title,badge.description,badge.icon,owned.awarded_at,owned.revoked_at,
              owned.visibility,owned.evidence_id,badge.rule_version,
              badge.rule->>'event' event,badge.rule->>'courseId' course_id,badge.rule->>'moduleId' module_id,
              badge.rule->>'minimumScorePercent' minimum_score_percent,
              badge.rule->>'criticalRequirementsRequired' critical_requirements_required,
              evidence_attempt.id attempt_id,evidence_attempt.score attempt_score,evidence_attempt.status attempt_status,
              evidence_attempt.mastery_awarded,evidence_attempt.assistance_level,
              evidence_attempt.solution_revealed,evidence_attempt.user_id attempt_user_id,
              effective.attempt_id effective_attempt_id,effective.user_id effective_user_id,
              effective.outcome_id effective_outcome_id,effective.revision effective_revision,
              effective.result effective_result,effective.result_hash effective_result_hash,
              corrected.id outcome_id,corrected.attempt_id outcome_attempt_id,corrected.user_id outcome_user_id,
              corrected.revision outcome_revision,corrected.correction_id outcome_correction_id,corrected.impact_id outcome_impact_id,
              impact.snapshot->'form'->>'courseId' outcome_course_id,impact.snapshot->'form'->>'moduleId' outcome_module_id,
              corrected.corrected_result outcome_result,corrected.corrected_result_hash outcome_result_hash,
              corrected.original_result outcome_original_result,corrected.original_result_hash outcome_original_result_hash,
              corrected.decision_evidence outcome_decision_evidence,corrected.decision_evidence_hash outcome_decision_evidence_hash,
              (selection.user_achievement_id is not null) selected,
              coalesce(portfolio.is_published,false) portfolio_published,portfolio.slug portfolio_slug
         from user_achievement owned
         join achievement badge on badge.id=owned.achievement_id
         left join attempt evidence_attempt
           on owned.evidence_id='exam-attempt:' || evidence_attempt.id::text
          and evidence_attempt.user_id=owned.user_id
         left join assessment_attempt_effective_result effective
           on effective.attempt_id=evidence_attempt.id
         left join assessment_regrade_outcome corrected on corrected.id=effective.outcome_id
         left join assessment_correction_impact impact
           on impact.id=corrected.impact_id and impact.correction_id=corrected.correction_id
          and impact.attempt_id=evidence_attempt.id and impact.user_id=owned.user_id
         left join public_portfolio portfolio on portfolio.user_id=owned.user_id
         left join public_portfolio_achievement selection
           on selection.user_id=owned.user_id and selection.user_achievement_id=owned.id
        where owned.user_id=$1 and badge.rule_version=$2
        order by owned.awarded_at desc,owned.id`,
      [userId, EXAM_MASTERY_RULE_VERSION],
    ),
  ]);
  return assembleTrophyCabinet({
    userId,
    certificateRows: certificates.rows,
    masteryRows: mastery.rows,
  });
}
