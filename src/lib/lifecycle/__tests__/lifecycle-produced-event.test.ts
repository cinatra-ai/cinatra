/**
 * cinatra#2038 (epic #2037 S0) — the ArtifactProduced event contract: the
 * deterministic id, validation, and the reconciliation-sweeper detection half.
 * Pure, DB-free.
 */
import { describe, it, expect } from "vitest";

import {
  producedEventId,
  reconcileProducedEvents,
  validateProducedEvent,
  isProducedEventEmitter,
  PRODUCED_EVENT_EMITTERS,
  type ArtifactProducedEvent,
} from "../lifecycle-produced-event";

function mkEvent(over: Partial<ArtifactProducedEvent> = {}): ArtifactProducedEvent {
  const artifactId = over.artifactId ?? "art-1";
  const representationRevisionId = over.representationRevisionId ?? "rev-1";
  return {
    eventId: producedEventId(artifactId, representationRevisionId),
    orgId: "org-1",
    artifactId,
    representationRevisionId,
    eventKind: "artifact_produced",
    emitter: "createSemanticArtifact",
    producerRunId: "run-1",
    producerAgentId: "agent-1",
    originKind: "agent_produced",
    destinationClass: "none",
    continuationMode: "async_effects_gated",
    continuationAddress: null,
    ...over,
  };
}

describe("deterministic event id (gate key)", () => {
  it("is stable for the same (artifact, revision, kind) tuple", () => {
    expect(producedEventId("a", "b")).toBe(producedEventId("a", "b"));
  });
  it("differs across artifact / revision / kind", () => {
    expect(producedEventId("a", "b")).not.toBe(producedEventId("a", "c"));
    expect(producedEventId("a", "b")).not.toBe(producedEventId("x", "b"));
  });
});

describe("emitter enumeration", () => {
  it("recognizes exactly the enumerated emitters", () => {
    for (const e of PRODUCED_EVENT_EMITTERS) expect(isProducedEventEmitter(e)).toBe(true);
    expect(isProducedEventEmitter("some_other_writer")).toBe(false);
  });
});

describe("validation", () => {
  it("accepts a well-formed event whose id is its own deterministic id", () => {
    expect(validateProducedEvent(mkEvent()).ok).toBe(true);
  });
  it("rejects an event whose eventId is NOT the deterministic id (would evade the sweeper)", () => {
    const bad = mkEvent({ eventId: "hand-rolled-id" });
    const r = validateProducedEvent(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/deterministic id/);
  });
  it("rejects an unknown emitter", () => {
    const bad = mkEvent();
    (bad as { emitter: string }).emitter = "rogue_writer";
    expect(validateProducedEvent(bad).ok).toBe(false);
  });
  it("rejects a missing org / artifact / revision", () => {
    expect(validateProducedEvent(mkEvent({ orgId: "" })).ok).toBe(false);
  });
});

describe("reconciliation sweeper (detection half)", () => {
  it("reports an expected emit whose event id is absent (a suppressed emit)", () => {
    const present = new Set([producedEventId("a", "1")]);
    const missing = reconcileProducedEvents(
      [
        { artifactId: "a", representationRevisionId: "1" }, // present
        { artifactId: "b", representationRevisionId: "2" }, // suppressed
      ],
      present,
    );
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ artifactId: "b", representationRevisionId: "2" });
  });
  it("reports nothing when every expected emit is present", () => {
    const present = new Set([producedEventId("a", "1"), producedEventId("b", "2")]);
    const missing = reconcileProducedEvents(
      [
        { artifactId: "a", representationRevisionId: "1" },
        { artifactId: "b", representationRevisionId: "2" },
      ],
      present,
    );
    expect(missing).toHaveLength(0);
  });
});
