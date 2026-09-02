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
 * has become — and puts the kind beside the title. §V.2 draws a size the way a
 * person reads one ("2.4 MB"), never a count of bytes.
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
 * THE SIZE, DRAWN. A raw byte count is a number the reader has to convert; the
 * drawing draws "2.4 MB". Decimal units, because that is what the drawing's own
 * reading uses, and a named absence rather than a number this leaf does not
 * have.
 */
export function formatArtifactSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  const units = ["kB", "MB", "GB", "TB", "PB"] as const;
  let value = bytes / 1000;
  let unit = 0;
  // THE UNIT IS DECIDED BY THE NUMBER AS DRAWN, not by the raw quotient: a
  // quotient of 999.999 is drawn "1000 kB" if it is rounded after the unit is
  // chosen, and "1000 kB" is the count of a unit nobody reads. Step the unit
  // whenever the number this leaf would DRAW has reached the next one.
  while (unit < units.length - 1) {
    const drawnValue = value < 10 ? Number(value.toFixed(1)) : Math.round(value);
    if (drawnValue < 1000) break;
    value /= 1000;
    unit += 1;
  }
  const drawn = value < 10 ? value.toFixed(1) : String(Math.round(value));
  // 2.0 MB reads as a measurement nobody took; 2 MB is the same number drawn.
  return `${drawn.endsWith(".0") ? drawn.slice(0, -2) : drawn} ${units[unit]}`;
}

/**
 * THE REVISION, AS A MONO ID. The drawing shortens it — "rev_11b8…" — under the
 * same rule the trail places on an id it must show at all: eight characters and
 * an ellipsis, never the whole identifier and never a title-cased one.
 */
export function artifactRevisionLabel(revisionId: string | null): string | null {
  if (revisionId === null) return null;
  const trimmed = revisionId.trim();
  if (trimmed === "") return null;
  const short = trimmed.length > 8 ? `${trimmed.slice(0, 8)}…` : trimmed;
  return `revision ${short}`;
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
  readonly sizeBytes: number;
  readonly now?: Date;
}): ArtifactDetailHeaderModel {
  const { artifact, mime, revisionId, sizeBytes } = input;
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
      formatArtifactSize(sizeBytes),
      updated,
    ],
  };
}
