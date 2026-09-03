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
  buildArtifactRendererProps,
} from "@/lib/artifacts/artifact-renderer-props";
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

import {
  buildArtifactContentProjection,
  type ArtifactContentChannelPorts,
  type ArtifactRepresentationForm,
} from "@/lib/artifacts/artifact-content-channel";
import { objectProjectionDigest } from "@/lib/artifacts/object-backed-contract";
import { createLocalDiskBlobStore } from "@/lib/artifacts/local-disk-blob-store";
import type { ArtifactContentProjection } from "@cinatra-ai/sdk-extensions/artifact-content-channel";

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
// ---------------------------------------------------------------------------
// THE CONTENT CHANNEL, WIRED FOR THE REVIEW TARGET (cinatra#3080, fix leg 7).
//
// THE DEFECT. This consumer passed `absentArtifactContent(...)` unconditionally
// and said so in a comment — "this consumer is not wired to it yet". The
// eighth proof round measured what that means on a real review: a run produced a
// `text/markdown` post, the gate pinned its revision, and the markdown display
// drew its `content-absent` floor — "No markdown is available to show for the
// revision being viewed." — over a document that was sitting readable in the
// blob store. §V of the ratified review drawing keeps the floor for the target
// that does NOT resolve; a floor over a resolvable one tells the reviewer
// something false about the work they are deciding on.
//
// WHAT IS WIRED, AND WHAT IS NOT. The TEXT arm reads the pinned revision's bytes
// through `resolveArtifactVersionForServe` + the local blob store — the same
// canonical server-side read the artifact page's own markdown handler uses. The
// CONFIGURATION arm needs no read at all: a dashboard revision's pinned
// configuration travels on the member the gate already resolved, with its own
// stable digest. The `page` class (a `connectorRef` revision's remote content)
// has no server-side reader on this surface, so it answers `null` and the
// channel says `absent` — the same honest absence it says today, and named here
// rather than hidden behind a comment.
// ---------------------------------------------------------------------------

/** The pinned revision's bytes as text, or `null` when they cannot be read. */
async function readPinnedRevisionText(input: {
  orgId: string;
  artifactId: string;
  representationRevisionId: string;
}): Promise<string | null> {
  const resolved = resolveArtifactVersionForServe({
    orgId: input.orgId,
    artifactId: input.artifactId,
    representationRevisionId: input.representationRevisionId,
  });
  if (!resolved) return null;
  try {
    const store = createLocalDiskBlobStore();
    const handle = await store.openByStorageKey({
      orgId: input.orgId,
      storageKey: resolved.storageKey,
    });
    const chunks: Buffer[] = [];
    for await (const chunk of handle.stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    // A read that fails is an absence, never a throw: the channel's own contract
    // is that "every failure is a NAMED absence", and the display floors on it.
    return null;
  }
}

/** The substance read for ONE pinned review target, over the member the gate
 *  already resolved. Exported shape kept injectable so the wiring is testable
 *  without a blob store. */
export function reviewTargetSubstancePorts(
  member: NonNullable<RevisionMemberOutcome>,
): ArtifactContentChannelPorts {
  return {
    async readPinnedSubstance(input) {
      if (input.contentClass === "configuration") {
        const configuration = member.configuration;
        if (configuration === undefined || configuration === null) return null;
        return {
          class: "configuration",
          configuration,
          digest: member.configurationDigest ?? objectProjectionDigest(configuration),
        };
      }
      if (input.contentClass === "text") {
        const text = await readPinnedRevisionText({
          orgId: input.orgId,
          artifactId: input.artifactId,
          representationRevisionId: input.representationRevisionId,
        });
        return text === null ? null : { class: "text", text };
      }
      return null;
    },
  };
}

/** Build ONE review target's content projection. The form is the SUBSTRATE's own
 *  (`member.form`, defaulting to `file` exactly as `isFileFormMember` reads it),
 *  never a caller claim. */
export async function buildReviewTargetContentProjection(
  input: {
    orgId: string;
    artifactId: string;
    representationRevisionId: string;
    mime: string;
    member: NonNullable<RevisionMemberOutcome>;
  },
  ports: ArtifactContentChannelPorts = reviewTargetSubstancePorts(input.member),
): Promise<ArtifactContentProjection> {
  const form: ArtifactRepresentationForm = input.member.form ?? "file";
  return buildArtifactContentProjection(
    {
      orgId: input.orgId,
      artifactId: input.artifactId,
      representationRevisionId: input.representationRevisionId,
      form,
      mime: input.mime,
    },
    ports,
  );
}

export function bindArtifactReviewPorts(ctx: {
  orgId: string;
  actor: ActorContext;
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
    return buildArtifactRendererProps({
      artifact,
      representation: { revisionId: representationRevisionId, mime },
      previewHref,
      downloadHref,
      // THE NEGOTIATED VERSION (enabler 0.4) — the display's own, resolved
      // before this builder ran.
      propsApiVersion: input.propsApiVersion,
      // THE CONTENT CHANNEL (enabler 0.3, cinatra#3027), WIRED (fix leg 7).
      // See `buildReviewTargetContentProjection` above for what each class
      // reads and which one still answers an honest absence.
      content: await buildReviewTargetContentProjection({
        orgId: ctx.orgId,
        artifactId: artifact.artifactId,
        representationRevisionId,
        mime,
        member: input.member,
      }),
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
}): Promise<PrepareReviewResult> {
  const artifactPorts = bindArtifactReviewPorts({ orgId: args.orgId, actor: args.actor });
  return prepareReviewTargetsCore(args.input, { ...artifactPorts, ...args.runGatePorts });
}
