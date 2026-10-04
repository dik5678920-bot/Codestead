export type SupportedProvider =
  | "nvidia_nim"
  | "openrouter"
  | "google"
  | "openai"
  | "anthropic"
  | "deepseek"
  | "custom_openai_compatible";

export interface TutorMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ProviderRequest {
  provider: SupportedProvider;
  apiKey: string;
  model: string;
  messages: TutorMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export interface ProviderResult {
  provider: SupportedProvider;
  model: string;
  content: string;
  finishReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  requestId: string | null;
}

const providerErrorCodes = [
  "AUTHENTICATION", "RATE_LIMIT", "TIMEOUT", "UNAVAILABLE",
  "BAD_RESPONSE", "MODEL_NOT_FOUND", "BAD_REQUEST", "POLICY", "UNKNOWN",
] as const;

export type ProviderErrorCode = typeof providerErrorCodes[number];

// Next server chunks can contain distinct copies of the error constructor.
// Classify only the stable marker and allowlisted code, never class identity.
export function isProviderError(error: unknown): error is Pick<ProviderError, "name" | "code" | "status" | "retryAfterSeconds"> {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as Record<string, unknown>;
  return candidate.name === "ProviderError" &&
    providerErrorCodes.some((code) => code === candidate.code) &&
    (candidate.status === undefined || (typeof candidate.status === "number" && Number.isFinite(candidate.status))) &&
    (candidate.retryAfterSeconds === undefined || (typeof candidate.retryAfterSeconds === "number" && Number.isFinite(candidate.retryAfterSeconds)));
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly code: ProviderErrorCode,
    public readonly status?: number,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
