import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { containsCredentialOrHiddenEvidence } from "@/lib/security/sensitive-text";
import type { SupportedProvider } from "./types";

export const modelProviders = ["google", "nvidia_nim", "openrouter", "deepseek", "openai", "anthropic", "custom_openai_compatible"] as const;
export const modelIdSchema = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+\-]*$/)
  .refine((value) => !containsCredentialOrHiddenEvidence(value), "Use a model identifier, never a credential.");
const common = { provider: z.enum(modelProviders), version: z.number().int().min(0) };
export const modelCommandSchema = z.discriminatedUnion("action", [
  z.object({ ...common, action: z.literal("configure"), baseUrl: z.string().trim().min(1).max(2048), platformKey: z.string().trim().min(8).max(4096).optional(), removeKey: z.boolean().optional() }).strict().refine((value) => !(value.platformKey && value.removeKey)),
  z.object({ ...common, action: z.literal("load") }).strict(),
  z.object({ ...common, action: z.literal("test"), model: modelIdSchema, message: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ ...common, action: z.literal("save"), model: modelIdSchema, priority: z.number().int().min(1).max(100), verification: z.enum(["verified", "untested"]), proof: z.string().max(4096).optional(), reportedModel: modelIdSchema.optional() }).strict(),
]);
export type ModelCommand = z.infer<typeof modelCommandSchema>;
export type ProofBinding = { actorId: string; sessionId: string; provider: SupportedProvider; model: string; baseUrl: string; version: number; reportedModel?: string };
function proofData(binding: ProofBinding, expires: number) {
  return JSON.stringify([binding.actorId, binding.sessionId, binding.provider, binding.model, binding.baseUrl, binding.version, binding.reportedModel ?? binding.model, expires]);
}
export function createModelProof(binding: ProofBinding, key: Buffer) {
  const expires = Date.now() + 10 * 60_000;
  const signature = createHmac("sha256", key).update("admin-model-proof-v1\0").update(proofData(binding, expires)).digest("hex");
  return `${expires}.${signature}`;
}
export function verifyModelProof(proof: string | undefined, binding: ProofBinding, key: Buffer) {
  const parsed = /^(\d{13})\.([a-f0-9]{64})$/.exec(proof ?? "");
  if (!parsed) return false;
  const expires = Number(parsed[1]);
  if (expires <= Date.now() || expires > Date.now() + 10 * 60_000) return false;
  const signature = createHmac("sha256", key).update("admin-model-proof-v1\0").update(proofData(binding, expires)).digest();
  return timingSafeEqual(signature, Buffer.from(parsed[2], "hex"));
}
export function modelListUrl(provider: SupportedProvider, baseUrl: string) {
  return provider === "google"
    ? `${baseUrl.replace(/\/openai\/?$/, "")}/models?pageSize=1000`
    : `${baseUrl}/models${provider === "anthropic" ? "?limit=1000" : ""}`;
}
export function nextModelListUrl(provider: SupportedProvider, initialUrl: string, payload: unknown) {
  const url = new URL(initialUrl);
  if (provider === "google") {
    const page = z.object({ nextPageToken: z.string().max(2048).optional() }).parse(payload);
    if (!page.nextPageToken) return null;
    url.searchParams.set("pageToken", page.nextPageToken);
  } else if (provider === "anthropic") {
    const page = z.object({ has_more: z.boolean().optional(), last_id: modelIdSchema.nullable().optional() }).parse(payload);
    if (!page.has_more) return null;
    if (!page.last_id) throw new Error("Invalid provider pagination.");
    url.searchParams.set("after_id", page.last_id);
  } else return null;
  return url.href;
}
const entrySchema = z.object({ id: modelIdSchema, name: z.string().max(300).optional(), display_name: z.string().max(300).optional() });
export function parseModelList(provider: SupportedProvider, payload: unknown) {
  const native = z.object({ models: z.array(z.object({ name: z.string(), displayName: z.string().max(300).optional(), supportedGenerationMethods: z.array(z.string()).optional() })).max(10_000) });
  const compatible = z.object({ data: z.array(entrySchema).max(10_000) });
  const entries = provider === "google"
    ? native.parse(payload).models.filter((model) => model.supportedGenerationMethods?.includes("generateContent"))
      .map((model) => ({ id: modelIdSchema.parse(model.name.replace(/^models\//, "")), name: model.displayName }))
    : compatible.parse(payload).data.map((entry) => ({ id: entry.id, name: provider === "anthropic" ? entry.display_name ?? entry.name : entry.name }));
  return [...new Map(entries.map((entry) => [entry.id, { id: entry.id, name: entry.name ?? entry.id, free: provider === "openrouter" && entry.id.endsWith(":free") }])).values()];
}
