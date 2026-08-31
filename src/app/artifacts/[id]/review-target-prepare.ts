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
  readArtifactForSettledReview,
  type ArtifactSummary,
} from "@/lib/artifacts/artifact-service";
import {
  resolveArtifactVersionForServe,
  resolveNonFileArtifactRevision,
} from "@/lib/artifacts/artifact-read";
import {
  absentArtifactContent,
  buildArtifactRendererProps,
} from "@/lib/artifacts/artifact-renderer-props";
// TYPE-ONLY, and that is load-bearing (wave 3). This module is reachable from
// four routes whose first-party module count the route-graph ratchet locks, and
// both roads pull real graphs behind them — the content channel's builder and
// the capability minters. The roads are CONSTRUCTED on the surfaces that choose
// them (`./review-surface-roads`), none of which is a locked route, and named
// here by type alone, which the compiler erases.
import type {
  ArtifactContentBuilder,
  ArtifactByteUrlMinter,
} from "./review-surface-roads";
import {
  prepareReviewTargetsCore,
  type ArtifactReadOutcome,
  type PrepareReviewInput,
  type PrepareReviewPorts,
  type PrepareReviewResult,
  type ResolvedRendererMount,
  type RevisionMemberOutcome,
  isFileFormMember,
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
  /**
   * HOW THIS SURFACE ADDRESSES BYTES (wave 3 of
   * `PLAN: Agents Lifecycle (D) — Review`, cinatra#3091).
   *
   * Absent — every first-party, cookie-authenticated surface — and the snapshot
   * carries the session byte routes it always carried, named as the `session`
   * road. Present — the island, whose reader holds a broker bearer and no
   * cookie — and the snapshot carries the island-scoped capability address
   * instead, which is the whole of "the byte capability and its serving route
   * ... for the six media displays and the CMS picture pair".
   *
   * A FUNCTION, NOT A FLAG, and it is the surface's: this binder cannot
   * construct an island address by itself, so no first-party path can acquire
   * one by accident.
   */
  byteMinter?: ArtifactByteUrlMinter;
  /**
   * HOW THIS SURFACE READS CONTENT (wave 3).
   *
   * Absent and the snapshot carries the channel's own NAMED ABSENCE, which is
   * what this consumer said about itself before this wave: "each a contract
   * defined here and wired for its consumers in the sibling plan". Present and
   * the pinned revision is read ON THE SERVER and carried on the props — which
   * is what takes "the three browser fetchers — json, cms-snapshot, text" off
   * the browser fetch that dies inside a third-party application.
   */
  buildContent?: ArtifactContentBuilder;
}): Pick<
  PrepareReviewPorts,
  | "readArtifact"
  | "readArtifactHistorical"
  | "revisionMember"
  | "revisionMemberHistorical"
  | "resolveMount"
  | "buildProps"
> {
  const { orgId, actor } = ctx;
  const byteMinter = ctx.byteMinter ?? null;
  const buildContent = ctx.buildContent ?? null;

  const toOutcome = (access: ReturnType<typeof readArtifactForDetail>): ArtifactReadOutcome => {
    if (access.kind === "not-found") return { kind: "not-found" };
    if (access.kind === "denied") return { kind: "denied" };
    return { kind: "ok", artifact: access.artifact };
  };

  const readArtifact = (artifactId: string): ArtifactReadOutcome =>
    toOutcome(readArtifactForDetail({ artifactId, orgId, actor }));

  /**
   * THE ARTIFACT-LEVEL HISTORICAL READ (enabler 0.9), the twin of
   * `revisionMemberHistorical` below. Same authorization, tombstone-tolerant —
   * without it the live read floors a settled card at `unknown-or-tombstoned`
   * before the historical revision reader is ever consulted, and the enabler
   * delivers nothing. Reached only on the settled reading, only for a target the
   * gate itself pinned.
   */
  const readArtifactHistorical = (artifactId: string): ArtifactReadOutcome =>
    toOutcome(readArtifactForSettledReview({ artifactId, orgId, actor }));

  /**
   * Membership for ONE pinned revision.
   *
   * TWO ARMS, ONE ANSWER (enabler 0.10). The FILE arm is the byte resolver this
   * path has always used; the NON-FILE arm is the membership-and-projection
   * reader for resources that are not files, which "verifies the exact
   * organization, artifact and representation-revision tuple and returns its
   * form and the pinned configuration record". A dashboard revision used to
   * answer null here and floor "before any renderer runs"; it now answers with
   * its form and its pinned configuration, and carries no byte address at all.
   *
   * The file arm is tried first and stays byte-identical: nothing about a
   * file-backed review moved.
   */
  const memberFor = (
    artifactId: string,
    representationRevisionId: string,
    liveOnly: boolean,
  ): RevisionMemberOutcome => {
    const file = resolveArtifactVersionForServe({
      orgId,
      artifactId,
      representationRevisionId,
      liveOnly,
    });
    if (file) return { mime: file.mime, form: "file" };
    const nonFile = resolveNonFileArtifactRevision({
      orgId,
      artifactId,
      representationRevisionId,
      liveOnly,
    });
    if (!nonFile) return null;
    return {
      mime: nonFile.mime,
      form: nonFile.form,
      configuration: nonFile.configuration,
      configurationDigest: nonFile.configurationDigest,
    };
  };

  const revisionMember = (
    artifactId: string,
    representationRevisionId: string,
  ): RevisionMemberOutcome =>
    // liveOnly: a review surface reviews LIVE artifacts — a tombstoned-but-pinned
    // representation must NOT resolve here (it degrades to the floor via a
    // not-found readArtifact / a null member), never serve stale bytes.
    memberFor(artifactId, representationRevisionId, true);

  /**
   * THE RUN- OR GATE-AUTHORIZED HISTORICAL READER (enabler 0.9). Consulted only
   * on the settled reading, and only for a target the gate itself pinned — so
   * the tombstoned-pin replay this opens is bounded by the frozen set, exactly
   * as the byte routes' own pin override is bounded by their visibility check.
   * "The ordinary artifact page stays live and latest": nothing on the page's
   * own path reaches this.
   */
  const revisionMemberHistorical = (
    artifactId: string,
    representationRevisionId: string,
  ): RevisionMemberOutcome => memberFor(artifactId, representationRevisionId, false);

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
        //
        // AND CARRY THE VERSION THIS DISPLAY NEGOTIATED (enabler 0.4): "resolve
        // the display, read its declared props version, then build the snapshot
        // at that version". The tuple names the version the display itself
        // declared, and admission has already put it inside the host's window,
        // so the core builds the snapshot at it rather than at the host's
        // newest. A descriptor carrying a pre-import floor `reason` never
        // renders, so it keeps the host's own version and nothing changes.
        if (descriptor.reason === undefined) {
          return {
            kind: "runtime",
            packageName,
            descriptor,
            propsApiVersion: descriptor.tuple.propsApiVersion,
          };
        }
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

  const buildProps = async (input: {
    artifact: ArtifactSummary;
    representationRevisionId: string;
    mime: string;
    propsApiVersion: number;
    member: NonNullable<RevisionMemberOutcome>;
  }) => {
    // Host-authorized, version-PINNED hrefs (the exact reviewed revision, never
    // the artifact's latest) — the same content/preview endpoints the detail
    // route points at.
    //
    // AND NONE AT ALL FOR A NON-FILE REVISION (enabler 0.10): "non-file props
    // carry no preview or download address". A dashboard has no bytes, so an
    // href pointing at the byte routes would be a link that 404s from the moment
    // it is drawn — a dead end of exactly the kind this wave exists to remove.
    const { artifact, representationRevisionId, mime } = input;
    const fileBacked = isFileFormMember(input.member);
    const previewHref = fileBacked
      ? `/api/artifacts/${artifact.artifactId}/versions/${representationRevisionId}/preview`
      : null;
    const downloadHref = fileBacked
      ? `/api/artifacts/${artifact.artifactId}/versions/${representationRevisionId}/content`
      : null;
    // THE BYTE REFERENCE (wave 3, cinatra#3091). A non-file revision has no
    // bytes at all and therefore no road: enabler 0.10's rule that "non-file
    // props carry no preview or download address" governs this field exactly as
    // it governs the two above, and minting an island address for a dashboard
    // would be a sealed capability over nothing.
    //
    // AND THE ISLAND ROAD ONLY WHERE THE ROAD RUNS. The minter answers `null`
    // for a form that is not one of the six media kinds — the three browser
    // fetchers' forms among them — and such a revision keeps the session
    // addresses it always had rather than gaining a sealed capability to its
    // full bytes beside its capped content projection.
    const minted =
      fileBacked && byteMinter
        ? byteMinter({
            artifactId: artifact.artifactId,
            representationRevisionId,
            mime,
          })
        : null;
    const bytes = minted
      ? { road: "island" as const, ...minted }
      : fileBacked
        ? { road: "session" as const, preview: previewHref, download: downloadHref }
        : undefined;

    // THE CONTENT CHANNEL (enabler 0.3, cinatra#3027), WIRED HERE BY WAVE 3.
    // Until now this consumer named itself unwired; "the three browser fetchers
    // — json, cms-snapshot, text — moved onto the content channel" is that name
    // being replaced by the read it stood in for. A form the channel projects
    // no class for — every one of the six media forms — still comes back as the
    // channel's own named absence, because its bytes are the byte road's.
    const content = buildContent
      ? await buildContent({
          orgId,
          artifactId: artifact.artifactId,
          representationRevisionId,
          form: input.member.form ?? (fileBacked ? "file" : null),
          mime,
        })
      : absentArtifactContent(representationRevisionId);

    return buildArtifactRendererProps({
      artifact,
      representation: { revisionId: representationRevisionId, mime },
      previewHref,
      downloadHref,
      // THE NEGOTIATED VERSION (enabler 0.4) — the display's own, resolved
      // before this builder ran.
      propsApiVersion: input.propsApiVersion,
      content,
      bytes,
    });
  };

  return {
    readArtifact,
    readArtifactHistorical,
    revisionMember,
    revisionMemberHistorical,
    resolveMount,
    buildProps,
  };
}

/**
 * Prepare a caller's review targets against a run's gate — a PENDING gate, or a
 * RESOLVED one's frozen set when the caller asked for the read-only history
 * reading (`input.acceptResolvedGate`, default closed; the core owns that rule).
 * Composes the pure core with the real artifact-side ports + the caller-supplied
 * run/gate ports. Returns the per-target props + host mount descriptors
 * (never-blank floor on every artifact-level failure class; a substituted target
 * fails).
 */
export async function prepareArtifactReviewTargets(args: {
  input: PrepareReviewInput;
  orgId: string;
  actor: ActorContext;
  runGatePorts: ReviewRunGatePorts;
  /** The island's byte minter, when this preparation is for an island reader
   *  (wave 3). Absent on every cookie surface. */
  byteMinter?: ArtifactByteUrlMinter;
  /** How this surface reads content (wave 3). Absent on a surface that has not
   *  named a road. */
  buildContent?: ArtifactContentBuilder;
}): Promise<PrepareReviewResult> {
  const artifactPorts = bindArtifactReviewPorts({
    orgId: args.orgId,
    actor: args.actor,
    byteMinter: args.byteMinter,
    buildContent: args.buildContent,
  });
  return prepareReviewTargetsCore(args.input, { ...artifactPorts, ...args.runGatePorts });
}
