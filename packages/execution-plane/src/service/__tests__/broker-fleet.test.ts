/**
 * FLEET-SAFE DELIVERY — the routing half (cinatra#2266 design gap G3, slice 3).
 *
 * `broker-fleet.ts` states three invariants; this file drives each one and, for
 * each, the failure it prevents. The companion arms in `service-loopback.test.ts`
 * drive the same invariants across TWO REAL broker servers over real mTLS with
 * two real spools — those prove the property end to end; these prove the router
 * refuses correctly at every seam, including the ones a two-replica loopback
 * cannot reach (an evicted pin, an endpoint whose spool identity CHANGED under
 * it, a replica that throws mid-broadcast).
 *
 * The client is a plain object because `FleetReplicaClient` is structural on
 * purpose — the same discipline `BrokerServiceBroker` follows. What is NOT a
 * double anywhere here is the router itself.
 */

import { describe, expect, it } from "vitest";

import {
  BrokerFleetClient,
  FleetRoutingError,
  MAX_PINNED_JOBS,
  type FleetReplicaClient,
} from "../broker-fleet";
import {
  EXEC_PROTOCOL_VERSION,
  type AckAuditPayload,
  type DrainAuditResultPayload,
} from "../protocol";
import type { ExecResult, OpenJobResult } from "../../types";

type Recorder = {
  client: FleetReplicaClient;
  opens: number;
  execs: Array<{ jobId: string; command: string }>;
  closes: string[];
  terminates: string[];
  idleSweeps: number[];
  acks: AckAuditPayload[];
  drains: number;
};

function replica(opts: {
  jobId?: string;
  spoolId?: string;
  openResult?: OpenJobResult;
  execResult?: ExecResult;
  healthThrows?: Error;
  terminateThrows?: Error;
  terminated?: number;
  relayed?: boolean;
}): Recorder {
  const spoolId = opts.spoolId ?? "spool-x";
  const rec: Recorder = {
    opens: 0,
    execs: [],
    closes: [],
    terminates: [],
    idleSweeps: [],
    acks: [],
    drains: 0,
    client: {
      openJob: async (): Promise<OpenJobResult> => {
        rec.opens += 1;
        return opts.openResult ?? { ok: true, jobId: opts.jobId ?? "job-x" };
      },
      exec: async (jobId, command): Promise<ExecResult> => {
        rec.execs.push({ jobId, command });
        return (
          opts.execResult ?? {
            ok: true,
            result: {
              exitCode: 0,
              stdout: spoolId,
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
              termination: "exited",
              wallMs: 1,
              imageDigest: "sha256:feed",
              workspaceKb: 1,
            },
          }
        );
      },
      closeJob: async (jobId) => {
        rec.closes.push(jobId);
      },
      terminateJobsForRun: async (runId) => {
        rec.terminates.push(runId);
        if (opts.terminateThrows) throw opts.terminateThrows;
        return opts.terminated ?? 1;
      },
      closeIdleJobs: async (idleMs) => {
        rec.idleSweeps.push(idleMs);
        return 1;
      },
      drainAudit: async (): Promise<DrainAuditResultPayload> => {
        rec.drains += 1;
        return {
          audit: [],
          stdio: [],
          head: 0,
          spoolId,
          remaining: 0,
          durable: true,
          refusedReservations: 0,
          recoveredUnknown: 0,
          droppedAudit: 0,
          droppedStdio: 0,
          relayed: opts.relayed ?? true,
        };
      },
      ackAudit: async (payload: AckAuditPayload) => {
        rec.acks.push(payload);
        return { acked: true as const, head: payload.head, removed: 0, remaining: 0 };
      },
      health: async () => {
        if (opts.healthThrows) throw opts.healthThrows;
        return {
          protocolVersion: EXEC_PROTOCOL_VERSION,
          executingCount: 0,
          atMs: 1,
          spoolId,
        };
      },
      close: () => {},
    },
  };
  return rec;
}

function fleet(entries: Array<[string, Recorder]>, onGap?: (m: string) => void): BrokerFleetClient {
  return new BrokerFleetClient({
    replicas: entries.map(([endpoint, rec]) => ({ endpoint, client: rec.client })),
    ...(onGap ? { onGap } : {}),
  });
}

// ---------------------------------------------------------------------------
// Invariant 3 — a job's commands all reach the replica that opened it
// ---------------------------------------------------------------------------

describe("fleet routing — sticky job routing (G3, invariant 3)", () => {
  it("pins a job to the replica that answered openJob and sends every later exec there", async () => {
    const a = replica({ jobId: "job-a", spoolId: "spool-a" });
    const b = replica({ jobId: "job-b", spoolId: "spool-b" });
    const f = fleet([
      ["https://a", a],
      ["https://b", b],
    ]);

    // Round robin hands the first open to A and the second to B.
    expect(await f.openJob("carrier-1")).toEqual({ ok: true, jobId: "job-a" });
    expect(await f.openJob("carrier-2")).toEqual({ ok: true, jobId: "job-b" });
    expect(f.pinnedEndpoint("job-a")).toBe("https://a");
    expect(f.pinnedEndpoint("job-b")).toBe("https://b");

    // Interleaved commands, each landing on its OWN replica. Without the pin a
    // round-robin would send half of each job's commands to the wrong one.
    for (let i = 0; i < 4; i += 1) {
      await f.exec("job-a", `a-${i}`, "voucher");
      await f.exec("job-b", `b-${i}`, "voucher");
    }
    expect(a.execs.map((e) => e.jobId)).toEqual(["job-a", "job-a", "job-a", "job-a"]);
    expect(b.execs.map((e) => e.jobId)).toEqual(["job-b", "job-b", "job-b", "job-b"]);
  });

  it("REFUSES an unpinned job rather than guessing or broadcasting", async () => {
    const a = replica({ spoolId: "spool-a" });
    const b = replica({ spoolId: "spool-b" });
    const f = fleet([
      ["https://a", a],
      ["https://b", b],
    ]);

    const result = await f.exec("job-never-opened", "echo hi", "voucher");
    expect(result).toMatchObject({ ok: false, reason: "unknown_job" });
    // The load-bearing half: NOTHING was sent anywhere.
    expect(a.execs).toHaveLength(0);
    expect(b.execs).toHaveLength(0);
  });

  it("does not pin a job the replica REFUSED to open", async () => {
    const a = replica({ openResult: { ok: false, reason: "open_jobs_exhausted", message: "no" } });
    const f = fleet([["https://a", a]]);
    expect(await f.openJob("carrier")).toMatchObject({ ok: false });
    // A pin for an id that does not exist would be a routing entry held forever.
    expect(f.pinnedEndpoint("job-x")).toBeUndefined();
  });

  it("drops the pin on close — even when the close FAILED", async () => {
    const a = replica({ jobId: "job-a" });
    a.client.closeJob = async () => {
      throw new Error("replica went away mid-close");
    };
    const f = fleet([["https://a", a]]);
    await f.openJob("carrier");
    expect(f.pinnedEndpoint("job-a")).toBe("https://a");
    await expect(f.closeJob("job-a")).rejects.toThrow(/went away/);
    expect(f.pinnedEndpoint("job-a")).toBeUndefined();
  });

  it("evicts the OLDEST pin past the bound and fails closed on the evicted job", async () => {
    let n = 0;
    const a = replica({});
    a.client.openJob = async () => {
      n += 1;
      return { ok: true, jobId: `job-${n}` };
    };
    const f = fleet([["https://a", a]]);
    // One past the bound.
    for (let i = 0; i < MAX_PINNED_JOBS + 1; i += 1) await f.openJob("carrier");
    expect(f.pinnedEndpoint("job-1")).toBeUndefined();
    expect(f.pinnedEndpoint(`job-${MAX_PINNED_JOBS + 1}`)).toBe("https://a");
    // FAIL-CLOSED, not "route it somewhere": the evicted job is refused.
    expect(await f.exec("job-1", "echo hi", "voucher")).toMatchObject({
      ok: false,
      reason: "unknown_job",
    });
  });
});

// ---------------------------------------------------------------------------
// Invariant 2 — an ACK never leaves the replica that served the read
// ---------------------------------------------------------------------------

describe("fleet routing — the drain SESSION (G3, invariant 2)", () => {
  it("gives ONE drain target per replica and never a merged batch", async () => {
    const a = replica({ spoolId: "spool-a" });
    const b = replica({ spoolId: "spool-b" });
    const f = fleet([
      ["https://a", a],
      ["https://b", b],
    ]);
    const targets = f.drainTargets();
    expect(targets.map((t) => t.endpoint)).toEqual(["https://a", "https://b"]);
    // There is deliberately no fleet-wide drainAudit to call.
    expect((f as unknown as { drainAudit?: unknown }).drainAudit).toBeUndefined();
  });

  it("refuses a cross-replica ACK LOCALLY — the misroute never reaches the wire", async () => {
    const a = replica({ spoolId: "spool-a" });
    const b = replica({ spoolId: "spool-b" });
    const f = fleet([
      ["https://a", a],
      ["https://b", b],
    ]);
    const [targetA, targetB] = f.drainTargets();
    const batchA = await targetA!.drainAudit();
    expect(batchA.spoolId).toBe("spool-a");
    await targetB!.drainAudit();

    // A's head, presented to B. This is the exact misroute G3 names.
    await expect(targetB!.ackAudit({ spoolId: "spool-a", head: batchA.head })).rejects.toThrow(
      FleetRoutingError,
    );
    // NOTHING was sent — not "sent and refused". B's client never saw it.
    expect(b.acks).toHaveLength(0);
    // And the correctly-routed ACK still works.
    await targetA!.ackAudit({ spoolId: "spool-a", head: batchA.head });
    expect(a.acks).toEqual([{ spoolId: "spool-a", head: batchA.head }]);
  });

  it("carries the error CODE so a caller can tell a misroute from a transport fault", async () => {
    const a = replica({ spoolId: "spool-a" });
    const b = replica({ spoolId: "spool-b" });
    const f = fleet([
      ["https://a", a],
      ["https://b", b],
    ]);
    const [, targetB] = f.drainTargets();
    const batch = await targetB!.drainAudit();
    await targetB!.ackAudit({ spoolId: "spool-b", head: batch.head });
    try {
      // ANOTHER replica's spool, presented to B. Nothing about it is B's to
      // acknowledge, and after the fix above B has no pending batch either.
      await targetB!.drainAudit();
      await targetB!.ackAudit({ spoolId: "spool-a", head: 0 });
      expect.unreachable("the misrouted ACK must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FleetRoutingError);
      expect((err as FleetRoutingError).code).toBe("ack_misroute");
    }
  });

  it("does not record a spool identity for an in-process placement (relayed: false)", async () => {
    // `relayed: false` is a broker with no spool at all. Recording its empty
    // spoolId as an identity would make every later ACK look misrouted.
    const a = replica({ spoolId: "", relayed: false });
    const f = fleet([["https://a", a]]);
    const [target] = f.drainTargets();
    await target!.drainAudit();
    expect(target!.spoolId).toBeUndefined();
    // REWRITTEN for the session-state fix (Codex convergence). This used to let
    // the ACK through on the reasoning that an unknown identity should not be
    // second-guessed — but "no identity" and "no batch" are the same state here,
    // and forwarding an acknowledgement for a batch that was never served is the
    // misroute this layer exists to prevent, not a case to defer to the broker.
    await expect(target!.ackAudit({ spoolId: "whatever", head: 1 })).rejects.toThrow(
      /has not served a spooled batch/,
    );
    expect(a.acks).toHaveLength(0);
  });

  it("learns a replica's spool identity from HEALTH, without draining anything", async () => {
    const a = replica({ spoolId: "spool-a" });
    const f = fleet([["https://a", a]]);
    expect(f.observedSpoolId("https://a")).toBeUndefined();
    await f.health();
    expect(f.observedSpoolId("https://a")).toBe("spool-a");
    expect(a.drains).toBe(0);
    // ...and a target that learned an identity from HEALTH still cannot
    // acknowledge: health tells the router WHICH replica this is, it does not
    // hand it a batch. Only this target's own drain can do that.
    const [target] = f.drainTargets();
    await expect(target!.ackAudit({ spoolId: "spool-b", head: 1 })).rejects.toThrow(
      FleetRoutingError,
    );
    expect(a.acks).toHaveLength(0);
  });

  it("REPORTS a spool identity that changed under a stable endpoint", async () => {
    // A replaced replica or a remounted volume. Not an error — a redeploy does
    // this — but every record the old spool still held is now unreachable
    // through this address, and that is a gap in the trail.
    const gaps: string[] = [];
    let spoolId = "spool-old";
    const a = replica({});
    a.client.health = async () => ({
      protocolVersion: EXEC_PROTOCOL_VERSION,
      executingCount: 0,
      atMs: 1,
      spoolId,
    });
    const f = fleet([["https://a", a]], (m) => gaps.push(m));
    await f.health();
    expect(gaps).toHaveLength(0);
    spoolId = "spool-new";
    await f.health();
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain("spool-new");
    expect(gaps[0]).toContain("spool-old");
    expect(f.observedSpoolId("https://a")).toBe("spool-new");
  });
});

// ---------------------------------------------------------------------------
// Broadcast — the calls that legitimately touch every replica
// ---------------------------------------------------------------------------

describe("fleet routing — broadcast teardown", () => {
  it("asks EVERY replica to terminate a run and sums the counts", async () => {
    const a = replica({ terminated: 2 });
    const b = replica({ terminated: 3 });
    const f = fleet([
      ["https://a", a],
      ["https://b", b],
    ]);
    // One run legitimately opens jobs on several replicas, so asking only the
    // pinned one would leave containers running for a run that no longer exists.
    expect(await f.terminateJobsForRun("run-1", { removeWorkspace: true })).toBe(5);
    expect(a.terminates).toEqual(["run-1"]);
    expect(b.terminates).toEqual(["run-1"]);
  });

  it("a replica that throws does NOT abort the sweep, and the failure is reported", async () => {
    const gaps: string[] = [];
    const a = replica({ terminateThrows: new Error("unreachable"), terminated: 0 });
    const b = replica({ terminated: 4 });
    const f = fleet(
      [
        ["https://a", a],
        ["https://b", b],
      ],
      (m) => gaps.push(m),
    );
    // REWRITTEN for the partial-teardown fix (Codex convergence). The sweep
    // still asks EVERY replica — that half was always right — but it no longer
    // reports "4 terminated" for a fleet where one replica never answered and
    // may still be running the run's containers. A hard-removal caller reading
    // that number as success is exactly the outcome this now prevents.
    await expect(f.terminateJobsForRun("run-1")).rejects.toThrow(/did not reach every broker/);
    expect(a.terminates).toEqual(["run-1"]);
    expect(b.terminates).toEqual(["run-1"]);
    expect(gaps).toHaveLength(0);
  });

  it("sweeps idle jobs on every replica", async () => {
    const a = replica({});
    const b = replica({});
    const f = fleet([
      ["https://a", a],
      ["https://b", b],
    ]);
    expect(await f.closeIdleJobs(30_000)).toBe(2);
    expect(a.idleSweeps).toEqual([30_000]);
    expect(b.idleSweeps).toEqual([30_000]);
  });
});

// ---------------------------------------------------------------------------
// Construction — the misroutes refused at boot rather than at the first command
// ---------------------------------------------------------------------------

describe("fleet routing — construction refuses an unroutable fleet", () => {
  it("refuses an empty fleet at BOOT, not at the first call", () => {
    expect(() => new BrokerFleetClient({ replicas: [] })).toThrow(FleetRoutingError);
  });

  it("refuses a duplicated endpoint — one replica the router would treat as two", () => {
    const a = replica({ spoolId: "spool-a" });
    expect(() =>
      fleet([
        ["https://a", a],
        ["https://a", a],
      ]),
    ).toThrow(/twice/);
  });

  it("a ONE-replica fleet is exactly today's single-broker behaviour", async () => {
    const a = replica({ jobId: "job-a", spoolId: "spool-a" });
    const f = fleet([["https://a", a]]);
    expect(f.size).toBe(1);
    expect(f.endpoints).toEqual(["https://a"]);
    await f.openJob("carrier");
    await f.exec("job-a", "echo hi", "voucher");
    await f.closeJob("job-a");
    expect(a.opens).toBe(1);
    expect(a.execs).toHaveLength(1);
    expect(a.closes).toEqual(["job-a"]);
    expect(f.drainTargets()).toHaveLength(1);
  });

  it("close() closes every replica's transport and survives one that throws", () => {
    const a = replica({});
    const b = replica({});
    let closedB = false;
    a.client.close = () => {
      throw new Error("already closed");
    };
    b.client.close = () => {
      closedB = true;
    };
    const f = fleet([
      ["https://a", a],
      ["https://b", b],
    ]);
    expect(() => f.close()).not.toThrow();
    expect(closedB).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The Codex-convergence arms (cinatra#2266 slice 3). Each one drives a hole the
// first version of this router left open, and fails without its fix.
// ---------------------------------------------------------------------------

describe("fleet routing — the misdelivery holes the review found", () => {
  it("REFUSES a fleet where one spool identity is served by two endpoints", async () => {
    // A CLONED VOLUME. Both replicas mint `<same-spoolId>:<n>`, so the kernel's
    // unique delivery-key index would collapse two different executions into one
    // row — an execution silently leaving the trail, which is the whole defect
    // cinatra#2266 exists to end. Independently minted UUIDs never collide, so
    // this can only come from a copied data directory.
    const a = replica({ spoolId: "spool-shared" });
    const b = replica({ spoolId: "spool-shared" });
    const f = fleet([
      ["https://a", a],
      ["https://b", b],
    ]);
    const entries = await f.health();
    // The FIRST endpoint is fine; the second is where the collision becomes
    // visible, and it is reported as a failed health entry rather than silently
    // drained.
    expect(entries[0]).toMatchObject({ ok: true });
    expect(entries[1]).toMatchObject({ ok: false });
    expect(entries[1]?.detail).toMatch(/served by BOTH/);
  });

  it("REFUSES an endpoint whose spool identity comes BACK — a load balancer", async () => {
    // A replaced replica moves an endpoint forward and never back. An identity
    // that RETURNS means two live replicas answer on one address, and every
    // invariant in this router is decorative under that configuration.
    let spoolId = "spool-1";
    const a = replica({});
    a.client.health = async () => ({
      protocolVersion: EXEC_PROTOCOL_VERSION,
      executingCount: 0,
      atMs: 1,
      spoolId,
    });
    const gaps: string[] = [];
    const f = fleet([["https://a", a]], (m) => gaps.push(m));

    expect((await f.health())[0]).toMatchObject({ ok: true });
    spoolId = "spool-2"; // a legitimate redeploy — reported, allowed
    expect((await f.health())[0]).toMatchObject({ ok: true });
    expect(gaps.filter((g) => g.includes("previously reported"))).toHaveLength(1);

    spoolId = "spool-1"; // ...and back again. That is not a redeploy.
    const entry = (await f.health())[0];
    expect(entry?.ok).toBe(false);
    expect(entry?.detail).toMatch(/fronting SEVERAL live broker replicas/);
  });

  it("REFUSES the fleet when the endpoint that SERVED a batch rejects its own head as wrong_spool", async () => {
    // THE BALANCER THE IDENTITY-HISTORY CHECK CANNOT SEE (Codex convergence,
    // adopted). With per-connection affinity the observed identity sequence is
    // only ever `A, B` and never returns to `A`, so the return-to-a-previous-id
    // detector reads it as a redeploy and allows it.
    //
    // This is the decisive signal instead of a statistical one: one broker
    // cannot serve a batch AS spool-a and then deny being spool-a, seconds
    // later, for the very head it issued. The two calls reached different
    // brokers, which is the fact the router has to refuse on.
    const a = replica({ spoolId: "spool-a" });
    a.client.ackAudit = async () => {
      // Exactly what `broker-server.ts` puts on the wire: the spool's reason
      // token leading the refusal message, wrapped by BrokerServiceClient.
      throw new Error(
        'The execution-plane broker refused "ackAudit" (audit_ack_refused): wrong_spool: ' +
          "The acknowledgement names a different spool than the one that produced these records",
      );
    };
    const f = fleet([["https://a", a]]);
    const [target] = f.drainTargets();
    await target!.drainAudit({}); // served as spool-a, head 0

    await expect(target!.ackAudit({ spoolId: "spool-a", head: 0 })).rejects.toThrow(
      /fronts SEVERAL live replicas/,
    );
    // The router names the code, so a caller can tell this from a transport
    // fault rather than parsing prose.
    await target!.drainAudit({});
    const err = await target!
      .ackAudit({ spoolId: "spool-a", head: 0 })
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FleetRoutingError);
    expect((err as FleetRoutingError).code).toBe("fronted_endpoint");
    // The underlying refusal is preserved, not swallowed.
    expect((err as Error).message).toContain("wrong_spool");
  });

  it("does NOT fire on a token that merely CONTAINS wrong_spool", async () => {
    // The first matcher was `message.includes("wrong_spool")`, which also fired
    // on `not_wrong_spool` and on any prose quoting the token — and reading an
    // unrelated failure as a fronted endpoint sends an operator to rebuild
    // their networking over a spool bug.
    const a = replica({ spoolId: "spool-a" });
    a.client.ackAudit = async () => {
      throw new Error(
        'The execution-plane broker refused "ackAudit" (audit_ack_refused): not_wrong_spool: ' +
          "a reason that is not the one this detector is about",
      );
    };
    const f = fleet([["https://a", a]]);
    const [target] = f.drainTargets();
    await target!.drainAudit({});
    const err = await target!
      .ackAudit({ spoolId: "spool-a", head: 0 })
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(FleetRoutingError);
  });

  it("does NOT read an unrelated ACK failure as a fronted endpoint", async () => {
    // A transport fault, a stale head, an unknown head — none of them prove two
    // brokers, and turning any of them into `fronted_endpoint` would send an
    // operator to rebuild their networking over a spool bug.
    const a = replica({ spoolId: "spool-a" });
    a.client.ackAudit = async () => {
      throw new Error(
        'The execution-plane broker refused "ackAudit" (audit_ack_refused): stale_head: ' +
          "The acknowledged head 0 is at or behind this spool's committed watermark 4",
      );
    };
    const f = fleet([["https://a", a]]);
    const [target] = f.drainTargets();
    await target!.drainAudit({});
    const err = await target!
      .ackAudit({ spoolId: "spool-a", head: 0 })
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(FleetRoutingError);
    expect((err as Error).message).toContain("stale_head");
  });

  it("REFUSES an ACK from a target that never served a batch", async () => {
    // `health()` used to be enough to populate the identity this check compared
    // against, so a target that had never read anything would forward an ACK for
    // any head at all.
    const a = replica({ spoolId: "spool-a" });
    const f = fleet([["https://a", a]]);
    await f.health(); // learns spool-a WITHOUT serving a batch
    const [target] = f.drainTargets();
    await expect(target!.ackAudit({ spoolId: "spool-a", head: 9 })).rejects.toThrow(
      /has not served a spooled batch/,
    );
    expect(a.acks).toHaveLength(0);
  });

  it("REFUSES an ACK whose HEAD is not the one this target served", async () => {
    const a = replica({ spoolId: "spool-a" });
    const f = fleet([["https://a", a]]);
    const [target] = f.drainTargets();
    await target!.drainAudit({}); // serves head 0
    await expect(target!.ackAudit({ spoolId: "spool-a", head: 7 })).rejects.toThrow(
      /which served spool-a@0/,
    );
    expect(a.acks).toHaveLength(0);
    // The matching head is accepted, and is then CONSUMED — a replayed ACK
    // must be earned by its own read.
    await expect(target!.ackAudit({ spoolId: "spool-a", head: 0 })).resolves.toMatchObject({
      acked: true,
    });
    expect(a.acks).toHaveLength(1);
    await expect(target!.ackAudit({ spoolId: "spool-a", head: 0 })).rejects.toThrow(
      /has not served a spooled batch/,
    );
    expect(a.acks).toHaveLength(1);
  });

  it("does NOT let a concurrent health call refuse a correct acknowledgement", async () => {
    // The shared-map version refused this: a liveness probe between the drain
    // and the ack refreshed the entry the ack was compared against, so a correct
    // acknowledgement failed because an unrelated call had touched a shared map.
    const a = replica({ spoolId: "spool-a" });
    const f = fleet([["https://a", a]]);
    const [target] = f.drainTargets();
    const batch = await target!.drainAudit({});
    await f.health(); // concurrent probe, same endpoint
    await expect(
      target!.ackAudit({ spoolId: batch.spoolId!, head: batch.head }),
    ).resolves.toMatchObject({ acked: true });
  });

  it("RAISES a partial run teardown instead of reporting it as success", async () => {
    // Summing the counts reported "2 terminated" for a fleet where one replica
    // never answered and is still running the run's containers.
    const a = replica({ terminated: 2 });
    const b = replica({ terminateThrows: new Error("replica unreachable") });
    const f = fleet([
      ["https://a", a],
      ["https://b", b],
    ]);
    await expect(f.terminateJobsForRun("run-1")).rejects.toThrow(/did not reach every broker/);
    // Every replica was still ASKED — a teardown that stops at the first
    // unreachable replica is a teardown that half-happened.
    expect(a.terminates).toEqual(["run-1"]);
    expect(b.terminates).toEqual(["run-1"]);
  });

  it("REFUSES to re-pin a live job id that another replica also returned", async () => {
    // Unreachable while job ids are randomUUID()s, and fail-closed if that ever
    // stops holding: re-pointing a live job at another replica would run its
    // next command in a DIFFERENT workspace rather than refusing.
    const a = replica({ jobId: "job-dup" });
    const b = replica({ jobId: "job-dup" });
    const f = fleet([
      ["https://a", a],
      ["https://b", b],
    ]);
    expect(await f.openJob("carrier-1")).toMatchObject({ ok: true });
    await expect(f.openJob("carrier-2")).rejects.toThrow(/not unique across this fleet/);
    // The FIRST replica keeps the job; nothing was silently re-pointed.
    expect(f.pinnedEndpoint("job-dup")).toBe("https://a");
  });
});
