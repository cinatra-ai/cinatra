/**
 * THE BINDING IS PROVED PER ARTIFACT (cinatra#3476).
 *
 * The measured production: one completed Blog Idea Generator run filed five blog
 * ideas — one artifact per member of its `ideas` output, each through the agent's
 * own declared fan-out binding — and the product filed the whole list beside them
 * on the default road, as a JSON artifact titled after the agent. The lifecycle
 * batched all six produced events into ONE gate, and the review pinned SIX
 * targets: the five ideas, and the list of the five.
 *
 * The template-level declaration cannot tell those six apart: the agent DOES
 * declare an artifact-bound output, so `hasArtifactBindings` is true for every
 * one of the six events. The half that tells them apart is each write's OWN
 * provenance — the ledger path it took — and that is what the proof asks for
 * here: a write on the default road is bound to no declared output, so it is not
 * a review target; the five members are.
 *
 * Pure: the six event shapes, the two declarations, no database.
 */
import { describe, expect, it } from "vitest";

import {
  proveReviewBinding,
  writeProvenanceFromLedgerPaths,
  DEFAULT_ROAD_MATERIALIZATION_PATH,
  type ProducedWriteProvenance,
} from "@/lib/lifecycle/lifecycle-review-core";
import type { ProducedEventAxes } from "@/lib/lifecycle/lifecycle-orchestration";

/** One produced event of the measured run, with the provenance of its write. */
type ProducedWrite = {
  title: string;
  axes: ProducedEventAxes;
  provenance: ProducedWriteProvenance;
};

const axes = (n: number): ProducedEventAxes => ({
  eventId: `evt-3476-${n}`,
  artifactId: `art-3476-${n}`,
  representationRevisionId: `rev-3476-${n}`,
  originKind: "agent_produced",
  destinationClass: "none",
  continuationMode: "checkpointed",
});

/** The production as it was measured: five members through the declared binding,
 *  then the list of them through the default road. */
const PRODUCTION: ProducedWrite[] = [
  "Reproducible Builds as a Release Trust Signal",
  "Artifact Provenance for Safer Software Releases",
  "Review Gates Without Release Gridlock",
  "How Proof Rounds Catch Release Risk Early",
  "Verification Records That Make Releases Auditable",
]
  .map((title, index) => ({
    title,
    axes: axes(index),
    provenance: { materializationPath: "end_node_binding" } as ProducedWriteProvenance,
  }))
  .concat([
    {
      title: "the run's ideas list, filed as JSON beside the five ideas",
      axes: axes(5),
      provenance: {
        materializationPath: DEFAULT_ROAD_MATERIALIZATION_PATH,
      } as ProducedWriteProvenance,
    },
  ]);

/** The agent declares an artifact-bound output — true for every one of the six. */
const DECLARES_A_BINDING = { hasArtifactBindings: true } as const;

const pin = (write: ProducedWrite) =>
  proveReviewBinding({
    kind: "produced-output",
    produces: DECLARES_A_BINDING,
    writeEvent: write.axes,
    writeProvenance: write.provenance,
  });

describe("the review pins only the artifacts a declared binding produced", () => {
  it("the six produced events of the measured run pin FIVE targets, not six", () => {
    expect(PRODUCTION).toHaveLength(6);
    const pinned = PRODUCTION.map(pin).filter((binding) => binding.bound);
    expect(pinned).toHaveLength(5);
  });

  it("the five ideas are the targets, each pinned at its own revision", () => {
    const targets = PRODUCTION.map(pin).flatMap((binding) =>
      binding.bound && binding.kind === "produced-output" ? [binding.target] : [],
    );
    expect(targets).toEqual(
      PRODUCTION.slice(0, 5).map((write) => ({
        artifactId: write.axes.artifactId,
        representationRevisionId: write.axes.representationRevisionId,
      })),
    );
  });

  it("the list the default road filed is not a target, and says why", () => {
    const listWrite = PRODUCTION[5];
    const binding = pin(listWrite);
    expect(binding.bound).toBe(false);
    if (binding.bound) throw new Error("unreachable");
    expect(binding.why).toContain("default road");
  });

  it("the agent's own declaration cannot tell the six apart — the write's provenance can", () => {
    // Every one of the six carries the SAME template-level declaration, so a
    // proof that asks only that question pins all six.
    const withoutProvenance = PRODUCTION.map((write) =>
      proveReviewBinding({
        kind: "produced-output",
        produces: DECLARES_A_BINDING,
        writeEvent: write.axes,
      }),
    ).filter((binding) => binding.bound);
    expect(withoutProvenance).toHaveLength(6);
    // With each write's own provenance, the list drops out and the members stay.
    expect(PRODUCTION.map(pin).filter((binding) => binding.bound)).toHaveLength(5);
  });
});

describe("the provenance a write is read back with is order-independent", () => {
  // The identity the store reads a write back by — (org, run, artifact,
  // revision) — is not the ledger's unique key, so a write may be named by more
  // than one row. The answer must not depend on which row the store saw first.
  it("one row recording the default road settles it, whatever order the rows come back in", () => {
    expect(
      writeProvenanceFromLedgerPaths([
        "derived_output",
        DEFAULT_ROAD_MATERIALIZATION_PATH,
      ]).materializationPath,
    ).toBe(DEFAULT_ROAD_MATERIALIZATION_PATH);
    expect(
      writeProvenanceFromLedgerPaths([
        DEFAULT_ROAD_MATERIALIZATION_PATH,
        "derived_output",
      ]).materializationPath,
    ).toBe(DEFAULT_ROAD_MATERIALIZATION_PATH);
  });

  it("no row at all is UNKNOWN, and UNKNOWN keeps the review", () => {
    expect(writeProvenanceFromLedgerPaths([]).materializationPath).toBeNull();
    expect(
      proveReviewBinding({
        kind: "produced-output",
        produces: DECLARES_A_BINDING,
        writeEvent: axes(0),
        writeProvenance: writeProvenanceFromLedgerPaths([]),
      }).bound,
    ).toBe(true);
  });

  it("a declared binding's own path keeps the write a target", () => {
    expect(
      proveReviewBinding({
        kind: "produced-output",
        produces: DECLARES_A_BINDING,
        writeEvent: axes(0),
        writeProvenance: writeProvenanceFromLedgerPaths(["end_node_binding"]),
      }).bound,
    ).toBe(true);
  });
});
