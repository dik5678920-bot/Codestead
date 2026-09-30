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
