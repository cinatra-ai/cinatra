/**
 * FLEET-SAFE DELIVERY (cinatra#2266 design gap G3, slice 3).
 *
 * ONE PARAGRAPH OF WHY. The durable spool is a SINGLE-WRITER log on ONE volume,
 * and its delivery identity is `<spoolId>:<recordId>` where `spoolId` is
 * persisted on that volume. Run two broker replicas and you have two spools,
 * two identity spaces and two independent ACK watermarks — and the thing that
 * makes this dangerous rather than merely fiddly is that the replicas can be
 * INDISTINGUISHABLE at the transport layer: `mtls.ts` authorizes a
 * `broker-server` leaf by its instance-scoped URI SAN, and a fleet deliberately
 * shares one logical instance identity across its replicas so the app needs one
 * credential. So the certificate cannot tell replica A from replica B, and a
 * router that treats "the broker" as one endpoint will read from A and
 * acknowledge to B.
 *
 * WHAT THAT WOULD COST, precisely, if nothing here existed:
 *
 *  - AN ACK TO THE WRONG REPLICA. B's spool would be asked to commit a head it
 *    never issued. The spool already refuses that (`wrong_spool`, since slice
 *    2) — so the failure mode is not silent corruption, it is a LIVENESS
 *    failure: the app can never acknowledge, A's spool fills, and A correctly
 *    goes fail-closed and stops admitting commands. An audit-durability
 *    mechanism that turns a routing bug into an execution outage is not
 *    acceptable, so this module makes the misroute impossible rather than
 *    merely refused.
 *  - A COMMAND TO THE WRONG REPLICA. Broker job state is in-process. An `exec`
 *    that lands on a replica that never opened the job answers `unknown_job` —
 *    fail-closed, but a coin-flip failure on every command in a 2-replica
 *    fleet.
 *
 * THE MISDELIVERY ANALYSIS, stated as the three invariants this module holds
 * and the tests that drive them (`__tests__/broker-fleet.test.ts`, and the
 * two-replica loopback arms in `service-loopback.test.ts`):
 *
 *  1. NO DELIVERY KEY COLLISION IS POSSIBLE ACROSS REPLICAS. Every key is
 *     `<spoolId>:<n>` and `spoolId` is a per-volume `randomUUID` minted on
 *     first open. Two replicas both minting record 1 produce two different
 *     keys, so the kernel's unique delivery-key index cannot collapse two
 *     executions into one row. This is a property of the SPOOL, restated here
 *     because it is the foundation the rest of G3 stands on.
 *  2. AN ACK NEVER LEAVES THE REPLICA THAT SERVED THE READ. A drain is a
 *     SESSION on one `FleetDrainTarget`: the target holds the client, remembers
 *     the `spoolId` of the batch it served, and refuses locally — without a
 *     round trip — any acknowledgement whose `spoolId` is not the one it last
 *     handed out. The broker-side `wrong_spool` refusal remains as the
 *     second line of defence; this is the first.
 *  3. A JOB'S COMMANDS ALL REACH THE REPLICA THAT OPENED IT. `openJob` pins the
 *     returned `jobId` to the answering replica and every later `exec` /
 *     `closeJob` for that job is routed there. An unpinned `jobId` is REFUSED,
 *     never guessed at and never broadcast.
 *
 * THE ONE PRECONDITION THIS LAYER CANNOT CREATE FOR ITSELF, stated plainly
 * because everything above depends on it: EACH REPLICA MUST HAVE ITS OWN
 * DIRECTLY ROUTABLE ORIGIN, and all of them are listed in
 * `EXECUTION_BROKER_URL` (comma-separated). Put a load balancer in front of one
 * address and every invariant here becomes decorative — the router pins a job
 * to "the endpoint that answered", and the endpoint answers as a different
 * replica next request. Routing is done by the party that knows which replica
 * owns what, and a balancer is definitionally not that party.
 *
 * That is a DEPLOYMENT fact the app cannot verify by construction, so it is
 * DETECTED instead, by TWO checks that fail closed on `fronted_endpoint`. What
 * each one covers is stated exactly, because neither covers the whole of it:
 *
 *  - AN IDENTITY THAT COMES BACK. An endpoint that reports spool A, then B,
 *    then A again is fronting several live replicas: a replaced replica moves an
 *    endpoint's identity FORWARD and never back, so a legitimate redeploy is
 *    reported as a gap and allowed, while this is refused. Its limit, stated
 *    rather than left to be discovered: a balancer with per-connection affinity
 *    whose keep-alive connection rotates exactly once shows only `A, B` and is
 *    indistinguishable from a redeploy to this check alone.
 *  - AN ACK REFUSED BY THE ENDPOINT THAT SERVED THE READ. That is the case the
 *    first check misses, and it is decisive rather than statistical: one broker
 *    cannot serve a batch as spool S and then refuse the acknowledgement of that
 *    exact head as `wrong_spool`, so the two calls demonstrably reached
 *    different brokers. It fires at the FIRST misroute.
 *
 * Together they catch the balancer at its first consequence; the identity check
 * additionally catches one that has not misdelivered yet.
 *
 * WHAT THIS DOES NOT MAKE TRUE, stated because cinatra#2266 asks for it in so
 * many words: AUDIT DE-DUP IS INDEPENDENT OF COMMAND IDEMPOTENCY. Everything
 * above is about delivering each audit RECORD to the kernel exactly once. It
 * says nothing about running each COMMAND once — that is `command-ledger.ts`,
 * whose own docblock records that its ledger is in-memory and does not survive a
 * restart, and which names a durable Postgres-backed binding as the fix. A
 * durable audit spool does not strengthen it: the spool proves what DID happen,
 * the ledger decides what is ALLOWED to happen again, and a replica that
 * restarts still forgets its in-flight command claims. Sticky routing narrows
 * the exposure (a job's retries reach the replica that holds its claims) but
 * does not close it. This module must not be read as closing that sibling
 * problem.
 *
 * WHAT IS DELIBERATELY NOT HERE:
 *
 *  - NO FAILOVER ON `openJob`. If the chosen replica does not answer, this
 *    throws rather than trying the next one. A retried `openJob` whose first
 *    attempt actually SUCCEEDED (response lost in flight) leaks an open job and
 *    its L2 workspace volume on a replica the app will never talk to again, and
 *    the app has no handle with which to reclaim it. A refusal an operator can
 *    see beats a leak they cannot.
 *  - NO RE-ROUTING OF A PINNED JOB. If a job's replica stops answering, its
 *    commands fail; they are not re-issued elsewhere. The job's workspace,
 *    staged skills and admission state live on that replica, so "somewhere
 *    else" is a different job wearing the same id.
 *  - NO CROSS-REPLICA AGGREGATION OF THE AUDIT DRAIN. There is no
 *    `fleet.drainAudit()` returning one merged batch, because the head that
 *    batch would carry belongs to no single spool. The drain is per replica by
 *    construction (`drainTargets()`), which is the API shape that makes
 *    invariant 2 unstateable-as-a-bug rather than merely tested.
 */

import type { ExecResult, OpenJobResult, StagedSkillInput } from "../types";
import type { ResolvedEnvironmentMount } from "../environment/mount";
import type {
  AckAuditPayload,
  AckAuditResultPayload,
  DrainAuditPayload,
  DrainAuditResultPayload,
  HealthResultPayload,
} from "./protocol";

/**
 * The client surface one replica must present. Structural on purpose: the real
 * `BrokerServiceClient` satisfies it, and a test drives it with a plain object
 * — the same discipline `BrokerServiceBroker` follows on the server side.
 */
export type FleetReplicaClient = {
  openJob(
    carrier: string,
    openOpts?: { stagedSkills?: StagedSkillInput[]; environment?: ResolvedEnvironmentMount },
  ): Promise<OpenJobResult>;
  exec(
    jobId: string,
    command: string,
    voucher: string,
    opts?: { commandId?: string },
  ): Promise<ExecResult>;
  closeJob(jobId: string, opts?: { removeWorkspace?: boolean }): Promise<void>;
  terminateJobsForRun(runId: string, opts?: { removeWorkspace?: boolean }): Promise<number>;
  closeIdleJobs(idleMs: number): Promise<number>;
  drainAudit(limits?: DrainAuditPayload): Promise<DrainAuditResultPayload>;
  ackAudit(payload: AckAuditPayload): Promise<AckAuditResultPayload>;
  health(): Promise<HealthResultPayload>;
  close(): void;
};

export type FleetReplica = {
  /**
   * Operator-facing name for this replica — in practice its base URL. NEVER an
   * authorization input: mTLS plus the service token remain the boundary, and
   * this string only ever appears in routing decisions and diagnostics.
   */
  endpoint: string;
  client: FleetReplicaClient;
};

/** Raised when a fleet call cannot be routed. Always fail-closed. */
export class FleetRoutingError extends Error {
  readonly code:
    | "unpinned_job"
    | "unknown_replica"
    | "empty_fleet"
    | "ack_misroute"
    | "duplicate_spool"
    | "pin_conflict"
    | "fronted_endpoint";
  constructor(code: FleetRoutingError["code"], message: string) {
    super(message);
    this.name = "FleetRoutingError";
    this.code = code;
  }
}

/**
 * Bound on the job→replica pin table. It must not grow with traffic: the
 * executor above this layer memoizes at most `MAX_TRACKED_CARRIERS` (256) open
 * jobs, and the broker's own idle sweep closes them past the carrier TTL, so
 * this is comfortably above any live population. Eviction is oldest-first and
 * FAIL-CLOSED — an evicted pin makes the next command on that job a refusal,
 * never a guess at which replica owns it.
 */
export const MAX_PINNED_JOBS = 4_096;

/**
 * A DRAIN SESSION bound to exactly one replica (invariant 2).
 *
 * The read and the acknowledgement are two calls, and everything that can go
 * wrong between them is a routing question. Holding both on one object — with
 * the served `spoolId` remembered between them — is what makes "acknowledge the
 * batch I just read" the only expressible operation.
 */
export type FleetDrainTarget = {
  readonly endpoint: string;
  /**
   * The spool identity this target last SERVED, or the one `health` reported.
   * Present ⇒ every ACK is checked against it before it leaves this process.
   */
  readonly spoolId: string | undefined;
  drainAudit(limits?: DrainAuditPayload): Promise<DrainAuditResultPayload>;
  ackAudit(payload: AckAuditPayload): Promise<AckAuditResultPayload>;
};

export type FleetHealthEntry = {
  endpoint: string;
  ok: boolean;
  /** The replica's answer, when it gave one. */
  health?: HealthResultPayload;
  /** The failure, when it did not. Operator prose, never a credential. */
  detail?: string;
};

export type BrokerFleetOptions = {
  replicas: readonly FleetReplica[];
  /**
   * Reported when a replica's spool identity CHANGES under a stable endpoint —
   * a replaced replica, a remounted volume, a load balancer that moved us. Not
   * an error (a legitimate redeploy does this), but never silent: every record
   * the old spool still held is now unreachable through this endpoint.
   */
  onGap?: (message: string) => void;
};

/**
 * Does this failure carry the audit spool's own `wrong_spool` refusal?
 *
 * MATCHED ON THE MESSAGE, deliberately and with its cost stated. The refusal
 * crosses the wire as the `audit_ack_refused` error code with the spool's
 * reason token leading the message (`broker-server.ts` builds it as
 * `${reason}: ${message}`), and `BrokerServiceClient.ackAudit` raises a plain
 * `Error` carrying that text — there is no typed channel to read instead. The
 * token is emitted by THIS repo's own server, not by a third party, so it moves
 * only when someone edits it here; the fallback if it ever does is that this
 * detector stops firing and the identity-history check above still catches the
 * balancer on the next return-to-a-previous-identity. It cannot mis-fire in the
 * other direction: nothing else in the transport says `wrong_spool`.
 */
function isWrongSpoolRefusal(err: unknown): boolean {
  // ANCHORED ON THE PROTOCOL FRAMING, not on a substring (Codex round 3,
  // adopted). A bare `includes("wrong_spool")` would also fire on
  // `not_wrong_spool`, or on any prose that happened to quote the token — and
  // reading an unrelated failure as a fronted endpoint sends an operator to
  // rebuild their networking over a spool bug. This is the exact shape
  // `broker-server.ts` puts on the wire (the refusal code, then the spool's own
  // reason token) wrapped by `BrokerServiceClient`.
  return err instanceof Error && /\(audit_ack_refused\):\s*wrong_spool\b/.test(err.message);
}

/**
 * The fleet router. Presents the same surface `BrokerServiceClient` does for
 * everything above it — `createRemoteSandboxExecutor` takes it unchanged — and
 * routes each call by the rules above.
 *
 * A ONE-REPLICA FLEET IS THE DEGENERATE CASE AND IS EXACTLY TODAY'S BEHAVIOUR:
 * one endpoint, every job pinned to it, one drain target. Nothing about the
 * single-broker deployment changes by adopting this type, which is what makes
 * it safe to put on the default path.
 */
export class BrokerFleetClient {
  private readonly replicas: readonly FleetReplica[];
  private readonly onGap: (message: string) => void;
  /** jobId → endpoint. Insertion-ordered, bounded, fail-closed on eviction. */
  private readonly pins = new Map<string, string>();
  /** endpoint → last observed spool identity. */
  private readonly spoolIds = new Map<string, string>();
  /**
   * spoolId → the endpoint that owns it. THE REVERSE INDEX, and it is not
   * bookkeeping (Codex convergence, adopted).
   *
   * Invariant 1 says two replicas cannot mint the same delivery key because each
   * volume's `spoolId` is a distinct `randomUUID`. That holds for volumes that
   * were INITIALISED separately — and silently fails for a volume that was
   * CLONED after its id was written (a snapshot restore, a copied data
   * directory, a `docker volume` duplicated to seed a second replica). Two
   * replicas then emit byte-identical `<spoolId>:<recordId>` keys for different
   * executions, and the kernel's unique delivery-key index collapses them into
   * ONE row: an execution disappears from the trail, which is precisely the
   * failure cinatra#2266 exists to end.
   *
   * A UUID minted independently never collides by accident, so this index costs
   * nothing in the healthy case and is the only thing that catches the cloned
   * one.
   */
  private readonly spoolOwners = new Map<string, string>();
  /**
   * endpoint → every spool identity it has EVER reported. The load-balancer
   * detector (Codex convergence, adopted — see the module header's precondition).
   *
   * One endpoint's identity moving FORWARD is a redeploy: A, then B, never A
   * again. One endpoint's identity coming BACK to a value it already reported is
   * not a redeploy at all — it is two live replicas answering on one address,
   * which is exactly the configuration this layer cannot route safely and
   * cannot otherwise see. That asymmetry is what makes this cheap and precise
   * instead of a heuristic.
   */
  private readonly spoolHistory = new Map<string, Set<string>>();
  private cursor = 0;

  constructor(opts: BrokerFleetOptions) {
    if (opts.replicas.length === 0) {
      throw new FleetRoutingError(
        "empty_fleet",
        "A broker fleet needs at least one replica; refusing to construct a router with none " +
          "(an empty fleet would refuse every command at the first call instead of at boot).",
      );
    }
    const seen = new Set<string>();
    for (const replica of opts.replicas) {
      if (seen.has(replica.endpoint)) {
        throw new FleetRoutingError(
          "empty_fleet",
          `The broker fleet declares the endpoint "${replica.endpoint}" twice. Two entries for ` +
            "one address are not two replicas — they are one replica the router would treat as " +
            "two, which is exactly the misrouting this layer exists to prevent.",
        );
      }
      seen.add(replica.endpoint);
    }
    this.replicas = [...opts.replicas];
    this.onGap = opts.onGap ?? ((message) => console.error(message));
  }

  /** Endpoints in declaration order — for diagnostics and for the drain loop. */
  get endpoints(): string[] {
    return this.replicas.map((r) => r.endpoint);
  }

  get size(): number {
    return this.replicas.length;
  }

  /** The replica a job is pinned to, or `undefined`. Diagnostics + tests. */
  pinnedEndpoint(jobId: string): string | undefined {
    return this.pins.get(jobId);
  }

  private replicaAt(endpoint: string): FleetReplica {
    const replica = this.replicas.find((r) => r.endpoint === endpoint);
    if (!replica) {
      throw new FleetRoutingError(
        "unknown_replica",
        `No replica named "${endpoint}" is in this fleet.`,
      );
    }
    return replica;
  }

  /**
   * Round-robin over the declared replicas. Deliberately not "least loaded":
   * load is the broker's own bounded-queue problem and it already refuses
   * `queue_saturated`, whereas a router that steers by an observation it takes
   * one round trip to refresh mostly steers by a stale one.
   */
  private nextReplica(): FleetReplica {
    const replica = this.replicas[this.cursor % this.replicas.length]!;
    this.cursor = (this.cursor + 1) % this.replicas.length;
    return replica;
  }

  private pin(jobId: string, endpoint: string): void {
    // A JOB ID NAMES ONE JOB ON ONE REPLICA (Codex convergence, adopted).
    // `broker.ts` mints job ids with `randomUUID()`, so in practice two replicas
    // never answer with the same one and this branch is unreachable — but the
    // router must not INHERIT that guarantee silently from another module. If it
    // ever stopped holding, overwriting the pin would send a live job's later
    // commands to a different replica, where the same id may name a DIFFERENT
    // job with a different workspace: the one outcome worse than refusing, since
    // the command would run and be attributed to the wrong session.
    const existing = this.pins.get(jobId);
    if (existing !== undefined && existing !== endpoint) {
      throw new FleetRoutingError(
        "pin_conflict",
        `The job id "${jobId}" was returned by ${endpoint} while it is already pinned to ` +
          `${existing}. Two replicas answering with one job id means job ids are not unique ` +
          "across this fleet, so routing by id is unsound; the open is refused rather than " +
          "silently re-pointing a live job at another replica's workspace.",
      );
    }
    this.pins.set(jobId, endpoint);
    while (this.pins.size > MAX_PINNED_JOBS) {
      const oldest = this.pins.keys().next();
      if (oldest.done) break;
      this.pins.delete(oldest.value);
    }
  }

  /**
   * Open a job on ONE replica and pin it there.
   *
   * The pin is taken only on an `ok` result: a refused open (bad carrier,
   * removed run, exhausted quota) created no job, and pinning an id that does
   * not exist would hold a routing entry forever.
   */
  async openJob(
    carrier: string,
    openOpts?: { stagedSkills?: StagedSkillInput[]; environment?: ResolvedEnvironmentMount },
  ): Promise<OpenJobResult> {
    const replica = this.nextReplica();
    const result = await replica.client.openJob(carrier, openOpts);
    if (result.ok) this.pin(result.jobId, replica.endpoint);
    return result;
  }

  /**
   * Execute on the replica that owns the job — and ONLY there.
   *
   * An unpinned job is a structured refusal rather than a throw, matching
   * `BrokerServiceClient.exec`'s own contract that this call never rejects into
   * the provider tool loop. `unknown_job` is the honest member: from the app's
   * seat the plane holds no such job, which is precisely what the broker itself
   * would answer.
   */
  async exec(
    jobId: string,
    command: string,
    voucher: string,
    opts?: { commandId?: string },
  ): Promise<ExecResult> {
    const endpoint = this.pins.get(jobId);
    if (endpoint === undefined) {
      return {
        ok: false,
        reason: "unknown_job",
        message:
          `No replica in this execution-plane fleet is known to own job "${jobId}", so the ` +
          "command is refused rather than routed to a replica that would either not know the " +
          "job or run it against a different workspace (fail-closed sticky routing).",
      };
    }
    return this.replicaAt(endpoint).client.exec(jobId, command, voucher, opts);
  }

  /** Close on the owning replica and drop the pin. Unknown job ⇒ no-op. */
  async closeJob(jobId: string, opts?: { removeWorkspace?: boolean }): Promise<void> {
    const endpoint = this.pins.get(jobId);
    if (endpoint === undefined) return;
    try {
      await this.replicaAt(endpoint).client.closeJob(jobId, opts);
    } finally {
      // Dropped even when the close FAILED: the pin's purpose is to route this
      // app's own commands, and a job it can no longer close is not one it
      // should keep sending work to.
      this.pins.delete(jobId);
    }
  }

  /**
   * BROADCAST. A run's jobs can be spread across replicas — one run legitimately
   * opens several jobs — so a teardown that asked only the pinned replica would
   * leave the others running containers for a run that no longer exists. Every
   * replica is asked and the counts are summed.
   *
   * A replica that throws does NOT abort the sweep: a hard-removal teardown that
   * stops at the first unreachable replica is a teardown that half-happened.
   * The failure is reported through `onGap`.
   */
  async terminateJobsForRun(runId: string, opts?: { removeWorkspace?: boolean }): Promise<number> {
    let terminated = 0;
    const failures: string[] = [];
    for (const replica of this.replicas) {
      try {
        terminated += await replica.client.terminateJobsForRun(runId, opts);
      } catch (err) {
        failures.push(
          `${replica.endpoint}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // EVERY REPLICA IS ASKED, AND THEN A PARTIAL TEARDOWN IS RAISED (Codex
    // convergence, adopted). Returning the count alone reported "2 terminated"
    // for a fleet where one replica never answered and is still running the
    // run's containers — a caller performing a hard removal would read that as
    // done. `BrokerServiceClient.terminateJobsForRun` throws when a single
    // broker cannot be reached, so throwing here is the SAME contract, not a
    // new one. The loop still asks every replica first: a teardown that stops
    // at the first unreachable one is a teardown that half-happened.
    if (failures.length > 0) {
      throw new Error(
        `The execution-plane run teardown for ${runId} did not reach every broker replica ` +
          `(${failures.length} of ${this.replicas.length} failed): ${failures.join("; ")}. ` +
          `${terminated} job(s) were terminated on the replicas that answered; jobs for this run ` +
          "may still be open on the others.",
      );
    }
    return terminated;
  }

  /** BROADCAST, same rationale: idle jobs exist on every replica that opened one. */
  async closeIdleJobs(idleMs: number): Promise<number> {
    let closed = 0;
    for (const replica of this.replicas) {
      try {
        closed += await replica.client.closeIdleJobs(idleMs);
      } catch {
        // The sweep is opportunistic and runs on a timer; a replica that misses
        // one tick is swept on the next.
      }
    }
    return closed;
  }

  /**
   * Every replica's health, and the moment the router learns each one's spool
   * identity. A CHANGED identity under a stable endpoint is reported: the
   * previous spool's un-acknowledged records are no longer reachable through
   * this address, which is a gap in the trail and must be visible as one.
   */
  async health(): Promise<FleetHealthEntry[]> {
    const entries: FleetHealthEntry[] = [];
    for (const replica of this.replicas) {
      try {
        const health = await replica.client.health();
        if (health.spoolId) this.observeSpoolId(replica.endpoint, health.spoolId);
        entries.push({ endpoint: replica.endpoint, ok: true, health });
      } catch (err) {
        entries.push({
          endpoint: replica.endpoint,
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return entries;
  }

  private observeSpoolId(endpoint: string, spoolId: string): void {
    // ONE SPOOL IDENTITY BELONGS TO ONE ENDPOINT. Seeing it at a second one
    // means two replicas share an identity space, so their delivery keys are no
    // longer unique across the fleet. FAIL CLOSED: refusing the drain leaves the
    // records spooled and re-deliverable once the operator separates the
    // volumes, whereas continuing would let the kernel silently merge two
    // executions into one row.
    const owner = this.spoolOwners.get(spoolId);
    if (owner !== undefined && owner !== endpoint) {
      throw new FleetRoutingError(
        "duplicate_spool",
        `The audit spool ${spoolId} is being served by BOTH ${owner} and ${endpoint}. Two ` +
          "replicas holding one spool identity mint colliding delivery keys, and the audit " +
          "kernel's unique index would collapse two different executions into a single row — " +
          "so this fleet is refused rather than drained. A volume was almost certainly cloned " +
          "after its spool identity was written; each replica needs an independently " +
          "initialised volume.",
      );
    }
    this.spoolOwners.set(spoolId, endpoint);

    const previous = this.spoolIds.get(endpoint);
    const history = this.spoolHistory.get(endpoint) ?? new Set<string>();
    // A RETURNING identity means this address fronts more than one replica.
    if (previous !== undefined && previous !== spoolId && history.has(spoolId)) {
      throw new FleetRoutingError(
        "fronted_endpoint",
        `The endpoint ${endpoint} has reported audit spool ${spoolId} before, then a different ` +
          `one (${previous}), and now ${spoolId} again. A replica that was replaced never comes ` +
          "back, so this address is fronting SEVERAL live broker replicas — a load balancer or " +
          "a round-robin DNS record. This router pins a job to the endpoint that opened it and " +
          "acknowledges a batch to the endpoint that served it, and neither holds when the " +
          "address chooses a different replica per request: a job's commands reach a replica " +
          "that never opened it, and an acknowledgement reaches a spool that never issued the " +
          "head. Give each replica its own directly routable origin and list them all in " +
          "EXECUTION_BROKER_URL (comma-separated) instead of putting a balancer in front.",
      );
    }
    history.add(spoolId);
    this.spoolHistory.set(endpoint, history);
    if (previous !== undefined && previous !== spoolId) {
      this.onGap(
        `[execution-plane] the fleet replica ${endpoint} now reports audit spool ${spoolId}, ` +
          `where it previously reported ${previous} — the replica or its volume was replaced, and ` +
          "any records the previous spool still held are no longer reachable through this endpoint",
      );
    }
    if (previous !== undefined && previous !== spoolId) this.spoolOwners.delete(previous);
    this.spoolIds.set(endpoint, spoolId);
  }

  /** The spool identity last observed at an endpoint. Diagnostics + tests. */
  observedSpoolId(endpoint: string): string | undefined {
    return this.spoolIds.get(endpoint);
  }

  /**
   * ONE DRAIN TARGET PER REPLICA (invariant 2). There is deliberately no
   * fleet-wide `drainAudit`: a merged batch would carry a head that belongs to
   * no spool, and an ACK for it could only be a guess.
   */
  drainTargets(): FleetDrainTarget[] {
    return this.replicas.map((replica) => this.drainTarget(replica));
  }

  private drainTarget(replica: FleetReplica): FleetDrainTarget {
    const observe = (spoolId: string): void => this.observeSpoolId(replica.endpoint, spoolId);
    const known = (): string | undefined => this.spoolIds.get(replica.endpoint);
    /**
     * THE BATCH THIS TARGET ITSELF SERVED — the session state invariant 2 is
     * actually about (Codex convergence, adopted).
     *
     * The first version of this compared the ACK's `spoolId` against the
     * fleet-wide `spoolIds` map, which was wrong in two directions and neither
     * was hypothetical:
     *
     *   * TOO PERMISSIVE. The map is populated by `health()` too, so a target
     *     that had never served a read would happily forward an ACK for any
     *     head, and an ACK whose `spoolId` matched but whose HEAD belonged to
     *     another batch passed unexamined. An unobserved spool (`undefined`)
     *     skipped the check altogether.
     *   * TOO STRICT, and racily so. A concurrent liveness probe could refresh
     *     the shared entry between this target's drain and its ack, so a
     *     perfectly correct acknowledgement was refused because an unrelated
     *     call had touched a shared map.
     *
     * Holding `{spoolId, head}` from this target's OWN successful drain makes
     * "acknowledge the batch I just read" the only expressible operation, which
     * is what the invariant claimed all along.
     */
    let pending: { spoolId: string; head: number } | undefined;
    return {
      endpoint: replica.endpoint,
      get spoolId(): string | undefined {
        return known();
      },
      async drainAudit(limits?: DrainAuditPayload): Promise<DrainAuditResultPayload> {
        const batch = await replica.client.drainAudit(limits);
        // `relayed: false` is an in-process placement with no spool at all; its
        // empty `spoolId` is honest and must not be recorded as an identity.
        if (batch.relayed && batch.spoolId) {
          observe(batch.spoolId);
          pending = { spoolId: batch.spoolId, head: batch.head };
        } else {
          pending = undefined;
        }
        return batch;
      },
      async ackAudit(payload: AckAuditPayload): Promise<AckAuditResultPayload> {
        // THE LOCAL REFUSAL — invariant 2, enforced before the call rather than
        // after it. The broker would refuse a wrong-spool ACK too
        // (`wrong_spool`), and that refusal remains the second line of defence;
        // catching it HERE is what makes a misroute impossible to SEND rather
        // than merely impossible to succeed at, so a router bug can never
        // consume the app's drain budget acknowledging into the void.
        if (pending === undefined) {
          throw new FleetRoutingError(
            "ack_misroute",
            `Refusing to acknowledge audit spool ${payload.spoolId} to the fleet replica ` +
              `${replica.endpoint}: this drain target has not served a spooled batch, so it has ` +
              "nothing to acknowledge. An acknowledgement is a statement about a batch THIS " +
              "target was handed; one it never received could only delete another volume's " +
              "trail or be refused — nothing is sent.",
          );
        }
        if (payload.spoolId !== pending.spoolId || payload.head !== pending.head) {
          throw new FleetRoutingError(
            "ack_misroute",
            `Refusing to acknowledge ${payload.spoolId}@${payload.head} to the fleet replica ` +
              `${replica.endpoint}, which served ${pending.spoolId}@${pending.head}. An ` +
              "acknowledgement names an exact committed prefix of an exact spool; anything else " +
              "is a routing bug, and nothing is sent.",
          );
        }
        let result: AckAuditResultPayload;
        try {
          result = await replica.client.ackAudit(payload);
        } catch (err) {
          // A `wrong_spool` REFUSAL OF THE HEAD THIS TARGET JUST SERVED is a
          // contradiction a single replica cannot produce (Codex convergence,
          // adopted): the read asserted "I am spool S", and the refusal asserts
          // "I am not spool S", about the same address, seconds apart. The two
          // calls therefore reached DIFFERENT brokers.
          //
          // This is the detector that catches the balancer the identity-history
          // check above cannot — per-connection affinity, where the observed
          // sequence is only ever `A, B` and never returns to `A`. It fires at
          // the FIRST misroute rather than eventually, and it cannot false-fire
          // on a healthy fleet, because a correctly routed ACK is by
          // construction one this target's own read produced.
          if (isWrongSpoolRefusal(err)) {
            throw new FleetRoutingError(
              "fronted_endpoint",
              `The fleet replica ${replica.endpoint} served audit batch ${pending.spoolId}@` +
                `${pending.head} and then refused the acknowledgement of that exact head as ` +
                "`wrong_spool`. One broker cannot deny a spool identity it had just asserted, so " +
                "the read and the acknowledgement reached different brokers. Either this address " +
                "fronts SEVERAL live replicas — a load balancer or a round-robin DNS record, " +
                "which this router cannot route through: give each replica its own directly " +
                "routable origin and list them all in EXECUTION_BROKER_URL (comma-separated) — or " +
                "the replica was replaced between the two calls, in which case the records the " +
                "previous volume still held are unreachable through this endpoint. Nothing was " +
                "removed on either path and the records stay spooled, so the trail is intact " +
                `once the routing is: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          throw err;
        }
        // Consumed: the next ACK must be earned by its own read.
        pending = undefined;
        return result;
      },
    };
  }

  /** Close every replica's transport. Idempotent per the clients' own contract. */
  close(): void {
    for (const replica of this.replicas) {
      try {
        replica.client.close();
      } catch {
        /* a transport that is already closed is not an error */
      }
    }
  }
}
