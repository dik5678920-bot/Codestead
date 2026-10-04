import { describe, expect, it } from "vitest";
import { renderEmail } from "../templates";
import { evaluateTemplateAccountSnapshot } from "../template-authority-policy";
describe("support mail contracts", () => {
  it("binds admin notices to active verified admins and fixed notices to learners", () => {
    const learner = { role: "learner", status: "active", banned: false, emailVerified: true };
    const admin = { ...learner, role: "admin" };
    expect(evaluateTemplateAccountSnapshot({ template: "support-request-admin", templateVersion: "1", account: admin }).kind).toBe("account-snapshot-satisfied");
    expect(evaluateTemplateAccountSnapshot({ template: "support-request-admin", templateVersion: "1", account: learner }).kind).toBe("account-snapshot-denied");
    expect(evaluateTemplateAccountSnapshot({ template: "support-request-fixed", templateVersion: "1", account: learner }).kind).toBe("account-snapshot-satisfied");
    expect(evaluateTemplateAccountSnapshot({ template: "support-request-fixed", templateVersion: "1", account: admin }).kind).toBe("account-snapshot-denied");
  });
  it("renders action links and excludes supplied messages, prompts and diagnostics", () => {
    for (const template of ["support-request-admin", "support-request-fixed"] as const) {
      const email = renderEmail(template, { name: "Learner", url: "https://example.test/requests", message: "private message", prompt: "private prompt", errorCode: "private error", reply: "private reply" });
      expect(JSON.stringify(email)).toContain("https://example.test/requests");
      expect(JSON.stringify(email)).not.toContain("private");
    }
  });
});
