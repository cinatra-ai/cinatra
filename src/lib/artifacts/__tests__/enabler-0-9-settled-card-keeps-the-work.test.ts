/**
 * ENABLER 0.9 — the settled card keeps the work. The contract-level acceptance
 * test for the half this slice owns (cinatra#3027 / epic #3023).
 *
 * THE ENABLER'S OWN SENTENCE, the clause this file proves: "At gate creation a
 * durable review-gate representation pin is recorded, and a RUN- OR
 * GATE-AUTHORIZED HISTORICAL READER READS EXACTLY THAT PINNED REPRESENTATION
 * EVEN AFTER THE ARTIFACT IS TOMBSTONED; the ordinary artifact page stays live
 * and latest. No decision or mutation affordance remains."
 *
 * WHAT IT FIXES, IN THE PLAN'S OWN WORDS: "the reviewed revision can be
 * tombstoned later, so a settled card that read the live artifact could show
 * nothing where the approved work was."
 *
 * TWO READS GO HISTORICAL TOGETHER, and the first fixture below is why. The
 * preparation reads the ARTIFACT before it reads the pinned revision, and the
 * live artifact read answers `not-found` for a tombstone — so a historical
 * REVISION reader alone never runs, and the settled card floors at
 * `unknown-or-tombstoned` with the approved work still sitting in the store.
 * A fixture that stubs a tombstoned artifact as a LIVE `ok` read — which no real
 * binder can produce — therefore passes while the real path floors, which is why
 * the tombstoned fixture below answers `not-found` from the live artifact read.
 *
 * The rest of 0.9 — the resolved-gate display reader, the display-only settled
 * preparation mode, the surface model's settled targets, the island rendering
 * them, the card composing them, the protocol's settled island carriage and the
 * widget's settled island credential — landed before this slice and is asserted
 * by its own suites; this file adds the historical readers and pins that the
 * PENDING reading did not move an inch.
 */
import { describe, expect, it } from "vitest";

import {
  prepareReviewTargetsCore,
  type ArtifactReadOutcome,
  type PrepareReviewPorts,
  type RevisionMemberOutcome,
} from "@/lib/artifacts/artifact-review-preparation";
import type { ArtifactSummary } from "@/lib/artifacts/artifact-service";

const RUN = "run-3027";
const GATE = "wayflow-task-3027";
const TARGET = { artifactId: "artifact-a", representationRevisionId: "rev-a" };

const ARTIFACT = {
  artifactId: TARGET.artifactId,
  title: "The approved draft",
  objectType: "@cinatra-ai/blog-post:post",
  mime: "text/markdown",
  size: 12,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  ownerLevel: "organization",
  visibility: "organization",
  sourceUrl: null,
  effectiveIdentity: { kind: "no-primary", extension: null },
  presentationIdentity: { kind: "no-primary", extension: null },
} as unknown as ArtifactSummary;

const MEMBER: RevisionMemberOutcome = { mime: "text/markdown", form: "file" };

function basePorts(
  gateStatus: "pending" | "resolved",
  reads: {
    live: ArtifactReadOutcome;
    historical: ArtifactReadOutcome;
    liveMember: RevisionMemberOutcome;
    historicalMember: RevisionMemberOutcome;
  },
) {
  const consulted: string[] = [];
  const ports: PrepareReviewPorts = {
    verifyRunAccess: () => ({ ok: true }),
    readGatePinnedTargets: () => ({ status: gateStatus, targets: [TARGET] }),
    readArtifact: () => {
      consulted.push("artifact-live");
      return reads.live;
    },
    readArtifactHistorical: () => {
      consulted.push("artifact-historical");
      return reads.historical;
    },
    revisionMember: () => {
      consulted.push("member-live");
      return reads.liveMember;
    },
    revisionMemberHistorical: () => {
      consulted.push("member-historical");
      return reads.historicalMember;
    },
    resolveMount: () => ({ kind: "form", arm: "first-party", form: "markdown" }),
    buildProps: (input) =>
      ({
        propsApiVersion: input.propsApiVersion,
        artifact: { id: input.artifact.artifactId },
        representation: { revisionId: input.representationRevisionId, mime: input.mime },
        urls: { preview: null, download: null },
        identity: { kind: "no-primary", extension: null },
        actions: { download: null, openInSource: null },
        content: {
          kind: "none",
          channelVersion: 1,
          representationRevisionId: input.representationRevisionId,
          reason: "absent",
        },
      }) as never,
  };
  return { ports, consulted };
}

/**
 * The store in which the ARTIFACT ITSELF has been tombstoned since the decision.
 * This is what a real binder produces: `readArtifactForDetail` is live-rows-only,
 * so the live read answers `not-found` and only the gate-authorized historical
 * read can still name the row.
 */
const tombstonedArtifactPorts = (gateStatus: "pending" | "resolved") =>
  basePorts(gateStatus, {
    live: { kind: "not-found" },
    historical: { kind: "ok", artifact: ARTIFACT },
    liveMember: null,
    historicalMember: MEMBER,
  });

/** The store in which the artifact is still live but the pinned REVISION is no
 *  longer a live member (the representation-level half of the same defect). */
const revisionGonePorts = (gateStatus: "pending" | "resolved") =>
  basePorts(gateStatus, {
    live: { kind: "ok", artifact: ARTIFACT },
    historical: { kind: "ok", artifact: ARTIFACT },
    liveMember: null,
    historicalMember: MEMBER,
  });

describe("enabler 0.9 — the gate-authorized historical reader", () => {
  it("draws the approved work from a TOMBSTONED ARTIFACT on the settled reading", async () => {
    const { ports, consulted } = tombstonedArtifactPorts("resolved");
    const result = await prepareReviewTargetsCore(
      { runId: RUN, reviewTaskId: GATE, targets: [TARGET], acceptResolvedGate: true },
      ports,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The work is on screen: a real mount over the pinned revision, not the
    // `unknown-or-tombstoned` floor the live artifact read produces.
    expect(result.prepared[0].mount).toMatchObject({ kind: "form", form: "markdown" });
    expect(result.prepared[0].props).not.toBeNull();
    expect(result.prepared[0].props?.representation?.revisionId).toBe(TARGET.representationRevisionId);
    // BOTH reads went historical, and neither live reader ran.
    expect(consulted).toEqual(["artifact-historical", "member-historical"]);
  });

  it("draws it when the artifact lives on but the pinned REVISION is gone", async () => {
    const { ports, consulted } = revisionGonePorts("resolved");
    const result = await prepareReviewTargetsCore(
      { runId: RUN, reviewTaskId: GATE, targets: [TARGET], acceptResolvedGate: true },
      ports,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared[0].mount).toMatchObject({ kind: "form", form: "markdown" });
    expect(consulted).toEqual(["artifact-historical", "member-historical"]);
  });

  it("THE ORDINARY READING STAYS LIVE — a pending gate never reaches either historical reader", async () => {
    const tombstoned = tombstonedArtifactPorts("pending");
    const result = await prepareReviewTargetsCore(
      { runId: RUN, reviewTaskId: GATE, targets: [TARGET] },
      tombstoned.ports,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A tombstoned artifact on a LIVE review floors exactly as it did before.
    expect(result.prepared[0].mount).toMatchObject({ kind: "floor", reason: "unknown-or-tombstoned" });
    expect(result.prepared[0].props).toBeNull();
    expect(tombstoned.consulted).toEqual(["artifact-live"]);

    const gone = revisionGonePorts("pending");
    const second = await prepareReviewTargetsCore(
      { runId: RUN, reviewTaskId: GATE, targets: [TARGET] },
      gone.ports,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.prepared[0].mount).toMatchObject({ kind: "floor", reason: "revision-not-member" });
    expect(gone.consulted).toEqual(["artifact-live", "member-live"]);
  });

  it("does NOT reach either historical reader for a caller that merely set the flag on a pending gate", async () => {
    const { ports, consulted } = tombstonedArtifactPorts("pending");
    await prepareReviewTargetsCore(
      { runId: RUN, reviewTaskId: GATE, targets: [TARGET], acceptResolvedGate: true },
      ports,
    );
    expect(consulted).toEqual(["artifact-live"]);
  });

  it("keeps a RESOLVED gate closed to every path that did not ask for the read-only reading", async () => {
    const { ports, consulted } = tombstonedArtifactPorts("resolved");
    const result = await prepareReviewTargetsCore(
      { runId: RUN, reviewTaskId: GATE, targets: [TARGET] },
      ports,
    );
    expect(result).toEqual({ ok: false, error: { kind: "gate-not-pending" } });
    // Refused BEFORE any target was read — no reader of either kind ran.
    expect(consulted).toEqual([]);
  });

  it("keeps the live-only reading when a binder supplies NO historical readers at all", async () => {
    const { ports, consulted } = tombstonedArtifactPorts("resolved");
    const withoutHistorical: PrepareReviewPorts = { ...ports };
    delete (withoutHistorical as { readArtifactHistorical?: unknown }).readArtifactHistorical;
    delete (withoutHistorical as { revisionMemberHistorical?: unknown }).revisionMemberHistorical;
    const result = await prepareReviewTargetsCore(
      { runId: RUN, reviewTaskId: GATE, targets: [TARGET], acceptResolvedGate: true },
      withoutHistorical,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared[0].mount).toMatchObject({ kind: "floor", reason: "unknown-or-tombstoned" });
    expect(consulted).toEqual(["artifact-live"]);
  });

  it("keeps the live-only MEMBER reading when only the artifact reader is historical", async () => {
    // A half-wired binder must not silently gain the revision-level replay.
    const { ports, consulted } = revisionGonePorts("resolved");
    const partial: PrepareReviewPorts = { ...ports };
    delete (partial as { revisionMemberHistorical?: unknown }).revisionMemberHistorical;
    const result = await prepareReviewTargetsCore(
      { runId: RUN, reviewTaskId: GATE, targets: [TARGET], acceptResolvedGate: true },
      partial,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared[0].mount).toMatchObject({ kind: "floor", reason: "revision-not-member" });
    expect(consulted).toEqual(["artifact-historical", "member-live"]);
  });
});
