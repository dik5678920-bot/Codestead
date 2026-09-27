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
  it("forwards error events with the server DSN substituted", () => {
    const [header, item] = rewriteEnvelope(envelope(), target)!.split("\n");
    expect(JSON.parse(header!)).toEqual({ event_id: "e1", dsn: target.dsn });
    expect(JSON.parse(item!)).toEqual({ type: "event" });
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
});
