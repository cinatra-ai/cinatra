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
    // 11 bound params ($1..$11); continuation_address + status are SQL literals.
    expect(op.values).toHaveLength(11);
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
