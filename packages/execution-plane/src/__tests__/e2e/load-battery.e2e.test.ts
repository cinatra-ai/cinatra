/**
 * LOAD BATTERY (epic cinatra#1705, AC7) — "parallel-run burst degrades to
 * bounded queueing (no worker-host exhaustion); idle runs hold no compute."
 *
 * WHAT WAS MISSING, and why this file exists. The acceptance audit found AC7
 * PARTIAL: `broker.test.ts` bounds concurrency against a FAKE worker, and the
 * L5 service-boundary battery has one real queue wait — but that arm is an
 * authorization-expiry test that happens to queue. Nothing drove a parallel
 * **RUN** burst, and "no worker-host exhaustion" was asserted by construction
 * rather than measured: no container-count, memory, CPU or pids envelope was
 * recorded anywhere.
 *
 * SO THIS BATTERY MEASURES, on the SHIPPED topology:
 *   1. N orgs x M runs x K concurrent commands, submitted at once, well past
 *      BOTH the per-org and the global concurrency ceiling.
 *   2. peak concurrent sandbox containers <= the global ceiling — sampled from
 *      `docker ps`, not from the broker's own counter.
 *   3. containers return to ZERO between commands while every run stays open
 *      (a container exists only while a command executes).
 *   4. every command either completed or was refused `queue_saturated`, and
 *      NOT ONE WAS LOST — cross-checked record-by-record against the broker's
 *      DURABLE, ACKed audit spool (cinatra#2298), not against the wire replies.
 *   5. the worker host's own envelope — memory, CPU and pids of the worker
 *      container — stays bounded across the burst.
 *   6. the idle arm: N runs held open and idle hold ZERO containers, and the
 *      reaper closes them — while a run with a command IN FLIGHT is never
 *      reaped.
 *
 * THE SHIPPED CEILINGS ARE THE CEILINGS UNDER TEST. `broker-entry.ts` composes
 * the service without a `quotas` override, so the compose broker runs on
 * `DEFAULT_BROKER_QUOTAS`. This battery imports those constants instead of
 * restating them, and sizes its burst from them — so raising a ceiling moves
 * the battery with it, and the assertions below are about the invariant
 * ("never above the ceiling"), never about a number that could drift.
 *
 * The burst is deliberately built from `sleep` and `echo`: the property under
 * test is CONCURRENCY CONTROL, and a burst of real workloads would measure the
 * workloads. Every container is still a real hardened container over the real
 * L0 image, placed by the real worker through the real socket.
 *
 * NOTHING HERE IS STUBBED and the battery FAILS — never skips — when docker is
 * unavailable, exactly like the two batteries it sits beside.
 *
 * NOT A CI GATE, and that is stated rather than implied. Like
 * `docker-battery.e2e.test.ts` and `service-boundary.e2e.test.ts`, this file is
 * outside the default `pnpm test` run and no workflow invokes `test:e2e`, so
 * nothing here reds a merge today. Wiring a docker-capable CI job for all three
 * batteries is the acceptance audit's AC6(b) proof lane, not this one's; that
 * job will pick this file up for free, since it lives in the same tier and is
 * driven by the same script.
 *
 * Run with: pnpm --filter @cinatra-ai/execution-plane test:e2e
 * Deliberately NOT part of the default `pnpm test` run.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { mintExecutionSession, sealExecutionSession } from "@cinatra-ai/llm/execution-plane";

import { BrokerServiceClient } from "../../service/broker-client";
import { DEFAULT_BROKER_QUOTAS, DEFAULT_SANDBOX_LIMITS } from "../../types";
import type { ExecResult, ExecutionAuditRecord } from "../../types";
import { mintVoucher } from "./support/exec-rpc";
import {
  COMPOSE_PROJECT,
  WORKER_SERVICE,
  bringUpExecStack,
  docker,
  type ExecStack,
} from "./support/exec-stack";
import {
  liveSandboxJobs,
  sleep,
  startLoadSampler,
  waitForLiveSandboxes,
  waitForZeroSandboxes,
} from "./support/load-probe";

const INSTANCE = "l7load";
const TENANT = "l7-tenant";
const USER = "user-load";
const SURFACE = "agent_run";

/**
 * Enough ORGS that the burst presses the GLOBAL ceiling and not merely the
 * per-org one: the per-org semaphore caps each org at `maxConcurrentPerOrg`, so
 * a single-org burst can never reach the global limit at all. Asserted below
 * rather than assumed, so a quota change surfaces as "re-size the battery"
 * instead of as a silently weaker test.
 */
const ORG_COUNT = 6;
const RUNS_PER_ORG = 2;
const COMMANDS_PER_RUN = 3;
/**
 * Long enough that overlap is a property of the ceiling rather than of
 * container-startup luck: a sub-second command on a slow host can retire
 * before its peers are even placed, which would let a genuinely concurrent
 * broker read as a serial one.
 */
const BURST_COMMAND_SECONDS = 3;
const BURST_TOTAL = ORG_COUNT * RUNS_PER_ORG * COMMANDS_PER_RUN;

/**
 * The worker-host envelope this battery holds the plane to. Generous against
 * the measured figures (the worker dispatches containers, it does not host
 * them) and still far below "exhausted": a per-command process or buffer leak
 * across a 36-command burst crosses either of these long before the host is in
 * trouble.
 */
const WORKER_MEM_CEILING_BYTES = 768 * 1024 * 1024;
const WORKER_PIDS_CEILING = 200;
const WORKER_CPU_CEILING_PERCENT = 400;
/**
 * `docker stats` CPU percentages are sampled over a short window per container
 * and summed here, so the total can briefly read above a strict
 * cores x 100 arithmetic bound without the cgroup quota having been exceeded.
 * The slack keeps the assertion a real ceiling (a runaway fleet still crosses
 * it by orders of magnitude) without making it a stopwatch race.
 */
const CPU_MEASUREMENT_SLACK = 1.5;

let stack: ExecStack;
let app: BrokerServiceClient;
/** Every job this battery opens — the sampler counts only these. */
const ownedJobs = new Set<string>();

/**
 * REFUSE TO RUN ON TOP OF SOMEBODY ELSE'S STACK.
 *
 * The exec topology's internal network name and compose project are FIXED by
 * design (the worker is told the exact network string and asserts it really is
 * internal), so two stacks cannot coexist on one host — and `stack.down()`
 * ends in a host-global sweep of everything carrying the execution plane's
 * ownership label. A concurrently running sibling lane would therefore be
 * adopted by `compose up` and then destroyed by this file's teardown.
 *
 * So the battery checks FIRST and fails loudly. Somebody else's work is not
 * ours to reclaim, and "the tests passed" is worth nothing if the cost was a
 * sibling's run.
 */
async function refuseIfAnotherStackIsRunning(): Promise<void> {
  const running = await docker([
    "ps",
    "--quiet",
    "--filter",
    `label=com.docker.compose.project=${COMPOSE_PROJECT}`,
  ]);
  const ids = running.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  if (ids.length > 0) {
    throw new Error(
      `The execution-plane compose project "${COMPOSE_PROJECT}" already has ${ids.length} ` +
        "running container(s) on this host. That is another run's stack — this battery " +
        "would adopt it and then destroy it on teardown. Refusing. Stop that stack and re-run.",
    );
  }
}

beforeAll(async () => {
  await refuseIfAnotherStackIsRunning();
  stack = await bringUpExecStack({
    instance: INSTANCE,
    tenant: TENANT,
    // No command in this battery touches the network: every voucher is minted
    // `mode: "none"`, so the burst measures placement and queueing rather than
    // the gateway. The gateway still runs — it is part of the shipped topology.
    egressMode: "allowlist",
    egressAllowlist: ["pypi.org"],
    leaseRenewMs: 60_000,
    // The spool is ASSERTED on here, record by record. The compose default is a
    // shared host path that outlives `compose down -v`, so without this a
    // previous battery's unacked records would be counted as this one's.
    auditSpool: "per-run",
  });
  const leaf = stack.leaf("app-client");
  app = new BrokerServiceClient({
    baseUrl: stack.brokerUrl,
    instance: INSTANCE,
    serviceToken: stack.brokerToken,
    tls: { certPem: leaf.certPem, keyPem: leaf.keyPem, caPem: stack.ca.certPem },
    requestTimeoutMs: 240_000,
  });
  // A fresh spool should be empty; drain-and-ack anyway so an arm can never
  // inherit a record it did not produce.
  await drainAndAck();
}, 1_800_000);

afterAll(async () => {
  app?.close();
  if (stack) await stack.down();
}, 300_000);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type OpenRun = { jobId: string; orgId: string; runId: string };

async function openRun(orgId: string, runId: string): Promise<OpenRun> {
  const carrier = sealExecutionSession(
    mintExecutionSession({ orgId, userId: USER, surface: SURFACE, runId }),
    { secret: stack.carrierSecret },
  );
  const opened = await app.openJob(carrier);
  if (!opened.ok) throw new Error(`openJob refused: ${opened.reason} — ${opened.message}`);
  ownedJobs.add(opened.jobId);
  return { jobId: opened.jobId, orgId, runId };
}

async function closeRuns(runs: readonly OpenRun[]): Promise<void> {
  for (const run of runs) {
    await app.closeJob(run.jobId, { removeWorkspace: true }).catch(() => {});
    ownedJobs.delete(run.jobId);
  }
}

type Submission = {
  run: OpenRun;
  command: string;
  /** The VOUCHER's per-command id — the field the audit record carries. */
  voucherCommandId: string;
};

/**
 * The authorization lifetime this battery mints — deliberately LONGER than any
 * arm's own timeout.
 *
 * A voucher is re-checked for FRESHNESS after the admission wait, and this
 * battery's whole point is to make commands wait. A lifetime that a slow host
 * could outlast would turn a queued command into `revalidation_required` and
 * make these arms measure voucher expiry instead of queueing — a flake that
 * looks like a load failure. The expiry window has its own dedicated arm in the
 * L5 service-boundary battery; here it is taken off the table by construction,
 * because it can no longer elapse before the test that is waiting for it fails.
 */
const VOUCHER_LIFETIME_MS = 1_800_000;

function submit(run: OpenRun, command: string): Submission & { result: Promise<ExecResult> } {
  const voucherCommandId = randomUUID();
  const iat = Date.now();
  const voucher = mintVoucher(stack, {
    jobId: run.jobId,
    command,
    orgId: run.orgId,
    userId: USER,
    surface: SURFACE,
    runId: run.runId,
    commandId: voucherCommandId,
    egressPolicy: { mode: "none" },
    iat,
    exp: iat + VOUCHER_LIFETIME_MS,
  });
  return {
    run,
    command,
    voucherCommandId,
    // The WIRE command id is left to the client (a fresh transport-idempotency
    // key per attempt); only the VOUCHER's id is pinned, because that is the
    // one the audit record carries.
    result: app.exec(run.jobId, command, voucher),
  };
}

type DrainedSpool = {
  records: ExecutionAuditRecord[];
  durable: boolean;
  relayed: boolean;
  refusedReservations: number;
  recoveredUnknown: number;
  droppedAudit: number;
};

/**
 * Read the spool to exhaustion, acknowledging each prefix.
 *
 * The read is non-destructive since #2298, so the loop is the app's own
 * read-then-ACK contract: pull a bounded batch, commit exactly that prefix,
 * repeat while records remain.
 */
async function drainAndAck(): Promise<DrainedSpool> {
  const records: ExecutionAuditRecord[] = [];
  let durable = false;
  let relayed = false;
  let refusedReservations = 0;
  let recoveredUnknown = 0;
  let droppedAudit = 0;
  for (let pass = 0; pass < 100; pass += 1) {
    const batch = await app.drainAudit({ maxAuditRecords: 200 });
    durable = batch.durable;
    relayed = batch.relayed;
    refusedReservations = batch.refusedReservations;
    recoveredUnknown = batch.recoveredUnknown;
    droppedAudit = batch.droppedAudit;
    records.push(...batch.audit);
    if (batch.audit.length > 0) {
      await app.ackAudit({ spoolId: batch.spoolId, head: batch.head });
    }
    if (batch.remaining === 0) break;
  }
  return { records, durable, relayed, refusedReservations, recoveredUnknown, droppedAudit };
}

const mib = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)}MiB`;

// ===========================================================================
// 1. PARALLEL-RUN BURST
// ===========================================================================

describe("1. parallel-RUN burst: bounded queueing, no worker-host exhaustion", () => {
  it(
    "N orgs x M runs x K commands past both ceilings: peak <= ceiling, nothing lost",
    async () => {
      const { maxConcurrentPerOrg, maxGlobalConcurrent, maxQueuedPerOrg } =
        DEFAULT_BROKER_QUOTAS;

      // THE BURST MUST ACTUALLY BE A BURST. Each of these is a property of the
      // burst's SHAPE against the shipped quotas, so a quota change fails here
      // — "re-size the battery" — instead of quietly making it a weaker test.
      expect(
        ORG_COUNT * maxConcurrentPerOrg,
        "not enough orgs to press the GLOBAL ceiling",
      ).toBeGreaterThan(maxGlobalConcurrent);
      expect(
        RUNS_PER_ORG * COMMANDS_PER_RUN,
        "not enough per-org demand to press the PER-ORG ceiling",
      ).toBeGreaterThan(maxConcurrentPerOrg);
      expect(BURST_TOTAL).toBeGreaterThan(maxGlobalConcurrent);
      // This arm proves bounded QUEUEING, so it must stay inside the queue
      // ceiling; the refusal path is arm 2's subject.
      expect(RUNS_PER_ORG * COMMANDS_PER_RUN - maxConcurrentPerOrg).toBeLessThanOrEqual(
        maxQueuedPerOrg,
      );

      const runs: OpenRun[] = [];
      try {
        for (let org = 0; org < ORG_COUNT; org += 1) {
          for (let run = 0; run < RUNS_PER_ORG; run += 1) {
            runs.push(await openRun(`org-load-${org}`, `load-burst-${org}-${run}-${randomUUID()}`));
          }
        }
        expect(runs).toHaveLength(ORG_COUNT * RUNS_PER_ORG);

        // Baseline: this battery owns no live container before the burst, so a
        // peak measured below is genuinely produced by it.
        expect(await liveSandboxJobs(ownedJobs)).toEqual([]);

        const workerContainerId = await stack.containerId(WORKER_SERVICE);
        const sampler = startLoadSampler({
          jobIds: ownedJobs,
          workerContainerId,
          containerIntervalMs: 80,
          workerIntervalMs: 250,
        });

        const submissions: Array<Submission & { result: Promise<ExecResult> }> = [];
        const startedAt = Date.now();
        for (const [index, run] of runs.entries()) {
          for (let k = 0; k < COMMANDS_PER_RUN; k += 1) {
            submissions.push(
              submit(run, `sleep ${BURST_COMMAND_SECONDS}; echo burst-${index}-${k}`),
            );
          }
        }
        expect(submissions).toHaveLength(BURST_TOTAL);
        const results = await Promise.all(submissions.map((s) => s.result));
        const burstMs = Date.now() - startedAt;
        const envelope = await sampler.stop();

        // (iii) EVERY command completed or was refused `queue_saturated`.
        // Nothing else, and nothing without an answer.
        const completed = results.filter((r) => r.ok);
        const saturated = results.filter((r) => !r.ok && r.reason === "queue_saturated");
        const other = results
          .filter((r) => !r.ok && r.reason !== "queue_saturated")
          .map((r) => (r.ok ? "" : `${r.reason}: ${r.message}`));
        expect(other, "a burst command failed for a reason other than queue saturation").toEqual(
          [],
        );
        expect(completed.length + saturated.length).toBe(BURST_TOTAL);
        // Sized to stay inside the queue ceiling, so the burst must DEGRADE TO
        // QUEUEING rather than to refusal — that is AC7's headline claim.
        expect(saturated).toHaveLength(0);
        for (const [index, result] of results.entries()) {
          if (!result.ok) continue;
          expect(result.result.exitCode).toBe(0);
          expect(result.result.stdout.trim()).toBe(
            submissions[index].command.replace(/^sleep \d+; echo /, ""),
          );
          expect(result.result.termination).toBe("exited");
        }

        // (i) PEAK CONCURRENT SANDBOX CONTAINERS <= the global ceiling, and
        // genuinely above one org's share (otherwise the burst never left the
        // per-org lane and the global ceiling was not exercised at all).
        expect(envelope.containerSamples).toBeGreaterThan(10);
        expect(
          envelope.peakSandboxes,
          "the plane placed more concurrent containers than its global ceiling",
        ).toBeLessThanOrEqual(maxGlobalConcurrent);
        expect(
          envelope.peakSandboxes,
          "the burst never became cross-org concurrent — it did not press the global ceiling",
        ).toBeGreaterThan(maxConcurrentPerOrg);

        // (ii) BACK TO ZERO between commands, with every run still OPEN.
        const drainMs = await waitForZeroSandboxes(ownedJobs, 60_000);
        expect(drainMs, "sandbox containers outlived the burst").not.toBeNull();
        expect(await liveSandboxJobs(ownedJobs)).toEqual([]);

        // (iv) WORKER-HOST ENVELOPE, on BOTH halves of the host's exposure.
        //
        // The worker dispatches sandboxes, it does not contain them, so a
        // worker-only reading would miss the entire fleet — the sandbox
        // containers are siblings on the same host. Both are measured, and each
        // measurement is asserted to have HAPPENED: a silently-failing probe
        // reports zero usage, which would otherwise sail under every ceiling.
        expect(envelope.workerSamples).toBeGreaterThan(3);
        expect(envelope.peakWorkerMemBytes).toBeGreaterThan(0);
        expect(envelope.peakWorkerMemBytes).toBeLessThan(WORKER_MEM_CEILING_BYTES);
        expect(envelope.peakWorkerPids).toBeGreaterThan(0);
        expect(envelope.peakWorkerPids).toBeLessThanOrEqual(WORKER_PIDS_CEILING);
        expect(envelope.peakWorkerCpuPercent).toBeLessThanOrEqual(WORKER_CPU_CEILING_PERCENT);

        expect(envelope.sandboxStatSamples).toBeGreaterThan(0);
        expect(envelope.peakSandboxesMeasured).toBeGreaterThan(0);
        expect(envelope.peakSandboxMemBytes).toBeGreaterThan(0);
        // The FLEET is bounded by the global ceiling times the per-container
        // caps — the plane's actual promise. Measured, not derived.
        expect(envelope.peakSandboxMemBytes).toBeLessThanOrEqual(
          maxGlobalConcurrent * DEFAULT_SANDBOX_LIMITS.memoryMb * 1024 * 1024,
        );
        expect(envelope.peakSandboxPids).toBeLessThanOrEqual(
          maxGlobalConcurrent * DEFAULT_SANDBOX_LIMITS.pidsLimit,
        );
        expect(envelope.peakSandboxCpuPercent).toBeLessThanOrEqual(
          maxGlobalConcurrent * DEFAULT_SANDBOX_LIMITS.cpus * 100 * CPU_MEASUREMENT_SLACK,
        );

        // (iii, continued) NEVER LOST — cross-checked against the DURABLE,
        // ACKed spool rather than against the wire replies the assertions above
        // already used. One record per attempt, correlated on the voucher's
        // per-command id AND on the exact command text.
        const spool = await drainAndAck();
        expect(spool.relayed).toBe(true);
        expect(spool.durable, "the compose broker's spool is not durable").toBe(true);
        expect(spool.refusedReservations).toBe(0);
        expect(spool.recoveredUnknown).toBe(0);
        expect(spool.droppedAudit).toBe(0);
        const byCommandId = new Map(
          spool.records.filter((r) => r.commandId).map((r) => [r.commandId as string, r]),
        );
        const missing = submissions
          .filter((s) => !byCommandId.has(s.voucherCommandId))
          .map((s) => s.command);
        expect(missing, "commands with no audit record — the trail lost them").toEqual([]);
        for (const submission of submissions) {
          const record = byCommandId.get(submission.voucherCommandId)!;
          expect(record.command).toBe(submission.command);
          expect(record.jobId).toBe(submission.run.jobId);
          expect(record.orgId).toBe(submission.run.orgId);
          expect(record.decision).toBe("executed");
          expect(record.deliveryKey).toBeTruthy();
        }
        // Exactly one delivery slot per attempt: no duplicates, no extras.
        expect(new Set(spool.records.map((r) => r.deliveryKey)).size).toBe(
          spool.records.length,
        );
        expect(spool.records).toHaveLength(BURST_TOTAL);

        // The recorded envelope, for the acceptance evidence.
        console.log(
          `[AC7 burst] ${BURST_TOTAL} commands / ${runs.length} runs / ${ORG_COUNT} orgs in ${burstMs}ms | ` +
            `peak sandboxes ${envelope.peakSandboxes} (ceiling ${maxGlobalConcurrent}, per-org ${maxConcurrentPerOrg}) | ` +
            `drained to zero in ${drainMs}ms | ` +
            `worker peak mem ${mib(envelope.peakWorkerMemBytes)} / cpu ${envelope.peakWorkerCpuPercent}% / pids ${envelope.peakWorkerPids} | ` +
            `sandbox FLEET peak mem ${mib(envelope.peakSandboxMemBytes)} / cpu ${envelope.peakSandboxCpuPercent}% / ` +
            `pids ${envelope.peakSandboxPids} across up to ${envelope.peakSandboxesMeasured} containers ` +
            `(fleet ceiling ${maxGlobalConcurrent} x ${DEFAULT_SANDBOX_LIMITS.memoryMb}MiB / ` +
            `${maxGlobalConcurrent} x ${DEFAULT_SANDBOX_LIMITS.pidsLimit} pids) | ` +
            `samples ${envelope.containerSamples} container / ${envelope.workerSamples} worker / ` +
            `${envelope.sandboxStatSamples} sandbox-fleet`,
        );
      } finally {
        await closeRuns(runs);
      }
    },
    900_000,
  );
});

// ===========================================================================
// 1b. A CONTAINER EXISTS ONLY WHILE A COMMAND RUNS
// ===========================================================================

describe("1b. between commands, the run holds no container at all", () => {
  it(
    "sequential commands on one open run: zero containers BETWEEN each",
    async () => {
      // The burst arm proves the fleet drains once the burst is over. This arm
      // proves the narrower, literal claim: BETWEEN two commands of the SAME
      // still-open run, nothing is running. Only a sequential walk can observe
      // that transition — under a burst the pipeline is never idle.
      const runs: OpenRun[] = [];
      try {
        const run = await openRun("org-load-between", `load-between-${randomUUID()}`);
        runs.push(run);
        const gaps: number[] = [];
        for (let step = 0; step < 4; step += 1) {
          expect(
            await liveSandboxJobs(ownedJobs),
            `a container was alive BEFORE command ${step} started`,
          ).toEqual([]);
          const result = await submit(run, `sleep 1; echo step-${step}`).result;
          expect(result.ok).toBe(true);
          if (result.ok) expect(result.result.stdout.trim()).toBe(`step-${step}`);
          const drainedMs = await waitForZeroSandboxes(ownedJobs, 30_000);
          expect(drainedMs, `a container outlived command ${step}`).not.toBeNull();
          if (drainedMs !== null) gaps.push(drainedMs);
        }
        console.log(
          `[AC7 between] 4 sequential commands on one open run; container count returned to ` +
            `zero after each (drain ${gaps.join("ms, ")}ms)`,
        );
      } finally {
        await closeRuns(runs);
        await drainAndAck();
      }
    },
    900_000,
  );
});

// ===========================================================================
// 2. QUEUE SATURATION — bounded, and the overflow is REFUSED, never dropped
// ===========================================================================

describe("2. past the queue ceiling: refused, audited, never silently dropped", () => {
  it(
    "the overflow is refused queue_saturated and every refusal is on the spool",
    async () => {
      const { maxConcurrentPerOrg, maxQueuedPerOrg } = DEFAULT_BROKER_QUOTAS;
      const OVERFLOW = 4;
      const runs: OpenRun[] = [];
      try {
        const run = await openRun("org-load-saturate", `load-saturate-${randomUUID()}`);
        runs.push(run);

        // OCCUPY every execution permit FIRST and confirm the containers are
        // really placed. Firing blockers and followers together would race:
        // whichever commands happened to win the permits would decide how fast
        // the queue drained, and the refusal count would stop being a property
        // of the ceiling.
        // The blockers must still be RUNNING while all 20 followers reach
        // admission, or the exact split stops being a property of the ceiling
        // and becomes a property of how fast the queue drained.
        const blockers = Array.from({ length: maxConcurrentPerOrg }, (_, i) =>
          submit(run, `sleep 25; echo blocker-${i}`),
        );
        expect(
          await waitForLiveSandboxes(ownedJobs, maxConcurrentPerOrg, 60_000),
          "the blocking commands never reached the sandbox",
        ).toBe(true);

        // Now fill the queue exactly, and overflow it.
        const followers = Array.from({ length: maxQueuedPerOrg + OVERFLOW }, (_, i) =>
          submit(run, `echo follower-${i}`),
        );
        const followerResults = await Promise.all(followers.map((f) => f.result));
        const refused = followerResults.filter(
          (r) => !r.ok && r.reason === "queue_saturated",
        );
        const admitted = followerResults.filter((r) => r.ok);
        const unexpected = followerResults
          .filter((r) => !r.ok && r.reason !== "queue_saturated")
          .map((r) => (r.ok ? "" : `${r.reason}: ${r.message}`));
        expect(unexpected).toEqual([]);
        // THE INVARIANT, not a stopwatch. The safety property is that the queue
        // is BOUNDED: it never admits more than the ceiling, the overflow is
        // refused rather than buffered, and every submission is answered. The
        // exact split additionally depends on all 20 RPCs reaching admission
        // while the blockers still hold their permits — true here (25s of
        // blocker against milliseconds of arrival), but asserting it as an
        // equality would make an unrelated host stall look like a broken
        // ceiling. So: bounded above, refusal proven to fire, nothing lost.
        expect(admitted.length).toBeLessThanOrEqual(maxQueuedPerOrg);
        expect(refused.length).toBeGreaterThan(0);
        expect(refused.length).toBeLessThanOrEqual(OVERFLOW + maxConcurrentPerOrg);
        expect(admitted.length + refused.length).toBe(maxQueuedPerOrg + OVERFLOW);

        const blockerResults = await Promise.all(blockers.map((b) => b.result));
        expect(blockerResults.every((r) => r.ok)).toBe(true);
        expect(await waitForZeroSandboxes(ownedJobs, 60_000)).not.toBeNull();

        // A REFUSAL IS A RECORD. The whole attempt set — executed and refused
        // alike — is on the durable spool, correlated one-to-one.
        const spool = await drainAndAck();
        const all = [...blockers, ...followers];
        const byCommandId = new Map(
          spool.records.filter((r) => r.commandId).map((r) => [r.commandId as string, r]),
        );
        expect(spool.records).toHaveLength(all.length);
        expect(
          all.filter((s) => !byCommandId.has(s.voucherCommandId)).map((s) => s.command),
        ).toEqual([]);
        // PER-COMMAND, not aggregate: each wire answer must match ITS OWN audit
        // record's decision. Comparing counts alone would pass even if two
        // commands had their executed/refused verdicts swapped.
        const wireResults = new Map<string, ExecResult>();
        for (const [index, submission] of blockers.entries()) {
          wireResults.set(submission.voucherCommandId, blockerResults[index]);
        }
        for (const [index, submission] of followers.entries()) {
          wireResults.set(submission.voucherCommandId, followerResults[index]);
        }
        const mismatched: string[] = [];
        for (const submission of all) {
          const record = byCommandId.get(submission.voucherCommandId)!;
          const wire = wireResults.get(submission.voucherCommandId)!;
          const expected = wire.ok ? "executed" : "refused";
          if (record.decision !== expected) {
            mismatched.push(
              `${submission.command}: wire says ${expected}, spool says ${record.decision}`,
            );
          }
          if (!wire.ok && record.reason !== wire.reason) {
            mismatched.push(
              `${submission.command}: wire reason ${wire.reason}, spool reason ${record.reason}`,
            );
          }
          if (record.command !== submission.command) {
            mismatched.push(`${submission.command}: spool recorded a different command text`);
          }
        }
        expect(
          mismatched,
          "the durable trail disagrees with what the caller was told",
        ).toEqual([]);
        const refusedRecords = spool.records.filter((r) => r.reason === "queue_saturated");
        expect(refusedRecords).toHaveLength(refused.length);
        for (const record of refusedRecords) expect(record.decision).toBe("refused");
        expect(spool.refusedReservations).toBe(0);
        expect(spool.droppedAudit).toBe(0);

        console.log(
          `[AC7 saturation] permits ${maxConcurrentPerOrg} / queue ${maxQueuedPerOrg} / overflow ${OVERFLOW} ` +
            `=> admitted ${admitted.length}, refused ${refused.length}, audited ${spool.records.length}`,
        );
      } finally {
        await closeRuns(runs);
      }
    },
    900_000,
  );
});

// ===========================================================================
// 3. IDLE RUNS HOLD NO COMPUTE
// ===========================================================================

describe("3. idle runs hold no compute, and the reaper closes them", () => {
  it(
    "N open idle runs hold ZERO containers; a run with work in flight is never reaped",
    async () => {
      const IDLE_RUNS = 5;
      const runs: OpenRun[] = [];
      try {
        // Start from a broker with no open job at all: the sweep below is
        // asserted on an EXACT count, and a straggler another arm failed to
        // close would make that count someone else's business.
        await app.closeIdleJobs(0);
        for (let i = 0; i < IDLE_RUNS; i += 1) {
          runs.push(await openRun("org-load-idle", `load-idle-${i}-${randomUUID()}`));
        }
        // Each run does a little work, then goes idle. An open job that never
        // ran anything would prove nothing about what a USED run holds.
        for (const run of runs) {
          const result = await submit(run, `echo idle-ready`).result;
          expect(result.ok).toBe(true);
        }

        // ZERO CONTAINERS while five runs stay open: the container's lifetime is
        // the COMMAND's, not the run's.
        expect(await waitForZeroSandboxes(ownedJobs, 30_000)).not.toBeNull();
        await sleep(1_500);
        expect(await liveSandboxJobs(ownedJobs)).toEqual([]);

        // WORK IN FLIGHT IS NEVER REAPED. A sixth run holds a live command while
        // the sweep runs; the five idle runs go, it stays.
        const busy = await openRun("org-load-idle", `load-idle-busy-${randomUUID()}`);
        runs.push(busy);
        // Long enough that no scheduler or RPC stall can let it retire before
        // the sweep is handled — a busy run that finished first would be
        // legitimately reapable, and the arm would read as a reaper bug.
        const inFlight = submit(busy, "sleep 40; echo still-working").result;
        expect(await waitForLiveSandboxes(ownedJobs, 1, 60_000)).toBe(true);

        const closed = await app.closeIdleJobs(1_000);
        expect(
          closed,
          "the sweep did not close exactly the idle runs (or reaped the busy one)",
        ).toBe(IDLE_RUNS);

        // The busy run finished its command normally — the sweep never touched it.
        const busyResult = await inFlight;
        expect(busyResult.ok).toBe(true);
        if (busyResult.ok) expect(busyResult.result.stdout.trim()).toBe("still-working");

        // A reaped run is gone: a further command on it is refused, not run.
        const reaped = runs[0];
        const afterReap = await submit(reaped, "echo should-not-run").result;
        expect(afterReap.ok).toBe(false);
        if (!afterReap.ok) {
          expect(["unknown_job", "job_terminated"]).toContain(afterReap.reason);
        }

        // Nothing this battery owns is still running anywhere on the host.
        expect(await liveSandboxJobs(ownedJobs)).toEqual([]);
        for (const run of runs.slice(0, IDLE_RUNS)) ownedJobs.delete(run.jobId);

        // Now idle, the busy run is reapable too.
        await sleep(1_500);
        expect(await app.closeIdleJobs(1_000)).toBe(1);
        ownedJobs.delete(busy.jobId);

        console.log(
          `[AC7 idle] ${IDLE_RUNS} idle runs held 0 containers and were reaped; ` +
            `1 run with a command in flight survived the same sweep`,
        );
      } finally {
        await closeRuns(runs);
        await drainAndAck();
      }
    },
    900_000,
  );
});
