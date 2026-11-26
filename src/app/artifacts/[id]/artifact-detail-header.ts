/**
 * THE ARTIFACT PAGE'S HEADER, AS THE RATIFIED DRAWING GIVES IT — wave 3 of
 * `PLAN: Agents Lifecycle (D) — Review` (cinatra#3091, epic #3087), fix leg.
 *
 * WHAT THE DRAWING FIXES (artifact-review §IV): "the artifact's display title
 * over a mono meta line carrying its type, the pinned representation revision
 * (shown as a mono revision id with a pinned marker), and the read-only row
 * facts the host authorized — owner level / visibility, MIME, and updated
 * time." §XI draws the same line on the artifact's OWN page and puts the kind
 * beside the title. The pinned marker stands on it exactly where the revision
 * the page shows is a review target (cinatra#3092): "On a review target every
 * display draws the one revision the gate pinned … the meta line names the
 * revision with its pinned marker" (§XI, drawn so in §XI.5, §XI.7 and §XI.8);
 * a revision no gate pinned, and the page of an artifact never reviewed ("Where
 * no review stands", §XI.5), carry none.
 *
 * THE LINE CLOSES THERE. Type, revision, owner level, visibility, MIME, updated
 * time: six facts, and the drawing names no seventh. A size is drawn where the
 * drawing draws one — inside the kinds whose own display carries a file's form
 * and size (§V.2's download card) — and never in this header.
 *
 * ONE EXCEPTION, AND THE DISPLAY DECLARES IT (cinatra#4366, artifact-review
 * §XI.7 and §XI.8): "the identity line of every page names the renderer that
 * drew it", and the platform it names is the only thing that tells a WordPress
 * page from a Drupal page. The drawn line reads "<type> · drawn by <renderer> ·
 * revision rev_c410… · WordPress · Team: Growth · Private · acme.example/pricing"
 * (§XI.8; its pinned marker is the review's, drawn here only on a review target). Core
 * knows neither fact and names no extension, so the display that draws the row
 * says them itself, through two optional exports of its own module that the
 * page reads generically (`./artifact-display-identity`): the renderer's name,
 * and the cells after the revision and the cells that close the line in place
 * of the MIME and the updated time. A display that declares neither draws
 * exactly the six facts above, byte for byte.
 *
 * PURE AND TOTAL, and the clock is injected: the page draws exactly what this
 * returns, so the drawing is measured here rather than described in a comment
 * over a template literal.
 */
import { formatDistance } from "date-fns";

import type { ArtifactSummary } from "@/lib/artifacts/artifact-service";
import {
  DEFAULT_ARTIFACT_KIND_LABEL,
  extensionDisplayName,
} from "@/lib/artifacts/extension-display-name";
import {
  artifactOwnerLabel,
  artifactVisibilityLabel,
} from "@/lib/artifacts/artifact-owner-label";

/** The drawn header: a title, the kind beside it, and the mono meta line. */
export type ArtifactDetailHeaderModel = {
  readonly title: string;
  readonly kindLabel: string;
  readonly metaCells: readonly string[];
  /** The index of the "pinned" cell in `metaCells`, drawn as the marker the
   *  review card draws; null where the revision shown is no review target. */
  readonly pinnedCellIndex: number | null;
};

/** The pinned marker's word, as the review card's identity line draws it. */
export const ARTIFACT_PINNED_MARKER = "pinned";

/**
 * WHAT THE DISPLAY THAT DRAWS THE ROW SAYS OF ITSELF, already read and checked
 * (`./artifact-display-identity`). `drawnBy` is the renderer's name, drawn as
 * "drawn by <name>" right after the type. `facts.revision` is drawn right after
 * the revision; `facts.closing` closes the line after the owner and the
 * visibility, in place of the MIME and the updated time. Null is "declared
 * nothing", which leaves that part of the line as it always was.
 */
export type ArtifactDisplayIdentity = {
  readonly drawnBy: string | null;
  readonly facts: {
    readonly revision: readonly string[];
    readonly closing: readonly string[];
  } | null;
};

/** The display declared nothing: the line every display draws without it. */
export const NO_DISPLAY_IDENTITY: ArtifactDisplayIdentity = {
  drawnBy: null,
  facts: null,
};

/**
 * THE REVISION, IN THE DRAWN MONO FORM. Every reading in the ratified drawing
 * writes it the same way — "revision rev_8f3a…", "revision rev_11b8…",
 * "revision rev_9ac3…", "revision rev_c410…": the word, then a mono id that
 * says what it is, then the ellipsis that says it was shortened. The fourth
 * proof round measured "revision d2e62529…" on every frame — eight characters
 * of raw hexadecimal, which is a shortened identifier and not the drawn form.
 *
 * The stored identifier's own prefix is honoured rather than doubled: a
 * revision id that already names itself keeps its name.
 */
const REVISION_PREFIX = "rev_";

export function artifactRevisionLabel(revisionId: string | null): string | null {
  if (revisionId === null) return null;
  const trimmed = revisionId.trim();
  if (trimmed === "") return null;
  // A stored id may carry a prefix of its own (`rep_…`, `rev_…`). The drawn id
  // is the significant part behind it, under the drawing's own prefix.
  const significant = trimmed.replace(/^(rev|rep)_/i, "");
  if (significant === "") return null;
  // BY CHARACTER, NOT BY CODE UNIT. `slice` cuts a surrogate pair in half and
  // paints a replacement character; `Array.from` walks code points, so an id
  // carrying an astral character is shortened and never mangled.
  const short = Array.from(significant).slice(0, 4).join("");
  // THE ELLIPSIS IS PART OF THE DRAWN FORM, not a flag for "something was cut":
  // every reading in the drawing writes `rev_8f3a…`, and a cell that drops it on
  // a short id draws a form the drawing never draws.
  return `revision ${REVISION_PREFIX}${short.toLowerCase()}…`;
}

// THE OWNER AND THE VISIBILITY ARE DRAWN BY THE ONE COMPOSER (cinatra#3475).
// This header used to capitalize the STORED values through a local helper, so
// one artifact read "Organization: Acme Corp" on its library row and a bare
// "Organization" on its own page, and a personal row read "User" here against
// the drawn word "Personal" there. Both facts now come from
// `@/lib/artifacts/artifact-owner-label` — the composer the library row and the
// dashboard row read — so the same row cannot be worded two ways.

/** The kind beside the title — the row's presentation identity, which is the
 *  identity the page's renderer dispatch already presents, so the chip and the
 *  display can never name two different things. */
export function artifactKindLabel(
  identity: ArtifactSummary["presentationIdentity"],
): string {
  return identity.kind === "extension"
    ? extensionDisplayName(identity.extension)
    : DEFAULT_ARTIFACT_KIND_LABEL;
}

/**
 * THE DISPLAY TITLE, AND WHAT STANDS WHERE THERE IS NONE. The components
 * drawing's Breadcrumb section is unqualified: a crumb that stands for an
 * entity id shows that entity's display name, and while a name is genuinely
 * unavailable the crumb shows the id's first eight characters plus an
 * ellipsis - never a raw id. A stored title that is empty, or nothing but
 * whitespace, IS a name genuinely unavailable: it draws a blank crumb, which
 * is the one reading the rule leaves no room for. One rule, exported, so the
 * pointer surface and the rendered surface cannot answer it two ways.
 */
export function artifactDisplayTitle(
  artifact: Pick<ArtifactSummary, "title" | "artifactId">,
): string {
  const named = (artifact.title ?? "").trim();
  if (named !== "") return named;
  const id = artifact.artifactId.trim();
  if (id === "") return "Untitled artifact";
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

export function buildArtifactDetailHeader(input: {
  readonly artifact: ArtifactSummary;
  readonly mime: string;
  readonly revisionId: string | null;
  /** The owning team's / organization's display name, resolved by the page.
   *  Null or absent where the locus names no entity (a personal or
   *  workspace-owned row) or where the name did not resolve — the owner cell
   *  then draws the level word alone, never a stored value. */
  readonly ownerName?: string | null;
  /** What the display that draws the row declared of itself. Absent, or
   *  `NO_DISPLAY_IDENTITY`, draws the six facts exactly as before. */
  readonly display?: ArtifactDisplayIdentity;
  /** The revision shown is pinned by a review gate (open or decided). Absent or
   *  false draws no pinned marker. */
  readonly pinned?: boolean;
  readonly now?: Date;
}): ArtifactDetailHeaderModel {
  const { artifact, mime, revisionId } = input;
  const now = input.now ?? new Date();
  const drawnBy = input.display?.drawnBy ?? null;
  const facts = input.display?.facts ?? null;

  const revision = artifactRevisionLabel(revisionId);
  // The marker names the revision, so a line with no revision draws none.
  const pinned = input.pinned === true && revision !== null;
  const updated = artifact.updatedAt
    ? `updated ${formatDistance(new Date(artifact.updatedAt), now, { addSuffix: true })}`
    : "updated recently";

  const leading = [
    artifact.objectType,
    ...(drawnBy === null ? [] : [`drawn by ${drawnBy}`]),
    ...(revision === null ? [] : [revision]),
  ];
  return {
    // A NAME, OR EIGHT CHARACTERS OF AN ID. This title is what
    // `PageHeaderTitleSync` broadcasts to the trail's leaf crumb, and the
    // components drawing's Breadcrumb section is unqualified about it: while a
    // name is genuinely unavailable the crumb shows the id's first eight
    // characters plus an ellipsis, never a raw id.
    title: artifactDisplayTitle(artifact),
    kindLabel: artifactKindLabel(artifact.presentationIdentity),
    metaCells: [
      ...leading,
      // Right after the revision it names, before the display's own facts
      // (§XI.8: "revision rev_c410… · pinned · WordPress").
      ...(pinned ? [ARTIFACT_PINNED_MARKER] : []),
      ...(facts === null ? [] : facts.revision),
      artifactOwnerLabel(artifact.ownerLevel, input.ownerName),
      artifactVisibilityLabel(artifact.visibility),
      ...(facts === null ? [mime || "unknown", updated] : facts.closing),
    ],
    pinnedCellIndex: pinned ? leading.length : null,
  };
}
