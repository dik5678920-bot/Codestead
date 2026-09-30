import { describe, expect, it } from "vitest";
import type { ExamSessionView } from "../contracts";
import { createExamEventOutboxRecord, isExamSessionView } from "../use-durable-exam-outbox";

const timestamp = "2026-10-01T12:00:00.000Z";
const sessionId = "10000000-0000-4000-8000-000000000001";
function view(): ExamSessionView {
  return {
    sessionId, attemptId: "attempt-1", attemptNumber: 1, status: "active",
    serverNow: timestamp, serverStartedAt: timestamp, serverDeadlineAt: timestamp,
    disconnectedSeconds: 0, integrityReviewState: "clear",
    form: {
      schemaVersion: 1, purpose: "formal-exam", formId: "form-1", courseId: "python", courseTitle: "Python",
      moduleId: "loops", moduleTitle: "Loops", contentVersion: "1.0.0", policyVersion: "policy-1", durationMinutes: 10,
      generatedAt: timestamp, instructions: ["Read carefully"],
      integrityDisclosure: { version: "1", summary: "Bounded events", capturedEvents: ["navigation"], notCaptured: ["camera"] },
      items: [
        { id: "written", skillId: "trace", clusterId: "loops", title: "Trace", prompt: "Explain", kind: "short-answer", points: 4, critical: false, verificationAvailable: true },
        { id: "code", skillId: "code", clusterId: "loops", title: "Code", prompt: "Print", kind: "code", points: 6, critical: true, verificationAvailable: true, language: "python", starterCode: "print(1)", runtime: { version: "3.12", imageDigest: "sha256:fixture" } },
      ],
    },
    answers: {
      written: { revision: 0, savedAt: timestamp, answer: { text: "The loop stops" } },
      code: { revision: 1, savedAt: timestamp, answer: { sourceCode: "print(1)", language: "python" } },
    },
    result: {
      schemaVersion: 1, gradingStatus: "graded", outcome: "MASTERED", officialScorePercent: 100, earnedPoints: 10,
      possiblePoints: 10, pendingReviewItemIds: [], failedCriticalClusters: [], masteryBlockingCodingItems: [],
      compilationGatePassed: true, infrastructureFailure: false, finalizedAt: timestamp, finalizedBy: "learner-submit",
      policyVersion: "policy-1", remediation: { required: false, targets: [] },
      masteryRecheck: { required: false, clusterIds: [], codingItemIds: [] },
    },
    retake: { eligible: false, reason: "already-mastered", nextEligibleAt: null, requiresRemediation: false },
    appealSubmitted: true, appeal: { id: "appeal-1", status: "decided", decision: "upheld", decisionReason: "Reviewed", updatedAt: timestamp },
  };
}
function replace(path: string, value: unknown) {
  const candidate = structuredClone(view()) as unknown as Record<string, unknown>;
  const keys = path.split(".");
  let parent = candidate;
  for (const key of keys.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
  parent[keys.at(-1)!] = value;
  return candidate;
}

describe("exam session response validation", () => {
  it("accepts the complete response without changing answers or result evidence", () => {
    const response = view(); const before = structuredClone(response);
    expect(isExamSessionView(response, sessionId)).toBe(true);
    expect(response).toEqual(before);
  });

  it.each([
    ["sessionId", "another-session"], ["attemptId", " "], ["attemptNumber", 0], ["attemptNumber", 1.5],
    ["status", "unknown"], ["status", 3], ["serverNow", "invalid"], ["serverStartedAt", ""], ["serverDeadlineAt", null],
    ["disconnectedSeconds", -1], ["integrityReviewState", ""], ["form", null], ["answers", []],
    ["form.schemaVersion", 2], ["form.purpose", "practice"], ["form.formId", ""], ["form.courseId", ""],
    ["form.courseTitle", ""], ["form.moduleId", ""], ["form.moduleTitle", ""], ["form.contentVersion", ""],
    ["form.policyVersion", ""], ["form.durationMinutes", 0], ["form.generatedAt", "invalid"],
    ["form.instructions", [7]], ["form.integrityDisclosure", null], ["form.integrityDisclosure.version", ""],
    ["form.integrityDisclosure.summary", ""], ["form.integrityDisclosure.capturedEvents", [null]],
    ["form.integrityDisclosure.notCaptured", "camera"], ["form.items", null], ["form.items", []],
    ["form.items.0", null], ["form.items.0.id", ""], ["form.items.0.skillId", ""], ["form.items.0.clusterId", ""],
    ["form.items.0.title", ""], ["form.items.0.prompt", ""], ["form.items.0.kind", "multiple-choice"],
    ["form.items.0.points", "4"], ["form.items.0.points", Number.NaN], ["form.items.0.points", -1],
    ["form.items.0.critical", "false"], ["form.items.0.verificationAvailable", null], ["form.items.0.starterCode", 1],
    ["form.items.1.runtime", []], ["form.items.1.runtime.version", ""], ["form.items.1.runtime.imageDigest", ""],
    ["form.items.1.language", null], ["form.items.1.language", "ruby"], ["form.items.0.language", "python"],
    ["form.items.1.id", "written"], ["answers.unknown", { revision: 0, savedAt: timestamp, answer: { text: "unknown" } }],
    ["answers.written", null], ["answers.written.answer", []], ["answers.written.revision", -1], ["answers.written.savedAt", "invalid"],
    ["answers.written.answer.text", null], ["answers.written.answer.sourceCode", "injected"], ["answers.written.answer.language", "python"],
    ["answers.code.answer.sourceCode", null], ["answers.code.answer.language", "java"], ["answers.code.answer.text", "injected"],
    ["result", []], ["result.remediation", null], ["result.schemaVersion", 2], ["result.gradingStatus", "ungraded"],
    ["result.outcome", "invented"], ["result.officialScorePercent", Number.POSITIVE_INFINITY], ["result.earnedPoints", "10"],
    ["result.possiblePoints", null], ["result.possiblePoints", Number.NaN], ["result.possiblePoints", -1],
    ["result.pendingReviewItemIds", [1]], ["result.failedCriticalClusters", null], ["result.masteryBlockingCodingItems", "code"],
    ["result.compilationGatePassed", "true"], ["result.infrastructureFailure", 0], ["result.finalizedAt", "invalid"],
    ["result.finalizedBy", "operator"], ["result.policyVersion", ""], ["result.remediation.required", null], ["result.remediation.targets", [1]],
    ["result.masteryRecheck", []], ["result.masteryRecheck.required", "false"], ["result.masteryRecheck.clusterIds", [1]], ["result.masteryRecheck.codingItemIds", null],
    ["retake", []], ["retake.eligible", null], ["retake.reason", "unknown"], ["retake.nextEligibleAt", "invalid"], ["retake.requiresRemediation", 0],
    ["appealSubmitted", "true"], ["appeal", []], ["appeal.id", ""], ["appeal.status", ""],
    ["appeal.decision", 1], ["appeal.decisionReason", false], ["appeal.updatedAt", "invalid"],
  ])("rejects malformed %s = %s", (path, value) => {
    expect(isExamSessionView(view(), sessionId)).toBe(true);
    expect(isExamSessionView(replace(path as string, value), sessionId)).toBe(false);
  });

  it.each([null, [], new Date(), "response", Object.create({ sessionId })])("rejects a non-plain session payload %s", (response) => {
    expect(isExamSessionView(response, sessionId)).toBe(false);
  });
  it.each([
    ["result", null], ["retake", null], ["appeal", null], ["form.purpose", undefined], ["form.purpose", "mastery-recheck"],
    ["result.masteryRecheck", undefined], ["result.gradingStatus", "pending-review"], ["result.officialScorePercent", null],
    ["result.earnedPoints", null], ["result.compilationGatePassed", null], ["result.finalizedBy", "deadline"],
    ["retake.nextEligibleAt", timestamp], ["appeal.decision", null], ["appeal.decisionReason", null],
  ])("accepts supported optional or legacy %s", (path, value) => {
    expect(isExamSessionView(replace(path as string, value), sessionId)).toBe(true);
  });
  it("does not accept an empty expected session identity", () => {
    expect(isExamSessionView(replace("sessionId", ""), "")).toBe(false);
  });
});

describe("exam event recovery records", () => {
  it("preserves supplied event identity, timestamp and a copied metadata object", () => {
    const metadata = { reason: "navigation" };
    const event = createExamEventOutboxRecord({ namespace: "browser-1", sessionId, eventType: "navigation_attempt", clientEventId: sessionId, occurredAt: timestamp, metadata });
    metadata.reason = "changed";
    expect(event).toMatchObject({ kind: "exam-event", scope: sessionId, clientEventId: sessionId, updatedAt: timestamp, payload: { occurredAt: timestamp, eventType: "navigation_attempt", metadata: { reason: "navigation" } } });
  });
  it("creates a fresh UUID and timestamp when omitted", () => {
    const event = createExamEventOutboxRecord({ namespace: "browser-1", sessionId, eventType: "navigation_attempt" });
    expect(event.clientEventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isFinite(Date.parse(event.updatedAt))).toBe(true);
    expect(event.payload.metadata).toEqual({});
  });
  it.each([{ occurredAt: "invalid" }, { clientEventId: "invalid" }, { namespace: "" }])("refuses an invalid recovery identity %s", (override) => {
    expect(() => createExamEventOutboxRecord({ namespace: "browser-1", sessionId, eventType: "navigation_attempt", ...override })).toThrow("Exam event recovery record is invalid.");
  });
});
