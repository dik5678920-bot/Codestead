import { describe, expect, it } from "vitest";
import { deleteLearnerAccount } from "@/lib/data-lifecycle/deletion";
import { pool } from "@/lib/db/client";
import type { EmailOutboxPayload } from "@/lib/notifications/postgres-outbox-store";
import type { OutboxClaim } from "@/lib/notifications/outbox-worker";
import {
  CLAIM_TOKENS,
  ClaimRaceCoordinator,
  InstrumentedPool,
  LEARNER_ID,
  QueryPause,
  ROW_IDS,
  STALE_TOKENS,
  ZERO_ERASURE_SUMMARY,
  beginProviderCall,
  deletionInput,
  isBlockingAdvisoryLock,
  isCandidateSelect,
  markUnresolvedQuarantined,
  objectStorageRoot,
  outboxState,
  requireClaim,
  requireGuardedBoundary,
  requirePermit,
  requireSentPersistenceUnknown,
  seedOutboxRows,
  startGuardedDispatch,
  store,
  registerMailDeliveryRaceHarness,
  within,
  workerPool,
  zeroErasureDependencies,
} from "./support/mail-delivery-races-harness";

registerMailDeliveryRaceHarness();

describe("real PostgreSQL mail delivery races", () => {
  it("revalidates a selected claim candidate at the CAS after a concurrent winner changes it", async () => {
    await seedOutboxRows("pending", 1);
    const candidatePause = new QueryPause();
    const claimantStore = await store(new InstrumentedPool(workerPool, {
      after: async (event) => {
        if (isCandidateSelect(event.sql)) await candidatePause.hold(event.pid);
      },
    }));
    const claiming = claimantStore.claimNext({
      owner: "stale-candidate-worker",
      token: CLAIM_TOKENS[0],
      leaseMs: 120_000,
    });
    await within(candidatePause.reached, "stale claim candidate snapshot");

    let winnerError: unknown = null;
    let winner: OutboxClaim<EmailOutboxPayload> | null = null;
    try {
      winner = await requireClaim(
        STALE_TOKENS[0],
        "concurrent-cas-winner",
      );
    } catch (error) {
      winnerError = error;
    } finally {
      candidatePause.release();
    }
    const claim = await within(claiming, "stale candidate CAS");
    if (winnerError) throw winnerError;

    expect(winner).toMatchObject({
      id: ROW_IDS[0],
      claimToken: STALE_TOKENS[0],
      claimOwner: "concurrent-cas-winner",
      claimVersion: 1,
    });
    expect(claim).toBeNull();
    expect((await outboxState())[0]).toMatchObject({
      status: "sending",
      attempt_count: 1,
      claim_token: STALE_TOKENS[0],
      claim_owner: "concurrent-cas-winner",
      claim_version: 1,
      provider_call_started: null,
    });
  });

  it("rejects a NULL sending lease before ambiguous scope authority can exist", async () => {
    await seedOutboxRows("pending", 2);
    const genuineClaim = await requireClaim(
      STALE_TOKENS[0],
      "null-lease-worker",
    );

    await expect(workerPool.query(
      `UPDATE public.email_outbox
          SET lease_expires_at = NULL,
              updated_at = pg_catalog.statement_timestamp()
        WHERE id = $1::uuid`,
      [genuineClaim.id],
    )).rejects.toMatchObject({
      code: "23514",
      constraint: "email_outbox_delivery_hold_valid",
    });

    await expect((await store()).claimNext({
      owner: "null-lease-follow-up",
      token: CLAIM_TOKENS[0],
      leaseMs: 120_000,
    })).resolves.toBeNull();

    expect(await outboxState()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: ROW_IDS[0],
        status: "sending",
        claim_token: STALE_TOKENS[0],
        claim_version: 1,
        lease_is_active: true,
      }),
      expect.objectContaining({
        id: ROW_IDS[1],
        status: "pending",
        claim_token: null,
        claim_version: 0,
      }),
    ]));
  });

  it("keeps an unresolved quarantined provider call as a delivery-scope blocker", async () => {
    await seedOutboxRows("pending", 2);
    await markUnresolvedQuarantined();

    await expect((await store()).claimNext({
      owner: "quarantined-scope-follow-up",
      token: CLAIM_TOKENS[0],
      leaseMs: 120_000,
    })).resolves.toBeNull();

    expect(await outboxState()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: ROW_IDS[0],
        status: "quarantined",
        provider_message_id: null,
        last_error_code: "PROVIDER_OUTCOME_UNKNOWN",
      }),
      expect.objectContaining({
        id: ROW_IDS[1],
        status: "pending",
        claim_token: null,
        claim_version: 0,
      }),
    ]));
  });

  it("blocks deletion while a quarantined provider call has no provider message", async () => {
    await seedOutboxRows("pending", 1);
    await markUnresolvedQuarantined();
    let fileErasureStarted = false;

    await expect(deleteLearnerAccount(
      deletionInput(objectStorageRoot, "95000000-0000-4000-8000-000000000003"),
      {
        processFileErasures: async () => {
          fileErasureStarted = true;
          return ZERO_ERASURE_SUMMARY;
        },
      },
    )).rejects.toMatchObject({ code: "PROVIDER_OPERATION_IN_PROGRESS" });

    expect(fileErasureStarted).toBe(false);
    expect((await pool.query<{ status: string }>(
      `select status::text from "user" where id = $1`,
      [LEARNER_ID],
    )).rows[0]?.status).toBe("active");
    expect((await outboxState())[0]).toMatchObject({
      status: "quarantined",
      provider_message_id: null,
      last_error_code: "PROVIDER_OUTCOME_UNKNOWN",
    });
  });

  it("permits deletion after a failed provider call is definitely rejected", async () => {
    await seedOutboxRows("pending", 1);
    const claim = await requireClaim(CLAIM_TOKENS[0], "definitely-rejected-worker");
    const permit = await requirePermit(claim);

    await expect((await store()).finishAfterProvider(permit, {
      kind: "failed",
      code: "PROVIDER_DEFINITELY_REJECTED",
    })).resolves.toEqual({ kind: "applied" });
    expect((await outboxState())[0]).toMatchObject({
      id: claim.id,
      status: "failed",
      provider_message_id: null,
      last_error_code: "PROVIDER_DEFINITELY_REJECTED",
    });
    expect((await outboxState())[0]!.provider_call_started).not.toBeNull();

    const report = await deleteLearnerAccount(
      deletionInput(objectStorageRoot, "95000000-0000-4000-8000-000000000004"),
      zeroErasureDependencies(),
    );

    expect(report).toMatchObject({
      primaryStoreDeletionComplete: true,
      objectFileErasureComplete: true,
    });
    expect(report.deletedRows.emailOutbox).toBe(1);
    expect((await outboxState()).some((row) => row.id === claim.id)).toBe(false);
  });

  it.each([
    ["CLAIM-02", "pending claimers", "pending" as const],
    ["CLAIM-03", "expired reclaimers", "expired-pre-provider" as const],
  ])("[%s] allows one of two %s and keeps the delivery scope single-active", async (
    _caseId,
    _name,
    fixtureKind,
  ) => {
    const staleClaim = await seedOutboxRows(fixtureKind);
    const race = new ClaimRaceCoordinator();
    const racingStore = await store(new InstrumentedPool(workerPool, race.hooks));
    const first = racingStore.claimNext({
      owner: "racing-worker-one",
      token: CLAIM_TOKENS[0],
      leaseMs: 120_000,
    });
    const second = racingStore.claimNext({
      owner: "racing-worker-two",
      token: CLAIM_TOKENS[1],
      leaseMs: 120_000,
    });

    try {
      await race.releaseInOrder();
    } finally {
      race.releaseAll();
    }
    const firstRound = await Promise.all([first, second]);
    const winners = firstRound.filter(
      (claim): claim is OutboxClaim<EmailOutboxPayload> => claim !== null,
    );
    expect(winners).toHaveLength(1);
    expect(firstRound.filter((claim) => claim === null)).toHaveLength(1);
    const winner = winners[0]!;

    const followUp = await (await store()).claimNext({
      owner: "racing-worker-follow-up",
      token: CLAIM_TOKENS[2],
      leaseMs: 120_000,
    });
    expect(followUp).toBeNull();

    const rows = await outboxState();
    expect(rows.filter((row) => row.status === "sending" && row.lease_is_active)).toHaveLength(1);
    if (fixtureKind === "pending") {
      expect(staleClaim).toBeNull();
      expect(winner).toMatchObject({
        id: ROW_IDS[0],
        claimVersion: 1,
      });
      expect(rows).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: ROW_IDS[0],
          status: "sending",
          attempt_count: 1,
          claim_version: 1,
          lease_is_active: true,
        }),
        expect.objectContaining({
          id: ROW_IDS[1],
          status: "pending",
          attempt_count: 0,
          claim_token: null,
          claim_owner: null,
          claim_version: 0,
          lease_expires_at: null,
        }),
      ]));
      return;
    }

    expect(staleClaim).not.toBeNull();
    expect(winner).toMatchObject({
      id: staleClaim!.id,
      claimVersion: staleClaim!.claimVersion + 1,
    });
    expect(winner.claimToken).not.toBe(staleClaim!.claimToken);
    expect(winner.claimOwner).not.toBe(staleClaim!.claimOwner);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: staleClaim!.id,
        status: "sending",
        attempt_count: 2,
        claim_token: winner.claimToken,
        claim_owner: winner.claimOwner,
        claim_version: staleClaim!.claimVersion + 1,
        lease_is_active: true,
      }),
      expect.objectContaining({
        id: ROW_IDS[1],
        status: "pending",
        attempt_count: 0,
        claim_token: null,
        claim_owner: null,
        claim_version: 0,
        lease_expires_at: null,
      }),
    ]));
  });

  it("rolls back a provider boundary when its transaction does not commit", async () => {
    await seedOutboxRows("pending", 1);
    const claim = await requireClaim(CLAIM_TOKENS[0], "rollback-boundary-worker");
    const rollbackStore = await store(new InstrumentedPool(workerPool, {}, "rollback-before-ack", 2));

    await expect(beginProviderCall(claim, rollbackStore)).rejects.toThrow("Provider boundary commit result is unknown.");

    expect((await outboxState())[0]).toMatchObject({
      status: "sending",
      adapter: null,
      provider_call_started: null,
      claim_version: claim.claimVersion,
    });
    await expect(beginProviderCall(claim)).resolves.toMatchObject({ kind: "applied" });
  });

  it("persists an unknown provider-boundary commit without reconstructing a permit", async () => {
    await seedOutboxRows("pending", 1);
    const claim = await requireClaim(CLAIM_TOKENS[0], "unknown-commit-worker");
    const unknownCommitStore = await store(new InstrumentedPool(workerPool, {}, "commit-ack-lost", 2));

    await expect(beginProviderCall(claim, unknownCommitStore)).rejects.toThrow("Provider boundary commit result is unknown.");

    expect((await outboxState())[0]).toMatchObject({
      status: "sending",
      adapter: "console",
    });
    expect((await outboxState())[0]!.provider_call_started).not.toBeNull();
    await expect(beginProviderCall(claim)).resolves.toEqual({ kind: "lost" });
  });

  it("carries exact PostgreSQL boundary text through guarded dispatch", async () => {
    await seedOutboxRows("pending", 1);
    const selectedStore = await store();
    const claim = await requireClaim(
      CLAIM_TOKENS[0],
      "precision-worker",
      selectedStore,
    );
    const boundary = await requireGuardedBoundary(claim, selectedStore);
    const captured = await pool.query<{ provider_call_started: string }>(`
      select provider_call_started::text as provider_call_started
        from email_outbox
       where id = $1::uuid
    `, [claim.id]);
    const exactBoundary = captured.rows[0]?.provider_call_started;
    expect(exactBoundary).toEqual(expect.stringMatching(/\S/u));

    const dispatch = await startGuardedDispatch(boundary);
    await expect(dispatch.finish()).resolves.toMatchObject({
      kind: "applied",
      exit: { kind: "sent" },
    });

    const persisted = await pool.query<{
      provider_call_started: string;
      provider_message_id: string | null;
    }>(`
      select provider_call_started::text as provider_call_started,
             provider_message_id
        from email_outbox
       where id = $1::uuid
    `, [claim.id]);
    expect(persisted.rows[0]).toMatchObject({
      provider_call_started: exactBoundary,
      provider_message_id: expect.stringMatching(/\S/u),
    });
  });
  it("lets a finalizer that owns the scope lock beat the abandoned-send sweeper", async () => {
    const finalizerPause = new QueryPause();
    let pauseRecovery = false;
    const finalizerStore = await store(new InstrumentedPool(workerPool, {
      after: async (event) => {
        if (pauseRecovery && isBlockingAdvisoryLock(event.sql)) {
          await finalizerPause.hold(event.pid);
        }
      },
    }, "rollback-before-ack", 4));
    const { claim, uncertainty } = await requireSentPersistenceUnknown(
      finalizerStore,
      "finalizer-first-worker",
    );
    pauseRecovery = true;
    const finalizing = finalizerStore.finishGuardedDispatchUnknown(uncertainty);
    await within(finalizerPause.reached, "finalizer scope lock");

    let swept: number;
    try {
      swept = await within(
        (await store()).quarantineAbandoned({ limit: 10 }),
        "non-blocking abandoned-send sweep",
      );
    } finally {
      finalizerPause.release();
    }
    const finalized = await finalizing;

    expect(swept).toBe(0);
    expect(finalized).toMatchObject({
      result: { kind: "applied" },
      exit: { kind: "sent" },
    });
    expect((await outboxState())[0]).toMatchObject({
      id: claim.id,
      status: "sent",
      quarantined_at: null,
      last_error_code: null,
    });
    expect((await outboxState())[0]!.provider_message_id).not.toBeNull();
  }, 180_000);
});
