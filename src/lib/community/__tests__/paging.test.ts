import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn(), release: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ pool: { connect: mocks.connect } }));
vi.mock("@/lib/privacy/consent", () => ({ ENROLLMENT_DISCLOSURE_VERSION: "test-consent" }));

import { listCommunity } from "../service";

const groupId = "20000000-0000-4000-8000-000000000001";
const idFor = (number: number) => `10000000-0000-4000-8000-${String(number).padStart(12, "0")}`;

function exactTimestamp(value: unknown) {
  const text = value instanceof Date ? value.toISOString() : String(value);
  return text.replace(/\.(\d{3})Z$/, (_match, milliseconds: string) => `.${milliseconds}000Z`);
}

describe("community post pagination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
  });

  it("rejects a reply cursor bound to another post before reading data", async () => {
    const replyCursor = Buffer.from(JSON.stringify(["2026-09-29T10:00:00.123456Z", idFor(1), idFor(100)])).toString("base64url");
    await expect(listCommunity({ actorUserId: "learner-1", postId: idFor(101), replyCursor }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("does not read replies when the visibility-filtered post is unavailable", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('from "user"')) return { rows: [{ id: "learner-1", role: "learner" }] };
      if (sql.includes("from community_group g") || sql.includes("from community_post p")) return { rows: [] };
      throw new Error("Replies must not be queried for an unavailable post.");
    });
    const page = await listCommunity({ actorUserId: "learner-1", postId: idFor(100) });
    expect(page.posts).toEqual([]);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("from community_reply r"))).toBe(false);
  });

  it.each([25, 45])("makes all %i replies reachable once, including timestamp ties", async (count) => {
    const postId = idFor(100);
    const replies = Array.from({ length: count }, (_, index) => ({
      id: idFor(index + 1), post_id: postId, body: `Reply ${index + 1}`, state: "active",
      row_version: 1, created_at: new Date("2026-09-29T10:00:00.123456Z"), edited_at: null,
      created_at_token: "2026-09-29T10:00:00.123456Z", author_alias: "You", own: true,
    }));
    mocks.query.mockImplementation(async (sql: string, values: readonly unknown[] = []) => {
      if (sql.includes('from "user"')) return { rows: [{ id: "learner-1", role: "learner" }] };
      if (sql.includes("from community_group g")) return { rows: [] };
      if (sql.includes("from community_post p")) return { rows: [{
        id: postId, group_id: groupId, kind: "discussion", title: "Post", body: "Post body",
        state: "active", row_version: 1, created_at: new Date(), edited_at: null, author_alias: "You", own: true,
      }] };
      if (sql.includes("from community_reply r")) {
        const boundary = values[4] == null ? null : exactTimestamp(values[4]);
        return { rows: replies.filter((reply) => !boundary || reply.created_at_token > boundary
          || (reply.created_at_token === boundary && reply.id > String(values[5])))
          .slice(0, sql.includes("reply_rank <= 21") ? 21 : 20) };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const received: string[] = [];
    let replyCursor: string | null = null;
    for (let pageNumber = 0; pageNumber < 4; pageNumber += 1) {
      const page = await listCommunity({ actorUserId: "learner-1", postId, replyCursor });
      const post = page.posts[0]!;
      expect(post.replies.length).toBeLessThanOrEqual(20);
      received.push(...post.replies.map((reply) => reply.id));
      replyCursor = post.replyNextCursor ?? null;
      if (!replyCursor) break;
    }
    expect(replyCursor).toBeNull();
    expect(received).toEqual(replies.map((reply) => reply.id));
    expect(new Set(received).size).toBe(count);
  });

  it.each([
    { name: "identical microsecond timestamps", fractions: ["123456", "123456", "123456", "123456", "123456", "123456"] },
    { name: "near timestamps within a millisecond", fractions: ["123900", "123456", "123400", "123300", "123000", "122999"] },
  ])("returns every post once across a boundary with $name", async ({ fractions }) => {
    const posts = fractions.map((fraction, index) => ({
      id: idFor(fractions.length - index),
      at: `2026-09-29T10:00:00.${fraction}Z`,
    }));
    mocks.query.mockImplementation(async (sql: string, values: readonly unknown[] = []) => {
      if (sql.includes('from "user"')) return { rows: [{ id: "learner-1", role: "learner" }] };
      if (sql.includes("from community_group g")) return { rows: [{
        id: groupId, name: "Group", description: "A cohort group", visibility: "cohort",
        status: "active", member_role: "member", member_count: "1",
      }] };
      if (sql.includes("from community_post p")) {
        const boundary = values[3] === null ? null : exactTimestamp(values[3]);
        const boundaryId = String(values[4]);
        return { rows: posts
          .filter((post) => boundary === null || post.at < boundary || (post.at === boundary && post.id < boundaryId))
          .slice(0, Number(values[5]))
          .map((post) => ({
            id: post.id, group_id: groupId, kind: "discussion", title: "Post", body: "Post body",
            state: "active", row_version: 1, created_at: new Date(post.at), edited_at: null,
            ...(sql.includes("created_at_token") ? { created_at_token: post.at } : {}),
            author_alias: "You", own: true,
          })) };
      }
      if (sql.includes("from community_reply r")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    });
    const received: string[] = [];
    let cursor: string | null = null;
    for (let pageNumber = 0; pageNumber < posts.length; pageNumber += 1) {
      const page = await listCommunity({ actorUserId: "learner-1", groupId, limit: 2, cursor });
      received.push(...page.posts.map((post) => post.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    expect(received).toEqual(posts.map((post) => post.id));
    expect(new Set(received).size).toBe(posts.length);
  });
});
