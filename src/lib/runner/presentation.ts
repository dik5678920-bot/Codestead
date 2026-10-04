import { PRACTICE_LIMITS } from "./practice-dispatch";
import { configuredCodeRunnerProvider, PISTON_LIMITS } from "./provider-config";

/** Called only by server pages; serialize the public label into CodeLab. */
export function configuredRunnerPresentation() {
  const piston = configuredCodeRunnerProvider() === "piston";
  return {
    description: piston ? "isolated Piston runner" : "two-slot NUC runner",
    runnerLabel: piston ? "isolated Piston runner" : "isolated NUC runner",
    concurrentJobs: piston ? PISTON_LIMITS.concurrentJobs : 2,
    runSeconds: (piston
      ? Math.min(PRACTICE_LIMITS.wallTimeMs, PISTON_LIMITS.runTimeoutMs)
      : PRACTICE_LIMITS.wallTimeMs) / 1_000,
    detail: piston
      ? `${PISTON_LIMITS.compileTimeoutMs / 1_000} sec compile limit · ${PRACTICE_LIMITS.memoryMb} MiB practice memory`
      : undefined,
  };
}
