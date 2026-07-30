// The broker's per-command authorization boundary — integration battery
// (exec-plane, epic #1705).
//
// These exercise the BROKER against real signed vouchers (real Ed25519, via the
// shared fixture): the pre-dispatch gate, the POST-QUEUE freshness gate and its
// one-shot revalidation, per-commandId idempotency, and the fact that the
// deployment egress clamp is what actually reaches the gateway and the worker —
// not the tenant's signed tier.

import { beforeEach, describe, expect, it } from "vitest";

import {
  mintExecutionSession,
  sealExecutionSession,
} from "@cinatra-ai/llm/execution-plane";

import { ExecutionBroker } from "../broker";
import type {
  EgressGatewayEndpoint,
  ExecutionAuditRecord,
  SandboxCommandResult,
  SandboxCommandSpec,
  SandboxWorker,
} from "../types";
import type { DockerCli } from "../docker-cli";
import {
  makeVerifier,
  openVouched,
  signVoucher,
  claimsFor,
  voucherFor,
  FOREIGN_VOUCHER_PRIVATE_KEY,
  TEST_BROKER_AUD,
} from "./support/voucher-fixture";

const SECRET = "voucher-boundary-secret";
const TTL = 30_000;
const SKEW = 5_000;

function carrierFor(runId = "run-1"): string {
  return sealExecutionSession(
    mintExecutionSession({ orgId: "org-1", userId: "user-1", surface: "agent_run", runId }),
    { secret: SECRET },
  );
}

/** Docker seam that pretends volume ops succeed (no docker in unit tests). */
const fakeDocker: DockerCli = async (args) => ({
  exitCode: 0,
  stdout: args[0] === "volume" && args[1] === "create" ? args[args.length - 1] : "",
  stderr: "",
  stdioOverflow: false,
  timedOut: false,
});

/** A worker that can be told to BLOCK on a given command, so a queue forms. */
function gatedWorker() {
  const specs: SandboxCommandSpec[] = [];
  const gates = new Map<string, () => void>();
  const worker: SandboxWorker = {
    async runCommand(spec): Promise<SandboxCommandResult> {
      specs.push(spec);
      if (spec.command.startsWith("hold-")) {
        await new Promise<void>((resolve) => gates.set(spec.command, resolve));
      }
      return {
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        termination: "exited",
        wallMs: 1,
        imageDigest: "sha256:test",
        workspaceKb: 4,
      };
    },
  };
  return {
    worker,
    specs,
    async release(command: string): Promise<void> {
      // The gate is installed by the worker call itself, so wait for it.
      for (let i = 0; i < 200 && !gates.has(command); i++) {
        await new Promise((r) => setTimeout(r, 1));
      }
      gates.get(command)?.();
    },
    isHolding(command: string): boolean {
      return gates.has(command);
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

type BrokerBits = {
  broker: ExecutionBroker;
  audits: ExecutionAuditRecord[];
  clock: { now: number };
  registered: Array<{ mode: string; allowlist: string[]; maxBytesPerJob: number }>;
};

function makeBroker(
  over: Partial<ConstructorParameters<typeof ExecutionBroker>[0]> = {},
  opts: { nonces?: string[] } = {},
): BrokerBits {
  const audits: ExecutionAuditRecord[] = [];
  const clock = { now: 1_700_000_000_000 };
  const registered: BrokerBits["registered"] = [];
  const nonces = [...(opts.nonces ?? [])];
  const broker = new ExecutionBroker({
    worker: gatedWorker().worker,
    auditSink: (record) => {
      audits.push(record);
    },
    livenessProbe: async () => "alive",
    voucherVerifier: makeVerifier(),
    egressPolicyResolver: () => ({ mode: "none" }),
    docker: fakeDocker,
    nowMs: () => clock.now,
    nonceFactory: () => nonces.shift() ?? "unexpected-nonce",
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      registered.push(JSON.parse(String(init?.body)));
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch,
    ...over,
  });
  return { broker, audits, clock, registered };
}

/** Mint a voucher pinned to this suite's carrier identity + a chosen clock. */
function vouch(
  jobId: string,
  command: string,
  clock: { now: number },
  over: Parameters<typeof voucherFor>[2] = {},
): string {
  return signVoucher(
    claimsFor(jobId, command, {
      orgId: "org-1",
      userId: "user-1",
      surface: "agent_run",
      runId: "run-1",
      iat: clock.now,
      exp: clock.now + TTL,
      ...over,
    }),
    over.signWith ?? undefined,
  );
}

let priorSecret: string | undefined;
beforeEach(() => {
  priorSecret = process.env.EXECUTION_BROKER_SECRET;
  process.env.EXECUTION_BROKER_SECRET = SECRET;
  return () => {
    if (priorSecret === undefined) delete process.env.EXECUTION_BROKER_SECRET;
    else process.env.EXECUTION_BROKER_SECRET = priorSecret;
  };
});

describe("the voucher gate runs BEFORE anything else", () => {
  it("refuses a MISSING voucher without probing liveness or the hygiene hook", async () => {
    let probes = 0;
    let hygieneCalls = 0;
    const { broker, audits } = makeBroker({
      livenessProbe: async () => {
        probes += 1;
        return "alive";
      },
      commandPolicy: () => {
        hygieneCalls += 1;
        return { allowed: true };
      },
    });
    const opened = await openVouched(broker, carrierFor());
    if (!opened.ok) throw new Error("open failed");
    const probesAfterOpen = probes;

    expect(await broker.exec(opened.jobId, "echo hi", "")).toMatchObject({
      ok: false,
      reason: "voucher_missing",
    });
    // Nothing downstream of the boundary was consulted.
    expect(probes).toBe(probesAfterOpen);
    expect(hygieneCalls).toBe(0);
    // …and the refusal is audited with the precise rejection for the operator.
    expect(audits.at(-1)).toMatchObject({
      decision: "refused",
      reason: "voucher_missing",
      voucherRejection: "missing",
    });
  });

  it("refuses a FORGED voucher (valid shape, untrusted key) as voucher_invalid", async () => {
    const { broker, audits, clock } = makeBroker();
    const opened = await openVouched(broker, carrierFor());
    if (!opened.ok) throw new Error("open failed");
    const forged = vouch(opened.jobId, "echo hi", clock, {
      signWith: FOREIGN_VOUCHER_PRIVATE_KEY,
    });
    expect(await broker.exec(opened.jobId, "echo hi", forged)).toMatchObject({
      ok: false,
      reason: "voucher_invalid",
    });
    expect(audits.at(-1)).toMatchObject({ voucherRejection: "bad_signature" });
  });

  it("refuses a WRONG-AUD voucher, a COMMAND-HASH mismatch and a REPLAY", async () => {
    const { broker, audits, clock } = makeBroker();
    const opened = await openVouched(broker, carrierFor());
    if (!opened.ok) throw new Error("open failed");

    expect(
      await broker.exec(
        opened.jobId,
        "echo hi",
        vouch(opened.jobId, "echo hi", clock, { aud: "urn:cinatra:execution-broker:elsewhere" }),
      ),
    ).toMatchObject({ ok: false, reason: "voucher_invalid" });
    expect(audits.at(-1)).toMatchObject({ voucherRejection: "wrong_audience" });

    // A voucher for a DIFFERENT command lifted onto this one.
    const forOther = vouch(opened.jobId, "echo other", clock);
    expect(await broker.exec(opened.jobId, "echo hi", forOther)).toMatchObject({
      ok: false,
      reason: "voucher_invalid",
    });
    expect(audits.at(-1)).toMatchObject({ voucherRejection: "command_mismatch" });

    // Replay: the SAME voucher presented twice.
    const once = vouch(opened.jobId, "echo twice", clock);
    expect((await broker.exec(opened.jobId, "echo twice", once)).ok).toBe(true);
    expect(await broker.exec(opened.jobId, "echo twice", once)).toMatchObject({
      ok: false,
      reason: "voucher_replayed",
    });
  });

  it("refuses a PRE-EXPIRED voucher with voucher_expired", async () => {
    const { broker, clock } = makeBroker();
    const opened = await openVouched(broker, carrierFor());
    if (!opened.ok) throw new Error("open failed");
    const stale = vouch(opened.jobId, "echo hi", clock, {
      iat: clock.now - 10 * TTL,
      exp: clock.now - TTL,
    });
    expect(await broker.exec(opened.jobId, "echo hi", stale)).toMatchObject({
      ok: false,
      reason: "voucher_expired",
    });
  });

  it("refuses a voucher lifted onto ANOTHER JOB (a different tenant's session)", async () => {
    const { broker, clock, audits } = makeBroker();
    const mine = await openVouched(broker, carrierFor("run-mine"));
    const theirs = await openVouched(
      broker,
      sealExecutionSession(
        mintExecutionSession({
          orgId: "org-2",
          userId: "user-2",
          surface: "agent_run",
          runId: "run-theirs",
        }),
        { secret: SECRET },
      ),
    );
    if (!mine.ok || !theirs.ok) throw new Error("open failed");
    // A voucher minted for MY job, presented on THEIRS.
    const lifted = vouch(mine.jobId, "echo hi", clock, { runId: "run-mine" });
    expect(await broker.exec(theirs.jobId, "echo hi", lifted)).toMatchObject({
      ok: false,
      reason: "voucher_invalid",
    });
    expect(audits.at(-1)).toMatchObject({ voucherRejection: "job_mismatch" });
  });
});

describe("post-queue freshness — exactly ONE remint, then exhausted", () => {
  it("expiring during the admission wait releases the permit and challenges once", async () => {
    const gated = gatedWorker();
    const { broker, audits, clock } = makeBroker(
      {
        worker: gated.worker,
        quotas: { maxConcurrentPerOrg: 1, maxQueuedPerOrg: 8 },
      },
      { nonces: ["challenge-1"] },
    );
    const opened = await openVouched(broker, carrierFor());
    if (!opened.ok) throw new Error("open failed");

    // A occupies the single slot.
    const a = broker.exec(opened.jobId, "hold-A", vouch(opened.jobId, "hold-A", clock));
    await tick();
    expect(broker.executingCount).toBe(1);

    // B queues behind it, authorized NOW.
    const bVoucher = vouch(opened.jobId, "cmd-B", clock, { commandId: "cmd-b" });
    const b = broker.exec(opened.jobId, "cmd-B", bVoucher);
    await tick();

    // The wait outlives B's authorization.
    clock.now += TTL + SKEW + 1;
    await gated.release("hold-A");
    await a;

    const answered = await b;
    expect(answered).toMatchObject({
      ok: false,
      reason: "revalidation_required",
      revalidation: { commandId: "cmd-b", nonce: "challenge-1", aud: TEST_BROKER_AUD },
    });
    // The permit was released BEFORE answering — a command going nowhere must not
    // hold a concurrency slot across the client's remint round-trip.
    expect(broker.executingCount).toBe(0);
    // B never reached the sandbox.
    expect(gated.specs.map((s) => s.command)).toEqual(["hold-A"]);
    expect(audits.at(-1)).toMatchObject({
      decision: "refused",
      reason: "revalidation_required",
      commandId: "cmd-b",
      voucherRejection: "expired",
    });
  });

  it("the remint must carry the broker's challenge nonce — any other nonce is refused", async () => {
    const gated = gatedWorker();
    const { broker, clock } = makeBroker(
      { worker: gated.worker, quotas: { maxConcurrentPerOrg: 1, maxQueuedPerOrg: 8 } },
      { nonces: ["challenge-1"] },
    );
    const opened = await openVouched(broker, carrierFor());
    if (!opened.ok) throw new Error("open failed");

    const a = broker.exec(opened.jobId, "hold-A", vouch(opened.jobId, "hold-A", clock));
    await tick();
    const b = broker.exec(
      opened.jobId,
      "cmd-B",
      vouch(opened.jobId, "cmd-B", clock, { commandId: "cmd-b" }),
    );
    await tick();
    clock.now += TTL + SKEW + 1;
    await gated.release("hold-A");
    await a;
    expect((await b).ok).toBe(false);

    // A fresh, perfectly valid voucher that does NOT answer the challenge.
    const selfChosen = vouch(opened.jobId, "cmd-B", clock, {
      commandId: "cmd-b",
      nonce: "self-chosen",
    });
    expect(await broker.exec(opened.jobId, "cmd-B", selfChosen)).toMatchObject({
      ok: false,
      reason: "voucher_replayed",
    });
  });

  it("a SECOND post-queue expiry is revalidation_exhausted, not another challenge", async () => {
    const gated = gatedWorker();
    const { broker, audits, clock } = makeBroker(
      { worker: gated.worker, quotas: { maxConcurrentPerOrg: 1, maxQueuedPerOrg: 8 } },
      { nonces: ["challenge-1", "challenge-2"] },
    );
    const opened = await openVouched(broker, carrierFor());
    if (!opened.ok) throw new Error("open failed");

    // --- round 1: expire while queued ⇒ challenge -------------------------
    const a = broker.exec(opened.jobId, "hold-A", vouch(opened.jobId, "hold-A", clock));
    await tick();
    const b1 = broker.exec(
      opened.jobId,
      "cmd-B",
      vouch(opened.jobId, "cmd-B", clock, { commandId: "cmd-b" }),
    );
    await tick();
    clock.now += TTL + SKEW + 1;
    await gated.release("hold-A");
    await a;
    const first = await b1;
    if (first.ok || first.reason !== "revalidation_required" || !first.revalidation) {
      throw new Error("expected a revalidation challenge");
    }

    // --- round 2: the remint expires while queued too ⇒ exhausted ---------
    const c = broker.exec(opened.jobId, "hold-C", vouch(opened.jobId, "hold-C", clock));
    await tick();
    const b2 = broker.exec(
      opened.jobId,
      "cmd-B",
      vouch(opened.jobId, "cmd-B", clock, {
        commandId: "cmd-b",
        nonce: first.revalidation.nonce,
      }),
    );
    await tick();
    clock.now += TTL + SKEW + 1;
    await gated.release("hold-C");
    await c;

    const second = await b2;
    expect(second).toMatchObject({ ok: false, reason: "revalidation_exhausted" });
    expect("revalidation" in second && second.revalidation).toBeFalsy();
    // Still never dispatched, and the second nonce was never spent.
    expect(gated.specs.map((s) => s.command)).toEqual(["hold-A", "hold-C"]);
    expect(broker.executingCount).toBe(0);
    expect(audits.at(-1)).toMatchObject({
      decision: "refused",
      reason: "revalidation_exhausted",
      commandId: "cmd-b",
    });
  });

  it("a remint that arrives IN TIME dispatches normally", async () => {
    const gated = gatedWorker();
    const { broker, clock } = makeBroker(
      { worker: gated.worker, quotas: { maxConcurrentPerOrg: 1, maxQueuedPerOrg: 8 } },
      { nonces: ["challenge-1"] },
    );
    const opened = await openVouched(broker, carrierFor());
    if (!opened.ok) throw new Error("open failed");

    const a = broker.exec(opened.jobId, "hold-A", vouch(opened.jobId, "hold-A", clock));
    await tick();
    const b1 = broker.exec(
      opened.jobId,
      "cmd-B",
      vouch(opened.jobId, "cmd-B", clock, { commandId: "cmd-b" }),
    );
    await tick();
    clock.now += TTL + SKEW + 1;
    await gated.release("hold-A");
    await a;
    const first = await b1;
    if (first.ok || !("revalidation" in first) || !first.revalidation) {
      throw new Error("expected a revalidation challenge");
    }
    // Remint at the current clock, carrying the challenge nonce.
    const retry = await broker.exec(
      opened.jobId,
      "cmd-B",
      vouch(opened.jobId, "cmd-B", clock, {
        commandId: "cmd-b",
        nonce: first.revalidation.nonce,
      }),
    );
    expect(retry.ok).toBe(true);
    expect(gated.specs.map((s) => s.command)).toEqual(["hold-A", "cmd-B"]);
  });
});

describe("freshness is re-checked immediately before dispatch (Codex round 2)", () => {
  it("a voucher that expires during the pre-dispatch awaits does NOT reach the sandbox", async () => {
    const gated = gatedWorker();
    // The post-queue check alone is not enough: the liveness re-probe and the
    // gateway registration are awaited calls, and a slow one can carry the
    // voucher past its expiry between "admission won" and "running".
    const { broker, audits, clock } = makeBroker(
      {
        worker: gated.worker,
        livenessProbe: async () => {
          // A slow store read that outlives the voucher.
          clock.now += TTL + SKEW + 1;
          return "alive";
        },
      },
      { nonces: ["challenge-1"] },
    );
    const opened = await openVouched(broker, carrierFor());
    if (!opened.ok) throw new Error("open failed");

    const result = await broker.exec(
      opened.jobId,
      "echo hi",
      vouch(opened.jobId, "echo hi", clock, { commandId: "cmd-slow" }),
    );
    expect(result).toMatchObject({
      ok: false,
      reason: "revalidation_required",
      revalidation: { commandId: "cmd-slow", nonce: "challenge-1" },
    });
    expect(gated.specs).toHaveLength(0);
    expect(broker.executingCount).toBe(0);
    expect(audits.at(-1)).toMatchObject({ reason: "revalidation_required" });
  });

  it("an ANSWERED challenge is cleared even when the command is then refused early", async () => {
    const gated = gatedWorker();
    let blockHygiene = false;
    const { broker, clock } = makeBroker(
      {
        worker: gated.worker,
        quotas: { maxConcurrentPerOrg: 1, maxQueuedPerOrg: 8 },
        commandPolicy: () =>
          blockHygiene ? { allowed: false, reason: "blocked" } : { allowed: true },
      },
      { nonces: ["challenge-1"] },
    );
    const opened = await openVouched(broker, carrierFor());
    if (!opened.ok) throw new Error("open failed");

    // Earn a challenge.
    const a = broker.exec(opened.jobId, "hold-A", vouch(opened.jobId, "hold-A", clock));
    await tick();
    const b1 = broker.exec(
      opened.jobId,
      "cmd-B",
      vouch(opened.jobId, "cmd-B", clock, { commandId: "cmd-b" }),
    );
    await tick();
    clock.now += TTL + SKEW + 1;
    await gated.release("hold-A");
    await a;
    const first = await b1;
    if (first.ok || !("revalidation" in first) || !first.revalidation) {
      throw new Error("expected a challenge");
    }

    // Answer the challenge with a valid remint, but have the command refused
    // AFTER verification. The challenge nonce is now consumed, so if the pin
    // survived, the commandId would be permanently unusable.
    blockHygiene = true;
    expect(
      await broker.exec(
        opened.jobId,
        "cmd-B",
        vouch(opened.jobId, "cmd-B", clock, {
          commandId: "cmd-b",
          nonce: first.revalidation.nonce,
        }),
      ),
    ).toMatchObject({ ok: false, reason: "command_blocked" });

    // A fresh voucher with its OWN nonce is now accepted again.
    blockHygiene = false;
    const retry = await broker.exec(
      opened.jobId,
      "cmd-B",
      vouch(opened.jobId, "cmd-B", clock, { commandId: "cmd-b", nonce: "own-nonce" }),
    );
    expect(retry.ok).toBe(true);
  });
});

describe("a throwing host seam cannot escape exec (Codex round 2)", () => {
  it("a THROWING liveness probe keeps the recorded alive posture and records it", async () => {
    const gated = gatedWorker();
    const { broker, audits, clock } = makeBroker({
      worker: gated.worker,
      livenessProbe: async () => {
        throw new Error("pg down");
      },
    });
    // openJob probes too; a throw there must not break the open either.
    const opened = await openVouched(broker, carrierFor());
    if (!opened.ok) throw new Error("open failed");
    const result = await broker.exec(
      opened.jobId,
      "echo hi",
      vouch(opened.jobId, "echo hi", clock),
    );
    expect(result.ok).toBe(true);
    expect(audits.at(-1)).toMatchObject({ decision: "executed", livenessDegraded: true });
  });

  it("a THROWING stdio/audit sink cannot turn a completed execution into a throw", async () => {
    const gated = gatedWorker();
    const { broker, clock } = makeBroker({
      worker: gated.worker,
      auditSink: () => {
        throw new Error("audit transport down");
      },
      stdioSink: () => {
        throw new Error("retention down");
      },
    });
    const opened = await openVouched(broker, carrierFor());
    if (!opened.ok) throw new Error("open failed");
    const result = await broker.exec(
      opened.jobId,
      "echo hi",
      vouch(opened.jobId, "echo hi", clock),
    );
    expect(result.ok).toBe(true);
    expect(gated.specs).toHaveLength(1);
  });
});

describe("per-commandId idempotency", () => {
  it("a commandId that already DISPATCHED never runs again, even under a fresh voucher", async () => {
    const gated = gatedWorker();
    const { broker, clock } = makeBroker({ worker: gated.worker });
    const opened = await openVouched(broker, carrierFor());
    if (!opened.ok) throw new Error("open failed");

    expect(
      (
        await broker.exec(
          opened.jobId,
          "echo once",
          vouch(opened.jobId, "echo once", clock, { commandId: "cmd-x" }),
        )
      ).ok,
    ).toBe(true);
    // A brand-new, perfectly valid voucher — different nonce, same commandId.
    expect(
      await broker.exec(
        opened.jobId,
        "echo once",
        vouch(opened.jobId, "echo once", clock, { commandId: "cmd-x", nonce: "fresh" }),
      ),
    ).toMatchObject({ ok: false, reason: "command_replayed" });
    expect(gated.specs).toHaveLength(1);
  });

  it("two CONCURRENT submissions of one commandId dispatch exactly once", async () => {
    const gated = gatedWorker();
    const { broker, clock } = makeBroker({ worker: gated.worker });
    const opened = await openVouched(broker, carrierFor());
    if (!opened.ok) throw new Error("open failed");

    // Both vouchers are individually valid and individually un-replayed: only the
    // commandId is shared. Without a synchronous in-flight claim both would pass
    // the executed-check (there are awaits before the dispatch-time claim) and the
    // command would run twice.
    const [one, two] = await Promise.all([
      broker.exec(
        opened.jobId,
        "hold-A",
        vouch(opened.jobId, "hold-A", clock, { commandId: "cmd-dup", nonce: "n-1" }),
      ),
      (async () => {
        await tick();
        return broker.exec(
          opened.jobId,
          "hold-A",
          vouch(opened.jobId, "hold-A", clock, { commandId: "cmd-dup", nonce: "n-2" }),
        );
      })(),
      (async () => {
        await tick();
        await gated.release("hold-A");
      })(),
    ]);
    const outcomes = [one, two];
    expect(outcomes.filter((r) => r.ok)).toHaveLength(1);
    expect(outcomes.filter((r) => !r.ok && r.reason === "command_replayed")).toHaveLength(1);
    expect(gated.specs).toHaveLength(1);
  });
});

describe("the deployment egress clamp is what actually runs", () => {
  const gateway: EgressGatewayEndpoint = {
    host: "127.0.0.1",
    port: 3128,
    adminUrl: "http://127.0.0.1:3129",
    controlSecret: "control",
  };

  it("clamps the SIGNED tier and registers the CLAMPED policy at the gateway", async () => {
    const gated = gatedWorker();
    const { broker, audits, clock, registered } = makeBroker({
      worker: gated.worker,
      gateway,
      deploymentEgressMaximum: {
        mode: "allowlist",
        allowlist: ["files.pypi.org"],
        maxBytesPerJob: 1_000,
      },
    });
    const opened = await openVouched(broker, carrierFor());
    if (!opened.ok) throw new Error("open failed");

    // The tenant's mint authorized the whole internet with a huge byte budget.
    const result = await broker.exec(
      opened.jobId,
      "curl pypi",
      vouch(opened.jobId, "curl pypi", clock, {
        egressPolicy: { mode: "default_internet", maxBytesPerJob: 10_000_000 },
      }),
    );
    expect(result.ok).toBe(true);
    // What the gateway was told — all three axes narrowed.
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({
      mode: "allowlist",
      allowlist: ["files.pypi.org"],
      maxBytesPerJob: 1_000,
    });
    // What the worker was handed.
    expect(gated.specs[0].egress).toMatchObject({ kind: "gateway", mode: "allowlist" });
    // And the clamp is AUDITED — the evidence an egress investigation needs.
    const executed = audits.at(-1);
    expect(executed).toMatchObject({ decision: "executed", effectivePolicy: { egressMode: "allowlist" } });
    expect([...(executed?.egressClamped ?? [])].sort()).toEqual([
      "allowlist",
      "max_bytes",
      "mode",
    ]);
  });

  it("a deployment maximum of `none` isolates the sandbox whatever the voucher says", async () => {
    const gated = gatedWorker();
    const { broker, audits, clock, registered } = makeBroker({
      worker: gated.worker,
      gateway,
      deploymentEgressMaximum: { mode: "none" },
    });
    const opened = await openVouched(broker, carrierFor());
    if (!opened.ok) throw new Error("open failed");
    const result = await broker.exec(
      opened.jobId,
      "curl anything",
      vouch(opened.jobId, "curl anything", clock, {
        egressPolicy: { mode: "allowlist", allowlist: ["evil.example"] },
      }),
    );
    expect(result.ok).toBe(true);
    expect(registered).toHaveLength(0); // nothing to register: no route at all
    expect(gated.specs[0].egress).toEqual({ kind: "none" });
    expect(audits.at(-1)).toMatchObject({
      effectivePolicy: { egressMode: "none" },
      egressClamped: ["mode"],
    });
  });

  it("no deployment maximum ⇒ the signed tier stands, and nothing is reported clamped", async () => {
    const gated = gatedWorker();
    const { broker, audits, clock, registered } = makeBroker({ worker: gated.worker, gateway });
    const opened = await openVouched(broker, carrierFor());
    if (!opened.ok) throw new Error("open failed");
    await broker.exec(
      opened.jobId,
      "curl pypi",
      vouch(opened.jobId, "curl pypi", clock, {
        egressPolicy: { mode: "allowlist", allowlist: ["pypi.org"] },
      }),
    );
    expect(registered[0]).toMatchObject({ mode: "allowlist", allowlist: ["pypi.org"] });
    expect(audits.at(-1)?.egressClamped).toBeUndefined();
  });

  it("the signed policy — never the resolver — decides the tier", async () => {
    const gated = gatedWorker();
    const { broker, audits, clock } = makeBroker({
      worker: gated.worker,
      gateway,
      // A resolver that would grant the whole internet is irrelevant now.
      egressPolicyResolver: () => ({ mode: "default_internet" }),
    });
    const opened = await openVouched(broker, carrierFor());
    if (!opened.ok) throw new Error("open failed");
    await broker.exec(
      opened.jobId,
      "echo hi",
      vouch(opened.jobId, "echo hi", clock, { egressPolicy: { mode: "none" } }),
    );
    expect(audits.at(-1)).toMatchObject({ effectivePolicy: { egressMode: "none" } });
    expect(gated.specs[0].egress).toEqual({ kind: "none" });
  });
});
