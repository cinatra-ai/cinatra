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

import {
  resolveSemanticDispatch,
  resolveRepresentationDispatch,
  classifyLoadablePath,
} from "./renderer-resolution";
import { resolveRuntimeRendererForRoute } from "./runtime-renderer-route";
import { ensureActivatedRepresentationProviders } from "@/lib/artifacts/system-artifact-renderer-registrar";

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
    // Classify a resolved (packageName, generatedKey, `built`) tuple — from EITHER
    // dispatch path below — into a host mount descriptor exactly like the detail
    // route: the build-map SSR fast path, the runtime dynamic seam, or the
    // never-blank floor (requires-rebuild when the resolved key is not loadable in
    // THIS build). Keyed only on the opaque `generatedKey`; no concrete package
    // identity is branched on here (coupling-ban G1).
    const mountLoadable = async (
      packageName: string,
      generatedKey: string,
      built: boolean,
    ): Promise<ResolvedRendererMount> => {
      if (!built) {
        // Runtime-installed but absent from THIS build.
        return { kind: "floor", packageName, reason: "requires-rebuild" };
      }
      const path = classifyLoadablePath(generatedKey);
      if (path === "build-map") {
        return { kind: "build-map", packageName, generatedKey };
      }
      if (path === "runtime") {
        const descriptor = await resolveRuntimeRendererForRoute(generatedKey, input.propsApiVersion);
        if (!descriptor) {
          return { kind: "floor", packageName, reason: "requires-rebuild" };
        }
        // Pass the descriptor through even when it carries a pre-import `reason`
        // (peer/abi/archived) — the client loader renders its floor from the reason,
        // exactly as the detail route does. Never blank.
        return { kind: "runtime", packageName, descriptor };
      }
      return { kind: "floor", packageName, reason: "requires-rebuild" };
    };

    // 1) SEMANTIC detail slot — the type's winner-bound semantic renderer takes
    // precedence (mirrors `pickArtifactRenderer`: semantic wins over
    // representation). Winner-binding (defensive): the resolved claimant must BE
    // the row's effective-identity extension winner.
    const semantic = resolveSemanticDispatch(input.artifact.objectType, input.artifact.effectiveIdentity);
    const winnerBound =
      semantic !== null &&
      input.artifact.effectiveIdentity.kind === "extension" &&
      input.artifact.effectiveIdentity.extension === semantic.packageName;
    if (semantic && winnerBound) {
      return mountLoadable(semantic.packageName, semantic.generatedKey, semantic.built);
    }

    // 2) REPRESENTATION fallback (the S6-L-A slice) — when no semantic renderer
    // wins, consult the org-scoped representation-provider dispatch at the `detail`
    // slot, exactly as the non-review detail route does
    // (`resolveArtifactDispatchInputs`). An EXTENSION representation provider can
    // therefore serve a review target — e.g. a CMS-snapshot MIME that has no
    // semantic renderer now renders through its representation renderer instead of
    // flooring to "review target unavailable". Keyed purely on `(orgId, mime)` +
    // the opaque `generatedKey` — never on an extension package identity
    // (coupling-ban G1). A first-party host handler is NOT a mountable review
    // target (there is no such mount kind) and, like a no-provider MIME, falls
    // through to the unchanged generic floor below.
    // ACTIVATION-COUPLED BINDING (cinatra#2044 L-A3): the org-scoped providers of
    // build-bundled NON-SYSTEM (`guardedOptional`) renderer packs are bound/retired
    // from the canonical install rows before the SYNC resolve below. Without this
    // the CMS-snapshot pack — bundled and dev-enrolled, but deliberately NOT a
    // system base (cinatra#1630: no auto-bind for every org, no teardown exemption)
    // — has no production binding path at all and this fallback resolves null.
    await ensureActivatedRepresentationProviders(orgId);
    const representation = resolveRepresentationDispatch(orgId, input.mime, "detail");
    if (representation && representation.tier === "extension") {
      return mountLoadable(
        representation.packageName,
        representation.generatedKey,
        representation.built,
      );
    }

    // 3) FLOOR (unchanged) — no semantic winner and no extension representation
    // provider. `packageName` still reports the semantic claimant when one exists
    // (a losing non-winner claimant), else null.
    return { kind: "floor", packageName: semantic?.packageName ?? null, reason: "no-semantic-renderer" };
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
