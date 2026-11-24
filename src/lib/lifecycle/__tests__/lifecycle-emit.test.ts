/**
 * cinatra#2039 (epic #2037 S1) — the local-write PRODUCED-EVENT emit builder: the
 * default-ON-with-explicit-opt-out behaviour (#2047 ruling), the op shape (columns/params), the deterministic
 * event id, the physical→lattice origin mapping, and the closed emitter set. Pure.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  buildProducedEventInsertOp,
  maybeBuildProducedEventInsertOp,
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
