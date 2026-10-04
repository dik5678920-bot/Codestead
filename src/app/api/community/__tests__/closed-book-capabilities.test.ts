// Exercise real authentication and the exam gate before each route's services.
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  exam: vi.fn(),
  event: vi.fn(),
  rateLimit: vi.fn(),
  audit: vi.fn(),
  services: {
    owners: vi.fn(), profile: vi.fn(), settings: vi.fn(), updateProfile: vi.fn(),
    leaderboards: vi.fn(), discussions: vi.fn(), reply: vi.fn(),
    battles: vi.fn(), createBattle: vi.fn(), battle: vi.fn(), join: vi.fn(), submit: vi.fn(),
  },
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth", () => ({ auth: { api: {
  getSession: async () => ({ user: { id: "learner-1" }, session: { mfaVerifiedAt: new Date() } }),
} } }));
vi.mock("@/lib/db/client", async () => {
  const { user } = await import("@/lib/db/schema");
  return { db: {
    select: () => ({ from: (table: unknown) => ({ where: () => ({ limit: table === user ? mocks.account : mocks.exam }) }) }),
    insert: () => ({ values: (value: unknown) => ({ onConflictDoNothing: () => mocks.event(value) }) }),
  } };
});
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.rateLimit }));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.audit }));
vi.mock("@/lib/social/profile-service", () => ({
  SocialProfileError: class extends Error {},
  listVisibleProfileOwners: mocks.services.owners,
  loadVisibleCohortProfile: mocks.services.profile,
  loadOwnCohortSettings: mocks.services.settings,
  updateCohortProfile: mocks.services.updateProfile,
}));
vi.mock("@/lib/social/leaderboard-service", () => ({ loadCohortLeaderboards: mocks.services.leaderboards }));
vi.mock("@/lib/community/service", () => ({
  CommunityError: class extends Error {},
  listCommunity: mocks.services.discussions,
  createCommunityReply: mocks.services.reply,
}));
vi.mock("@/lib/battles/service", () => ({
  BattleError: class extends Error {},
  listBattles: mocks.services.battles,
  createBattle: mocks.services.createBattle,
  getBattle: mocks.services.battle,
  joinBattle: mocks.services.join,
  submitBattle: mocks.services.submit,
}));

import { GET as cohort } from "@/app/api/community/route";
import { GET as profile } from "@/app/api/community/profiles/[publicId]/route";
import { GET as settings, PATCH as updateProfile } from "@/app/api/community/profile/route";
import { GET as discussions, POST as discussionWrite } from "@/app/api/community/discussions/route";
import { GET as battles, POST as createBattle } from "@/app/api/battles/route";
import { GET as battle, POST as battleWrite } from "@/app/api/battles/[battleId]/route";

const id = "b5000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({ publicId: id, battleId: id }) };
function request(path: string, method = "GET", body?: unknown) {
  return new NextRequest(`https://learn.test/api/${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
}

const operations = [
  { name: "GET /community", capability: "community_read", run: () => cohort(), service: mocks.services.owners, status: 200 },
  { name: "GET /community/profiles/[publicId]", capability: "community_read", run: () => profile(request("community/profiles/" + id), context), service: mocks.services.profile, status: 200 },
  { name: "GET /community/profile", capability: "community_read", run: () => settings(), service: mocks.services.settings, status: 200 },
  { name: "PATCH /community/profile", capability: "community_write", run: () => updateProfile(request("community/profile", "PATCH", {
    requestId: id, expectedVersion: 0, alias: "safe-alias", bio: null,
    showBio: false, showStreak: false, showMasterySummary: false, publish: false,
    selectedAchievementIds: [], selectedProjectIds: [],
  })), service: mocks.services.updateProfile, status: 200 },
  { name: "GET /community/discussions", capability: "community_read", run: () => discussions(request("community/discussions")), service: mocks.services.discussions, status: 200 },
  { name: "POST /community/discussions", capability: "community_write", run: () => discussionWrite(request("community/discussions", "POST", { action: "reply", requestId: id, postId: id, body: "Safe reply" })), service: mocks.services.reply, status: 200 },
  { name: "GET /battles", capability: "battles", run: () => battles(), service: mocks.services.battles, status: 200 },
  { name: "POST /battles", capability: "battles", run: () => createBattle(request("battles", "POST", { requestId: id, activityId: id, scope: "cohort" })), service: mocks.services.createBattle, status: 201 },
  { name: "GET /battles/[battleId]", capability: "battles", run: () => battle(request("battles/" + id), context), service: mocks.services.battle, status: 200 },
  { name: "POST /battles/[battleId] join", capability: "battles", run: () => battleWrite(request("battles/" + id, "POST", { action: "join" }), context), service: mocks.services.join, status: 200 },
  { name: "POST /battles/[battleId] submit", capability: "battles", run: () => battleWrite(request("battles/" + id, "POST", { action: "submit", requestId: id, answer: { value: "a" } }), context), service: mocks.services.submit, status: 200 },
] as const;

describe.each(operations)("closed-book $name", ({ run, capability, service, status }) => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.account.mockResolvedValue([{ status: "active", role: "learner", twoFactorEnabled: true, mustChangePassword: false }]);
    mocks.exam.mockResolvedValue([]);
    mocks.event.mockResolvedValue(undefined);
    mocks.rateLimit.mockImplementation(async (_policy, handler: () => Promise<Response>) => handler());
    mocks.audit.mockResolvedValue(undefined);
    for (const operation of Object.values(mocks.services)) operation.mockResolvedValue({});
    mocks.services.owners.mockResolvedValue([]);
    mocks.services.createBattle.mockResolvedValue({ id, replayed: false });
    mocks.services.updateProfile.mockResolvedValue({ rowVersion: 1, replayed: false });
  });

  it.each(["active", "paused_by_system"])("blocks an authoritative %s exam before reads or writes", async (examStatus) => {
    mocks.exam.mockResolvedValue([{ id: "exam-1", status: examStatus }]);
    const response = await run();
    expect(response.status).toBe(423);
    expect(await response.json()).toMatchObject({ code: "EXAM_CLOSED_BOOK" });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.event).toHaveBeenCalledWith(expect.objectContaining({
      examSessionId: "exam-1", type: "blocked_capability_attempt", metadata: { capability },
    }));
    for (const operation of Object.values(mocks.services)) expect(operation).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("allows the operation when no active or system-paused exam exists", async () => {
    expect((await run()).status).toBe(status);
    expect(mocks.exam).toHaveBeenCalledOnce();
    expect(service).toHaveBeenCalledOnce();
    expect(mocks.event).not.toHaveBeenCalled();
  });

  it("fails closed when authoritative exam state is unavailable", async () => {
    mocks.exam.mockRejectedValue(new Error("private database detail"));
    const response = await run();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "EXAM_STATE_UNAVAILABLE" });
    for (const operation of Object.values(mocks.services)) expect(operation).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
