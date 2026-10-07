import "server-only";

// The SERVER BINDER for the artifact-review preparation core (cinatra#1795, epic
// #1620 S12, item 2). Wires the pure `prepareReviewTargetsCore` to the REAL host
// seams for the artifact-side ports — the same seams the `/artifacts/[id]` detail
// route uses, so a reviewed target renders identically to how it opens in the
// library, but PINNED to the exact revision the gate froze (never "latest").
//
// RENDERER RESOLVED FROM THE ARTIFACT TYPE (never caller-chosen): `resolveMount`
// runs the SAME resolution the artifact detail page runs, through the one
// exported primitive both call. It branches only on the opaque mount outputs —
// G1-clean, no concrete type / renderer id keyed here.
//
// ONE RESOLUTION, CARD AND PAGE. This binder used to re-implement the
// precedence and then classify the loadable path "exactly like the detail
// route" — two copies of one decision, which is the shape a drift takes before
// it is a drift. Both roads now call the SHARED display primitive
// (`resolveArtifactDisplayMount` in `./renderer-resolution`, mounted through
// `./artifact-display-mount`), so the ladder, the mount and the failure
// policy are decided once for the page and the card alike.
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
  readOnlyArtifactEdit,
} from "@/lib/artifacts/artifact-renderer-props";
import type { ArtifactContentProjection } from "@cinatra-ai/sdk-extensions/artifact-content-channel";
// THE CHANNEL'S OWN READ STAYS THE DEFAULT OF THIS BINDER (enabler 0.3,
// cinatra#3027 / cinatra#3047). Wave 3 adds a road a surface MAY hand in, and
// a road that is handed in wins; but a caller that names none must still get
// the pinned revision's substance, because that is the whole of the defect
// cinatra#3047 closed: two of this module's own callers (`review-gate-ports`)
// name no road, and defaulting to the named absence would draw a "nothing is
// pinned" floor over a revision holding the run's real work.
//
// So the channel's builder and its pinned-substance reader are named here as
// VALUES, the way main wires them, and the route-graph ratchet records what
// that costs the four locked routes.
import {
  buildArtifactContentProjection,
  type ArtifactContentChannelPorts,
  type ArtifactRepresentationForm,
} from "@/lib/artifacts/artifact-content-channel";
import { createPinnedSubstanceReader } from "@/lib/artifacts/artifact-content-substance-reader";
// The ROADS themselves stay type-only: they are CONSTRUCTED on the surfaces
// that choose them (`./review-surface-roads`), none of which is a locked
// route, and named here by type alone, which the compiler erases.
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

import { resolveArtifactDisplayMount } from "./renderer-resolution";

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
    // The bound this answer was made under travels WITH it (see
    // `RevisionMemberOutcome.historical`), so the content read that follows
    // resolves the same revision under the same rule rather than guessing.
    const historical = !liveOnly;
    if (file) return { mime: file.mime, form: "file", historical };
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
      historical,
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

  /**
   * ONE RESOLUTION, CARD AND PAGE — now literally one function.
   *
   * This binder used to classify the loadable path itself, "exactly like the
   * detail route", which is the shape a drift takes before it is a drift. Both
   * roads call `resolveArtifactDisplayMount` instead: the ladder, the loadable
   * classification and the failure policy are decided once, and what stays this
   * road's own is the REVISION it resolves at — the one the gate froze, never
   * the artifact's latest — and the words its floor is drawn in.
   */
  const resolveMount = async (input: {
    artifact: ArtifactSummary;
    mime: string;
    propsApiVersion: number;
  }): Promise<ResolvedRendererMount> => {
    const mount = await resolveArtifactDisplayMount({
      orgId,
      baseType: input.artifact.objectType,
      // THE PRESENTATION IDENTITY, the one the page resolves off, so a row filed
      // under an asserted type cannot resolve one display on its page and
      // another under review.
      identity: input.artifact.presentationIdentity,
      mime: input.mime,
      propsApiVersion: input.propsApiVersion,
    });

    if (mount.kind === "build-map") {
      return {
        kind: "build-map",
        slot: mount.slot,
        packageName: mount.packageName,
        generatedKey: mount.generatedKey,
      };
    }
    if (mount.kind === "runtime") {
      return {
        kind: "runtime",
        slot: mount.slot,
        packageName: mount.packageName,
        descriptor: mount.descriptor,
        ...(mount.propsApiVersion === undefined ? {} : { propsApiVersion: mount.propsApiVersion }),
      };
    }
    // The card's own vocabulary for the two floors the resolver classifies: a
    // claimant this build does not carry, and the terminal state where nothing
    // installed draws the row at all.
    return {
      kind: "floor",
      slot: mount.slot,
      packageName: mount.packageName,
      reason: mount.reason === "requires-rebuild" ? "requires-rebuild" : "no-semantic-renderer",
    };
  };

  /**
   * THE CONTENT READ, DEGRADED PER TARGET RATHER THAN PER CARD.
   *
   * The projection is a SERVER READ off the blob store, and this binder is the
   * layer that introduced that read into the review path. The preparation core
   * around it answers every artifact-level failure with the never-blank floor
   * FOR THAT ONE TARGET — an absent artifact, a refused read, a revision that is
   * not a member — because a card carries several targets and one bad row must
   * not take the other rows down with it. A rejected read here would have been
   * the one exception: it would have escaped `prepareOneTarget`, escaped the
   * core, and left the whole card with nothing, which is precisely the class of
   * blankness this wave exists to remove.
   *
   * The reader underneath already answers its OWN named absences — an
   * unreadable blob, an over-ceiling file, a class it does not carry. This
   * wrapper is for the class it cannot: a substrate resolver that THROWS. That
   * becomes the channels own named absence — the same value a caller that has
   * not wired the channel passes, and the value the display already draws its
   * named `content-absent` reading from. The reviewer sees the card, the chrome
   * and the pinned revision, and the display says in its own words that the
   * document could not be carried; every sibling target on the card is
   * unaffected.
   *
   * The failure is not swallowed silently: it is reported to the server log with
   * the revision it belongs to, so an operator can tell a store fault from a
   * revision that genuinely holds nothing.
   */
  const readPinnedContentOrAbsence = async (
    input: {
      orgId: string;
      artifactId: string;
      representationRevisionId: string;
      form: ArtifactRepresentationForm;
      mime: string;
    },
    ports: ArtifactContentChannelPorts,
  ): Promise<ArtifactContentProjection> => {
    try {
      return await buildArtifactContentProjection(input, ports);
    } catch (error) {
      console.error(
        "[artifacts] review card content read failed",
        input.artifactId,
        input.representationRevisionId,
        error instanceof Error ? error.message : String(error),
      );
      return absentArtifactContent(input.representationRevisionId, "absent");
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

    // THE READ ITSELF, and the two inputs only this caller knows.
    //
    // THE BOUND THE MEMBERSHIP ANSWER WAS MADE UNDER travels with it: a LIVE
    // reading must not replay a tombstoned pin, while the gate-authorized
    // historical reading (enabler 0.9) may, inside the frozen set the gate
    // pinned. And the non-file membership answer already carried the pinned
    // configuration record and its digest (enabler 0.10), so the channel takes
    // THAT rather than resolving the same row a second time.
    const contentInput = {
      orgId,
      artifactId: artifact.artifactId,
      representationRevisionId,
      form: memberForm(input.member),
      mime,
      liveOnly: input.member.historical !== true,
      carriedConfiguration: fileBacked
        ? null
        : {
            configuration: input.member.configuration ?? null,
            digest: input.member.configurationDigest ?? null,
          },
    };

    // THE CONTENT CHANNEL (enabler 0.3, cinatra#3027). A surface that named a
    // road reads through ITS builder — that is what takes "the three browser
    // fetchers — json, cms-snapshot, text" off a browser fetch that dies inside
    // a third-party application. A surface that named none reads through the
    // channel bound to this binder's own pinned read, which is the wiring
    // cinatra#3047 shipped and which no road may quietly remove. Either way a
    // form the channel projects no class for — the six media forms among them —
    // comes back as the channel's own NAMED absence, because those bytes are
    // the byte road's.
    const content = buildContent
      ? await buildContent(contentInput)
      : // THROUGH THE STORE-FAULT GUARD, which main added on this same arm: a
        // read that throws is logged against its revision and comes back as the
        // channel's named absence, so a store fault draws the floor instead of
        // failing the whole card.
        await readPinnedContentOrAbsence(
          contentInput,
          createPinnedSubstanceReader({
            liveOnly: contentInput.liveOnly,
            carriedConfiguration: contentInput.carriedConfiguration,
          }),
        );

    return buildArtifactRendererProps({
      artifact,
      // THE REVIEW CARD IS READ-ONLY BY CONSTRUCTION (enabler 0.20): it mints a
      // NAMED REFUSAL rather than an edit capability, so the SAME display draws
      // there with no editing affordance and no save address — and "a review's
      // pinned revision never moves under an edit" holds because there is no road
      // from this surface to a write at all.
      edit: readOnlyArtifactEdit("read-only-surface"),
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
 * The member's own recorded form, as the content channel names it. An absent
 * form reads as `file` for the reason `isFileFormMember` gives: that is what
 * every caller written before enabler 0.10 meant.
 */
function memberForm(
  member: NonNullable<RevisionMemberOutcome>,
): ArtifactRepresentationForm {
  return member.form ?? "file";
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
