import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import type { Page } from "@playwright/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hasAuthenticationCookies, readCommittedExamAnswer, waitForCommittedExamAnswer } from "./authenticated-browser-readiness";

const expected = { sessionId: "session-1", itemId: "item-1", answer: "durable answer" };
const record = {
  schemaVersion: 1,
  storageKey: "learner:exam-answer:session-1:item-1",
  namespace: "learner",
  kind: "exam-answer",
  scope: expected.sessionId,
  clientMutationId: "mutation-1",
  updatedAt: "2026-10-01T00:00:00.000Z",
  payload: { itemId: expected.itemId, answer: expected.answer, baseRevision: 0 },
};

async function database(withEntries = true) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("codestead-browser-outbox-v1", 1);
    request.onupgradeneeded = () => {
      if (withEntries) request.result.createObjectStore("entries", { keyPath: "storageKey" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function commit(value: typeof record) {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("entries", "readwrite");
    transaction.objectStore("entries").put(value);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("authenticated browser readiness", () => {
  const cookie = {
    name: "__Secure-learncoding.session_token", value: "synthetic-session",
    domain: "127.0.0.1", path: "/", expires: 2_000_000_000,
    secure: true, httpOnly: true, sameSite: "Lax" as const,
  };

  it("requires the signed-in durable cookie rather than an unrelated or session-only cookie", () => {
    expect(hasAuthenticationCookies([], [cookie])).toBe(false);
    expect(hasAuthenticationCookies([cookie], [])).toBe(false);
    expect(hasAuthenticationCookies([{ ...cookie, name: "other" }], [cookie])).toBe(false);
    expect(hasAuthenticationCookies([{ ...cookie, value: "another-session" }], [cookie])).toBe(false);
    expect(hasAuthenticationCookies([{ ...cookie, expires: -1 }], [cookie])).toBe(false);
    expect(hasAuthenticationCookies([{ ...cookie, domain: "other.test" }], [cookie])).toBe(false);
    expect(hasAuthenticationCookies([{ ...cookie, path: "/other" }], [cookie])).toBe(false);
    expect(hasAuthenticationCookies([{ ...cookie, secure: false }], [cookie])).toBe(false);
    expect(hasAuthenticationCookies([{ ...cookie, httpOnly: false }], [cookie])).toBe(false);
    expect(hasAuthenticationCookies([cookie], [cookie])).toBe(true);
  });

  it("does not create an outbox while waiting for the application to initialize", async () => {
    expect(await readCommittedExamAnswer(expected)).toBe(false);
    expect(await indexedDB.databases()).toEqual([]);
  });

  it("waits for the entries store and the exact committed answer", async () => {
    const db = await database(false);
    db.close();
    expect(await readCommittedExamAnswer(expected)).toBe(false);
  });

  it("observes durable readiness even when transient UI states are coalesced", async () => {
    document.body.innerHTML = '<div data-state="server-saved"></div>';
    const status = document.querySelector<HTMLElement>("div")!;
    const observed = [status.dataset.state];
    const observer = new MutationObserver(() => observed.push(status.dataset.state));
    observer.observe(status, { attributes: true, attributeFilter: ["data-state"] });
    status.dataset.state = "saving-local";
    status.dataset.state = "saved-local";
    status.dataset.state = "syncing";
    await Promise.resolve();
    observer.disconnect();
    expect(observed).toEqual(["server-saved", "syncing"]);
    expect(await readCommittedExamAnswer(expected)).toBe(false);
    await commit(record);
    expect(await readCommittedExamAnswer(expected)).toEqual(record);
  });

  it("awaits a negative storage read and polls again until the answer commits", async () => {
    const reads: unknown[] = [];
    const evaluate = vi.fn(async (read: typeof readCommittedExamAnswer, input: typeof expected) => {
      if (reads.length === 1) await commit(record);
      const result = await read(input);
      reads.push(result);
      return result;
    });
    const page = { evaluate } as unknown as Page;
    expect(await waitForCommittedExamAnswer(page, expected)).toEqual(record);
    expect(reads).toEqual([false, record]);
    expect(evaluate).toHaveBeenCalledWith(readCommittedExamAnswer, expected);
  });

  it.each([
    { ...record, schemaVersion: 2 },
    { ...record, kind: "draft" },
    { ...record, scope: "other-session" },
    { ...record, payload: { ...record.payload, itemId: "other-item" } },
    { ...record, payload: { ...record.payload, answer: "old answer" } },
  ])("rejects an unrelated or stale outbox entry %#", async (candidate) => {
    await commit(candidate);
    expect(await readCommittedExamAnswer(expected)).toBe(false);
  });

  it("does not acknowledge a request whose read transaction subsequently aborts", async () => {
    await commit(record);
    const originalGetAll = IDBObjectStore.prototype.getAll;
    vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(function (this: IDBObjectStore) {
      const request = originalGetAll.call(this);
      request.addEventListener("success", () => this.transaction.abort());
      return request;
    });
    await expect(readCommittedExamAnswer(expected)).rejects.toThrow("Exam outbox read transaction aborted");
  });
});
