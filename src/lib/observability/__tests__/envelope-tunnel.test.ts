import { describe, expect, it } from "vitest";

import { envelopeTarget, MAX_ENVELOPE_BYTES, rewriteEnvelope } from "../envelope-tunnel";

const target = envelopeTarget("https://serverkey@errors.example.test/7")!;

function envelope(itemType = "event") {
  return [
    JSON.stringify({ dsn: "https://browser@tunnel.invalid/1", event_id: "e1" }),
    JSON.stringify({ type: itemType }),
    JSON.stringify({ event_id: "e1" }),
  ].join("\n");
}

describe("envelopeTarget", () => {
  it("derives the ingest URL from a DSN and is off without one", () => {
    expect(target).toEqual({
      url: "https://errors.example.test/api/7/envelope/",
      dsn: "https://serverkey@errors.example.test/7",
    });
    for (const dsn of [undefined, "", "https://errors.example.test/7", "https://k@errors.example.test/x", "nope"]) {
      expect(envelopeTarget(dsn)).toBeNull();
    }
  });
});

describe("rewriteEnvelope", () => {
  it("forwards error events with the server DSN substituted and the item length recalculated", () => {
    const [header, item, payload] = rewriteEnvelope(envelope(), target)!.split("\n");
    expect(JSON.parse(header!)).toEqual({ event_id: "e1", dsn: target.dsn });
    expect(JSON.parse(item!)).toEqual({ type: "event", length: Buffer.byteLength(payload!) });
  });

  it.each(["replay_event", "replay_recording", "attachment", "session", "transaction", "profile"])(
    "drops %s items",
    (type) => expect(rewriteEnvelope(envelope(type), target)).toBeNull(),
  );

  it("drops malformed and oversized envelopes", () => {
    expect(rewriteEnvelope("not json\n{}\n{}", target)).toBeNull();
    expect(rewriteEnvelope(JSON.stringify({}), target)).toBeNull();
    expect(rewriteEnvelope(`${envelope()}\n${"x".repeat(MAX_ENVELOPE_BYTES)}`, target)).toBeNull();
  });

  it.each([
    ["non-object payload", [JSON.stringify({ type: "event" }), "[1,2]"]],
    ["null payload", [JSON.stringify({ type: "event" }), "null"]],
    ["invalid payload json", [JSON.stringify({ type: "event" }), "{nope"]],
    ["item header array", ["[]", "{}"]],
    ["second unsupported item", [JSON.stringify({ type: "event" }), "{}", JSON.stringify({ type: "session" }), "{}"]],
  ])("rejects %s", (_name, lines) => {
    const body = [JSON.stringify({ event_id: "e1" }), ...lines].join("\n");
    expect(rewriteEnvelope(body, target)).toBeNull();
  });

  it("forwards nothing the scrubber would not keep: canaries are absent from outbound bytes", () => {
    const EMAIL = "canary.user@example.com";
    const AUTH = "Authorization: Basic Y2FuYXJ5OnBhc3N3b3Jk";
    const BEARER = "Bearer canarytoken123456789abc";
    const COOKIE = "session=canarycookievalue";
    const SECRET = "canary-unknown-field-value";
    const event = {
      event_id: "e1",
      timestamp: 1_700_000_000,
      platform: "javascript",
      level: "error",
      logger: BEARER,
      release: `r-${EMAIL}`,
      environment: "production",
      sdk: { name: "sentry.javascript.nextjs", version: "9.0.0", integrations: [EMAIL], packages: [{ name: BEARER }] },
      user: { email: EMAIL, id: SECRET, ip_address: "10.0.0.1" },
      contexts: { device: { note: SECRET } },
      extra: { auth: AUTH },
      breadcrumbs: { values: [{ message: COOKIE }] },
      fingerprint: [BEARER, "{{ default }}"],
      message: `failed for ${EMAIL} with ${BEARER}`,
      tags: { runtime: "browser", leaked: SECRET, route: `/x?e=${EMAIL}` },
      request: {
        url: `https://app.example.test/p?email=${EMAIL}`,
        method: "POST",
        headers: { Authorization: BEARER, Cookie: COOKIE },
        cookies: COOKIE,
        data: { password: SECRET },
        query_string: `e=${EMAIL}`,
      },
      exception: {
        values: [{
          type: "TypeError",
          value: `${EMAIL} ${AUTH}`,
          mechanism: { type: BEARER, handled: false, data: { x: SECRET } },
          stacktrace: { frames: [{
            filename: `https://app.example.test/a.js?t=${EMAIL}`,
            function: BEARER,
            module: EMAIL,
            lineno: 1,
            vars: { token: SECRET },
            pre_context: [COOKIE],
          }] },
        }],
      },
    };
    const body = [
      JSON.stringify({ event_id: "e1", sent_at: "2026-01-01T00:00:00Z", dsn: "https://browser@tunnel.invalid/1", sdk: { name: EMAIL, version: BEARER } }),
      JSON.stringify({ type: "event", length: 1, filename: EMAIL }),
      JSON.stringify(event),
    ].join("\n");
    const out = rewriteEnvelope(body, target)!;
    expect(out).not.toBeNull();
    for (const canary of [EMAIL, "canary.user", "Y2FuYXJ5", "canarytoken", "canarycookie", SECRET, "10.0.0.1", "browser@tunnel"]) {
      expect(out).not.toContain(canary);
    }
    const [, itemHeader, payloadLine] = out.split("\n");
    expect(JSON.parse(itemHeader!)).toEqual({ type: "event", length: Buffer.byteLength(payloadLine!) });
    const forwarded = JSON.parse(payloadLine!);
    expect(forwarded.exception.values[0].type).toBe("TypeError");
    expect(forwarded.exception.values[0].stacktrace.frames[0].lineno).toBe(1);
    expect(forwarded.tags.runtime).toBe("browser");
    expect(forwarded.user).toBeUndefined();
    expect(forwarded.request.headers).toBeUndefined();
  });

  it("still forwards a valid scrubbed event", () => {
    const body = [
      JSON.stringify({ event_id: "e1" }),
      JSON.stringify({ type: "event" }),
      JSON.stringify({ event_id: "e1", level: "error", message: "boom", exception: { values: [{ type: "Error", value: "boom" }] } }),
    ].join("\n");
    const forwarded = JSON.parse(rewriteEnvelope(body, target)!.split("\n")[2]!);
    expect(forwarded).toMatchObject({ level: "error", message: "boom", exception: { values: [{ type: "Error", value: "boom" }] } });
  });
});
