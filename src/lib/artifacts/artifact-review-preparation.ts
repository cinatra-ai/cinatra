/**
 * The generic artifact-review PREPARATION core (cinatra#1795, epic #1620 S12,
 * item 2). Given a run, a gate identity, and caller-supplied review targets, it
 * produces — per target — the serialized display props + a HOST-produced mount
 * descriptor, with the never-blank floor on every artifact-level failure class.
 *
 * The three trust guarantees, enforced HERE, in order:
 *   1. GATE PROVENANCE — the run is access-checked and the gate must be a
 *      PENDING gate on that run; a caller cannot prepare a review against a run
 *      it may not read or a gate that already resolved.
 *   2. NO CLIENT TARGET SUBSTITUTION — every caller target must belong to the
 *      gate's PINNED set (resolved at gate creation, frozen). A target the gate
 *      never pinned is a HARD rejection (never a render-degrade), so the client
 *      cannot smuggle in an artifact/revision the gate did not authorize.
 *   3. RENDERER RESOLVED FROM TYPE, NEVER CALLER-CHOSEN — the mount descriptor
 *      is produced by the host `resolveMount` port from the artifact's semantic
 *      type (the S2 dispatch spine), so no renderer id ever crosses from the
 *      client. The core branches ONLY on the OPAQUE mount kind (G1-clean: it
 *      keys on no concrete type / binding / renderer id).
 *
 * Per-target degrades (a pinned target that cannot render) become a FLOOR
 * descriptor — unknown/tombstoned artifact, read-denied, non-member revision,
 * or a runtime-installed-but-unbuilt claimant — never a blank and never the
 * bytes. Only substitution (a target the gate never pinned) fails the call.
 *
 * PURE (no React / DB / server-only): every seam is an injected port, so the
 * whole authz + degrade matrix is unit-testable without a DB. The server binder
 * (`src/app/artifacts/[id]/review-target-prepare.ts`) wires the real host seams.
 * Mirrors the pure-leaf + server-binder split of
 * `renderer-dispatch.ts` / `renderer-resolution.ts`.
 */
import type { ArtifactRendererProps } from "./artifact-renderer-props";
import type { ArtifactSummary } from "./artifact-service";
import type { SerializedRuntimeRendererDescriptor } from "./runtime-renderer-descriptor";
import {
  normalizeReviewTargets,
  partitionAgainstPinnedTargets,
  type ArtifactReviewTarget,
} from "./artifact-review-target";

// ---------------------------------------------------------------------------
// The HOST-produced mount descriptor (opaque to the client).
// ---------------------------------------------------------------------------

/** Why a target renders the never-blank floor instead of an extension renderer.
 * Every reason is an artifact-/type-level display degrade — a pinned target the
 * reviewer cannot be shown through its type's renderer — never an integrity
 * failure (those fail the whole call). */
export type ReviewMountFloorReason =
  /** The pinned artifact is absent, not an artifact type, or tombstoned. */
  | "unknown-or-tombstoned"
  /** object.read refused this artifact for the reviewing actor. */
  | "read-denied"
  /** The pinned revision is not a member of this artifact (or tombstoned-away). */
  | "revision-not-member"
  /** The artifact's type ships a semantic renderer that is runtime-installed but
   * ABSENT from this build. */
  | "requires-rebuild"
  /** The artifact's type ships no semantic detail renderer — the generic floor. */
  | "no-semantic-renderer";

/** The single renderer the review surface mounts for a target. Semantic `detail`
 * slot this release. Every field (generatedKey / packageName / descriptor) is
 * HOST-resolved from the artifact type — the client receives it, it never
 * supplies it. */
export type ReviewTargetMount =
  | { kind: "build-map"; slot: "detail"; packageName: string; generatedKey: string }
  | {
      kind: "runtime";
      slot: "detail";
      packageName: string;
      descriptor: SerializedRuntimeRendererDescriptor;
    }
  | { kind: "floor"; slot: "detail"; packageName: string | null; reason: ReviewMountFloorReason };

/** One prepared target: its display props (null when there is no artifact /
 * representation to render — the floor cases) and its host mount descriptor. */
export interface PreparedReviewTarget {
  target: ArtifactReviewTarget;
  props: ArtifactRendererProps | null;
  mount: ReviewTargetMount;
}

// ---------------------------------------------------------------------------
// Port outcomes.
// ---------------------------------------------------------------------------

export type RunAccessOutcome = { ok: true } | { ok: false; status: number };

export type GatePinnedOutcome =
  | { status: "pending"; targets: ArtifactReviewTarget[] }
  | { status: "not-pending" }
  | { status: "not-found" };

export type ArtifactReadOutcome =
  | { kind: "ok"; artifact: ArtifactSummary }
  | { kind: "not-found" }
  | { kind: "denied" };

export type RevisionMemberOutcome = { mime: string } | null;

/** The renderer-resolution outcome the host derives FROM the artifact type. Only
 * the two loadable paths + the two type-level floors — the artifact-level floors
 * (unknown / denied / non-member) are produced by the core BEFORE resolveMount
 * is ever consulted. */
export type ResolvedRendererMount =
  | { kind: "build-map"; packageName: string; generatedKey: string }
  | { kind: "runtime"; packageName: string; descriptor: SerializedRuntimeRendererDescriptor }
  | { kind: "floor"; packageName: string | null; reason: "requires-rebuild" | "no-semantic-renderer" };

export interface PrepareReviewPorts {
  /** Verify the reviewing actor may READ the run (enforceRunAccess "read"). */
  verifyRunAccess(runId: string): Promise<RunAccessOutcome> | RunAccessOutcome;
  /** The gate's PINNED target set (frozen at gate creation) — or the gate's
   * non-pending / absent status. `not-found` is folded into gate-not-pending by
   * the core so gate existence is never leaked. */
  readGatePinnedTargets(
    runId: string,
    reviewTaskId: string,
  ): Promise<GatePinnedOutcome> | GatePinnedOutcome;
  /** Read the artifact with object.read enforced (mirrors readArtifactForDetail). */
  readArtifact(artifactId: string): Promise<ArtifactReadOutcome> | ArtifactReadOutcome;
  /** Confirm the pinned revision is a member of the artifact (and resolve its
   * mime). Null ⇒ non-member / tombstoned-away. */
  revisionMember(
    artifactId: string,
    representationRevisionId: string,
  ): Promise<RevisionMemberOutcome> | RevisionMemberOutcome;
  /** Resolve the renderer FROM THE ARTIFACT TYPE (the S2 dispatch spine). Never
   * consults the target or any caller input for renderer identity. */
  resolveMount(input: {
    artifact: ArtifactSummary;
    mime: string;
    propsApiVersion: number;
  }): Promise<ResolvedRendererMount> | ResolvedRendererMount;
  /** Build the serialized, display-only props snapshot for a pinned revision. */
  buildProps(input: {
    artifact: ArtifactSummary;
    representationRevisionId: string;
    mime: string;
  }): ArtifactRendererProps;
}

// ---------------------------------------------------------------------------
// Result.
// ---------------------------------------------------------------------------

export type PrepareReviewError =
  | { kind: "invalid-targets"; message: string }
  | { kind: "run-access-denied"; status: number }
  | { kind: "gate-not-pending" }
  | { kind: "target-substitution"; substituted: ArtifactReviewTarget[] };

export type PrepareReviewResult =
  | { ok: true; prepared: PreparedReviewTarget[] }
  | { ok: false; error: PrepareReviewError };

export interface PrepareReviewInput {
  runId: string;
  /** The gate identity (a `setup-<runId>` / `wayflow-<taskId>` reviewTaskId). */
  reviewTaskId: string;
  /** Caller-supplied targets — validated, deduped, and checked against the
   * gate's pinned set. */
  targets: unknown;
  /** Optional cap override (defaults to MAX_REVIEW_TARGETS via normalize). */
  maxTargets?: number;
}

// ---------------------------------------------------------------------------
// The pure core.
// ---------------------------------------------------------------------------

/**
 * Prepare the caller's review targets. Order matters and is security-load-bearing:
 * run access → pending gate → substitution check (ALL hard failures) run BEFORE
 * any per-target artifact work, so an unauthorized / substituted request never
 * reaches a read or a renderer resolve.
 */
export async function prepareReviewTargetsCore(
  input: PrepareReviewInput,
  ports: PrepareReviewPorts,
): Promise<PrepareReviewResult> {
  // 1. Validate/normalize the caller's targets (a single malformed element
  //    rejects the whole list — never silently drop a target under review).
  const normalized = normalizeReviewTargets(input.targets, { maxTargets: input.maxTargets });
  if (!normalized.ok) {
    return { ok: false, error: { kind: "invalid-targets", message: normalized.error } };
  }

  // 2. Run access (gate provenance, half 1): the actor must be able to READ the
  //    run this gate belongs to.
  const access = await ports.verifyRunAccess(input.runId);
  if (!access.ok) {
    return { ok: false, error: { kind: "run-access-denied", status: access.status } };
  }

  // 3. Pending gate (gate provenance, half 2): the gate must be a PENDING gate
  //    on this run, and it carries the frozen pinned target set. A non-pending /
  //    absent gate is a single "not pending" outcome (gate existence not leaked).
  const gate = await ports.readGatePinnedTargets(input.runId, input.reviewTaskId);
  if (gate.status !== "pending") {
    return { ok: false, error: { kind: "gate-not-pending" } };
  }

  // 4. NO CLIENT TARGET SUBSTITUTION: every caller target must be in the pinned
  //    set. Any that is not is a HARD rejection — never a per-target degrade.
  const { member, substituted } = partitionAgainstPinnedTargets(normalized.targets, gate.targets);
  if (substituted.length > 0) {
    return { ok: false, error: { kind: "target-substitution", substituted } };
  }

  // 5. Per (pinned, member) target: resolve the never-blank display.
  const prepared: PreparedReviewTarget[] = [];
  for (const target of member) {
    prepared.push(await prepareOneTarget(target, ports));
  }
  return { ok: true, prepared };
}

async function prepareOneTarget(
  target: ArtifactReviewTarget,
  ports: PrepareReviewPorts,
): Promise<PreparedReviewTarget> {
  // Artifact-level floors (props null — nothing authorized to render props from).
  const read = await ports.readArtifact(target.artifactId);
  if (read.kind === "not-found") {
    return { target, props: null, mount: floor(null, "unknown-or-tombstoned") };
  }
  if (read.kind === "denied") {
    return { target, props: null, mount: floor(null, "read-denied") };
  }
  const artifact = read.artifact;

  const member = await ports.revisionMember(target.artifactId, target.representationRevisionId);
  if (!member) {
    return { target, props: null, mount: floor(null, "revision-not-member") };
  }
  const { mime } = member;

  // Props are valid from here on (a real artifact + a member revision) — even a
  // type-level floor (requires-rebuild / no-semantic-renderer) renders the
  // generic view from these props, never a blank.
  const props = ports.buildProps({
    artifact,
    representationRevisionId: target.representationRevisionId,
    mime,
  });

  const resolved = await ports.resolveMount({ artifact, mime, propsApiVersion: props.propsApiVersion });
  if (resolved.kind === "build-map") {
    return {
      target,
      props,
      mount: { kind: "build-map", slot: "detail", packageName: resolved.packageName, generatedKey: resolved.generatedKey },
    };
  }
  if (resolved.kind === "runtime") {
    return {
      target,
      props,
      mount: { kind: "runtime", slot: "detail", packageName: resolved.packageName, descriptor: resolved.descriptor },
    };
  }
  return { target, props, mount: floor(resolved.packageName, resolved.reason) };
}

function floor(packageName: string | null, reason: ReviewMountFloorReason): ReviewTargetMount {
  return { kind: "floor", slot: "detail", packageName, reason };
}
