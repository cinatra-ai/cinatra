/**
 * The generic artifact-review PREPARATION core (cinatra#1795, epic #1620 S12,
 * item 2). Given a run, a gate identity, and caller-supplied review targets, it
 * produces — per target — the serialized display props + a HOST-produced mount
 * descriptor, with the never-blank floor on every artifact-level failure class.
 *
 * The three trust guarantees, enforced HERE, in order:
 *   1. GATE PROVENANCE — the run is access-checked and the gate must be a
 *      PENDING gate on that run; a caller cannot prepare a review against a run
 *      it may not read. PENDING BY DEFAULT, and resolved ONLY for the read-only
 *      history reading: a caller that sets `acceptResolvedGate` may prepare a
 *      DECIDED gate's own frozen pinned set, because the reviewed work stays on
 *      screen after the decision ("A resolved gate opens read-only: what was
 *      decided, and the reviewed target(s), kept for the run's audit trail").
 *      That flag is default-closed and no decision path sets it, so a gate that
 *      already resolved is still unpreparable to everything that could act on
 *      it — and preparing it grants nothing but the drawing: the decision floor
 *      lives on the card, and the decided card draws none. The run access check
 *      is unchanged and runs first either way, and an ABSENT gate stays closed
 *      to both readings.
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
import {
  ARTIFACT_RENDERER_PROPS_API_VERSION,
  type ArtifactRendererProps,
} from "./artifact-renderer-props";
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

/**
 * The FORM-RENDERING RUNG's first-party arm (plan `PLAN: Agents Lifecycle (B)`
 * §5): the declared text forms the HOST itself renders — markdown and escaped
 * plain text. This is the rung the card was missing: the artifact page consumed
 * it before its fallback and the review path did not, so the same markdown draft
 * that renders on its own page showed "cannot render" under review.
 *
 * A CLOSED SET, and deliberately a local one. The pure core must not import the
 * route-scoped `pickHandler` (it reaches the server-only artifact-read module),
 * so the arm names are declared here and a structural test pins them to the
 * handler kinds `pickHandler` can actually return. Widening the host floor
 * therefore fails that test rather than silently drifting the two apart.
 *
 * It is an ARM, not the rung: once an artifact extension ships its own renderer
 * for a text type, the semantic tier wins above this and the arm is only a
 * floor — which is exactly why it is consumed BEFORE the fallback and not
 * instead of a package's renderer.
 */
export type ReviewFormArm = "markdown" | "text";

/** The single renderer the review surface mounts for a target. Semantic `detail`
 * slot this release. Every field (generatedKey / packageName / descriptor /
 * form) is HOST-resolved from the artifact type — the client receives it, it
 * never supplies it. */
export type ReviewTargetMount =
  | { kind: "build-map"; slot: "detail"; packageName: string; generatedKey: string }
  | {
      kind: "runtime";
      slot: "detail";
      packageName: string;
      descriptor: SerializedRuntimeRendererDescriptor;
    }
  /** The form-rendering rung: the host's own renderer for a declared text form,
   * server-rendered against the PINNED revision. `arm` names which arm of the
   * rung was consumed, so a later package arm is a new arm and not a new kind. */
  | { kind: "form"; slot: "detail"; arm: "first-party"; form: ReviewFormArm }
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
  /**
   * A gate that EXISTS on this run and has been decided, with the same frozen
   * pinned set it was decided on. Only the read-only history reading may prepare
   * from it (`acceptResolvedGate`); to every decision path it is exactly as
   * closed as `not-pending`.
   */
  | { status: "resolved"; targets: ArtifactReviewTarget[] }
  /** A port that cannot name a non-pending gate's set. Always closed. */
  | { status: "not-pending" }
  | { status: "not-found" };

export type ArtifactReadOutcome =
  | { kind: "ok"; artifact: ArtifactSummary }
  | { kind: "not-found" }
  | { kind: "denied" };

/**
 * A pinned revision that IS a member of its artifact.
 *
 * THE NON-FILE ARM (enabler 0.10 of `PLAN: Agents Lifecycle (C)`,
 * cinatra#3027). Before it, membership was answered only by the FILE-serving
 * resolver, so "the review path serves file-backed resources only, so a non-file
 * artifact floors before any renderer runs, however good the renderer, and a
 * revision of it carries nothing pinned to draw". A dashboard revision now
 * answers here too, with its FORM and its PINNED CONFIGURATION RECORD — and,
 * because it has no bytes, "non-file props carry no preview or download
 * address", which the binder honours by building those hrefs as null.
 *
 * `form` is optional so every existing caller and fixture keeps compiling; an
 * absent form reads as `file`, which is what every one of them meant.
 */
export type RevisionMemberOutcome =
  | {
      mime: string;
      /** The substrate's own recorded form — never a caller claim. */
      form?: "file" | "connectorRef" | "dashboard";
      /** The pinned configuration record for a non-file revision, or null. */
      configuration?: unknown;
      /** Its stable digest — what a data capability is sealed to (enabler 0.12). */
      configurationDigest?: string | null;
      /**
       * Was this member resolved through the GATE-AUTHORIZED HISTORICAL reader
       * (enabler 0.9) rather than the live one?
       *
       * It exists so a later read of the SAME revision — the content channel's
       * server read, which runs after this port has answered — is made under the
       * SAME bound this membership answer was made under, instead of guessing. A
       * settled card that kept its work must keep its content too; a live
       * reading must not replay a tombstoned pin to get one.
       *
       * Optional, and absent reads as the LIVE bound: that is what every caller
       * written before the content channel was bound meant.
       */
      historical?: boolean;
    }
  | null;

/** Is this member a FILE (and therefore byte-addressable)? An absent form reads
 *  as `file`: that is what every caller written before enabler 0.10 meant. */
export function isFileFormMember(member: NonNullable<RevisionMemberOutcome>): boolean {
  return (member.form ?? "file") === "file";
}

/** The renderer-resolution outcome the host derives FROM the artifact type. Only
 * the two loadable paths + the two type-level floors — the artifact-level floors
 * (unknown / denied / non-member) are produced by the core BEFORE resolveMount
 * is ever consulted. */
export type ResolvedRendererMount = (
  | { kind: "build-map"; packageName: string; generatedKey: string }
  | { kind: "runtime"; packageName: string; descriptor: SerializedRuntimeRendererDescriptor }
  | { kind: "form"; arm: "first-party"; form: ReviewFormArm }
  | { kind: "floor"; packageName: string | null; reason: "requires-rebuild" | "no-semantic-renderer" }
) & {
  /**
   * THE VERSION THIS DISPLAY NEGOTIATED (enabler 0.4 of
   * `PLAN: Agents Lifecycle (C)`): "resolve the display, read its declared props
   * version, then build the snapshot at that version". The core builds the
   * snapshot at this number, so a v1 display admitted under a later host is
   * handed a v1 snapshot rather than one it cannot read.
   *
   * Optional: a resolver that names none leaves the host's own version standing,
   * which is exactly the pre-0.4 behaviour and what the host's own form arm and
   * floors mean.
   */
  propsApiVersion?: number;
};

export interface PrepareReviewPorts {
  /** Verify the reviewing actor may READ the run (enforceRunAccess "read"). */
  verifyRunAccess(runId: string): Promise<RunAccessOutcome> | RunAccessOutcome;
  /** The gate's PINNED target set (frozen at gate creation) — for a pending
   * gate, and for a RESOLVED one whose set the read-only history reading draws.
   * `not-found` is folded into gate-not-pending by the core so gate existence is
   * never leaked. */
  readGatePinnedTargets(
    runId: string,
    reviewTaskId: string,
  ): Promise<GatePinnedOutcome> | GatePinnedOutcome;
  /** Read the artifact with object.read enforced (mirrors readArtifactForDetail).
   *  LIVE rows only — a tombstone reads as not-found. */
  readArtifact(artifactId: string): Promise<ArtifactReadOutcome> | ArtifactReadOutcome;
  /**
   * THE ARTIFACT-LEVEL HALF OF THE GATE-AUTHORIZED HISTORICAL READ (enabler
   * 0.9). Same authorization as {@link readArtifact} — the same ownership filter
   * and the same `object.read` decision — differing only in that a TOMBSTONED
   * row still resolves.
   *
   * It exists because the two halves cannot be split: the live artifact read
   * answers `not-found` for a tombstone, so a historical REVISION reader alone
   * never runs and the settled card floors at `unknown-or-tombstoned` — the
   * exact defect the enabler names. Consulted ONLY on the settled reading.
   *
   * Optional: a binder that supplies none keeps the live-only reading, which is
   * the pre-0.9 behaviour.
   */
  readArtifactHistorical?(
    artifactId: string,
  ): Promise<ArtifactReadOutcome> | ArtifactReadOutcome;
  /** Confirm the pinned revision is a member of the artifact (and resolve its
   * mime, its form and — for a non-file revision — its pinned configuration).
   * Null ⇒ non-member / tombstoned-away. */
  revisionMember(
    artifactId: string,
    representationRevisionId: string,
  ): Promise<RevisionMemberOutcome> | RevisionMemberOutcome;
  /**
   * THE RUN- OR GATE-AUTHORIZED HISTORICAL READER (enabler 0.9 of
   * `PLAN: Agents Lifecycle (C)`, cinatra#3027): "a run- or gate-authorized
   * historical reader reads exactly that pinned representation EVEN AFTER THE
   * ARTIFACT IS TOMBSTONED; the ordinary artifact page stays live and latest."
   *
   * Consulted ONLY on the settled reading, and ONLY after the gate has vouched
   * for the exact target — which is what "gate-authorized" means and why it is
   * a SECOND port rather than a flag on the first: nothing that can decide
   * anything is ever handed it. Without it, "the reviewed revision can be
   * tombstoned later, so a settled card that read the live artifact could show
   * nothing where the approved work was".
   *
   * Optional: a binder that supplies none keeps the live-only reading, which is
   * the pre-0.9 behaviour.
   */
  revisionMemberHistorical?(
    artifactId: string,
    representationRevisionId: string,
  ): Promise<RevisionMemberOutcome> | RevisionMemberOutcome;
  /** Resolve the renderer FROM THE ARTIFACT TYPE (the S2 dispatch spine). Never
   * consults the target or any caller input for renderer identity. */
  resolveMount(input: {
    artifact: ArtifactSummary;
    mime: string;
    /** The host's NEWEST props version — the negotiation CEILING, never an
     *  equality target (enabler 0.4). */
    propsApiVersion: number;
  }): Promise<ResolvedRendererMount> | ResolvedRendererMount;
  /** Build the serialized, display-only props snapshot for a pinned revision,
   *  AT THE VERSION THE DISPLAY NEGOTIATED (enabler 0.4), and with the member's
   *  own form so a non-file revision carries no preview or download address
   *  (enabler 0.10). */
  /**
   * Build the display props for ONE pinned revision.
   *
   * ASYNCHRONOUS BY CONTRACT, like the artifact page's own builder: the props
   * carry the versioned content channel's projection, and reading the pinned
   * revision's substance is a server read off the store. A binder that needs no
   * read may still answer synchronously — the core awaits either.
   *
   * IT MUST RESOLVE, NEVER REJECT. Everything else this core reads is answered
   * with the never-blank floor FOR ONE TARGET, because a card carries several
   * and one bad row must not blank the others. A rejection here would escape the
   * whole preparation and take the card down with it, so the read's failure is
   * the BINDER's to name: the content channel already carries a named absence
   * for exactly that, and the display draws its own reading from it. The binder
   * suite pins this; the core deliberately does not catch, so a binder that
   * throws is a defect in the binder rather than a silently floored card whose
   * cause nobody sees.
   */
  buildProps(input: {
    artifact: ArtifactSummary;
    representationRevisionId: string;
    mime: string;
    propsApiVersion: number;
    member: NonNullable<RevisionMemberOutcome>;
  }): Promise<ArtifactRendererProps> | ArtifactRendererProps;
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
  /**
   * Accept a RESOLVED gate's frozen pinned set as well as a pending gate's.
   *
   * DEFAULT CLOSED, and only the read-only history reading turns it on: "A
   * resolved gate opens read-only: what was decided, and the reviewed
   * target(s), kept for the run's audit trail." That reading draws the decided
   * work exactly as it was reviewed — the same never-blank ladder, the same
   * frozen revision — so it prepares the same set through the same core rather
   * than growing a second ladder beside it.
   *
   * EVERY DECISION PATH LEAVES THIS OFF, which is why it is a flag and not a
   * widening: a gate that is no longer pending still fails closed before any
   * target is read, and preparing a decided gate's targets never makes them
   * decidable — the decision floor is drawn by the card, and the decided reading
   * draws none.
   */
  acceptResolvedGate?: boolean;
}

// ---------------------------------------------------------------------------
// The pure core.
// ---------------------------------------------------------------------------

/**
 * Prepare the caller's review targets. Order matters and is security-load-bearing:
 * run access → gate provenance → substitution check (ALL hard failures) run
 * BEFORE any per-target artifact work, so an unauthorized / substituted request
 * never reaches a read or a renderer resolve.
 *
 * Gate provenance is PENDING BY DEFAULT; a RESOLVED gate's frozen set is
 * preparable only when the caller asked for the read-only history reading
 * (`acceptResolvedGate`). Neither the run access check nor the substitution
 * check moves for it.
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

  // 3. Gate provenance, half 2: the gate must be a PENDING gate on this run, and
  //    it carries the frozen pinned target set. A non-pending / absent gate is a
  //    single "not pending" outcome (gate existence not leaked).
  //
  //    ONE EXCEPTION, OPT-IN AND READ-ONLY: a caller that asked for the history
  //    reading (`acceptResolvedGate`) may prepare a RESOLVED gate's frozen set,
  //    because the reviewed work stays on screen after the decision — "A
  //    resolved gate opens read-only: what was decided, and the reviewed
  //    target(s), kept for the run's audit trail." An absent gate, and a port
  //    that cannot name the resolved set, stay closed either way.
  const gate = await ports.readGatePinnedTargets(input.runId, input.reviewTaskId);
  const pinned =
    gate.status === "pending"
      ? gate.targets
      : gate.status === "resolved" && input.acceptResolvedGate === true
        ? gate.targets
        : null;
  if (pinned === null) {
    return { ok: false, error: { kind: "gate-not-pending" } };
  }

  // 4. NO CLIENT TARGET SUBSTITUTION: every caller target must be in the pinned
  //    set. Any that is not is a HARD rejection — never a per-target degrade.
  // The SETTLED reading is the one the gate answered `resolved` for AND the
  // caller asked for. Both halves matter: a caller that merely set the flag on a
  // still-pending gate gets the ordinary live reading, and a resolved gate the
  // caller did not ask about was already refused above.
  const settledReading = gate.status === "resolved" && input.acceptResolvedGate === true;

  const { member, substituted } = partitionAgainstPinnedTargets(normalized.targets, pinned);
  if (substituted.length > 0) {
    return { ok: false, error: { kind: "target-substitution", substituted } };
  }

  // 5. Per (pinned, member) target: resolve the never-blank display.
  const prepared: PreparedReviewTarget[] = [];
  for (const target of member) {
    prepared.push(await prepareOneTarget(target, ports, settledReading));
  }
  return { ok: true, prepared };
}

async function prepareOneTarget(
  target: ArtifactReviewTarget,
  ports: PrepareReviewPorts,
  settled: boolean,
): Promise<PreparedReviewTarget> {
  // Artifact-level floors (props null — nothing authorized to render props from).
  //
  // ON THE SETTLED READING THE ARTIFACT ITSELF MAY BE TOMBSTONED (enabler 0.9).
  // The live reader answers `not-found` for a tombstone, so reading live here
  // floored the settled card at `unknown-or-tombstoned` BEFORE the historical
  // revision reader could run — "the reviewed revision can be tombstoned later,
  // so a settled card that read the live artifact could show nothing where the
  // approved work was". Both halves of the read therefore go historical
  // together, and only on the reading the gate itself authorized.
  const settledHistorical = settled === true;
  const read =
    settledHistorical && typeof ports.readArtifactHistorical === "function"
      ? await ports.readArtifactHistorical(target.artifactId)
      : await ports.readArtifact(target.artifactId);
  if (read.kind === "not-found") {
    return { target, props: null, mount: floor(null, "unknown-or-tombstoned") };
  }
  if (read.kind === "denied") {
    return { target, props: null, mount: floor(null, "read-denied") };
  }
  const artifact = read.artifact;

  // THE MEMBERSHIP READ. On the SETTLED reading the gate has already vouched for
  // this exact target, so the historical reader may answer for a tombstoned
  // artifact (enabler 0.9); everywhere else the live-only reader answers, and a
  // tombstoned pin floors exactly as it did before.
  const memberHistorical =
    settledHistorical && typeof ports.revisionMemberHistorical === "function";
  const member = memberHistorical
    ? await ports.revisionMemberHistorical!(target.artifactId, target.representationRevisionId)
    : await ports.revisionMember(target.artifactId, target.representationRevisionId);
  if (!member) {
    return { target, props: null, mount: floor(null, "revision-not-member") };
  }
  const { mime } = member;

  // PER-DISPLAY VERSION NEGOTIATION (enabler 0.4). The display is resolved
  // FIRST, at the host's ceiling, and the snapshot is then built at the version
  // that display declared — "resolve the display, read its declared props
  // version, then build the snapshot at that version". Building first and
  // resolving after would have made the order impossible to honour.
  const resolved = await ports.resolveMount({
    artifact,
    mime,
    propsApiVersion: ARTIFACT_RENDERER_PROPS_API_VERSION,
  });

  // Props are valid from here on (a real artifact + a member revision) — even a
  // type-level floor (requires-rebuild / no-semantic-renderer) renders the
  // generic view from these props, never a blank.
  // AWAITED, like `resolveMount` above (cinatra#3080, fix leg 7). The content
  // channel reads the pinned revision on the SERVER — "the text arm streams
  // bytes off the blob store, and the plan asks for an asynchronous builder
  // precisely so no display is ever tempted to fetch them itself" — so the props
  // a review target is built with cannot be assembled synchronously any more.
  const props = await ports.buildProps({
    artifact,
    representationRevisionId: target.representationRevisionId,
    mime,
    propsApiVersion: resolved.propsApiVersion ?? ARTIFACT_RENDERER_PROPS_API_VERSION,
    member,
  });

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
  if (resolved.kind === "form") {
    // The form rung reaches the reviewer with the SAME pinned props every other
    // mount kind carries — the host renders the frozen revision, never the
    // artifact's latest.
    return {
      target,
      props,
      mount: { kind: "form", slot: "detail", arm: resolved.arm, form: resolved.form },
    };
  }
  return { target, props, mount: floor(resolved.packageName, resolved.reason) };
}

function floor(packageName: string | null, reason: ReviewMountFloorReason): ReviewTargetMount {
  return { kind: "floor", slot: "detail", packageName, reason };
}
