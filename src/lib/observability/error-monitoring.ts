/**
 * Error monitoring (GlitchTip, Sentry-compatible) policy shared by the Next
 * server/edge/browser runtimes and the background workers.
 *
 * Everything here is OFF unless a DSN is configured, and every event passes
 * through `scrubEvent` before it leaves the process: no request bodies,
 * cookies, headers, query strings, user identity, breadcrumbs or source
 * context; free text (messages, exception values, frame variables) is
 * redacted for emails, bearer/API keys, long secrets and 6-8 digit codes;
 * tags are reduced to an allow-list. Learner code and credentials are
 * therefore never sent, only error types and stack locations.
 */

export type ErrorMonitoringRuntime = "nodejs" | "edge" | "browser" | "worker";

// Deliberately structural: the scrubber must work on any SDK event shape and
// must not trust fields it does not know.
export type MonitoredEvent = Record<string, unknown>;

const ALLOWED_TAGS = new Set(["runtime", "worker", "code", "route", "level"]);
const MAX_TEXT_LENGTH = 1_000;
const REDACTED = "[redacted]";

const TEXT_REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  // Email addresses.
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]"],
  // Authorization values and key=value / key: value secrets.
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]"],
  [/\b(api[_-]?key|token|secret|password|passwd|authorization|cookie|session|dsn|code|otp|totp)(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi, "$1$2[redacted]"],
  // URLs keep only scheme, host and path (query strings and fragments go).
  [/(https?:\/\/[^\s?#"']+)[?#][^\s"']*/gi, "$1"],
  [/\bAQ\.[A-Za-z0-9_-]{8,}/g, "[key]"],
  // Provider-style keys (sk-..., ghp_..., AIza..., xox...).
  [/\b(sk|pk|rk|ghp|gho|ghu|ghs|github_pat|xox[abprs]|AIza)[-_][A-Za-z0-9_-]{8,}/g, "[key]"],
  // Long opaque tokens (hex/base64url) and one-time codes.
  [/\b[A-Za-z0-9_-]{32,}\b/g, "[token]"],
  [/\b\d{6,8}\b/g, "[number]"],
];

export function scrubText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let text = value.length > MAX_TEXT_LENGTH ? `${value.slice(0, MAX_TEXT_LENGTH)}…` : value;
  for (const [pattern, replacement] of TEXT_REDACTIONS) text = text.replace(pattern, replacement);
  return text;
}

function scrubUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value, "http://relative.invalid");
    const path = url.pathname.replace(/\/[A-Za-z0-9_-]{20,}(?=\/|$)/g, "/[id]");
    return url.origin === "http://relative.invalid" ? path : `${url.origin}${path}`;
  } catch {
    return undefined;
  }
}

function scrubStackFrames(frames: unknown) {
  if (!Array.isArray(frames)) return undefined;
  return frames.map((frame) => {
    const source = (frame ?? {}) as Record<string, unknown>;
    // Keep only location fields; drop vars, context lines and absolute paths
    // that could carry learner code or secrets.
    const kept: Record<string, unknown> = {};
    if (typeof source.filename === "string") kept.filename = scrubUrl(source.filename) ?? REDACTED;
    for (const key of ["function", "module"]) {
      const text = safeString(source[key]);
      if (text !== undefined) kept[key] = text;
    }
    for (const key of ["lineno", "colno"]) {
      if (typeof source[key] === "number" && Number.isFinite(source[key])) kept[key] = source[key];
    }
    if (typeof source.in_app === "boolean") kept.in_app = source.in_app;
    return kept;
  });
}

function scrubException(exception: unknown) {
  const source = (exception ?? {}) as { values?: unknown };
  if (!Array.isArray(source.values)) return undefined;
  return {
    values: source.values.map((value) => {
      const item = (value ?? {}) as Record<string, unknown>;
      const stacktrace = item.stacktrace as { frames?: unknown } | undefined;
      const mechanism = item.mechanism as { type?: unknown; handled?: unknown } | undefined;
      return {
        type: safeString(item.type)?.slice(0, 100) ?? "Error",
        value: scrubText(item.value),
        ...(mechanism && typeof mechanism === "object"
          ? { mechanism: { type: unchangedString(mechanism.type, 50), handled: typeof mechanism.handled === "boolean" ? mechanism.handled : undefined } }
          : {}),
        ...(stacktrace ? { stacktrace: { frames: scrubStackFrames(stacktrace.frames) } } : {}),
      };
    }),
  };
}

function scrubTags(tags: unknown) {
  if (!tags || typeof tags !== "object") return undefined;
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags as Record<string, unknown>)) {
    if (ALLOWED_TAGS.has(key) && (typeof value === "string" || typeof value === "number")) {
      kept[key] = scrubText(String(value)) ?? REDACTED;
    }
  }
  return kept;
}

const LEVELS = new Set(["fatal", "error", "warning", "log", "info", "debug"]);
const SAFE_ID = /^[A-Za-z0-9-]{1,64}$/;

function safeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = scrubText(value);
  return text === undefined || text.length === 0 ? undefined : text;
}

/** Strings are kept only when the scrubber would not alter them. */
function unchangedString(value: unknown, max = 200): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > max) return undefined;
  return scrubText(value) === value ? value : undefined;
}

function scrubSdk(sdk: unknown) {
  if (!sdk || typeof sdk !== "object") return undefined;
  const source = sdk as Record<string, unknown>;
  const name = unchangedString(source.name, 100);
  const version = unchangedString(source.version, 50);
  if (!name && !version) return undefined;
  return { ...(name ? { name } : {}), ...(version ? { version } : {}) };
}

export function scrubEnvelopeSdk(sdk: unknown) {
  return scrubSdk(sdk);
}

/**
 * Fingerprints are grouping hints. Keep them only when every entry is a short
 * string the scrubber leaves untouched; otherwise fall back to default grouping.
 */
function scrubFingerprint(fingerprint: unknown) {
  if (!Array.isArray(fingerprint) || fingerprint.length > 10) return undefined;
  const kept = fingerprint.map((entry) => unchangedString(entry, 100));
  return kept.every((entry) => entry !== undefined) ? kept : undefined;
}

/**
 * Rebuilds the event from an allow-list instead of deleting known-bad fields,
 * so fields added by future SDK versions are dropped by default.
 */
export function scrubEvent<T extends object>(input: T): T {
  const event = input as MonitoredEvent;
  const request = event.request as { method?: unknown; url?: unknown } | undefined;
  const scrubbed: MonitoredEvent = {
    event_id: typeof event.event_id === "string" && SAFE_ID.test(event.event_id) ? event.event_id : undefined,
    timestamp: typeof event.timestamp === "number" && Number.isFinite(event.timestamp)
      ? event.timestamp
      : unchangedString(event.timestamp, 40),
    platform: unchangedString(event.platform, 40),
    level: typeof event.level === "string" && LEVELS.has(event.level) ? event.level : undefined,
    logger: unchangedString(event.logger, 100),
    release: unchangedString(event.release, 100),
    environment: unchangedString(event.environment, 100),
    sdk: scrubSdk(event.sdk),
    type: event.type === "transaction" ? "transaction" : undefined,
    message: typeof event.message === "string" ? scrubText(event.message) : undefined,
    exception: scrubException(event.exception),
    tags: scrubTags(event.tags),
    fingerprint: scrubFingerprint(event.fingerprint),
    transaction: typeof event.transaction === "string" ? scrubUrl(event.transaction) : undefined,
    ...(request
      ? { request: { method: typeof request.method === "string" && /^[A-Za-z]{3,10}$/.test(request.method) ? request.method : undefined, url: scrubUrl(request.url) } }
      : {}),
  };
  for (const key of Object.keys(scrubbed)) if (scrubbed[key] === undefined) delete scrubbed[key];
  return scrubbed as T;
}

export interface ErrorMonitoringOptions {
  dsn: string;
  release?: string;
  environment: string;
  sendDefaultPii: false;
  tracesSampleRate: number;
  maxBreadcrumbs: 0;
  attachStacktrace: true;
  initialScope: { tags: { runtime: ErrorMonitoringRuntime } };
  beforeSend: <T extends object>(event: T) => T;
  beforeSendTransaction: <T extends object>(event: T) => T;
  beforeBreadcrumb: () => null;
}

function traceRate(value: string | undefined) {
  const parsed = Number(value ?? "0");
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
}

/**
 * SDK init options, or null when monitoring is not configured (the default):
 * callers must not initialize any SDK in that case.
 */
export function errorMonitoringOptions(input: {
  runtime: ErrorMonitoringRuntime;
  dsn: string | undefined;
  release?: string | undefined;
  environment?: string | undefined;
  tracesSampleRate?: string | undefined;
}): ErrorMonitoringOptions | null {
  const dsn = input.dsn?.trim();
  if (!dsn) return null;
  try {
    const parsed = new URL(dsn);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  } catch {
    return null;
  }
  const release = input.release?.trim();
  return {
    dsn,
    ...(release ? { release } : {}),
    environment: input.environment?.trim() || "production",
    sendDefaultPii: false,
    tracesSampleRate: traceRate(input.tracesSampleRate),
    maxBreadcrumbs: 0,
    attachStacktrace: true,
    initialScope: { tags: { runtime: input.runtime } },
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
    beforeBreadcrumb: () => null,
  };
}

/** The DSN's origin, for the browser Content-Security-Policy connect-src. */
export function errorMonitoringOrigin(dsn: string | undefined) {
  if (!dsn?.trim()) return null;
  try {
    return new URL(dsn).origin;
  } catch {
    return null;
  }
}
