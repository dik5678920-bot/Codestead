import { describe, expect, it } from "vitest";

import { errorMonitoringOptions, scrubEvent, scrubText } from "../error-monitoring";

describe("errorMonitoringOptions", () => {
  it.each([undefined, "", "   ", "not a url", "ftp://key@host/1"])("is off without a usable DSN (%j)", (dsn) => {
    expect(errorMonitoringOptions({ runtime: "nodejs", dsn })).toBeNull();
  });

  it("enables a privacy-first configuration when a DSN is set", () => {
    const options = errorMonitoringOptions({
      runtime: "worker",
      dsn: "https://key@errors.example.test/3",
      release: "abc1234",
      tracesSampleRate: "not-a-number",
    });
    expect(options).toMatchObject({
      dsn: "https://key@errors.example.test/3",
      release: "abc1234",
      environment: "production",
      sendDefaultPii: false,
      tracesSampleRate: 0,
      maxBreadcrumbs: 0,
      initialScope: { tags: { runtime: "worker" } },
    });
    expect(options?.beforeBreadcrumb()).toBeNull();
    expect(errorMonitoringOptions({ runtime: "nodejs", dsn: "https://k@h.test/1", tracesSampleRate: "2" })?.tracesSampleRate).toBe(0);
    expect(errorMonitoringOptions({ runtime: "nodejs", dsn: "https://k@h.test/1", tracesSampleRate: "0.1" })?.tracesSampleRate).toBe(0.1);
  });
});

describe("scrubText", () => {
  it("redacts Google AQ keys", () => {
    expect(scrubText("AQ." + "syntheticValue".repeat(3))).toBe("[key]");
  });
  it.each([
    ["learner ada@example.com failed", "learner [email] failed"],
    ["Authorization: Bearer abc.def.ghi", "Authorization: [redacted] [redacted]"],
    ["api_key=sk-live-123456789abcdef", "api_key=[redacted]"],
    ["called https://api.example.test/v1/x?token=secret#frag", "called https://api.example.test/v1/x"],
    ["key ghp_ABCDEFGHIJKLMNOP1234 leaked", "key [key] leaked"],
    ["totp 123456 rejected", "totp [number] rejected"],
    ["session 0123456789abcdef0123456789abcdef0", "session [token]"],
  ])("redacts %j", (input, expected) => {
    expect(scrubText(input)).toBe(expected);
  });

  it("truncates very long text such as pasted learner code", () => {
    expect(scrubText("x ".repeat(2_000))!.length).toBeLessThanOrEqual(1_001);
  });
});

describe("scrubEvent", () => {
  it("keeps error type and location but drops bodies, cookies, headers, user and code", () => {
    const event = {
      event_id: "e1",
      level: "error",
      release: "abc1234",
      message: "failed for ada@example.com",
      user: { id: "u1", email: "ada@example.com", ip_address: "1.2.3.4" },
      request: {
        method: "POST",
        url: "https://learn.example.test/api/code/run?token=abc",
        data: { source: "print(\"secret learner code\")" },
        cookies: { "learncoding.session_token": "tok" },
        headers: { authorization: "Bearer abc", cookie: "a=b" },
        query_string: "token=abc",
      },
      breadcrumbs: [{ message: "typed password" }],
      contexts: { state: { value: "learner code" } },
      extra: { body: "learner code" },
      tags: { runtime: "nodejs", route: "/api/code/run", email: "ada@example.com", code: "WORKER_OPERATION_FAILED" },
      exception: {
        values: [{
          type: "TypeError",
          value: "bad input from ada@example.com with code 654321",
          stacktrace: {
            frames: [{
              filename: "/app/src/lib/x.ts",
              function: "run",
              lineno: 10,
              colno: 2,
              context_line: "const password = \"hunter2\"",
              pre_context: ["learner code"],
              vars: { password: "hunter2" },
            }],
          },
        }],
      },
    };
    const scrubbed = scrubEvent(event) as Record<string, unknown>;
    const serialized = JSON.stringify(scrubbed);
    for (const secret of ["ada@example.com", "hunter2", "learner code", "token=abc", "Bearer", "session_token", "1.2.3.4", "654321"]) {
      expect(serialized).not.toContain(secret);
    }
    for (const field of ["user", "breadcrumbs", "contexts", "extra"]) expect(scrubbed).not.toHaveProperty(field);
    expect(scrubbed.request).toEqual({ method: "POST", url: "https://learn.example.test/api/code/run" });
    expect(scrubbed.tags).toEqual({ runtime: "nodejs", route: "/api/code/run", code: "WORKER_OPERATION_FAILED" });
    expect(scrubbed.exception).toEqual({
      values: [{
        type: "TypeError",
        value: "bad input from [email] with code [number]",
        stacktrace: { frames: [{ filename: "/app/src/lib/x.ts", function: "run", lineno: 10, colno: 2 }] },
      }],
    });
  });

  it("drops fields it does not know about", () => {
    expect(scrubEvent({ event_id: "e", future_sdk_field: { secret: "x" } })).toEqual({ event_id: "e" });
  });
});
