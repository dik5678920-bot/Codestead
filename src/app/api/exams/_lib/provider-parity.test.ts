import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ admit: vi.fn(), begin: vi.fn(), settle: vi.fn(), record: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ db: {}, pool: {} }));
vi.mock("@/lib/runner/admission", async (original) => ({
  ...await original<typeof import("@/lib/runner/admission")>(),
  admitRunnerJob: mocks.admit, beginRunnerDispatch: mocks.begin,
  settleRunnerJob: mocks.settle, recordRunnerDispatch: mocks.record,
}));

import { executeExamCode } from "./service";
import type { RunnerRequest } from "@/lib/runner/client";
import { IMAGE, languages, outcomes, score, tests, transport, verdict, version } from "../../../../../scripts/lib/provider-parity-fixtures";

const admission = { submissionId: "submission", runnerJobId: "job", userId: "learner",
  requestId: "request", requestHash: "a".repeat(64), submissionType: "exam_final_test", status: "queued",
  remoteJobId: null, result: null, runtimeImageDigest: "pending", queuedAt: new Date(), duplicate: false };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.admit.mockResolvedValue(admission);
  mocks.begin.mockResolvedValue({ replayed: false, remoteJobId: null });
  mocks.settle.mockResolvedValue({ replayed: false });
  mocks.record.mockResolvedValue({ replayed: false });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function input(provider: string, language: typeof languages[number]) {
  return { userId: "learner", attemptId: "attempt", sessionId: "session", itemId: "item", language,
    sourceCode: "source", mode: "TEST" as const,
    tests: tests.map((test) => ({ id: test.id, visibility: test.visibility, category: test.category,
      stdin: test.stdin, expectedStdout: test.expectedStdout, comparison: test.comparison })), testBundleVersion: "v1",
    expectedRuntimeVersion: version(provider, language), expectedRuntimeImageDigest: IMAGE,
    idempotencySeed: "same-finalization-generation", submissionType: "exam_final_test" };
}

describe("official exam provider parity", () => {
  for (const language of languages) {
    it.each(outcomes)(`${language} %s retains verdict, score and critical gates`, async (outcome) => {
      transport("legacy", outcome);
      const legacy = await executeExamCode(input("legacy", language));
      const fetch = transport("piston", outcome);
      const piston = await executeExamCode(input("piston", language));
      expect(verdict(piston)).toEqual(verdict(legacy));
      expect(score(piston, language)).toEqual(score(legacy, language));
      expect(score(piston, language).officialScorePercent).toBe(outcome === "accepted" ? 100 : outcome === "wrong_answer" ? 50 : 0);
      expect(piston.tests).toHaveLength(2);
      expect(piston.tests[1]).not.toHaveProperty("expectedStdout");
      expect(fetch.mock.calls.every(([url]) => String(url).startsWith("http://piston:"))).toBe(true);
      expect(mocks.admit).toHaveBeenLastCalledWith(expect.objectContaining({ submissionType: "exam_final_test" }));
    });
  }

  it("keeps legacy-pinned attempts on legacy after the global Piston switch", async () => {
    const fetch = transport("piston", "accepted");
    const result = await executeExamCode(input("legacy", "c"));
    expect(result.runtimeVersion).toBe(version("legacy", "c"));
    expect(fetch.mock.calls.every(([url]) => String(url).startsWith("http://legacy:"))).toBe(true);
  });

  it.each(["legacy", "piston"])("%s cannot grade a missing runtime pin", async (provider) => {
    const fetch = transport(provider, "accepted");
    await expect(executeExamCode({ ...input(provider, "c"), expectedRuntimeImageDigest: undefined }))
      .rejects.toMatchObject({ code: "RUNNER_RUNTIME_PIN_MISSING" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["legacy", "piston"])("%s still rejects evidence for a different image digest", async (provider) => {
    transport(provider, "accepted");
    await expect(executeExamCode({ ...input(provider, "c"), expectedRuntimeImageDigest: `sha256:${"f".repeat(64)}` }))
      .rejects.toMatchObject({ code: "RUNNER_RUNTIME_MISMATCH" });
    expect(mocks.settle).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", runtimeImageDigest: "runner-runtime-mismatch" }));
  });

  it("never switches a pinned Piston attempt to legacy when rollout is reversed", async () => {
    const fetch = transport("legacy", "accepted");
    await executeExamCode(input("piston", "python"));
    expect(fetch.mock.calls.every(([url]) => String(url).startsWith("http://piston:"))).toBe(true);
  });

  it("recovers the existing legacy remote job after switching the rollout flag", async () => {
    const firstFetch = transport("legacy", "accepted");
    const original = await executeExamCode(input("legacy", "python"));
    const request = JSON.parse(String(firstFetch.mock.calls[0]![1]!.body)) as RunnerRequest;
    mocks.begin.mockResolvedValue({ replayed: false, remoteJobId: "legacy-job" });
    const recoveryFetch = transport("piston", "accepted", request);
    const recovered = await executeExamCode(input("legacy", "python"));
    expect(verdict(recovered)).toEqual(verdict(original));
    expect(recoveryFetch.mock.calls).toHaveLength(1);
    expect(String(recoveryFetch.mock.calls[0]![0])).toBe("http://legacy:4100/v1/jobs/legacy-job");
    expect(recoveryFetch.mock.calls[0]![1]!.method).toBe("GET");
  });

  it.each(["legacy", "piston"])("%s compile failure cannot bypass the exact manifest trust gate", async (provider) => {
    transport(provider, "compile_error");
    await expect(executeExamCode(input(provider, "c"))).rejects.toBeInstanceOf(Error);
    expect(mocks.settle.mock.calls.some(([value]) => value.status === "succeeded")).toBe(false);
  });

  it.each(["unknown", "piston"])("%s configuration failure never falls back", async (provider) => {
    const fetch = transport(provider, "accepted");
    vi.stubEnv(provider === "piston" ? "PISTON_URL" : "RUNNER_BASE_URL", "");
    await expect(executeExamCode(input(provider, "c"))).rejects.toMatchObject({ code: "RUNNER_UNAVAILABLE" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
