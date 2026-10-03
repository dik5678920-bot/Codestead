import { configuredRunnerClient, runtimeByLanguage, type RunnerLanguage } from "./client";
import { PistonRunnerClient, PISTON_RUNTIMES } from "./piston-client";

export function pinnedPistonImageDigest(image: string): string {
  const match = /^(?:[^@\s]+@)?(sha256:[a-f0-9]{64})$/.exec(image);
  if (!match) throw new Error("Piston exams require a pinned image manifest digest.");
  return match[1]!;
}

/** Provider selection is part of the immutable exam pin, not the current rollout flag.
 * The caller must still verify the response's exact version AND image digest.
 * There is no retry or fallback to the other provider.
 */
export function configuredExamRunnerClient(input: {
  readonly language: RunnerLanguage;
  readonly expectedRuntimeVersion?: string;
}) {
  const version = input.expectedRuntimeVersion ?? runtimeByLanguage[input.language].version;
  if (version === PISTON_RUNTIMES[input.language].label) {
    const url = process.env.PISTON_URL;
    const image = process.env.PISTON_IMAGE;
    if (!url || !image) throw new Error("Pinned Piston exam runner is not configured.");
    // Deployment config may use registry/name@sha256, while immutable exam
    // snapshots bind the OCI manifest digest. Preserve exact digest comparison.
    return new PistonRunnerClient(url, pinnedPistonImageDigest(image));
  }
  if (version.includes("(Piston)")) throw new Error("Unrecognized pinned Piston exam runtime.");
  return configuredRunnerClient();
}
