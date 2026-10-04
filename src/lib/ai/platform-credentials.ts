import { openCredential } from "@/lib/security/credential-vault";
import type { PolicyRow } from "./admin-models-store";
import type { ProviderCandidate } from "./router";

export function buildPlatformCandidates(input: {
  learnerId: string; policies: PolicyRow[]; connections: PolicyRow[];
  ownProviders: ReadonlySet<string>; allowedProviders: ReadonlySet<string>; master: Buffer;
}): ProviderCandidate[] {
  const candidates: ProviderCandidate[] = [];
  const selected = new Set<string>();
  for (const policy of input.policies) {
    if (!policy.enabled || policy.operation !== "tutor" || selected.has(policy.provider)) continue;
    selected.add(policy.provider);
    if (input.ownProviders.has(policy.provider) || !input.allowedProviders.has(policy.provider)) continue;
    const connection = input.connections.find((row) => row.provider === policy.provider && row.operation === "provider_configuration" && row.enabled);
    const envelope = connection?.platformCredential;
    if (!connection || !envelope || !connection.baseUrl || connection.baseUrl !== policy.baseUrl || connection.configurationVersion !== policy.configurationVersion) continue;
    let apiKey: string;
    try {
      apiKey = openCredential(envelope, { userId: "platform-ai-models", credentialId: connection.id, provider: policy.provider, keyVersion: envelope.keyVersion }, input.master);
    } catch { continue; }
    candidates.push({ ownerUserId: input.learnerId, credentialId: connection.id, provider: policy.provider,
      apiKey, model: policy.model, baseUrl: connection.baseUrl, source: "platform",
      maxOutputTokens: policy.maxOutputTokens, timeoutMs: policy.timeoutMs,
      ...(policy.verificationStatus === "verified" && policy.verifiedReportedModel ? { verifiedReportedModel: policy.verifiedReportedModel } : {}),
    });
  }
  return candidates;
}
