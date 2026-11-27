import "server-only";

// ---------------------------------------------------------------------------
// THE REVIEWED TARGET'S HEADER, attached to an already-authorized card state
// (cinatra#3141 item 7).
//
// §IV of the ratified review drawing gives every target a header that "names
// what is under review and fixes it in place: the artifact's display title over
// a mono meta line carrying its type, the pinned representation revision (shown
// as a mono revision id with a pinned marker), and the read-only row facts the
// host authorized". That header was rendered by the ISLAND — the server-rendered
// document the card frames in an iframe — so it existed only once that frame had
// painted. While the preview was still arriving the card drew a bar skeleton,
// and past the island's bounded wait it drew the preview-recovery panel, and
// neither carried a title, a type or a revision. A pending gate on the run page
// drew with no header at all.
//
// So the CARD draws the header now, in every island state, and this module is
// what tells it what the header says.
//
// WHY THIS IS A LEAF AND NOT A BRANCH IN `lifecycle-card-refetch`. Exactly the
// reason `lifecycle-settled-outcome` and `lifecycle-suggestion-chips` give, and
// it applies here unchanged: the resolver is reachable from `lifecycle-pull-mcp`,
// which the app's auth plugins mount, which puts it on the module graph of the
// route-locked routes. The pull uses the resolver purely as the AUTHORIZATION
// LADDER — it reads `state === "absent"` and discards the rest — so composing a
// header from there would drag the artifact read onto those budgets for a
// projection that path never draws. It is the stronger posture as well as the
// cheaper one: no artifact title can reach a tool result, because the code that
// reads one is not on that path at all.
//
// THE STATE IS THE AUTHORIZATION, AND IT IS AN ARGUMENT. This module runs no run
// access check of its own and must never be asked to. It takes the state
// `resolveLifecycleCardState` already answered for THIS reader and THIS ref;
// every denial has already collapsed into `absent`, which carries no header, so
// a reader who may not read the run, a gate that does not exist and a ref that
// does not decode all arrive as a state that cannot carry one and leave
// unchanged. The artifact read below is actor-scoped on top of that, so a row
// this reader could not open on its own detail page is not readable here either.
//
// WHAT THIS DISCLOSES, STATED PLAINLY. To a reader who may READ the run and
// therefore already sees this gate: the pinned target's title, its type, the
// revision the gate froze, and the row facts the host authorizes on the artifact
// page — which is precisely what the island drew to the same reader a moment
// later, out of the same reads. Nothing here widens the audience or the set; it
// moves where the sentence is composed, and it moves it because the old place
// could not be relied on to exist.
//
// A FAILURE COSTS THE HEADER, NEVER THE CARD. A gate row that vanished between
// the two reads, an artifact that is unreadable or tombstoned, and a store that
// threw all mean "this answer cannot name the target". Each yields NO header for
// that target, and the card draws none rather than an invented one — naming the
// wrong artifact over a review is worse than naming none.
// ---------------------------------------------------------------------------

import {
  LIFECYCLE_TARGET_HEADERS_MAX,
  LIFECYCLE_TARGET_HEADER_FACTS_MAX,
  LIFECYCLE_TARGET_HEADER_MAX_TEXT,
  projectReviewTargetHeaderRevision,
  type LifecycleCardState,
  type LifecycleDataPartViewType,
  type LifecycleTargetDisplay,
  type LifecycleTargetHeader,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";
import { readReviewGate } from "@cinatra-ai/agents/artifact-review-gate-store";

import { buildActorContextFromPrimitive } from "@/lib/authz/build-actor-context";
import {
  readArtifactForDetail,
  readArtifactForSettledReview,
  type ArtifactSummary,
} from "@/lib/artifacts/artifact-service";
import { artifactKindLabelFor } from "@/lib/artifacts/artifact-kind-label";
import { ARTIFACT_RENDERER_PROPS_API_VERSION } from "@/lib/artifacts/artifact-renderer-props";
import { reviewTargetRowFacts } from "@/lib/artifacts/review-target-row-facts";
import { decodeLifecycleGateRef } from "@/lib/lifecycle/lifecycle-card-ref";
import { readOwnerDisplayName } from "@/lib/owner-display-names";
import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";

type ReviewTargetHeadersInput = {
  viewType: LifecycleDataPartViewType;
  ref: string;
  state: LifecycleCardState;
  actorCtx: ReviewActorContext;
};

/**
 * The header(s) for the pinned target(s) of ONE review gate, or `null` when this
 * answer cannot name them.
 *
 * `null` is not a signal and never distinguishes a denial from an absence: the
 * three states that can carry a header are exactly the three the card draws a
 * target under, and every other state — `absent` above all — leaves here with
 * nothing, which is what the card already draws for an answer composed before
 * this field existed.
 *
 * The headers ALONE never say how many targets the gate pins: a target this
 * reader cannot read is skipped, and the list stops at
 * {@link LIFECYCLE_TARGET_HEADERS_MAX}. A reading that needs to know whether
 * the headers are complete reads {@link readReviewTargetHeadersReading}
 * instead.
 */
export async function readReviewTargetHeaders(
  input: ReviewTargetHeadersInput,
): Promise<LifecycleTargetHeader[] | null> {
  return (await readReviewTargetHeadersReading(input)).headers;
}

/**
 * The headers, and whether they are COMPLETE.
 *
 * `pinnedCount` is the number of targets the gate pins (0 when no gate was
 * read). `complete` is true only when every pinned target was read and
 * produced a header that carries its pinned revision id exactly, and none was
 * cut by the {@link LIFECYCLE_TARGET_HEADERS_MAX} bound, and no two pinned
 * targets share a revision id. A target skipped as unreadable, tombstoned or
 * denied has no header, so it makes the reading NOT complete: pairs would drop
 * it from under the gate's one decision (cinatra#4129). Two pins sharing a revision
 * id are never complete, whether or not the reader may read both: the island
 * selects a target by its revision id among EVERY pinned target, so such a
 * selector is ambiguous even when one of the two has no header. The
 * gate is drawn as one island per header, one address per header, only when
 * `complete` is true; any other answer keeps the gate's one aggregate island,
 * which renders every pinned target the reader may read.
 */
export type ReviewTargetHeadersReading = {
  headers: LifecycleTargetHeader[] | null;
  pinnedCount: number;
  complete: boolean;
  /** WHICH DISPLAY DRAWS the gate's ONE pinned target (cinatra#3033), decided
   *  by the same display resolution the target's preview mounts, for the PINNED
   *  REVISION; `null` unless the gate pins exactly one target, the reading is
   *  complete and that revision and its resolution answer. */
  onlyTargetDisplay: LifecycleTargetDisplay | null;
};

const NO_HEADERS: ReviewTargetHeadersReading = Object.freeze({
  headers: null,
  pinnedCount: 0,
  complete: false,
  onlyTargetDisplay: null,
});

export async function readReviewTargetHeadersReading(
  input: ReviewTargetHeadersInput,
): Promise<ReviewTargetHeadersReading> {
  const { viewType, ref, state, actorCtx } = input;
  // Only the review kind has a target, and only the three states that draw one
  // may carry its header. `absent` carries nothing beside itself.
  if (viewType !== "artifact_review_gate") return NO_HEADERS;
  if (state.state !== "pending" && state.state !== "restricted" && state.state !== "settled") {
    return NO_HEADERS;
  }
  // A SETTLED STATE WITH NO RECOGNIZED OUTCOME PRESENTS NO TARGET, so it may
  // carry no header either. The card is explicit about it — a gate resolved
  // before the outcome travelled, and a disposition this build cannot read,
  // both draw the generic "no longer open" panel and no island, because a card
  // that cannot say what was decided may not present the reviewed work as
  // decided. Composing a header for that answer would put the target's title,
  // type and row facts on a response whose own surface has refused to show
  // them; the answer stops where the drawing stops.
  if (state.state === "settled" && state.outcome === undefined) return NO_HEADERS;
  try {
    const payload = decodeLifecycleGateRef(ref);
    if (!payload) return NO_HEADERS;
    const gate = await readReviewGate(payload.runId, payload.reviewTaskId);
    if (!gate || gate.pinnedTargets.length === 0) return NO_HEADERS;
    const pinnedCount = gate.pinnedTargets.length;
    // Every pin's revision id, the ones this reader cannot read among them:
    // the island selects its target among all of them.
    const distinctRevisions =
      new Set(gate.pinnedTargets.map((target) => target.representationRevisionId)).size ===
      pinnedCount;

    const actor = buildActorContextFromPrimitive(
      actorCtx.actor,
      actorCtx.orgId,
      actorCtx.roleHints,
    );
    // A NAME IS READ ONLY FOR A SCOPE THE READER BELONGS TO (cinatra#3443).
    // Reading the row does not make its owning team's or organization's name
    // the reader's to see: the line names a team only when the reader's own
    // resolved memberships (the actor's `teamIds`, the axis run access
    // consults) carry it, and an organization only when it is the reader's own
    // organization. Any other scope is drawn by its type word alone and its
    // name is never read. Unresolved memberships name nothing.
    const memberTeams = new Set(actor.teamIds ?? []);
    const mayName = (level: string, id: string | null | undefined): boolean =>
      !!id &&
      ((level === "team" && memberTeams.has(id)) ||
        (level === "organization" && id === actor.organizationId));
    const headers: LifecycleTargetHeader[] = [];
    const displays: Array<LifecycleTargetDisplay | null> = [];
    // Every header's revision is the pinned id EXACTLY, or the reading is not
    // complete (cinatra#4129): a header whose id the projection module cut,
    // substituted or refused names its target and nothing more.
    let allExact = true;
    // How many pins this reading reached. The bound below stops it before the
    // rest, and a pin it never reached is not known to be one this reader
    // cannot read.
    let reached = 0;
    // Whether this reader could read every pin it reached. A pin it cannot read
    // has no header, so the headers no longer name every pinned target, and
    // only the gate's one aggregate island renders every pinned target.
    let allRead = true;
    for (const target of gate.pinnedTargets) {
      reached += 1;
      // WHICH READING, AND WHY THE TWO ARE NOT INTERCHANGEABLE. Both carry the
      // same authorization — the same actor-scoped ownership filter and the same
      // canonical read decision, so a row this reader may not read answers
      // `denied` under either — and they differ in exactly one thing: whether a
      // TOMBSTONED row still resolves.
      //
      //   settled → the HISTORICAL read. A gate holds its decision to the
      //     revision it pinned, and enabler 0.9's sentence is that a target
      //     tombstoned after the fact must still name what was reviewed.
      //
      //   pending / restricted → the LIVE read, which is what the ordinary
      //     target preparation uses on those readings: it floors a tombstone at
      //     `unknown-or-tombstoned` and shows no title, type, ownership,
      //     visibility, MIME or update time for it. The header is composed for
      //     the same reader on the same reading, so it must withhold exactly
      //     what that reading withholds — a header is not a side door onto a
      //     deleted row.
      const read =
        state.state === "settled"
          ? readArtifactForSettledReview({
              artifactId: target.artifactId,
              orgId: actorCtx.orgId,
              actor,
            })
          : readArtifactForDetail({
              artifactId: target.artifactId,
              orgId: actorCtx.orgId,
              actor,
            });
      // A target this reader cannot read names nothing, and it makes the
      // reading NOT complete (`complete` below): pairs drawn over the other
      // headers would drop it from under the gate's one decision.
      if (read.kind !== "ok") {
        allRead = false;
        continue;
      }
      const artifact = read.artifact;
      // THE SCOPES ARE NAMED (cinatra#3443): the meta line names each scope by
      // its type and its actual name, so the names are read here, through the
      // one owner-name resolver the artifact page reads (best-effort: a name
      // that does not resolve floors to the drawn type word). The organization's
      // name is read only where the visibility reaches it; an organization's
      // own artifact is named once, by its owner name. A personal row names no
      // entity ("Personal"), so no name is read for it, and a scope the reader
      // does not belong to is never named (above).
      const ownerId =
        artifact.ownerLevel === "organization" ? artifact.organizationId : artifact.ownerId;
      const ownerName = mayName(artifact.ownerLevel, ownerId)
        ? await readOwnerDisplayName(artifact.ownerLevel, ownerId ?? "")
        : null;
      const organizationName =
        artifact.visibility === "organization" &&
        artifact.ownerLevel !== "organization" &&
        mayName("organization", artifact.organizationId)
          ? await readOwnerDisplayName("organization", artifact.organizationId ?? "")
          : null;
      const revision = projectReviewTargetHeaderRevision(target.representationRevisionId);
      if (!revision.exact) allExact = false;
      // WHAT DRAWS THE PINNED REVISION, AND WHAT THAT DISPLAY SAYS OF ITSELF:
      // one membership read and one mount resolution per target, as the
      // target's preview makes them.
      const drawing = await readPinnedRevisionDrawing(
        actorCtx.orgId,
        actor,
        artifact,
        target,
        state.state === "settled",
      );
      if (pinnedCount === 1) displays.push(drawing.display);
      const drawnBy = drawing.identity.drawnBy;
      headers.push({
        title: clamp(artifact.title ?? artifact.artifactId, artifact.artifactId),
        typeLabel: artifact.objectType
          ? clamp(artifactKindLabelFor(artifact.objectType), "Artifact")
          : "Artifact",
        objectType: (artifact.objectType ?? "").slice(0, LIFECYCLE_TARGET_HEADER_MAX_TEXT),
        revisionId: revision.revisionId,
        // Worded by the SURFACE MODEL, not here: the card owns no artifact
        // vocabulary, and the island's own header reads the same function, so
        // the two cannot word the same fact differently.
        facts: reviewTargetRowFacts({
          ownerLevel: artifact.ownerLevel,
          visibility: artifact.visibility,
          mime: artifact.mime,
          updatedAt: artifact.updatedAt,
          ownerName,
          organizationName,
        }, undefined, drawing.identity.facts)
          // The bound holds every cell the identity leaf admits plus the
          // scope facts, so this cut never drops one (cinatra#3092).
          .slice(0, LIFECYCLE_TARGET_HEADER_FACTS_MAX)
          .map((fact) => clamp(fact, "—")),
        // THE RENDERER, where the display names itself (cinatra#3092,
        // lifecycle-cards §XIII.7); absent otherwise, so the header of a
        // display that declares nothing is the header it always was.
        ...(drawnBy === null ? {} : { drawnBy: clamp(drawnBy, drawnBy) }),
      });
      if (headers.length === LIFECYCLE_TARGET_HEADERS_MAX) break;
    }
    // COMPLETE ONLY WHEN EVERY PIN WAS REACHED AND READ, EVERY HEADER CARRIES
    // ITS EXACT ID AND NO TWO PINS SHARE ONE: the bound leaves pins unread, a
    // pin this reader cannot read has no header, an empty, dot-segment,
    // ill-formed or cut revision id is not its pin's id, and a shared id
    // selects no single target.
    const complete =
      headers.length > 0 && reached === pinnedCount && allRead && allExact && distinctRevisions;
    return {
      headers: headers.length > 0 ? headers : null,
      pinnedCount,
      complete,
      onlyTargetDisplay: complete && pinnedCount === 1 && displays.length === 1 ? displays[0] : null,
    };
  } catch {
    // The reading is lost, never the card.
    return NO_HEADERS;
  }
}

/**
 * THE DISPLAY THAT DRAWS THE PINNED REVISION (cinatra#3033), AND WHAT IT SAYS
 * OF ITSELF (cinatra#3092).
 *
 * The media type alone does not say which display draws a target: the dispatch
 * gives an extension artifact's own detail renderer priority over the display of
 * its media type. So this asks the question the target's preview asks, through
 * the SAME ports of the artifact-side review binder, bound to the same
 * organization and the same actor-scoped context:
 *   - the pinned revision's membership read, under the same live or historical
 *     bound the preview takes on this reading (the row's own mime is its CURRENT
 *     revision's, and the preview draws the revision the gate pinned);
 *   - then `resolveMount`, with the artifact, that revision's media type and the
 *     host's props version: the exact call the preparation core makes before it
 *     mounts the preview.
 * `artifactDisplayFamily` then names which display that mount is, as a closed
 * value. A revision that is not a member, and a read or a resolution that throws,
 * name no display: no display, no reading drawn from it.
 *
 * THE IDENTITY LINE IS READ THE WAY THE ARTIFACT PAGE READS IT. lifecycle-cards
 * §XIII.7: "the extension's display draws on the card exactly what it draws on
 * the artifact's own page", and "the platform the page lives on is carried in
 * the identity line, which also names the one renderer both CMS extensions
 * draw through … so a WordPress page and a Drupal page are told apart there
 * and nowhere else". For a display mounted from the build map, the same load
 * decision the page makes (`buildMapDisplayDecision`) and the same generic read
 * of the module's two optional exports (`readPinnedArtifactDisplayIdentity`,
 * over `displayIdentityFromModule`), fed the PINNED revision's content exactly
 * as the binder builds it for the card's display. A runtime mount, a floor, a
 * decision the slot would not mount and any failure declare nothing.
 *
 * DYNAMIC on purpose, the resolve route's `readReviewGateRecordedPrompt`
 * posture: the binder module carries the display resolution, and this leaf
 * keeps it off the static graph of every route that reaches the header. The
 * props version is a NAMED static import, never a dynamic one: a dynamic import
 * of the props module would hand this file every export of it, the artifact
 * page's edit grant among them (w4-edit-capability-repo-wide.test.ts).
 */
async function readPinnedRevisionDrawing(
  orgId: string,
  actor: ReturnType<typeof buildActorContextFromPrimitive>,
  artifact: ArtifactSummary,
  target: { artifactId: string; representationRevisionId: string },
  settled: boolean,
): Promise<{ display: LifecycleTargetDisplay | null; identity: PinnedDisplayIdentity }> {
  try {
    const { bindArtifactReviewPorts } = await import("@/app/artifacts/[id]/review-target-prepare");
    const { artifactDisplayFamily } = await import("@/app/artifacts/[id]/renderer-resolution");
    const ports = bindArtifactReviewPorts({ orgId, actor });
    const member =
      settled && typeof ports.revisionMemberHistorical === "function"
        ? await ports.revisionMemberHistorical(target.artifactId, target.representationRevisionId)
        : await ports.revisionMember(target.artifactId, target.representationRevisionId);
    if (typeof member?.mime !== "string") return NO_DRAWING;
    const mime = member.mime;
    const mount = await ports.resolveMount({
      artifact,
      mime,
      propsApiVersion: ARTIFACT_RENDERER_PROPS_API_VERSION,
    });
    const display = artifactDisplayFamily(orgId, mount, mime);
    if (mount.kind !== "build-map" || typeof ports.buildProps !== "function") {
      return { display, identity: NO_IDENTITY };
    }
    const { buildMapDisplayDecision, readPinnedArtifactDisplayIdentity } = await import(
      "@/app/artifacts/[id]/artifact-display-identity"
    );
    const identity = await readPinnedArtifactDisplayIdentity({
      // The review road resolves at the detail slot, as the page does.
      decision: buildMapDisplayDecision(
        { generatedKey: mount.generatedKey, packageName: mount.packageName, slot: mount.slot ?? "detail" },
        ARTIFACT_RENDERER_PROPS_API_VERSION,
      ),
      readContent: async () =>
        (
          await ports.buildProps({
            artifact,
            representationRevisionId: target.representationRevisionId,
            mime,
            propsApiVersion: ARTIFACT_RENDERER_PROPS_API_VERSION,
            member,
          })
        ).content,
      propsApiVersion: ARTIFACT_RENDERER_PROPS_API_VERSION,
    });
    return { display, identity };
  } catch {
    return NO_DRAWING;
  }
}

/** What the display of a pinned revision declares of itself, or nothing. */
type PinnedDisplayIdentity = {
  readonly drawnBy: string | null;
  readonly facts: { readonly revision: readonly string[]; readonly closing: readonly string[] } | null;
};
const NO_IDENTITY: PinnedDisplayIdentity = Object.freeze({ drawnBy: null, facts: null });
const NO_DRAWING = Object.freeze({ display: null, identity: NO_IDENTITY });

/**
 * COMPOSE INSIDE THE WIRE'S OWN BOUNDS, never outside them.
 *
 * The answer's schema is strict and bounded, and the parser refuses the WHOLE
 * envelope for one field it cannot accept — which is right for a hostile shape
 * and wrong as a way to lose a card. An artifact title is authored up to 500
 * characters while one header's text is bounded at
 * {@link LIFECYCLE_TARGET_HEADER_MAX_TEXT}, so a perfectly legal title would
 * otherwise refuse the envelope and blank the gate the reader came to decide.
 * A header trimmed at the bound is a small loss of wording; a refused envelope
 * is the loss of the whole review. The empty string is not a legal value on this
 * wire either, so a row that words a field as nothing falls back rather than
 * composing a value the parser must reject.
 */
function clamp(value: string, fallback: string): string {
  const trimmed = value.slice(0, LIFECYCLE_TARGET_HEADER_MAX_TEXT);
  if (trimmed.length > 0) return trimmed;
  const fallbackTrimmed = fallback.slice(0, LIFECYCLE_TARGET_HEADER_MAX_TEXT);
  return fallbackTrimmed.length > 0 ? fallbackTrimmed : "—";
}
