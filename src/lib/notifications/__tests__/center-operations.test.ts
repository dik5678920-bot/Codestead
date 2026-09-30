import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ select: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ db: mocks }));
import { decodeNotificationCursor, listNotifications, setNotificationsRead } from "../center";

const dialect = new PgDialect();
const now = new Date("2026-10-01T12:00:00Z");
const id = "11111111-1111-4111-8111-111111111111";
function query(rows: unknown[]) {
  const builder = { from: vi.fn(), where: vi.fn(), orderBy: vi.fn(), limit: vi.fn(), returning: vi.fn(), set: vi.fn(), then: Promise.resolve(rows).then.bind(Promise.resolve(rows)) };
  for (const method of [builder.from, builder.where, builder.orderBy, builder.limit, builder.returning, builder.set]) method.mockReturnValue(builder);
  return builder;
}
beforeEach(() => vi.resetAllMocks());

describe("notification timeline and read operations", () => {
  it("pages by timestamp and id, reports unread counts, and serializes dates", async () => {
    const rows = [{ id, createdAt: now, readAt: null }, { id: "22222222-2222-4222-8222-222222222222", createdAt: now, readAt: now }, { id: "overflow", createdAt: now, readAt: null }];
    const page = query(rows);
    mocks.select.mockReturnValueOnce(page).mockReturnValueOnce(query([{ count: "4" }]));
    const result = await listNotifications({ userId: "owner", limit: 2.9, cursor: { id, createdAt: now } });
    expect(page.limit).toHaveBeenCalledWith(3);
    const filter = dialect.sqlToQuery(page.where.mock.calls[0][0]);
    expect(filter.params).toEqual(["owner", now.toISOString(), now.toISOString(), id]);
    expect(filter.sql).toContain('"notification"."id" <');
    expect(result.notifications).toEqual(rows.slice(0, 2).map((row) => ({ ...row, createdAt: now.toISOString(), readAt: row.readAt?.toISOString() ?? null })));
    expect(result.unreadCount).toBe(4);
    expect(decodeNotificationCursor(result.nextCursor)).toEqual({ createdAt: now, id: rows[1].id });
  });
  it.each([[undefined, 21], [-20, 2], [1000, 51]])("bounds page size %s", async (limit, requested) => {
    const page = query([]);
    mocks.select.mockReturnValueOnce(page).mockReturnValueOnce(query([]));
    expect(await listNotifications({ userId: "owner", limit })).toEqual({ notifications: [], unreadCount: 0, nextCursor: null });
    expect(page.limit).toHaveBeenCalledWith(requested);
    expect(dialect.sqlToQuery(page.where.mock.calls[0][0]).params).toEqual(["owner"]);
  });
  it("does not write when no ids or read-all scope was requested", async () => {
    expect(await setNotificationsRead({ userId: "owner", read: true })).toEqual({ updated: 0 });
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("deduplicates and bounds ids while retaining the owner and unread guard", async () => {
    const write = query([{ id }]); mocks.update.mockReturnValue(write);
    const ids = [id, id, ...Array.from({ length: 70 }, (_, index) => `id-${index}`)];
    expect(await setNotificationsRead({ userId: "owner", ids, read: true, now })).toEqual({ updated: 1 });
    expect(write.set).toHaveBeenCalledWith({ readAt: now });
    const filter = dialect.sqlToQuery(write.where.mock.calls[0][0]);
    expect(filter.params).toEqual(["owner", id, ...ids.slice(2, 51)]);
    expect(filter.sql).toContain('"read_at" is null');
  });
  it("marks all owned notifications unread without an id or unread filter", async () => {
    const write = query([{ id }, { id: "other" }]); mocks.update.mockReturnValue(write);
    expect(await setNotificationsRead({ userId: "owner", read: false, readAll: true })).toEqual({ updated: 2 });
    expect(write.set).toHaveBeenCalledWith({ readAt: null });
    expect(dialect.sqlToQuery(write.where.mock.calls[0][0]).params).toEqual(["owner"]);
  });
  it("uses the current timestamp when marking all unread notifications read", async () => {
    const write = query([]); mocks.update.mockReturnValue(write);
    await setNotificationsRead({ userId: "owner", read: true, readAll: true });
    expect(write.set).toHaveBeenCalledWith({ readAt: expect.any(Date) });
  });
});
