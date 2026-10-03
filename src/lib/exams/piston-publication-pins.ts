// Shipped under src/ for standalone app and worker images. The sync test checks
// this projection against the reviewed infra handoff and publication manifest.
import runtimePins from "./piston-runtime-pins.json";
import type { RunnerLanguage } from "@/lib/runner/client";
import { PISTON_RUNTIMES } from "@/lib/runner/piston-client";
import { pinnedPistonImageDigest } from "@/lib/runner/exam-client";

import type { ExamFormSnapshot, ExamItem } from "./contracts";

const { handoff, publicationPins } = runtimePins;

export const PISTON_EXAM_PIN_REVISION = "piston-pr4b-v1";
export const PISTON_EXAM_IMAGE_DIGEST = handoff.imageReference.split("@")[1]!;

export function publishedExamPinRevision(): typeof PISTON_EXAM_PIN_REVISION | undefined {
  const provider = process.env.CODE_RUNNER_PROVIDER || "legacy";
  if (provider === "legacy") return undefined;
  if (provider !== "piston") throw new Error("Unknown code runner provider.");
  validateHandoff();
  if (!process.env.PISTON_URL || !process.env.PISTON_IMAGE
    || pinnedPistonImageDigest(process.env.PISTON_IMAGE) !== PISTON_EXAM_IMAGE_DIGEST) {
    throw new Error("Piston exam publication requires the reviewed image manifest and configured endpoint.");
  }
  return PISTON_EXAM_PIN_REVISION;
}

function validateHandoff() {
  if (publicationPins.schemaVersion !== 1 || publicationPins.revision !== PISTON_EXAM_PIN_REVISION
    || publicationPins.imageReference !== handoff.imageReference
    || handoff.schemaVersion !== 1 || !handoff.validation.passed || handoff.validation.liveTests !== 20
    || !/^sha256:[a-f0-9]{64}$/.test(PISTON_EXAM_IMAGE_DIGEST)) {
    throw new Error("Unverified Piston publication runtime handoff.");
  }
  for (const language of Object.keys(PISTON_RUNTIMES) as RunnerLanguage[]) {
    const recorded = handoff.runtimeLabels[language];
    const expected = PISTON_RUNTIMES[language];
    if (recorded.language !== expected.language || recorded.version !== expected.version || recorded.label !== expected.label) {
      throw new Error("Piston publication runtime labels differ from the reviewed handoff.");
    }
  }
}

function legacyPin(language: RunnerLanguage, runtime: NonNullable<ExamItem["runtime"]>) {
  const record = publicationPins.legacyPins[language];
  return record.imageDigest === runtime.imageDigest && record.versions.includes(runtime.version);
}

function pistonPin(language: RunnerLanguage, runtime: NonNullable<ExamItem["runtime"]>) {
  return runtime.version === handoff.runtimeLabels[language].label && runtime.imageDigest === PISTON_EXAM_IMAGE_DIGEST;
}

/** Apply the reviewed, runtime-only publication revision BEFORE storing a new form.
 * Only independently reviewed DB publications opt into this at admission.
 * Never run this on a stored attempt, or mutate the source bank or its oracles.
 */
export function pinPublishedExamItemsToPiston(items: readonly ExamItem[]): readonly ExamItem[] {
  validateHandoff();
  return items.map((item) => {
    if (item.kind !== "code") return item;
    if (!item.runtime || !item.language || !(item.language in PISTON_RUNTIMES)
      || item.gradingEvidence.kind !== "runner-tests") throw new Error("Published code item has no reviewed runner pins.");
    const language = item.language as RunnerLanguage;
    if (!legacyPin(language, item.runtime) && !pistonPin(language, item.runtime)) {
      throw new Error("Published code item is outside the reviewed runtime pin migration.");
    }
    return { ...item, runtime: { version: handoff.runtimeLabels[language].label, imageDigest: PISTON_EXAM_IMAGE_DIGEST } };
  });
}

/** Retakes/rechecks retain the source lineage's exact pins before the existing
 * full equivalent-form validator runs. Only the reviewed pin pairs may cross
 * the rollout boundary; arbitrary runtime changes still fail parity.
 */
export function retainEquivalentExamRuntimePins(source: ExamFormSnapshot, candidate: ExamFormSnapshot): ExamFormSnapshot {
  validateHandoff();
  return { ...candidate, items: candidate.items.map((item) => {
    const prior = source.items.find((entry) => entry.skillId === item.skillId && entry.clusterId === item.clusterId);
    if (item.kind !== "code" || prior?.kind !== "code" || !item.runtime || !prior.runtime
      || !item.language || item.language !== prior.language || !(item.language in PISTON_RUNTIMES)) return item;
    const language = item.language as RunnerLanguage;
    if ((legacyPin(language, prior.runtime) && pistonPin(language, item.runtime))
      || (pistonPin(language, prior.runtime) && legacyPin(language, item.runtime))) {
      return { ...item, runtime: { ...prior.runtime } };
    }
    return item;
  }) };
}
