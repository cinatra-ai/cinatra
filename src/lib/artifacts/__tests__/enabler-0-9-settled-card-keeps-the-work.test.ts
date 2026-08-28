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
 * The rest of 0.9 — the resolved-gate display reader, the display-only settled
 * preparation mode, the surface model's settled targets, the island rendering
 * them, the card composing them, the protocol's settled island carriage and the
 * widget's settled island credential — landed before this slice and is asserted
 * by its own suites; this file adds the historical reader and pins that the
 * PENDING reading did not move an inch.
 */
import { describe, expect, it } from "vitest";

import {
  prepareReviewTargetsCore,
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

/**
 * A store in which the artifact has been TOMBSTONED since the decision: the
 * live-only reader answers null, and only the gate-authorized historical reader
 * can still name the pinned revision.
 */
function tombstonedPorts(gateStatus: "pending" | "resolved") {
  const consulted: string[] = [];
  const ports: PrepareReviewPorts = {
    verifyRunAccess: () => ({ ok: true }),
    readGatePinnedTargets: () => ({ status: gateStatus, targets: [TARGET] }),
    readArtifact: () => ({ kind: "ok", artifact: ARTIFACT }),
    revisionMember: (): RevisionMemberOutcome => {
      consulted.push("live");
      return null;
    },
    revisionMemberHistorical: (): RevisionMemberOutcome => {
      consulted.push("historical");
      return { mime: "text/markdown", form: "file" };
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
        content: { kind: "none", channelVersion: 1, representationRevisionId: input.representationRevisionId, reason: "absent" },
      }) as never,
  };
  return { ports, consulted };
}

describe("enabler 0.9 — the gate-authorized historical reader", () => {
  it("draws the approved work from a TOMBSTONED artifact on the settled reading", async () => {
    const { ports, consulted } = tombstonedPorts("resolved");
    const result = await prepareReviewTargetsCore(
      { runId: RUN, reviewTaskId: GATE, targets: [TARGET], acceptResolvedGate: true },
      ports,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The work is on screen: a real mount over the pinned revision, not the
    // "revision-not-member" floor a live-only read would have produced.
    expect(result.prepared[0].mount).toMatchObject({ kind: "form", form: "markdown" });
    expect(result.prepared[0].props).not.toBeNull();
    expect(result.prepared[0].props?.representation?.revisionId).toBe(TARGET.representationRevisionId);
    expect(consulted).toEqual(["historical"]);
  });

  it("THE ORDINARY READING STAYS LIVE — a pending gate never reaches the historical reader", async () => {
    const { ports, consulted } = tombstonedPorts("pending");
    const result = await prepareReviewTargetsCore(
      { runId: RUN, reviewTaskId: GATE, targets: [TARGET] },
      ports,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A tombstoned pin on a LIVE review still floors, exactly as before.
    expect(result.prepared[0].mount).toMatchObject({ kind: "floor", reason: "revision-not-member" });
    expect(result.prepared[0].props).toBeNull();
    expect(consulted).toEqual(["live"]);
  });

  it("does NOT reach the historical reader for a caller that merely set the flag on a pending gate", async () => {
    const { ports, consulted } = tombstonedPorts("pending");
    await prepareReviewTargetsCore(
      { runId: RUN, reviewTaskId: GATE, targets: [TARGET], acceptResolvedGate: true },
      ports,
    );
    expect(consulted).toEqual(["live"]);
  });

  it("keeps a RESOLVED gate closed to every path that did not ask for the read-only reading", async () => {
    const { ports, consulted } = tombstonedPorts("resolved");
    const result = await prepareReviewTargetsCore(
      { runId: RUN, reviewTaskId: GATE, targets: [TARGET] },
      ports,
    );
    expect(result).toEqual({ ok: false, error: { kind: "gate-not-pending" } });
    // Refused BEFORE any target was read — no reader of either kind ran.
    expect(consulted).toEqual([]);
  });

  it("keeps the live-only reading when a binder supplies no historical reader at all", async () => {
    const { ports } = tombstonedPorts("resolved");
    const withoutHistorical: PrepareReviewPorts = { ...ports };
    delete (withoutHistorical as { revisionMemberHistorical?: unknown }).revisionMemberHistorical;
    const result = await prepareReviewTargetsCore(
      { runId: RUN, reviewTaskId: GATE, targets: [TARGET], acceptResolvedGate: true },
      withoutHistorical,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared[0].mount).toMatchObject({ kind: "floor", reason: "revision-not-member" });
  });
});
