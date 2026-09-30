// @vitest-environment node

import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import {
  disarmMailDispatchHardWatchdog,
  isMailDispatchHardWatchdogArmed,
  MAIL_DISPATCH_HARD_WATCHDOG_TIMEOUT_MS,
  MAIL_DISPATCH_WATCHDOG_ARM_ACK_TIMEOUT_MS,
  MAIL_DISPATCH_WATCHDOG_DISARM_DELIVERY_TIMEOUT_MS,
  startMailDispatchHardWatchdog,
  type ArmedMailDispatchHardWatchdog,
  type MailDispatchHardWatchdog,
} from "../mail-dispatch-hard-watchdog";
import { planMailDispatchRuntime } from "../mail-dispatch-runtime-policy";

import { prepareChild, prepareSequentially } from "../../../../scripts/__tests__/helpers/prepared-child";

const TEST_FAULT_NAME = "MAIL_DISPATCH_WATCHDOG_TEST_FAULT";
const TEST_HANDSHAKE_NAME =
  "MAIL_DISPATCH_WATCHDOG_TEST_HANDSHAKE_TIMEOUT_MS";

function stubWatchdogFault(fault: string) {
  vi.stubEnv(TEST_FAULT_NAME, fault);
  vi.stubEnv(TEST_HANDSHAKE_NAME, "1000");
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function closeController(
  controller: MailDispatchHardWatchdog | undefined,
  armed: ArmedMailDispatchHardWatchdog | undefined,
) {
  if (armed && isMailDispatchHardWatchdogArmed(armed)) {
    await disarmMailDispatchHardWatchdog(armed);
  }
  await controller?.close();
}

type FatalFixtureResult = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}>;

async function prepareFatalFixture(input: Readonly<{
  fault: string;
  phase: "arm" | "armed" | "disarm" | "idle";
  exitMode: "native" | "return" | "throw";
}>) {
  const fixture = path.resolve(
    process.cwd(),
    "src/lib/notifications/__tests__/fixtures/mail-dispatch-hard-watchdog-fatal-parent.mjs",
  );
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    MAIL_DISPATCH_WATCHDOG_TEST_TIMEOUT_MS: "250",
    MAIL_DISPATCH_WATCHDOG_TEST_HANDSHAKE_TIMEOUT_MS: "1000",
    MAIL_DISPATCH_WATCHDOG_TEST_FAULT: input.fault,
    MAIL_DISPATCH_WATCHDOG_TEST_EXIT_MODE: input.exitMode,
    MAIL_DISPATCH_WATCHDOG_TEST_FATAL_PHASE: input.phase,
    DATABASE_URL: "postgresql://watchdog-must-not-inherit",
    GMAIL_CLIENT_SECRET: "gmail-secret-must-not-inherit",
    DELETION_TOMBSTONE_KEY: "tombstone-must-not-inherit",
    LOST_DEVICE_PROOF_KEY: "proof-key-must-not-inherit",
  };
  for (const name of ["PATH", "SYSTEMROOT", "WINDIR"] as const) {
    if (process.env[name]) environment[name] = process.env[name];
  }

  return prepareChild(["--import", "tsx", fixture], { cwd: process.cwd(), env: environment });
}

const fatalCases = [
  ["DISCONNECT_AFTER_READY", "idle", "native"],
  ["MALFORMED_ARMED", "arm", "native"],
  ["DROP_ARM_ACK", "arm", "native"],
  ["DISCONNECT_ON_ARM", "arm", "native"],
  ["SEND_CALLBACK_ERROR", "arm", "native"],
  ["SEND_SYNC_THROW", "arm", "native"],
  ["MALFORMED_DISARMED", "disarm", "native"],
  ["DROP_DISARM_ACK", "disarm", "native"],
  ["DISCONNECT_ON_DISARM", "disarm", "native"],
  ["CONTROLLER_FAIL_AFTER_ARMED", "armed", "return"],
  ["CONTROLLER_FAIL_AFTER_ARMED", "armed", "throw"],
] as const;
const fatalFixtures = new Map(await prepareSequentially(fatalCases, async ([fault, phase, exitMode]) => [
  JSON.stringify({ fault, phase, exitMode }),
  await prepareFatalFixture({ fault, phase, exitMode }),
] as const));
afterAll(() => { for (const fixture of fatalFixtures.values()) fixture.kill(); });

async function runFatalFixture(input: Readonly<{
  fault: string;
  phase: "arm" | "armed" | "disarm" | "idle";
  exitMode: "native" | "return" | "throw";
}>): Promise<FatalFixtureResult> {
  const { code, signal, stdout, stderr } = await fatalFixtures.get(JSON.stringify(input))!.run(3_000);
  return { code, signal, stdout, stderr };
}

const frozenFaults = ["", "EXIT_AFTER_ARMED", "DISCONNECT_AFTER_ARMED", "UNCAUGHT_AFTER_ARMED", "UNHANDLED_REJECTION_AFTER_ARMED"];
const frozenFixtures = new Map(await prepareSequentially(frozenFaults, async (fault) => {
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    MAIL_DISPATCH_WATCHDOG_TEST_TIMEOUT_MS: fault ? "5000" : "250",
    ...(fault ? { MAIL_DISPATCH_WATCHDOG_TEST_FAULT: fault } : {}),
    DATABASE_URL: "postgresql://watchdog-must-not-inherit",
    GMAIL_CLIENT_SECRET: "gmail-secret-must-not-inherit",
    DELETION_TOMBSTONE_KEY: "tombstone-must-not-inherit",
    LOST_DEVICE_PROOF_KEY: "proof-key-must-not-inherit",
  };
  for (const name of ["PATH", "SYSTEMROOT", "WINDIR"] as const) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  return [fault, await prepareChild([
    "--import", "tsx",
    path.resolve(process.cwd(), "src/lib/notifications/__tests__/fixtures/mail-dispatch-hard-watchdog-parent.mjs"),
  ], { cwd: process.cwd(), env: environment })] as const;
}));
afterAll(() => { for (const fixture of frozenFixtures.values()) fixture.kill(); });

describe("mail dispatch external hard watchdog", () => {
  it("binds and packages the exact production timer implementation", () => {
    const policy = planMailDispatchRuntime();

    expect(MAIL_DISPATCH_HARD_WATCHDOG_TIMEOUT_MS).toBe(55_000);
    expect(MAIL_DISPATCH_WATCHDOG_ARM_ACK_TIMEOUT_MS).toBe(2_000);
    expect(MAIL_DISPATCH_WATCHDOG_DISARM_DELIVERY_TIMEOUT_MS).toBe(2_000);
    expect(MAIL_DISPATCH_HARD_WATCHDOG_TIMEOUT_MS).toBe(
      policy.timeouts.hardWatchdogMs,
    );
    expect(MAIL_DISPATCH_WATCHDOG_ARM_ACK_TIMEOUT_MS).toBe(
      policy.timeouts.watchdogArmAckMs,
    );
    expect(MAIL_DISPATCH_WATCHDOG_DISARM_DELIVERY_TIMEOUT_MS).toBe(
      policy.timeouts.watchdogDisarmDeliveryMs,
    );
    expect(
      MAIL_DISPATCH_WATCHDOG_ARM_ACK_TIMEOUT_MS
      + 47_000
      + MAIL_DISPATCH_WATCHDOG_DISARM_DELIVERY_TIMEOUT_MS,
    ).toBeLessThan(MAIL_DISPATCH_HARD_WATCHDOG_TIMEOUT_MS);

    const childSource = readFileSync(
      path.resolve(
        process.cwd(),
        "src/lib/notifications/mail-dispatch-hard-watchdog-child.mjs",
      ),
      "utf8",
    );
    expect(childSource).toContain("const PRODUCTION_TIMEOUT_MS = 55_000;");

    const dockerfile = readFileSync(
      path.resolve(process.cwd(), "Dockerfile"),
      "utf8",
    );
    expect(dockerfile).toContain(
      "COPY --chown=node:node src/lib/notifications/mail-dispatch-hard-watchdog-child.mjs ./src/lib/notifications/mail-dispatch-hard-watchdog-child.mjs",
    );
  });

  it("returns an opaque capability only after ARM acknowledgement and requires DISARM acknowledgement", async () => {
    let controller: MailDispatchHardWatchdog | undefined;
    let armed: ArmedMailDispatchHardWatchdog | undefined;
    try {
      controller = await startMailDispatchHardWatchdog();
      armed = await controller.arm();

      expect(Object.isFrozen(armed)).toBe(true);
      expect(Reflect.ownKeys(armed)).toEqual([]);
      expect(isMailDispatchHardWatchdogArmed(armed)).toBe(true);
      await expect(controller.arm()).rejects.toThrow(/already armed/i);

      await disarmMailDispatchHardWatchdog(armed);
      expect(isMailDispatchHardWatchdogArmed(armed)).toBe(false);
      await expect(disarmMailDispatchHardWatchdog(armed))
        .rejects.toThrow(/not armed/i);
      armed = undefined;
    } finally {
      await closeController(controller, armed);
    }
  });

  it("accepts delayed ARM acknowledgement and DISARM delivery only inside the explicit IPC budget", async () => {
    // IPC arrival is an OS signal, not elapsed time in the controller's clock.
    // Keep the clock controlled while the real child starts and acknowledges.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    stubWatchdogFault("DELAY_BOUNDARY_IPC");
    let controller: MailDispatchHardWatchdog | undefined;
    let armed: ArmedMailDispatchHardWatchdog | undefined;
    try {
      controller = await startMailDispatchHardWatchdog();
      armed = await controller.arm();
      expect(isMailDispatchHardWatchdogArmed(armed)).toBe(true);
      const disarming = disarmMailDispatchHardWatchdog(armed);
      await vi.advanceTimersByTimeAsync(50);
      await disarming;
      armed = undefined;
    } finally {
      await closeController(controller, armed);
    }
  });

  it("rejects forged and stale-generation capabilities without disarming the current generation", async () => {
    let controller: MailDispatchHardWatchdog | undefined;
    let current: ArmedMailDispatchHardWatchdog | undefined;
    try {
      controller = await startMailDispatchHardWatchdog();
      const first = await controller.arm();
      await disarmMailDispatchHardWatchdog(first);

      current = await controller.arm();
      const forged = Object.freeze({}) as ArmedMailDispatchHardWatchdog;
      expect(isMailDispatchHardWatchdogArmed(first)).toBe(false);
      expect(isMailDispatchHardWatchdogArmed(forged)).toBe(false);
      await expect(disarmMailDispatchHardWatchdog(first))
        .rejects.toThrow(/not armed/i);
      await expect(disarmMailDispatchHardWatchdog(forged))
        .rejects.toThrow(/not armed/i);
      expect(isMailDispatchHardWatchdogArmed(current)).toBe(true);

      await disarmMailDispatchHardWatchdog(current);
      current = undefined;
    } finally {
      await closeController(controller, current);
    }
  });

  it.each([
    "EXIT_BEFORE_READY",
    "MALFORMED_READY",
  ])("refuses startup for child fault %s without invoking the post-ready fatal hook", async (fault) => {
    stubWatchdogFault(fault);
    const outcome = await startMailDispatchHardWatchdog().then(
      (controller) => ({ kind: "started" as const, controller }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    );

    if (outcome.kind === "started") {
      await outcome.controller.close();
    }
    expect(outcome.kind).toBe("failed");
  });

  it.each([
    ["DISCONNECT_AFTER_READY", "idle"],
    ["MALFORMED_ARMED", "arm"],
    ["DROP_ARM_ACK", "arm"],
    ["DISCONNECT_ON_ARM", "arm"],
    ["SEND_CALLBACK_ERROR", "arm"],
    ["SEND_SYNC_THROW", "arm"],
    ["MALFORMED_DISARMED", "disarm"],
    ["DROP_DISARM_ACK", "disarm"],
    ["DISCONNECT_ON_DISARM", "disarm"],
  ] as const)(
    "module-owned exit terminates post-READY fault %s without unwind",
    { timeout: 10_000 },
    async (fault, phase) => {
      const result = await runFatalFixture({
        fault,
        phase,
        exitMode: "native",
      });

      // With the arm ack dropped, the already-armed watchdog's kill wins the race
      // against the parent's own ack timeout. Windows reports that kill as exit 1.
      const killedByWatchdog = fault === "DROP_ARM_ACK" && process.platform !== "win32";
      expect(result).toEqual({
        code: killedByWatchdog ? null : 1,
        signal: killedByWatchdog ? "SIGKILL" : null,
        stdout: "",
        stderr: "",
      });
    },
  );

  it.each(["return", "throw"] as const)(
    "parks under the armed child when process.exit is patched to %s",
    { timeout: 10_000 },
    async (exitMode) => {
      const result = await runFatalFixture({
        fault: "CONTROLLER_FAIL_AFTER_ARMED",
        phase: "armed",
        exitMode,
      });

      expect(result.stdout).toBe("ARMED\n");
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toMatch(
        /CATCH|FINALLY|SURVIVED|UNCAUGHT|UNHANDLED/u,
      );
      if (process.platform === "win32") {
        expect(result.code).not.toBe(0);
      } else {
        expect(result.signal).toBe("SIGKILL");
      }
    },
  );

  it(
    "kills a stalled or SIGSTOPped parent without running cleanup, health, retry, or telemetry callbacks",
    { timeout: 10_000 },
    async () => {
      const run = frozenFixtures.get("")!;
      const child = run.child;
      let stdout = "";
      let stopAttempted = false;
      let stopSignalAccepted = false;
      child.stdout!.on("data", (chunk: string) => {
        stdout += chunk;
        if (
          process.platform !== "win32"
          && !stopAttempted
          && stdout.includes("ARMED\n")
        ) {
          stopAttempted = true;
          stopSignalAccepted = child.kill("SIGSTOP");
        }
      });
      const result = await run.run(5_000);
      stdout = run.stdout();
      const stderr = run.stderr();

      expect(stdout).toBe("ARMED\n");
      expect(stderr).toBe("");
      expect(stdout).not.toMatch(/POOL_END|HEALTH|RETRY|TELEMETRY|FINALLY/u);
      if (process.platform === "win32") {
        expect(result.code).not.toBe(0);
      } else {
        expect(stopAttempted).toBe(true);
        expect(stopSignalAccepted).toBe(true);
        expect(result.signal).toBe("SIGKILL");
      }
    },
  );

  it.each([
    "EXIT_AFTER_ARMED",
    "DISCONNECT_AFTER_ARMED",
    "UNCAUGHT_AFTER_ARMED",
    "UNHANDLED_REJECTION_AFTER_ARMED",
  ])(
    "child fault %s independently kills a frozen parent before its five-second watchdog timer",
    { timeout: 10_000 },
    async (fault) => {
      const run = frozenFixtures.get(fault)!;
      const result = await run.run(3_000);
      const stdout = run.stdout();
      const stderr = run.stderr();

      expect(stdout).toBe("ARMED\n");
      expect(stderr).toBe("");
      expect(stdout).not.toMatch(/POOL_END|HEALTH|RETRY|TELEMETRY|FINALLY/u);
      if (process.platform === "win32") {
        expect(result.code).not.toBe(0);
      } else {
        expect(result.signal).toBe("SIGKILL");
      }
    },
  );
});
