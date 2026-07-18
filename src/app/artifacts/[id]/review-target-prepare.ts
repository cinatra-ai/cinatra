import "server-only";

// The SERVER BINDER for the artifact-review preparation core (cinatra#1795, epic
// #1620 S12, item 2). Wires the pure `prepareReviewTargetsCore` to the REAL host
// seams for the artifact-side ports — the same seams the `/artifacts/[id]` detail
// route uses, so a reviewed target renders identically to how it opens in the
// library, but PINNED to the exact revision the gate froze (never "latest").
//
// RENDERER RESOLVED FROM THE ARTIFACT TYPE (never caller-chosen): `resolveMount`
// runs the SEMANTIC `detail` dispatch (`resolveSemanticDispatch`) off the row's
// effective-identity winner + the generated build map, then classifies the
// loadable path exactly like `ExtensionRendererMount`. It branches only on the
// opaque dispatch outputs — G1-clean, no concrete type / renderer id keyed here.
//
// The RUN + GATE ports (verifyRunAccess, readGatePinnedTargets) are supplied by
// the CALLER (the review surface / the reviewer-generalization slice #1796 that
// owns the emitting gate) so this artifact-side binder stays free of any
// agents-package coupling and grows no locked route graph.

import type { ActorContext } from "@/lib/authz/actor-context";
import {
  readArtifactForDetail,
  type ArtifactSummary,
} from "@/lib/artifacts/artifact-service";
import { resolveArtifactVersionForServe } from "@/lib/artifacts/artifact-read";
import { buildArtifactRendererProps } from "@/lib/artifacts/artifact-renderer-props";
import {
  prepareReviewTargetsCore,
  type ArtifactReadOutcome,
  type PrepareReviewInput,
  type PrepareReviewPorts,
  type PrepareReviewResult,
  type ResolvedRendererMount,
  type RevisionMemberOutcome,
} from "@/lib/artifacts/artifact-review-preparation";

import { resolveSemanticDispatch, classifyLoadablePath } from "./renderer-resolution";
import { resolveRuntimeRendererForRoute } from "./runtime-renderer-route";

/** The two run/gate ports the caller supplies (the agents-domain seam). */
export type ReviewRunGatePorts = Pick<
  PrepareReviewPorts,
  "verifyRunAccess" | "readGatePinnedTargets"
>;

/** Build the artifact-side ports bound to the reviewing actor + org. */
export function bindArtifactReviewPorts(ctx: {
  orgId: string;
  actor: ActorContext;
}): Pick<PrepareReviewPorts, "readArtifact" | "revisionMember" | "resolveMount" | "buildProps"> {
  const { orgId, actor } = ctx;

  const readArtifact = (artifactId: string): ArtifactReadOutcome => {
    const access = readArtifactForDetail({ artifactId, orgId, actor });
    if (access.kind === "not-found") return { kind: "not-found" };
    if (access.kind === "denied") return { kind: "denied" };
    return { kind: "ok", artifact: access.artifact };
  };

  const revisionMember = (
    artifactId: string,
    representationRevisionId: string,
  ): RevisionMemberOutcome => {
    // liveOnly: a review surface reviews LIVE artifacts — a tombstoned-but-pinned
    // representation must NOT resolve here (it degrades to the floor via a
    // not-found readArtifact / a null member), never serve stale bytes.
    const resolved = resolveArtifactVersionForServe({
      orgId,
      artifactId,
      representationRevisionId,
      liveOnly: true,
    });
    return resolved ? { mime: resolved.mime } : null;
  };

  const resolveMount = async (input: {
    artifact: ArtifactSummary;
    mime: string;
    propsApiVersion: number;
  }): Promise<ResolvedRendererMount> => {
    // Semantic detail slot this release — resolve the type's winner-bound semantic
    // renderer. No semantic renderer ⇒ the generic floor.
    const semantic = resolveSemanticDispatch(input.artifact.objectType, input.artifact.effectiveIdentity);
    // Winner-binding (defensive, mirrors pickArtifactRenderer): the resolved
    // claimant must BE the row's effective-identity extension winner.
    const winnerBound =
      semantic !== null &&
      input.artifact.effectiveIdentity.kind === "extension" &&
      input.artifact.effectiveIdentity.extension === semantic.packageName;
    if (!semantic || !winnerBound) {
      return { kind: "floor", packageName: semantic?.packageName ?? null, reason: "no-semantic-renderer" };
    }
    if (!semantic.built) {
      // Runtime-installed but absent from THIS build.
      return { kind: "floor", packageName: semantic.packageName, reason: "requires-rebuild" };
    }
    const path = classifyLoadablePath(semantic.generatedKey);
    if (path === "build-map") {
      return { kind: "build-map", packageName: semantic.packageName, generatedKey: semantic.generatedKey };
    }
    if (path === "runtime") {
      const descriptor = await resolveRuntimeRendererForRoute(semantic.generatedKey, input.propsApiVersion);
      if (!descriptor) {
        return { kind: "floor", packageName: semantic.packageName, reason: "requires-rebuild" };
      }
      // Pass the descriptor through even when it carries a pre-import `reason`
      // (peer/abi/archived) — the client loader renders its floor from the reason,
      // exactly as the detail route does. Never blank.
      return { kind: "runtime", packageName: semantic.packageName, descriptor };
    }
    return { kind: "floor", packageName: semantic.packageName, reason: "requires-rebuild" };
  };

  const buildProps = (input: {
    artifact: ArtifactSummary;
    representationRevisionId: string;
    mime: string;
  }) => {
    // Host-authorized, version-PINNED hrefs (the exact reviewed revision, never
    // the artifact's latest) — the same content/preview endpoints the detail
    // route points at.
    const { artifact, representationRevisionId, mime } = input;
    const previewHref = `/api/artifacts/${artifact.artifactId}/versions/${representationRevisionId}/preview`;
    const downloadHref = `/api/artifacts/${artifact.artifactId}/versions/${representationRevisionId}/content`;
    return buildArtifactRendererProps({
      artifact,
      representation: { revisionId: representationRevisionId, mime },
      previewHref,
      downloadHref,
    });
  };

  return { readArtifact, revisionMember, resolveMount, buildProps };
}

/**
 * Prepare a caller's review targets against a run's pending gate. Composes the
 * pure core with the real artifact-side ports + the caller-supplied run/gate
 * ports. Returns the per-target props + host mount descriptors (never-blank
 * floor on every artifact-level failure class; a substituted target fails).
 */
export async function prepareArtifactReviewTargets(args: {
  input: PrepareReviewInput;
  orgId: string;
  actor: ActorContext;
  runGatePorts: ReviewRunGatePorts;
}): Promise<PrepareReviewResult> {
  const artifactPorts = bindArtifactReviewPorts({ orgId: args.orgId, actor: args.actor });
  return prepareReviewTargetsCore(args.input, { ...artifactPorts, ...args.runGatePorts });
}
