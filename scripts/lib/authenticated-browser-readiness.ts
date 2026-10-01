import type { ExamAnswerOutboxRecord } from "../../src/lib/browser-durability/types";
import { expect, type BrowserContext, type Page } from "@playwright/test";

type BrowserCookie = Awaited<ReturnType<BrowserContext["cookies"]>>[number];

export function hasAuthenticationCookies(
  stored: readonly BrowserCookie[],
  expected: readonly BrowserCookie[],
) {
  return expected.length > 0 && expected.every((cookie) => stored.some((candidate) => (
    candidate.name === cookie.name
    && candidate.value === cookie.value
    && candidate.domain === cookie.domain
    && candidate.path === cookie.path
    && candidate.secure === cookie.secure
    && candidate.httpOnly === cookie.httpOnly
    && candidate.expires > 0
  )));
}

export type ExamAnswerExpectation = Readonly<{
  sessionId: string;
  itemId: string;
  answer: string;
}>;

export async function waitForCommittedExamAnswer(page: Page, expected: ExamAnswerExpectation) {
  const observed = { answer: false as ExamAnswerOutboxRecord | false };
  // waitForFunction treats a returned Promise as truthy. Poll in Node instead,
  // awaiting the page's IndexedDB transaction before deciding whether to stop.
  await expect.poll(async () => {
    observed.answer = await page.evaluate(readCommittedExamAnswer, expected);
    return observed.answer !== false;
  }, {
    timeout: 15_000,
    message: "The expected local exam answer did not reach committed browser storage.",
  }).toBe(true);
  if (!observed.answer) throw new Error("The expected local exam answer was not committed.");
  return observed.answer;
}

// Serialized by Playwright into the page realm: keep all runtime dependencies
// inside this function. A completed readonly transaction sees committed data,
// unlike a transient React status or an individual IDB request's success event.
export function readCommittedExamAnswer(
  expected: ExamAnswerExpectation,
): Promise<ExamAnswerOutboxRecord | false> {
  return new Promise((resolve, reject) => {
    let databaseMissing = false;
    const request = indexedDB.open("codestead-browser-outbox-v1");
    request.onupgradeneeded = () => {
      databaseMissing = true;
      request.transaction?.abort();
    };
    request.onerror = () => {
      if (databaseMissing) resolve(false);
      else reject(request.error ?? new Error("Exam outbox could not be opened."));
    };
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("entries")) {
        db.close();
        resolve(false);
        return;
      }
      const transaction = db.transaction("entries", "readonly");
      const entries = transaction.objectStore("entries").getAll();
      transaction.oncomplete = () => {
        db.close();
        const records = entries.result as ExamAnswerOutboxRecord[];
        resolve(records.find((record) => (
          record.schemaVersion === 1
          && record.kind === "exam-answer"
          && record.scope === expected.sessionId
          && record.payload.itemId === expected.itemId
          && record.payload.answer === expected.answer
        )) ?? false);
      };
      transaction.onabort = () => {
        db.close();
        reject(transaction.error ?? new Error("Exam outbox read transaction aborted."));
      };
    };
  });
}
