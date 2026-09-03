/**
 * THE ARTIFACT PAGE'S HEADER, AS THE RATIFIED DRAWING GIVES IT — wave 3 of
 * `PLAN: Agents Lifecycle (D) — Review` (cinatra#3091, epic #3087), fix leg.
 *
 * WHAT THE DRAWING FIXES (artifact-review §IV): "the artifact's display title
 * over a mono meta line carrying its type, the pinned representation revision
 * (shown as a mono revision id with a pinned marker), and the read-only row
 * facts the host authorized — owner level / visibility, MIME, and updated
 * time." §XI draws the same line on the artifact's OWN page without the pinned
 * marker — nothing on this surface is pinned, the page reads what the artifact
 * has become — and puts the kind beside the title.
 *
 * THE LINE CLOSES THERE. Type, revision, owner level, visibility, MIME, updated
 * time: six facts, and the drawing names no seventh. A size is drawn where the
 * drawing draws one — inside the kinds whose own display carries a file's form
 * and size (§V.2's download card) — and never in this header.
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

/** The drawn header: a title, the kind beside it, and the mono meta line. */
export type ArtifactDetailHeaderModel = {
  readonly title: string;
  readonly kindLabel: string;
  readonly metaCells: readonly string[];
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
  const short = significant.length > 4 ? `${significant.slice(0, 4)}…` : significant;
  return `revision ${REVISION_PREFIX}${short.toLowerCase()}`;
}

/** Owner level and visibility are drawn capitalized, exactly as the library
 *  row draws the same two facts about the same row. */
function capitalized(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

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
  readonly now?: Date;
}): ArtifactDetailHeaderModel {
  const { artifact, mime, revisionId } = input;
  const now = input.now ?? new Date();

  const revision = artifactRevisionLabel(revisionId);
  const updated = artifact.updatedAt
    ? `updated ${formatDistance(new Date(artifact.updatedAt), now, { addSuffix: true })}`
    : "updated recently";

  return {
    // A NAME, OR EIGHT CHARACTERS OF AN ID. This title is what
    // `PageHeaderTitleSync` broadcasts to the trail's leaf crumb, and the
    // components drawing's Breadcrumb section is unqualified about it: while a
    // name is genuinely unavailable the crumb shows the id's first eight
    // characters plus an ellipsis, never a raw id.
    title: artifactDisplayTitle(artifact),
    kindLabel: artifactKindLabel(artifact.presentationIdentity),
    metaCells: [
      artifact.objectType,
      ...(revision === null ? [] : [revision]),
      capitalized(artifact.ownerLevel),
      capitalized(artifact.visibility),
      mime || "unknown",
      updated,
    ],
  };
}
