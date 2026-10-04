import { z } from "zod";
import { containsCredentialOrHiddenEvidence } from "@/lib/security/sensitive-text";

// Zod's JIT capability probe itself triggers a CSP violation, even when caught.
// Configure the browser runtime before constructing any object schemas.
if (typeof window !== "undefined") z.config({ jitless: true });

export const supportKinds = ["support-ai", "support-other"] as const;
export function isSupportKind(kind: string) { return supportKinds.some((value) => value === kind); }
export const supportProviderSchema = z.enum(["google", "openai", "anthropic", "openrouter", "deepseek", "nvidia_nim", "custom_openai_compatible"]);
// Codes are closed-world symbols, never provider response text.
export const supportErrorCodeSchema = z.enum([
  "AUTHENTICATION", "MODEL_NOT_FOUND", "BAD_REQUEST", "RATE_LIMIT", "TIMEOUT",
  "UNAVAILABLE", "BAD_RESPONSE", "POLICY", "VALIDATION_INCOMPLETE",
  "CREDENTIAL_VALIDATION_UNAVAILABLE", "AI_PROVIDER_UNAVAILABLE", "AI_UNAVAILABLE",
]);
export const supportContextSchema = z.object({
  provider: supportProviderSchema.optional(),
  errorCode: supportErrorCodeSchema.optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
}).strict();
const detailsSchema = z.object({
  message: z.string().trim().min(1).max(1000).refine((text) => !containsCredentialOrHiddenEvidence(text) && !/\b(?:api[_ -]?key|secret|authorization|bearer)\s*[:=]\s*\S+/i.test(text)),
  context: supportContextSchema.optional(),
}).strict();
export const supportRequestSchema = detailsSchema.extend({
  requestId: z.uuid(),
  kind: z.enum(supportKinds),
  provider: supportProviderSchema.optional(),
}).strict().superRefine((input, ctx) => {
  if (input.kind === "support-ai" && !input.provider) ctx.addIssue({ code: "custom", message: "Choose a provider", path: ["provider"] });
  if (input.context?.provider && input.context.provider !== input.provider) ctx.addIssue({ code: "custom", message: "Provider mismatch", path: ["context"] });
  if (input.kind === "support-other" && (input.provider || input.context)) ctx.addIssue({ code: "custom", message: "Other requests have no AI context", path: ["context"] });
});
export type SupportRequestInput = z.infer<typeof supportRequestSchema>;
export type SupportContext = z.infer<typeof supportContextSchema>;
export function encodeSupportDetails(input: SupportRequestInput) {
  return JSON.stringify({ message: input.message, ...(input.context ? { context: input.context } : {}) });
}
export function decodeSupportDetails(details: string): z.infer<typeof detailsSchema> | null {
  try { const parsed = detailsSchema.safeParse(JSON.parse(details)); return parsed.success ? parsed.data : null; }
  catch { return null; }
}
