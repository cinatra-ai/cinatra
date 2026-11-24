/**
 * cinatra#2039 (epic #2037 S1) — the local-write PRODUCED-EVENT emit builder: the
 * default-ON-with-explicit-opt-out behaviour (#2047 ruling), the op shape (columns/params), the deterministic
 * event id, the physical→lattice origin mapping, and the closed emitter set. Pure.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  buildProducedEventInsertOp,
  isPublishCallInFlightAbort,
  maybeBuildProducedEventInsertOp,
  producerRunLockOps,
  publishCallInFlightOr,
} from "../lifecycle-emit";
import { LIFECYCLE_REVIEW_ORCHESTRATION_ENV } from "../lifecycle-activation";
import { producedEventId } from "../lifecycle-produced-event";

const ENV = LIFECYCLE_REVIEW_ORCHESTRATION_ENV;
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[ENV];
  delete process.env[ENV];
});
afterEach(() => {
  if (saved === undefined) delete process.env[ENV];
  else process.env[ENV] = saved;
});

const base = {
  orgId: "org-1",
  artifactId: "art-1",
  representationRevisionId: "rev-1",
  emitter: "createSemanticArtifact" as const,
  originKind: "agent_generated" as const,
  producerAttempt: null,
};

describe("maybeBuildProducedEventInsertOp — the activation switch (#2047: DEFAULT ON)", () => {
  it("returns an op when the switch is UNSET (default ON)", () => {
    expect(maybeBuildProducedEventInsertOp("cinatra", base)).not.toBeNull();
  });
  it("returns an op for any non-'off' value (including the legacy 'on')", () => {
    process.env[ENV] = "on";
    expect(maybeBuildProducedEventInsertOp("cinatra", base)).not.toBeNull();
    process.env[ENV] = "true";
    expect(maybeBuildProducedEventInsertOp("cinatra", base)).not.toBeNull();
    process.env[ENV] = "0";
    expect(maybeBuildProducedEventInsertOp("cinatra", base)).not.toBeNull();
    process.env[ENV] = "";
    expect(maybeBuildProducedEventInsertOp("cinatra", base)).not.toBeNull();
  });
  it("returns null ONLY on the explicit opt-out 'off' (case-insensitive, trimmed)", () => {
    process.env[ENV] = "off";
    expect(maybeBuildProducedEventInsertOp("cinatra", base)).toBeNull();
    process.env[ENV] = "  OFF ";
    expect(maybeBuildProducedEventInsertOp("cinatra", base)).toBeNull();
  });
});

describe("buildProducedEventInsertOp — op shape", () => {
  it("emits an idempotent ON CONFLICT insert into artifact_produced_outbox with the deterministic id", () => {
    const op = buildProducedEventInsertOp("cinatra", base);
    expect(op.text).toContain(`"cinatra"."artifact_produced_outbox"`);
    expect(op.text).toContain("ON CONFLICT (event_id) DO NOTHING");
    // 13 bound params ($1..$13; $12/$13 the producing attempt, cinatra#4762); continuation_address + status are SQL literals.
    expect(op.values).toHaveLength(13);
    expect(op.values[0]).toBe(
      producedEventId("art-1", "rev-1", "artifact_produced"),
    );
    expect(op.values[1]).toBe("org-1");
  });

  it("maps the physical ArtifactOriginKind onto the lattice provenance axis", () => {
    // agent_generated → agent_produced; upload → user_provided.
    const agent = buildProducedEventInsertOp("cinatra", { ...base, originKind: "agent_generated" });
    expect(agent.values[8]).toBe("agent_produced");
    const upload = buildProducedEventInsertOp("cinatra", { ...base, originKind: "upload" });
    expect(upload.values[8]).toBe("user_provided");
  });

  it("defaults destination to 'none' and continuation to async_effects_gated", () => {
    const op = buildProducedEventInsertOp("cinatra", base);
    expect(op.values[9]).toBe("none");
    expect(op.values[10]).toBe("async_effects_gated");
  });

  it("carries producer provenance (run + agent) when supplied", () => {
    const op = buildProducedEventInsertOp("cinatra", {
      ...base,
      producerRunId: "run-9",
      producerAgentId: "agent-9",
    });
    expect(op.values[6]).toBe("run-9");
    expect(op.values[7]).toBe("agent-9");
  });

  // red-first-expect: to contain 'producer_run_generation'
  it("records the producing attempt's reset generation as the attempt carries it, never the run row's live state (cinatra#4762)", () => {
    // The delayed drain raises the event's review later, perhaps after a retry's reset began the next attempt: the
    // event itself carries the generation of the attempt that produced it, in both insert shapes.
    for (const op of [
      buildProducedEventInsertOp("cinatra", { ...base, producerRunId: "run-9", producerAttempt: { generation: 0 } }),
      buildProducedEventInsertOp("cinatra", { ...base, producerRunId: "run-9", producerAttempt: { generation: 0 } }, { whereExistsSql: "true" }),
    ]) {
      expect(op.text).toContain("producer_run_generation");
      expect(op.text).toMatch(/continuation_address, status, producer_run_generation\)/);
      // The carried generation ($12) wins; only a verified dispatch ($13) that is still the run's current one reads it.
      expect(op.text.replace(/\s+/g, " ")).toContain(
        `coalesce($12::integer, (SELECT live_run.reset_generation FROM "cinatra"."agent_runs" live_run WHERE live_run.id = $7::text AND live_run.execution_attempt_id = $13::text AND live_run.status IN ('running', 'pending_approval')), -1)`,
      );
      expect(op.values[6]).toBe("run-9");
      expect(op.values.slice(11)).toEqual([0, null]);
    }
  });

  // red-first-expect: expected [] to deeply equal [ null, 'attempt-7' ]
  it("a verified dispatch names its attempt id; no attempt identity, or no run, records -1 (cinatra#4762)", () => {
    const dispatched = buildProducedEventInsertOp("cinatra", { ...base, producerRunId: "run-9", producerAttempt: { executionAttemptId: "attempt-7" } });
    expect(dispatched.values.slice(11)).toEqual([null, "attempt-7"]);
    // Neither parameter set: the coalesce falls through to -1.
    expect(buildProducedEventInsertOp("cinatra", { ...base, producerRunId: "run-9", producerAttempt: null }).values.slice(11)).toEqual([null, null]);
    // A carried attempt with no run named is no attempt of any run.
    expect(buildProducedEventInsertOp("cinatra", { ...base, producerRunId: null, producerAttempt: { generation: 3 } }).values.slice(11)).toEqual([null, null]);
    // A generation that is no safe integer is none.
    expect(buildProducedEventInsertOp("cinatra", { ...base, producerRunId: "run-9", producerAttempt: { generation: 1.5 } }).values.slice(11)).toEqual([null, null]);
  });

  // red-first-expect: to deeply equal { locksRunRow: true, guardKept: true }
  it("takes the producing run's row FOR KEY SHARE in the insert itself, so a Publish's locked fence read serializes with it (cinatra#4762)", () => {
    const LOCK = `(SELECT count(*) FROM (SELECT 1 FROM "cinatra"."agent_runs" run_lock WHERE run_lock.id = $7::text FOR KEY SHARE) locked_run) >= 0`;
    const flat = (text: string) => text.replace(/\s+/g, " ");
    const plain = flat(buildProducedEventInsertOp("cinatra", { ...base, producerRunId: "run-9", producerAttempt: { generation: 0 } }).text);
    const guarded = flat(buildProducedEventInsertOp("cinatra", { ...base, producerRunId: "run-9", producerAttempt: { generation: 0 } },
      { whereExistsSql: "EXISTS (SELECT 1)" }).text);
    expect({ locksRunRow: plain.includes(`WHERE ${LOCK} AND `), guardKept: guarded.includes(` AND (EXISTS (SELECT 1)) ON CONFLICT`) })
      .toEqual({ locksRunRow: true, guardKept: true });
    // The row is the producing run's own ($7): the lock never names another run.
    expect(buildProducedEventInsertOp("cinatra", { ...base, producerRunId: "run-9", producerAttempt: null }).values[6]).toBe("run-9");
  });

  // red-first-expect: to match /calls_in_flight > 0/
  it("refuses the whole write while a publishing call of the run's current attempt holds its released decision (cinatra#4762)", () => {
    // That call read the review fence without this output; the event's cast of the fence's sentinel aborts the writer's
    // transaction, its artifact rows included. The writer's earlier lock statement (producerRunLockOps) makes this read
    // see every claim committed before it.
    const CALL = `(CASE WHEN EXISTS (SELECT 1 FROM "cinatra"."agent_run_publish_decisions" call_claim JOIN "cinatra"."agent_runs" claim_run ON claim_run.id = call_claim.run_id WHERE call_claim.run_id = $7::text AND call_claim.calls_in_flight > 0 AND coalesce(call_claim.run_generation, claim_run.reset_generation) = claim_run.reset_generation) THEN 'cinatra_publish_call_in_flight' ELSE '1' END)::integer = 1`;
    for (const op of [
      buildProducedEventInsertOp("cinatra", { ...base, producerRunId: "run-9", producerAttempt: { generation: 0 } }),
      buildProducedEventInsertOp("cinatra", { ...base, producerRunId: "run-9", producerAttempt: { generation: 0 } }, { whereExistsSql: "EXISTS (SELECT 1)" }),
    ]) {
      expect(op.text).toMatch(/calls_in_flight > 0/);
      expect(op.text.replace(/\s+/g, " ")).toContain(` AND ${CALL}`);
    }
  });

  // red-first-expect: expected undefined to be defined
  it("the in-flight abort is its own error, never a division by zero or another cast (cinatra#4762)", () => {
    // What Postgres raises for the fence's cast, read from the op itself.
    const op = buildProducedEventInsertOp("cinatra", { ...base, producerRunId: "run-9", producerAttempt: { generation: 0 } });
    const sentinel = /THEN '([^']+)' ELSE '1' END\)::integer = 1/.exec(op.text)?.[1];
    expect(sentinel).toBeDefined();
    const fence = Object.assign(new Error(`invalid input syntax for type integer: "${sentinel}"`), { code: "22P02" });
    expect(isPublishCallInFlightAbort(fence)).toBe(true);
    // A bridge that keeps only the message, and a query builder that wraps the database error as its cause.
    expect(isPublishCallInFlightAbort(new Error(fence.message))).toBe(true);
    expect(isPublishCallInFlightAbort(new Error(`Failed query: ${op.text}`, { cause: fence }))).toBe(true);
    // The typed refusal a writer rethrows.
    expect(publishCallInFlightOr(fence)).toMatchObject({ name: "PublishCallInFlightError", code: "publish_call_in_flight", retryable: true });
    // Never: a division by zero (a writer's unknown base, a compare-and-set), another cast, or the statement's text.
    for (const other of [
      Object.assign(new Error("division by zero"), { code: "22012" }),
      Object.assign(new Error('invalid input syntax for type integer: "abc"'), { code: "22P02" }),
      Object.assign(new Error(fence.message), { code: "23505" }),
      new Error(`Failed query: ${op.text}`),
    ]) {
      expect(isPublishCallInFlightAbort(other)).toBe(false);
      expect(publishCallInFlightOr(other)).toBe(other);
    }
  });

  // red-first-expect: producerRunLockOps is not a function
  it("a writer whose rows precede its event takes the producing run's row FOR KEY SHARE first, only when it splices the event (cinatra#4762)", () => {
    const event = maybeBuildProducedEventInsertOp("cinatra", { ...base, producerRunId: "run-9", producerAttempt: { generation: 0 } });
    expect(producerRunLockOps("cinatra", "run-9", event)).toEqual([
      { text: `SELECT 1 FROM "cinatra"."agent_runs" WHERE id = $1::text FOR KEY SHARE`, values: ["run-9"] },
    ]);
    // No run named: no row to lock.
    expect(producerRunLockOps("cinatra", null, event)).toEqual([]);
    // The switch OFF splices no event, and the transaction stays the pre-flip one: no lock either.
    process.env[ENV] = "off";
    const off = maybeBuildProducedEventInsertOp("cinatra", { ...base, producerRunId: "run-9", producerAttempt: { generation: 0 } });
    expect(off).toBeNull();
    expect(producerRunLockOps("cinatra", "run-9", off)).toEqual([]);
  });

  it("rejects an unknown emitter (the closed emitter set)", () => {
    expect(() =>
      buildProducedEventInsertOp("cinatra", {
        ...base,
        // @ts-expect-error — deliberately invalid emitter
        emitter: "not-a-real-emitter",
      }),
    ).toThrow(/unknown produced-event emitter/);
  });
});
