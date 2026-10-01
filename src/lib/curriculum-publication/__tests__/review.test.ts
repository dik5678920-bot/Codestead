import { describe, expect, it } from "vitest";

import { REVIEW_DIMENSIONS } from "../contracts";
import {
  artifactHumanReviewIssue,
  hasApprovedArtifactStage,
  hasHashBoundHumanApproval,
  type LatestArtifactReview,
} from "../review";

const contentHash = "a".repeat(64);
const bank = {
  review_status: "approved", content_hash: contentHash,
  artifact_type: "assessment_bank", artifact_key: "bank.review-test",
  content: { items: [{ id: "item-one" }, { id: "item-two" }] },
};

function approval(overrides: Partial<LatestArtifactReview> = {}): LatestArtifactReview {
  return {
    reviewer_kind: "human", decision: "approved", content_hash: contentHash,
    checklist: Object.fromEntries(REVIEW_DIMENSIONS.map((dimension) => [dimension, {
      passed: true, evidenceRef: `review-test:${dimension}:evidence`,
      note: `Independent ${dimension} review passed for this fixture.`,
    }])),
    reviewed_item_ids: ["item-one", "item-two"],
    ...overrides,
  };
}

describe("hash-bound artifact approval", () => {
  it("accepts a current human approval for the exact hash", () => {
    expect(hasHashBoundHumanApproval(bank, approval())).toBe(true);
  });

  it.each([
    ["unreviewed artifact", { ...bank, review_status: "unreviewed" }, approval()],
    ["missing artifact hash", { ...bank, content_hash: null }, approval()],
    ["missing review", bank, null],
    ["undefined review", bank, undefined],
    ["rejected review", bank, approval({ decision: "rejected" })],
    ["non-human review", bank, approval({ reviewer_kind: "ai" })],
    ["different hash", bank, approval({ content_hash: "b".repeat(64) })],
  ])("rejects %s", (_label, artifact, review) => {
    expect(hasHashBoundHumanApproval(artifact, review)).toBe(false);
  });

  it.each(["approved", "published"])("recognizes authored %s stage without bypassing human review", (publication_stage) => {
    const artifact = { ...bank, publication_stage, review_status: "unreviewed" };
    expect(hasApprovedArtifactStage(artifact, null)).toBe(true);
    expect(artifactHumanReviewIssue(artifact, null)).toMatchObject({ code: "HUMAN_REVIEW_MISSING" });
  });

  it("accepts an immutable draft stage with current hash-bound approval", () => {
    const artifact = { ...bank, publication_stage: "draft" };
    expect(hasApprovedArtifactStage(artifact, approval())).toBe(true);
    expect(artifactHumanReviewIssue(artifact, approval())).toBeNull();
    expect(artifact.publication_stage).toBe("draft");
  });

  it.each([
    ["no review", null],
    ["different hash", approval({ content_hash: "b".repeat(64) })],
    ["revoked review", approval({ decision: "rejected" })],
  ])("rejects a draft stage with %s", (_label, review) => {
    expect(hasApprovedArtifactStage({ ...bank, publication_stage: "draft" }, review)).toBe(false);
  });
});

describe("complete supported human review", () => {
  it("accepts complete bank review regardless of order and repeated reviewed IDs", () => {
    const review = approval({ reviewed_item_ids: ["item-two", "item-one", "item-one"] });
    const before = structuredClone({ bank, review });
    expect(artifactHumanReviewIssue(bank, review)).toBeNull();
    expect({ bank, review }).toEqual(before);
  });

  it.each([
    ["unreviewed artifact", { ...bank, review_status: "unreviewed" }, approval()],
    ["missing review", bank, null],
    ["undefined review", bank, undefined],
    ["rejected review", bank, approval({ decision: "rejected" })],
    ["changes requested", bank, approval({ decision: "changes_requested" })],
    ["non-human review", bank, approval({ reviewer_kind: "ai" })],
  ])("reports HUMAN_REVIEW_MISSING for %s", (_label, artifact, review) => {
    expect(artifactHumanReviewIssue(artifact, review)).toMatchObject({
      code: "HUMAN_REVIEW_MISSING", message: expect.stringContaining("human approval"),
    });
  });

  it.each([
    ["different review hash", bank, approval({ content_hash: "b".repeat(64) })],
    ["missing artifact hash", { ...bank, content_hash: null }, approval()],
  ])("reports REVIEW_HASH_MISMATCH for %s", (_label, artifact, review) => {
    expect(artifactHumanReviewIssue(artifact, review)).toMatchObject({
      code: "REVIEW_HASH_MISMATCH", message: expect.stringContaining("immutable artifact hash"),
    });
  });

  it("reports REVIEW_CHECKLIST_INCOMPLETE for a generic attestation", () => {
    expect(artifactHumanReviewIssue(bank, approval({ checklist: { independentlyReviewed: true } })))
      .toMatchObject({ code: "REVIEW_CHECKLIST_INCOMPLETE", message: expect.stringContaining("seven review dimensions") });
  });

  it.each(REVIEW_DIMENSIONS)("requires passing %s evidence even when the checklist has a valid schema", (dimension) => {
    const checklist = approval().checklist as Record<string, { passed: boolean }>;
    checklist[dimension]!.passed = false;
    expect(artifactHumanReviewIssue(bank, approval({ checklist })))
      .toMatchObject({ code: "REVIEW_CHECKLIST_INCOMPLETE" });
  });

  it.each([
    ["missing reviewed item", ["item-one"]],
    ["extra unrelated item", ["item-one", "item-two", "foreign-item"]],
  ])("reports ITEM_REVIEW_INCOMPLETE for %s", (_label, reviewed_item_ids) => {
    expect(artifactHumanReviewIssue(bank, approval({ reviewed_item_ids }))).toMatchObject({
      code: "ITEM_REVIEW_INCOMPLETE", message: expect.stringContaining("Every item"),
    });
  });

  it("requires a manifest approval to cover the artifact key rather than bank item IDs", () => {
    const manifest = { ...bank, artifact_type: "course_manifest", artifact_key: "course.review-test", content: {} };
    expect(artifactHumanReviewIssue(manifest, approval())).toMatchObject({ code: "ITEM_REVIEW_INCOMPLETE" });
    expect(artifactHumanReviewIssue(manifest, approval({ reviewed_item_ids: [manifest.artifact_key] }))).toBeNull();
  });

  it("rejects claimed item coverage when the immutable bank has no item list", () => {
    expect(artifactHumanReviewIssue({ ...bank, content: null }, approval()))
      .toMatchObject({ code: "ITEM_REVIEW_INCOMPLETE" });
    expect(artifactHumanReviewIssue({ ...bank, content: {} }, approval()))
      .toMatchObject({ code: "ITEM_REVIEW_INCOMPLETE" });
  });

  it("does not count invalid item identifiers as reviewed bank coverage", () => {
    const artifact = { ...bank, content: { items: [{ id: "item-one" }, { id: 7 }, {}] } };
    expect(artifactHumanReviewIssue(artifact, approval())).toMatchObject({ code: "ITEM_REVIEW_INCOMPLETE" });
  });
});
