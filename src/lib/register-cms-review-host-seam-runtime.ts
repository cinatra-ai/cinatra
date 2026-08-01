import "server-only";

// ---------------------------------------------------------------------------
// The BOOT-ONLY runtime binder for the `@cinatra-ai/host:cms-review` capability
// (cinatra#2043, epic #2037 S5).
//
// WHY THIS MODULE EXISTS (route-graph ratchet posture, mirroring the
// `bind-artifact-review-gate-seam` / lifecycle-review runner-slot precedents in
// `src/lib/boot/phases/system-loops.ts`): the capability PROVIDER is published
// from `register-host-connector-services.ts`, which sits in the LOCKED dev-perf
// routes' reachable first-party graph. The four real seam bindings reach the
// heavy core stores (`@/lib/artifacts/cms-content-snapshot-capture` → the
// objects/artifact-authoring graph; `@cinatra-ai/agents/lifecycle-review-
// orchestration` → the gate/park/outbox graph; `@cinatra-ai/agents/cms-snapshot-
// readback-store` → the agents store graph; `@/lib/extension-host-actor`;
// `@cinatra-ai/mcp-server`). A dynamic `import("<literal>")` of any of those in a
// route-reachable module STILL counts as an edge in `scripts/route-graph.mjs`
// (its extractor follows literal dynamic-import specifiers exactly like static
// ones), so binding them inline in the seam module dragged ~16 modules onto
// EVERY locked route and tripped the route-graph ratchet.
//
// The fix keeps the bindings LAZY exactly as before but relocates their
// literal-specifier dynamic imports OUT of any route-reachable module into THIS
// binder, which is imported ONLY from the boot graph (the system-loops
// `bind-cms-review-host-seam` phase). The binder builds the real seam and
// installs it into the globalThis slot declared in `cms-review-host-seam.ts`;
// the route-reachable `register-host-connector-services` publication reads that
// slot through a thin deferred wrapper (importing only the TYPE from the seam
// module). So the heavy store graph rides only boot, never a route — and there
// is NO behaviour change: every write-driving member still lazy-imports its
// heavy store at INVOCATION time, so a fence-off host stays byte-identical and
// the live W1/W4 proofs remain valid.
// ---------------------------------------------------------------------------

import {
  buildCmsReviewHostSeam,
  registerBuiltCmsReviewHostSeam,
  type CmsReviewHostSeamDeps,
  type CmsReviewIdentity,
} from "@/lib/cms-review-host-seam";
import { isLifecycleReviewOrchestrationActive } from "@/lib/lifecycle/lifecycle-activation";
import type { CmsRepairedCapturePort } from "@cinatra-ai/agents/cms-repaired-capture-port";
import { publishCmsRepairedCapturePort } from "@cinatra-ai/agents/cms-repaired-capture-port";

/**
 * Build the REAL `CmsReviewHostSeamDeps` (the injected core seams). Every
 * write-driving member resolves its heavy store LAZILY at call time (dynamic
 * `import()`) so building does no I/O and no resolution (probe-safe), mirroring
 * the anthropic-skill-config / skills-catalog lazy-bind precedents.
 * `isReviewActive` is the pure env fence (no import cost).
 *
 * This factory lives in the boot-only graph (imported from the system-loops
 * `bind-cms-review-host-seam` phase, never a route-reachable module), so its
 * literal dynamic-import specifiers never grow a locked route's reachable graph.
 */
function createCmsReviewHostSeamDeps(): CmsReviewHostSeamDeps {
  return {
    isReviewActive: () => isLifecycleReviewOrchestrationActive(),
    resolveIdentity: async (): Promise<CmsReviewIdentity> => {
      const [{ resolveExtensionActorSummary }, mcp] = await Promise.all([
        import("@/lib/extension-host-actor"),
        import("@cinatra-ai/mcp-server"),
      ]);
      const summary = await resolveExtensionActorSummary();
      const runId = mcp.mcpRequestContextStorage.getStore()?.runId ?? null;
      return {
        orgId: summary?.organizationId ?? null,
        runId: typeof runId === "string" && runId.length > 0 ? runId : null,
        createdBy: summary?.userId ?? null,
      };
    },
    captureCmsContentSnapshot: async (i) =>
      (await import("@/lib/artifacts/cms-content-snapshot-capture")).captureCmsContentSnapshot(i),
    // S6 (#2044 L-B + L-D): the pinned before/after capture pair. Lazy exactly
    // like the stores above — the capture module reaches the connect-site store,
    // the webhook secret service, and (through a SPAWNED script, never an
    // import) a headless browser, so it must never appear in a route-reachable
    // graph.
    capturePinnedPreviewPair: async (i) => {
      const { capturePinnedPreviewPairForGate } = await import(
        "@/lib/artifacts/cms-preview-capture"
      );
      const pair = await capturePinnedPreviewPairForGate(i);
      const project = (o: { status: "captured" | "degraded"; reason?: string }) =>
        o.status === "captured"
          ? { status: "captured" as const }
          : { status: "degraded" as const, reason: o.reason };
      return { before: project(pair.before), current: project(pair.current) };
    },
    // S6 (#2044 L-D): the post-apply read-back render, pinned with the S4
    // verification record it gives a visual counterpart to.
    capturePostApplyPreview: async (i) => {
      const { capturePostApplyPreviewForGate } = await import(
        "@/lib/artifacts/cms-preview-capture"
      );
      const outcome = await capturePostApplyPreviewForGate(i);
      return outcome.status === "captured"
        ? { status: "captured" }
        : { status: "degraded", reason: outcome.reason };
    },
    // D-7 (cinatra#2047): the CORE disposition gained a sixth state,
    // `policy_unresolved` (a checkpointed park TTL-expired with the policy never
    // resolved → the protected effect is TERMINALLY blocked). The connector-side
    // `CmsReviewDisposition` mirror is a FIVE-state contract owned by the connector
    // repos, so the new state is NARROWED here to `held` — the existing value whose
    // connector behaviour is exactly right (never apply; keep holding). The block is
    // terminal rather than pending, so the operator-facing truth is carried by the
    // lifecycle-operations ops surface (which reads the park set directly), not by
    // widening a cross-repo union.
    resolveArtifactEffectDisposition: async (i) => {
      const { disposition, gate } = await (
        await import("@cinatra-ai/agents/lifecycle-review-orchestration")
      ).resolveArtifactEffectDisposition(i);
      return { disposition: disposition === "policy_unresolved" ? "held" : disposition, gate };
    },
    readCmsSnapshotTargetByOperation: async (operationId) => {
      const row = await (
        await import("@cinatra-ai/agents/cms-snapshot-readback-store")
      ).readCmsSnapshotTargetByOperation(operationId);
      return row
        ? {
            artifactId: row.artifactId,
            snapshotRevisionId: row.snapshotRevisionId,
            scopeManifest: { paths: [...(row.scopeManifest?.paths ?? [])] },
          }
        : null;
    },
    readCmsSnapshotProposedFields: async (orgId, snapshotRevisionId) =>
      (await import("@/lib/artifacts/cms-content-snapshot-capture")).readCmsSnapshotProposedFields(
        orgId,
        snapshotRevisionId,
      ),
    recordCmsApplyVerification: async (i) => {
      const res = await (
        await import("@cinatra-ai/agents/cms-snapshot-readback-store")
      ).recordCmsApplyVerification(i);
      if (!res.ok) return { ok: false, code: res.code, error: res.error };
      return {
        ok: true,
        verdict: { outcome: res.verdict.outcome, outOfScopePaths: res.verdict.outOfScopePaths },
      };
    },
  };
}

/**
 * Publish the `repaired`-capture entry point (cinatra#2044 / #2046) on the
 * agents-package port. The repair-completion drain
 * (`lifecycle-repair-cms-production-bridge`) takes the round trip's THIRD
 * picture through it when a producer's fix lands — the right-hand side of
 * #2287's repair pair, which no production code wrote before this binding
 * existed.
 *
 * Bound HERE, in the same boot-only module as the seam deps, for the same
 * route-graph reason: the leaf agents package must not carry a literal
 * dynamic-import edge to the capture module (a headless-browser + connect-store
 * graph), so it reads this port off globalThis instead.
 *
 * The port never throws and never blocks the repair: it reports `captured`, or a
 * NAMED degrade plus whether that reason was pinned onto the gate.
 *
 * EXPORTED so the repair round-trip integration test publishes THIS adapter —
 * the one production boots — rather than restating it, which is what lets that
 * test assert the real writer fired instead of hand-inserting a capture row.
 */
export function createCmsRepairedCapturePort(): CmsRepairedCapturePort {
  return async (request) => {
    const { captureRepairedPreviewForGate, captureStatesItsGap } = await import(
      "@/lib/artifacts/cms-preview-capture"
    );
    const outcome = await captureRepairedPreviewForGate({
      orgId: request.orgId,
      successorArtifactId: request.successorTarget.artifactId,
      successorSnapshotRevisionId: request.successorTarget.representationRevisionId,
      baseArtifactId: request.baseTarget.artifactId,
      baseSnapshotRevisionId: request.baseTarget.representationRevisionId,
      title: request.title,
      createdBy: request.createdBy ?? null,
      producerRunId: request.producerRunId ?? null,
    });
    return outcome.status === "captured"
      ? { status: "captured" }
      : {
          status: "degraded",
          reason: outcome.reason,
          // `recorded` asks ONE question: can the successor gate state its own
          // gap? Only a pinned record that CARRIES a reason can — the renderer
          // prints the record's `degradedReason` verbatim, so a pinned record
          // with a null reason renders a causeless blank side, which is the very
          // thing this work exists to stop. A non-null `capture` alone is not
          // that proof (a codex convergence finding).
          recorded: captureStatesItsGap(outcome),
        };
  };
}

/**
 * Build the real CMS-review seam and install it into the globalThis DI slot,
 * and publish the repaired-capture port beside it.
 * Called from the boot-only system-loops `bind-cms-review-host-seam` phase
 * (UNCONDITIONAL — capability publication is fence-independent; the fence is read
 * per-call by `isReviewActive`). Idempotent (last write wins).
 */
export function bindCmsReviewHostSeamRuntime(): void {
  registerBuiltCmsReviewHostSeam(buildCmsReviewHostSeam(createCmsReviewHostSeamDeps()));
  publishCmsRepairedCapturePort(createCmsRepairedCapturePort());
}
