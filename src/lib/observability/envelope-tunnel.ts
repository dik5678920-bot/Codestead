/**
 * Same-origin tunnel for browser error events. The browser never learns the
 * real DSN and the Content-Security-Policy stays connect-src 'self': it posts
 * Sentry envelopes here, and the server forwards only envelopes that parse,
 * fit the size cap and carry nothing but error events, to the configured
 * GlitchTip project, rewriting the envelope DSN to the server-held one.
 */

import { scrubEnvelopeSdk, scrubEvent } from "./error-monitoring";

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
  const rebuilt: string[] = [];
  try {
    header = JSON.parse(lines[0]!) as Record<string, unknown>;
    if (!header || typeof header !== "object" || Array.isArray(header)) return null;
    for (let index = 1; index < lines.length; index += 2) {
      const item = JSON.parse(lines[index]!) as { type?: unknown };
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      if (typeof item.type !== "string" || !FORWARDED_ITEM_TYPES.has(item.type)) return null;
      const payload = JSON.parse(lines[index + 1]!) as unknown;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
      // Rebuild from the allow-list: nothing the browser sent is forwarded
      // verbatim, and the item length is recomputed for the new payload.
      const clean = JSON.stringify(scrubEvent(payload as Record<string, unknown>));
      rebuilt.push(JSON.stringify({ type: "event", length: Buffer.byteLength(clean) }), clean);
    }
  } catch {
    return null;
  }
  const eventId = typeof header.event_id === "string" && /^[A-Za-z0-9-]{1,64}$/.test(header.event_id) ? header.event_id : undefined;
  const sentAt = typeof header.sent_at === "string" && /^[0-9T:.+Z-]{10,40}$/.test(header.sent_at) ? header.sent_at : undefined;
  const rewritten = { event_id: eventId, sent_at: sentAt, sdk: scrubEnvelopeSdk(header.sdk), dsn: target.dsn };
  return [JSON.stringify(rewritten), ...rebuilt].join("\n");
}
