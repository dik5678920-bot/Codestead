import { describe, expect, it } from "vitest";
import { deleteLearnerAccount } from "@/lib/data-lifecycle/deletion";
import { pool } from "@/lib/db/client";
import {
  CLAIM_TOKENS,
  InstrumentedPool,
  LEARNER_ID,
  QueryPause,
  beginProviderCall,
  deletionInput,
  isBlockingAdvisoryLock,
  isTryAdvisoryLock,
  objectStorageRoot,
  outboxState,
  requireClaim,
  requireSentPersistenceUnknown,
  seedOutboxRows,
  store,
  registerMailDeliveryRaceHarness,
  waitForAdvisoryWaiters,
  within,
  workerPool,
  zeroErasureDependencies,
} from "./support/mail-delivery-races-harness";

registerMailDeliveryRaceHarness();

describe("real PostgreSQL mail delivery races", () => {

  it("preserves quarantine evidence when the sweeper owns the scope before a late finalizer", async () => {
    const finalizerStore = await store(new InstrumentedPool(
      workerPool,
      {},
      "rollback-before-ack",
      4,
    ));
    const { claim, uncertainty } = await requireSentPersistenceUnknown(
      finalizerStore,
      "sweeper-first-worker",
    );
    const sweeperPause = new QueryPause();
    const sweeperStore = await store(new InstrumentedPool(workerPool, {
      after: async (event, result) => {
        if (isTryAdvisoryLock(event.sql) && result.rows[0]?.locked === true) {
          await sweeperPause.hold(event.pid);
        }
      },
    }));
    const sweeping = sweeperStore.quarantineAbandoned({ limit: 10 });
    await within(sweeperPause.reached, "sweeper scope lock");
    const finalizing = finalizerStore.finishGuardedDispatchUnknown(uncertainty);

    let waitError: unknown = null;
    try {
      await waitForAdvisoryWaiters(sweeperPause.pid!, 1);
    } catch (error) {
      waitError = error;
    } finally {
      sweeperPause.release();
    }
    const [swept, finalized] = await Promise.all([sweeping, finalizing]);
    if (waitError) throw waitError;

    expect(swept).toBe(1);
    expect(finalized).toMatchObject({
      result: { kind: "applied" },
      exit: { kind: "sent" },
    });
    expect((await outboxState())[0]).toMatchObject({
      id: claim.id,
      status: "quarantined",
      claim_version: claim.claimVersion + 1,
      claim_token: null,
      claim_owner: null,
      lease_expires_at: null,
      last_error_code: "ABANDONED_POST_PROVIDER_BOUNDARY",
    });
    expect((await outboxState())[0]!.provider_message_id).not.toBeNull();
    expect((await outboxState())[0]!.sent_at).not.toBeNull();
    expect((await outboxState())[0]!.quarantined_at).not.toBeNull();
  }, 180_000);
  it("makes a committed provider boundary win when deletion queues behind its account lock", async () => {
    await seedOutboxRows("pending", 1);
    const claim = await requireClaim(CLAIM_TOKENS[0], "boundary-before-deletion-worker");
    const boundaryPause = new QueryPause();
    const boundaryStore = await store(new InstrumentedPool(workerPool, {
      after: async (event) => {
        if (isBlockingAdvisoryLock(event.sql)) await boundaryPause.hold(event.pid);
      },
    }));
    const boundary = beginProviderCall(claim, boundaryStore);
    await within(boundaryPause.reached, "provider boundary account lock");
    const deletion = deleteLearnerAccount(
      deletionInput(objectStorageRoot, "95000000-0000-4000-8000-000000000001"),
      zeroErasureDependencies(),
    );

    let waitError: unknown = null;
    try {
      await waitForAdvisoryWaiters(boundaryPause.pid!, 1);
    } catch (error) {
      waitError = error;
    } finally {
      boundaryPause.release();
    }
    const [boundaryOutcome, deletionOutcome] = await Promise.allSettled([boundary, deletion]);
    if (waitError) throw waitError;

    expect(boundaryOutcome).toMatchObject({
      status: "fulfilled",
      value: { kind: "applied" },
    });
    expect(deletionOutcome.status).toBe("rejected");
    if (deletionOutcome.status === "rejected") {
      expect(deletionOutcome.reason).toMatchObject({ code: "PROVIDER_OPERATION_IN_PROGRESS" });
    }
    expect((await pool.query<{ status: string }>(
      `select status::text from "user" where id = $1`,
      [LEARNER_ID],
    )).rows[0]?.status).toBe("active");
    expect((await outboxState())[0]!.provider_call_started).not.toBeNull();
  });

  it("makes deletion win before the provider boundary and emits one capability-bound notice", async () => {
    await seedOutboxRows("pending", 1);
    const claim = await requireClaim(CLAIM_TOKENS[0], "deletion-before-boundary-worker");
    const erasurePause = new QueryPause();
    const deletion = deleteLearnerAccount(
      deletionInput(objectStorageRoot, "95000000-0000-4000-8000-000000000002"),
      zeroErasureDependencies(erasurePause),
    );
    await within(erasurePause.reached, "deletion file-erasure checkpoint");

    const boundary = await beginProviderCall(claim);
    expect(boundary).toEqual({ kind: "lost" });

    erasurePause.release();
    const report = await deletion;
    expect(report.primaryStoreDeletionComplete).toBe(true);

    const notices = (await outboxState()).filter((row) => row.template === "account-deleted");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.variables).toEqual(expect.objectContaining({
      tombstoneId: report.tombstoneId,
      deletionRunId: report.runId,
    }));

    const noticeClaim = await requireClaim(CLAIM_TOKENS[1], "deletion-notice-worker");
    expect(noticeClaim.id).toBe(notices[0]!.id);
    await expect(beginProviderCall(noticeClaim)).resolves.toMatchObject({ kind: "applied" });
  });
});
