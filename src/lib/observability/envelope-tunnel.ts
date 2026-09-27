/**
 * Same-origin tunnel for browser error events. The browser never learns the
 * real DSN and the Content-Security-Policy stays connect-src 'self': it posts
 * Sentry envelopes here, and the server forwards only envelopes that parse,
 * fit the size cap and carry nothing but error events, to the configured
 * GlitchTip project, rewriting the envelope DSN to the server-held one.
 */

export const MAX_ENVELOPE_BYTES = 256 * 1024;
const FORWARDED_ITEM_TYPES = new Set(["event"]);

export interface EnvelopeTarget {
  url: string;
  dsn: string;
}

/** Ingest URL for a DSN of the form https://<key>@<host>/<projectId>. */
export function envelopeTarget(dsn: string | undefined): EnvelopeTarget | null {
  if (!dsn?.trim()) return null;
  try {
    const parsed = new URL(dsn.trim());
    const projectId = parsed.pathname.replace(/^\/+|\/+$/g, "");
    if (!parsed.username || !/^\d+$/.test(projectId)) return null;
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return { url: `${parsed.origin}/api/${projectId}/envelope/`, dsn: dsn.trim() };
  } catch {
    return null;
  }
}

/**
 * Returns the envelope to forward (with the server DSN substituted), or null
 * when it must be dropped. Envelope format: header line, then item header /
 * payload line pairs, newline separated.
 */
export function rewriteEnvelope(body: string, target: EnvelopeTarget): string | null {
  if (Buffer.byteLength(body) > MAX_ENVELOPE_BYTES) return null;
  const lines = body.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length < 3 || lines.length % 2 !== 1) return null;
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(lines[0]!) as Record<string, unknown>;
    if (!header || typeof header !== "object" || Array.isArray(header)) return null;
    for (let index = 1; index < lines.length; index += 2) {
      const item = JSON.parse(lines[index]!) as { type?: unknown };
      if (typeof item?.type !== "string" || !FORWARDED_ITEM_TYPES.has(item.type)) return null;
      JSON.parse(lines[index + 1]!);
    }
  } catch {
    return null;
  }
  const rewritten = { event_id: header.event_id, sent_at: header.sent_at, sdk: header.sdk, dsn: target.dsn };
  return [JSON.stringify(rewritten), ...lines.slice(1)].join("\n");
}
