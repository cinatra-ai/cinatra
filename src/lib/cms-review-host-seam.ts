import "server-only";

// ---------------------------------------------------------------------------
// The host `@cinatra-ai/host:cms-review` capability binding (cinatra#2043, epic
// #2037 S5 — the host WIRING that pairs the two merged halves).
//
// The CORE half (#2082) shipped the review-before-publish machinery as
// host-internal server modules the standalone connector build can NEVER import
// (`captureCmsContentSnapshot` — the one-Tx snapshot + produced-event + apply
// binding; `recordCmsApplyVerification` — the post-apply read-back verifier;
// the effect disposition over `isArtifactEffectHeld`; the review fence). The
// CONNECTOR half (wordpress-mcp-connector#84) placed the staged-write TRIGGER at
// `wordpress_post_update` and consumes those seams through an OPTIONAL
// `@cinatra-ai/host:cms-review` capability it resolves lazily + probe-safe — and
// is provably INERT until the host publishes it.
//
// THIS module is that publication: it binds the four seams the connector probes
// for onto the real core functions, deriving org / run / actor from the trusted
// MCP request frame (NEVER connector input — the `requireInstanceWriteAuthority`
// posture) and threading them into the capture. `register-host-connector-services`
// registers the built seam under the capability id.
//
// FENCE SEMANTICS: publication is UNCONDITIONAL (the connector already no-ops on
// the fence-off path — its `evaluateStagedContentWrite` returns `{action:"pass"}`
// before any capture when `isReviewActive()` is false). The capability itself
// reports the fence truthfully via `isLifecycleReviewOrchestrationActive()`, and
// gates the produced-event emission on it, so a host with the fence off keeps
// byte-identical write behaviour even though the capability is present.
//
// READ-BACK BASE: the connector hands the read-back seam ONLY the post-apply
// re-read (`postApplyFields`) — it never re-sends the approved proposal. The
// approved proposal IS the durable base: the capture persisted the connector's
// canonical CMS-fields serialization as the snapshot, so the binding reads it
// back (`readCmsSnapshotProposedFields`) and projects it as the REVIEWED target.
// The verdict then reads a post-apply field that deviates from the approved
// proposal and lies OUTSIDE the stored scope manifest as out-of-scope `drifted`
// (a site plugin rewriting content on save) — exactly the issue AC — while a
// faithful apply that matches the approved proposal reads `verified`.
// ---------------------------------------------------------------------------

import type {
  ConnectorRefPointer,
  ConnectorRefResolvedContent,
} from "@cinatra-ai/objects/connector-ref";

/** The five-state disposition of a captured staged write's external effect —
 * mirrors the connector's `CmsReviewDisposition`. */
export type CmsReviewDisposition = "held" | "approved" | "rejected" | "ungated" | "unknown";

/** The gate a captured staged write is holding on (for surfacing + the read-back
 * binding). Mirrors the connector's `CmsReviewGateRef`. */
export type CmsReviewGateRef = { gateId: string; runId: string } | null;

/** The closed set of authorized apply paths — mirrors `CmsReviewScopeManifest`. */
export type CmsReviewScopeManifest = { paths: string[] };

/** The non-identity coordinates of a staged CMS content write the connector hands
 * the host capture seam — mirrors the connector's `CmsReviewCaptureInput`. The
 * pointer / resolved shapes ARE the core `connector-ref` types (the connector's
 * mirrors are structural subsets), so capture accepts them directly. */
export interface CmsReviewCaptureInput {
  pointer: ConnectorRefPointer;
  resolved: ConnectorRefResolvedContent;
  capturedAt: string;
  scopeManifest: CmsReviewScopeManifest;
  connectorInstance: string;
  resourceType: string;
  cmsResourceId: string;
  baseRemoteRevisionRef: string | null;
  operationId: string;
  title?: string;
}

/** The snapshot identity a capture returns — mirrors `CmsReviewCaptureResult`. */
export interface CmsReviewCaptureResult {
  artifactId: string;
  snapshotRevisionId: string;
  snapshotTargetId: string;
  operationId: string;
  producedEventId: string | null;
}

/** Post-apply read-back input — mirrors the connector's `CmsReviewReadbackInput`. */
export interface CmsReviewReadbackInput {
  operationId: string;
  gateId: string;
  runId: string;
  postApplyFields: Record<string, string>;
}

/** Post-apply read-back result — mirrors the connector's `CmsReviewReadbackResult`. */
export interface CmsReviewReadbackResult {
  ok: boolean;
  outcome?: "verified" | "drifted" | "unmet";
  outOfScope?: string[];
  code?: string;
  error?: string;
}

/** The published host seam — mirrors the connector's `CmsReviewSeam` structurally
 * (they meet at runtime through the capability registry). */
export interface CmsReviewHostSeam {
  isReviewActive: () => boolean;
  captureStagedWrite: (input: CmsReviewCaptureInput) => Promise<CmsReviewCaptureResult>;
  resolveDisposition: (input: {
    artifactId: string;
    snapshotRevisionId: string;
  }) => Promise<{ disposition: CmsReviewDisposition; gate: CmsReviewGateRef }>;
  recordApplyVerification: (input: CmsReviewReadbackInput) => Promise<CmsReviewReadbackResult>;
}

/** The trusted identity the host derives from the MCP request frame — never
 * connector input. `orgId` scopes every write; `runId` links the produced event
 * to the agent run so the review weaves into that run's rail; `createdBy` is the
 * human subject stamped on the snapshot. */
export interface CmsReviewIdentity {
  orgId: string | null;
  runId: string | null;
  createdBy: string | null;
}

/** A resolved capture-time apply binding — the fields the read-back needs,
 * including the STORED scope manifest (the closed set of authorized apply paths;
 * the read-back can never widen it). */
export interface CmsReviewTargetRow {
  artifactId: string;
  snapshotRevisionId: string;
  scopeManifest: { paths: string[] };
}

/** A pinned target the verification records against. */
export interface CmsReviewVerificationTargetRef {
  artifactId: string;
  representationRevisionId: string;
}

/** The verification result the core read-back returns (the subset the mapping
 * reads). */
export type CmsReviewVerificationResult =
  | {
      ok: true;
      verdict: { outcome: "verified" | "drifted" | "unmet"; outOfScopePaths: string[] };
    }
  | { ok: false; code: string; error: string };

/** The injected core seams — real in `createCmsReviewHostSeam`, stubbed in tests.
 * Every member is the real function's exact call shape so the binding is a thin
 * delegation with identity threading, unit-provable without a database. */
export interface CmsReviewHostSeamDeps {
  isReviewActive: () => boolean;
  resolveIdentity: () => Promise<CmsReviewIdentity>;
  captureCmsContentSnapshot: (input: {
    orgId: string;
    pointer: ConnectorRefPointer;
    resolved: ConnectorRefResolvedContent;
    capturedAt: string;
    scopeManifest: CmsReviewScopeManifest;
    connectorInstance: string;
    resourceType: string;
    cmsResourceId?: string | null;
    baseRemoteRevisionRef?: string | null;
    operationId: string;
    producerRunId?: string | null;
    createdBy?: string | null;
    emitProducedEvent: boolean;
    title?: string;
  }) => Promise<{
    artifactId: string;
    snapshotRevisionId: string;
    snapshotTargetId: string;
    producedEventId: string | null;
  }>;
  /**
   * S6 (#2044 L-B) — the PINNED fetched-render capture, taken at gate creation.
   * OPTIONAL and best-effort by contract: the binding awaits it (the capture
   * must be pinned WITH the gate, never fetched later), but a rejection or a
   * degraded outcome can never fail the staged write. Absent ⇒ no capture step
   * runs and the write path is byte-identical to S5.
   */
  capturePinnedPreview?: (input: {
    orgId: string;
    boundArtifactId: string;
    boundSnapshotRevisionId: string;
    role: "current";
    sourceUrl: string | null;
    externalId: string | null;
    title?: string;
    createdBy?: string | null;
    producerRunId?: string | null;
  }) => Promise<{ status: "captured" | "degraded"; reason?: string }>;
  resolveArtifactEffectDisposition: (input: {
    artifactId: string;
    representationRevisionId: string;
  }) => Promise<{ disposition: CmsReviewDisposition; gate: CmsReviewGateRef }>;
  readCmsSnapshotTargetByOperation: (operationId: string) => Promise<CmsReviewTargetRow | null>;
  readCmsSnapshotProposedFields: (
    orgId: string,
    snapshotRevisionId: string,
  ) => Promise<Record<string, string> | null>;
  recordCmsApplyVerification: (input: {
    operationId: string;
    gateId: string;
    orgId: string;
    runId: string;
    repairedTarget: CmsReviewVerificationTargetRef;
    acceptedFindings: readonly { id: string; path?: string | null }[];
    projectFields: (t: CmsReviewVerificationTargetRef) => Record<string, string>;
    representationMatches?: boolean;
  }) => Promise<CmsReviewVerificationResult>;
}

/**
 * Build the host CMS-review seam from the injected core seams. PURE wiring — no
 * imports of the heavy stores, so a unit test can prove: each member delegates to
 * the right core function; the trusted identity is threaded from the frame into
 * the capture (never connector input); the produced event is gated on the fence;
 * the disposition passes through; and the read-back projects the stored proposal
 * as the reviewed base and maps the verdict to the connector's result shape.
 */
export function buildCmsReviewHostSeam(deps: CmsReviewHostSeamDeps): CmsReviewHostSeam {
  return {
    isReviewActive: () => deps.isReviewActive(),

    captureStagedWrite: async (input) => {
      const { orgId, runId, createdBy } = await deps.resolveIdentity();
      if (!orgId) {
        throw new Error(
          "[cms-review] no organization resolved from the trusted request frame — refusing to capture a staged CMS write without a tenant scope.",
        );
      }
      const res = await deps.captureCmsContentSnapshot({
        orgId,
        pointer: input.pointer,
        resolved: input.resolved,
        capturedAt: input.capturedAt,
        scopeManifest: input.scopeManifest,
        connectorInstance: input.connectorInstance,
        resourceType: input.resourceType,
        cmsResourceId: input.cmsResourceId,
        baseRemoteRevisionRef: input.baseRemoteRevisionRef,
        operationId: input.operationId,
        producerRunId: runId,
        createdBy,
        // CALLER-level fence: the core writer splices the produced-event INSERT
        // into the capture tx only when review orchestration is active.
        emitProducedEvent: deps.isReviewActive(),
        ...(input.title !== undefined ? { title: input.title } : {}),
      });
      // S6 (#2044 L-B): PIN the fetched render alongside the snapshot, at gate
      // creation. Awaited so an old gate can always show its ORIGINAL capture
      // (a later fetch would show a later page), but wrapped so NOTHING about
      // the capture can fail the staged write — a capture is additive context,
      // and its absence is recorded as a degraded capture the surface states.
      if (deps.capturePinnedPreview) {
        try {
          await deps.capturePinnedPreview({
            orgId,
            boundArtifactId: res.artifactId,
            boundSnapshotRevisionId: res.snapshotRevisionId,
            role: "current",
            sourceUrl: input.pointer.url ?? null,
            externalId: input.pointer.externalId ?? null,
            ...(input.title !== undefined ? { title: input.title } : {}),
            createdBy,
            producerRunId: runId,
          });
        } catch (err) {
          console.warn(
            "[cms-review] pinned preview capture failed (the gate is unaffected):",
            err instanceof Error ? err.message : err,
          );
        }
      }
      return {
        artifactId: res.artifactId,
        snapshotRevisionId: res.snapshotRevisionId,
        snapshotTargetId: res.snapshotTargetId,
        operationId: input.operationId,
        producedEventId: res.producedEventId,
      };
    },

    resolveDisposition: async ({ artifactId, snapshotRevisionId }) => {
      const { disposition, gate } = await deps.resolveArtifactEffectDisposition({
        artifactId,
        representationRevisionId: snapshotRevisionId,
      });
      return { disposition, gate };
    },

    recordApplyVerification: async (input) => {
      const { orgId } = await deps.resolveIdentity();
      if (!orgId) {
        return {
          ok: false,
          code: "no-org",
          error:
            "[cms-review] no organization resolved from the trusted request frame — cannot verify a CMS apply.",
        };
      }
      const target = await deps.readCmsSnapshotTargetByOperation(input.operationId);
      if (!target) {
        return {
          ok: false,
          code: "target-not-found",
          error: `[cms-review] no captured snapshot for operation ${input.operationId}`,
        };
      }
      // The REVIEWED (base) fields are the approved proposal, read back from the
      // stored snapshot. FAIL-CLOSED: an unreadable proposal cannot verify the
      // apply — substituting an empty base would let an all-in-scope read-back
      // read as `verified` (a codex convergence finding), so it errors, never
      // guesses.
      const proposedFields = await deps.readCmsSnapshotProposedFields(orgId, target.snapshotRevisionId);
      if (!proposedFields) {
        return {
          ok: false,
          code: "proposal-unreadable",
          error: `[cms-review] the approved proposal for operation ${input.operationId} could not be read back — refusing to verify fail-closed`,
        };
      }
      // EXPLICIT proposal-equality over the STORED scope paths (a codex
      // convergence finding). The core verdict treats an in-scope change as
      // EXPECTED (its base was designed as the PRE-apply state), so an in-scope
      // TAMPER — a site plugin rewriting the very field the reviewer approved to a
      // DIFFERENT value — would otherwise read as `verified`. WordPress must have
      // stored the approved value for every authorized field; any in-scope
      // deviation makes the apply UNFAITHFUL → `representationMatches:false` forces
      // a non-`verified` verdict. Out-of-scope deviations are still surfaced by the
      // core verdict as `drifted` (which takes outcome precedence).
      // STRICT presence-AND-equality (codex convergence findings): every stored
      // scope path MUST be present on BOTH the approved proposal and the post-apply
      // re-read, with strictly equal values. A nullish-normalized compare (`?? ""`)
      // would treat a MISSING field as an approved empty string, and a bare
      // `===` would let a key absent from BOTH sides pass as `undefined ===
      // undefined`; either would let an in-scope deletion / tamper read as
      // faithful. An over-flag here (an unnecessary reopen) is safe; an under-flag
      // (a tamper read as verified) is not — so any deviation, absence included,
      // makes the apply unfaithful.
      const hasOwn = (o: Record<string, string>, k: string) =>
        Object.prototype.hasOwnProperty.call(o, k);
      const inScopeFaithful = target.scopeManifest.paths.every(
        (p) =>
          hasOwn(proposedFields, p) &&
          hasOwn(input.postApplyFields, p) &&
          input.postApplyFields[p] === proposedFields[p],
      );
      // A synthetic post-apply revision id (never equal to the snapshot revision,
      // so the projector distinguishes base from read-back). The verification
      // record stores it as plain text — no representation row is required.
      const repairedRevisionId = `${target.snapshotRevisionId}:post-apply`;
      const res = await deps.recordCmsApplyVerification({
        operationId: input.operationId,
        gateId: input.gateId,
        orgId,
        runId: input.runId,
        repairedTarget: { artifactId: target.artifactId, representationRevisionId: repairedRevisionId },
        // No accepted findings: the base IS the approved proposal, so an in-scope
        // field is EXPECTED to already match. Out-of-scope deviation → `drifted`
        // (core verdict); in-scope deviation → `representationMatches:false` below.
        acceptedFindings: [],
        projectFields: (t) =>
          t.representationRevisionId === target.snapshotRevisionId ? proposedFields : input.postApplyFields,
        representationMatches: inScopeFaithful,
      });
      if (!res.ok) return { ok: false, code: res.code, error: res.error };
      return { ok: true, outcome: res.verdict.outcome, outOfScope: res.verdict.outOfScopePaths };
    },
  };
}

// ---------------------------------------------------------------------------
// Boot-registered BUILT seam (route-graph ratchet posture).
//
// The REAL seam (`buildCmsReviewHostSeam(deps)` with the deps whose members
// lazy-import the heavy core stores) is constructed and installed into this
// globalThis slot by the BOOT-ONLY `register-cms-review-host-seam-runtime`
// module, called from the system-loops `bind-cms-review-host-seam` phase. The
// heavy store bindings are kept OUT of any route-reachable module because
// `scripts/route-graph.mjs` follows a literal dynamic-import specifier exactly
// like a static import — so binding the stores in a route-reachable file (even
// lazily) dragged ~16 modules onto every locked route and tripped the ratchet
// (the same reason `background-jobs-registry` resolves its heavy runners through
// boot-registered globalThis slots, never importing them even dynamically). The
// route-reachable `register-host-connector-services` publication imports NO value
// from this module — only the `CmsReviewHostSeam` TYPE (erased) — and reads this
// slot off globalThis, so nothing cms-review pulls a module onto a route.
// ---------------------------------------------------------------------------

declare global {
  var __cinatraCmsReviewHostSeam: CmsReviewHostSeam | undefined;
}

/** Boot-time registration (system-loops `bind-cms-review-host-seam` phase).
 * Idempotent (last write wins). globalThis-backed so a worker dispatching from a
 * different bundle's module instance still sees the boot registration. */
export function registerBuiltCmsReviewHostSeam(seam: CmsReviewHostSeam): void {
  globalThis.__cinatraCmsReviewHostSeam = seam;
}
