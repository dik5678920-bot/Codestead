import { allReviewDimensionsPassed, curriculumReviewChecklistSchema } from "./contracts";

interface ReviewArtifact {
  readonly review_status: string | null;
  readonly content_hash: string | null;
  readonly artifact_type: string | null;
  readonly artifact_key: string | null;
  readonly content: Record<string, unknown> | null;
}

export interface LatestArtifactReview {
  readonly reviewer_kind: string;
  readonly decision: string;
  readonly content_hash: string;
  readonly checklist: unknown;
  readonly reviewed_item_ids: readonly string[];
}

/** Callers must select the latest event, including rejections/revocations. */
export function hasHashBoundHumanApproval(
  artifact: Pick<ReviewArtifact, "review_status" | "content_hash">,
  review: LatestArtifactReview | null | undefined,
): boolean {
  return artifact.review_status === "approved"
    && artifact.content_hash !== null
    && review?.decision === "approved"
    && review.reviewer_kind === "human"
    && review.content_hash === artifact.content_hash;
}

export function hasApprovedArtifactStage(
  artifact: Pick<ReviewArtifact, "review_status" | "content_hash"> & { readonly publication_stage: string | null },
  review: LatestArtifactReview | null | undefined,
): boolean {
  return artifact.publication_stage === "approved"
    || artifact.publication_stage === "published"
    || hasHashBoundHumanApproval(artifact, review);
}

/** The gate and exam runtime require the same complete supported human review. */
export function artifactHumanReviewIssue(
  artifact: ReviewArtifact,
  review: LatestArtifactReview | null | undefined,
): { readonly code: string; readonly message: string } | null {
  if (artifact.review_status !== "approved" || review?.decision !== "approved" || review.reviewer_kind !== "human") {
    return { code: "HUMAN_REVIEW_MISSING", message: "The latest bound review must be an attributable human approval." };
  }
  if (!hasHashBoundHumanApproval(artifact, review)) {
    return { code: "REVIEW_HASH_MISMATCH", message: "The review is not bound to this immutable artifact hash." };
  }
  const checklist = curriculumReviewChecklistSchema.safeParse(review.checklist);
  if (!checklist.success || !allReviewDimensionsPassed(checklist.data)) {
    return { code: "REVIEW_CHECKLIST_INCOMPLETE", message: "All seven review dimensions require passing evidence." };
  }
  const expectedItems = artifact.artifact_type === "assessment_bank"
    ? ((artifact.content?.items as Array<{ id?: unknown }> | undefined) ?? []).map((item) => typeof item.id === "string" ? item.id : "").filter(Boolean)
    : [artifact.artifact_key];
  const actual = [...new Set(review.reviewed_item_ids)].sort();
  const expected = [...new Set(expectedItems)].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    return { code: "ITEM_REVIEW_INCOMPLETE", message: "Every item in the immutable artifact must be explicitly reviewed." };
  }
  return null;
}
