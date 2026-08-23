import "server-only";

// The SERVER BINDER for the artifact-review preparation core (cinatra#1795, epic
// #1620 S12, item 2). Wires the pure `prepareReviewTargetsCore` to the REAL host
// seams for the artifact-side ports — the same seams the `/artifacts/[id]` detail
// route uses, so a reviewed target renders identically to how it opens in the
// library, but PINNED to the exact revision the gate froze (never "latest").
//
// RENDERER RESOLVED FROM THE ARTIFACT TYPE (never caller-chosen): `resolveMount`
// runs the SAME resolution the artifact detail page runs — `resolveArtifactDispatchInputs`
// fed to the pure `pickArtifactRenderer` leaf — and then classifies the loadable
// path exactly like `ExtensionRendererMount`. It branches only on the opaque
// dispatch outputs — G1-clean, no concrete type / renderer id keyed here.
//
// ONE RESOLUTION, CARD AND PAGE (plan `PLAN: Agents Lifecycle (B)` §5). This
// binder used to re-implement the precedence: semantic winner, then an EXTENSION
// representation provider, then the floor — the page's ladder minus its last
// rung, the first-party renderer for declared text forms. That missing rung is
// the whole defect the plan names: the same markdown draft that renders on its
// own page showed "cannot render" under review. Calling the page's own
// composition instead of a second copy of it means the two cannot drift again,
// and the rung arrives with it rather than as a fourth branch here.
//
// AND ONE IDENTITY. The page resolves off the row's assertion-aware PRESENTATION
// identity (epic #1883 A6); this path resolved off the EFFECTIVE identity, so a
// row filed under an asserted type could resolve one renderer on its page and
// another under review. The card now reads the presentation identity too — the
// enabler the plan puts before any package conversion, because every adoption
// would widen that divergence.
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

import { pickArtifactRenderer } from "./renderer-dispatch";
import {
  resolveArtifactDispatchInputs,
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
    // Classify a resolved (packageName, generatedKey) pair into a host mount
    // descriptor exactly like the detail route: the build-map SSR fast path, the
    // runtime dynamic seam, or the never-blank floor (requires-rebuild when the
    // resolved key is not loadable in THIS build). Keyed only on the opaque
    // `generatedKey`; no concrete package identity is branched on here
    // (coupling-ban G1).
    const mountLoadable = async (
      packageName: string,
      generatedKey: string,
    ): Promise<ResolvedRendererMount> => {
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

    // ACTIVATION-COUPLED BINDING (cinatra#2044 L-A3): the org-scoped providers of
    // build-bundled NON-SYSTEM (`guardedOptional`) renderer packs are bound/retired
    // from the canonical install rows before the SYNC resolve below. Without this
    // the CMS-snapshot pack — bundled and dev-enrolled, but deliberately NOT a
    // system base (cinatra#1630: no auto-bind for every org, no teardown exemption)
    // — has no production binding path at all and its representation never resolves.
    // The detail route does exactly this before its own dispatch.
    await ensureActivatedRepresentationProviders(orgId);

    // THE PAGE'S OWN LADDER, called rather than copied: semantic winner →
    // representation provider → the first-party form arm → the fallback.
    const dispatch = pickArtifactRenderer(
      resolveArtifactDispatchInputs({
        orgId,
        baseType: input.artifact.objectType,
        identity: input.artifact.presentationIdentity,
        mime: input.mime,
      }),
    );

    switch (dispatch.kind) {
      case "semantic":
      case "representation":
        return mountLoadable(dispatch.packageName, dispatch.generatedKey);
      case "requires-rebuild":
        return { kind: "floor", packageName: dispatch.packageName, reason: "requires-rebuild" };
      case "mime":
        // THE FORM RUNG. `pickHandler` still owns exactly two declared text
        // forms after the G2 cutover (markdown, escaped plain text); any other
        // handler kind is unreachable from it and floors rather than inventing a
        // mount the review surface cannot render.
        if (dispatch.handler === "markdown" || dispatch.handler === "text") {
          return { kind: "form", arm: "first-party", form: dispatch.handler };
        }
        return { kind: "floor", packageName: null, reason: "no-semantic-renderer" };
      case "fallback":
        // Genuinely nothing renders this type: no package renderer, no declared
        // text form. This is the ONLY state the card's "cannot render" reading is
        // for, and the floor gate counts exactly it.
        return { kind: "floor", packageName: null, reason: "no-semantic-renderer" };
    }
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
