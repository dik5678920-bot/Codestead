// @vitest-environment node
import { expect, it, vi } from "vitest";
vi.mock("@/lib/db/client", () => ({ db: {} }));
import { buildPlatformCandidates } from "../platform-credentials";
import type { PolicyRow } from "../admin-models-store";
import { sealCredential } from "@/lib/security/credential-vault";

const master = Buffer.alloc(32, 7);
const id = "10000000-0000-4000-8000-000000000001";
const connection = { id, provider: "openai", operation: "provider_configuration", enabled: true, configurationVersion: 2, baseUrl: "https://api.openai.com/v1", platformCredential: sealCredential("platform-secret", { userId: "platform-ai-models", credentialId: id, provider: "openai", keyVersion: 1 }, master) } as PolicyRow;
const policy = { ...connection, id: "policy-id", operation: "tutor", model: "admin-default", priority: 1, maxOutputTokens: 500, timeoutMs: 30000, platformCredential: null } as PolicyRow;

it("uses only the encrypted platform connection and matching admin default, scoped to this learner", () => {
  const [candidate] = buildPlatformCandidates({ learnerId: "learner", policies: [policy], connections: [connection], ownProviders: new Set(), allowedProviders: new Set(["openai"]), master });
  expect(candidate).toMatchObject({ source: "platform", ownerUserId: "learner", credentialId: id, model: "admin-default", apiKey: "platform-secret", baseUrl: connection.baseUrl });
});
it("excludes owned providers, missing consent, disabled models, and stale endpoint revisions", () => {
  const input = { learnerId: "learner", policies: [policy], connections: [connection], ownProviders: new Set<string>(), allowedProviders: new Set<string>(["openai"]), master };
  expect(buildPlatformCandidates({ ...input, ownProviders: new Set(["openai"]) })).toEqual([]);
  expect(buildPlatformCandidates({ ...input, allowedProviders: new Set() })).toEqual([]);
  expect(buildPlatformCandidates({ ...input, policies: [{ ...policy, enabled: false }] })).toEqual([]);
  expect(buildPlatformCandidates({ ...input, policies: [{ ...policy, configurationVersion: 1 }] })).toEqual([]);
  expect(buildPlatformCandidates({ ...input, policies: [{ ...policy, baseUrl: "https://other.example/v1" }] })).toEqual([]);
});
it("does not leak a malformed vault envelope or use an implicit fallback model", () => {
  expect(buildPlatformCandidates({ learnerId: "learner", policies: [], connections: [connection], ownProviders: new Set(), allowedProviders: new Set(["openai"]), master })).toEqual([]);
  expect(buildPlatformCandidates({ learnerId: "learner", policies: [policy], connections: [{ ...connection, platformCredential: { ...connection.platformCredential!, authTag: "bad" } }], ownProviders: new Set(), allowedProviders: new Set(["openai"]), master })).toEqual([]);
});
