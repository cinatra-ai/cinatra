// ---------------------------------------------------------------------------
// "What this run made" — the run's last rail step (Agents Lifecycle (C) §6
// step 6: "The run's page lists what the run made: the post with its pictures,
// the LinkedIn post, the idea now marked as used; each opens on its own page").
//
// Drawn to the ratified drawing's section on the run's last step, which fixes
// the reading in two sentences:
//
//   "A finished run says what it made. The rail's last entry is the run's own
//    record, and its page LISTS THE RUN'S WORK: one row per artifact the run
//    WROTE, and — where the run consumed an artifact to make them — that
//    artifact too, marked USED, because a reader needs to see what the run
//    started from as well as what it produced. Every row carries the artifact's
//    TITLE, the TYPE that owns it, the REVISION the run filed or read, and the
//    control that OPENS IT ON ITS OWN PAGE. Every row is a pointer, never a
//    copy."
//
//   "Only what reached an artifact, and everything that did. The list is not a
//    summary the run wrote about itself: a row appears because the work REACHED
//    AN ARTIFACT, so nothing an agent made is left to be looked for elsewhere.
//    Rows are not ranked or graded — a file that could only be typed as bytes is
//    listed like any other row and drawn by its own display, never marked as a
//    failure. A run that WROTE NOTHING AND USED NOTHING draws the EMPTY reading
//    and says exactly that, rather than an empty panel."
//
// This module is PURE (no DB, no React), the same posture as `run-step-rail.ts`,
// so the reading is fixture-pinned and the two named readings — rows, and
// wrote-and-used-nothing — are asserted in code rather than in a screenshot.
// ---------------------------------------------------------------------------

/** Whether the run WROTE this artifact or READ it to make the others. */
export type RunArtifactRole = "wrote" | "used";

/** One artifact of the run, as the read hands it over. */
export type RunArtifactRecord = {
  artifactId: string;
  representationRevisionId: string;
  role: RunArtifactRole;
  /** The artifact's own title. Absent/empty ⇒ the row falls back to its type. */
  title: string | null;
  /** `@vendor/package:type` — the identity that OWNS the artifact (§2). */
  objectTypeId: string;
  /** A short human label for the type, when the type declares one. */
  typeLabel?: string | null;
  /** The representation's form. */
  mime: string | null;
  /** A placement or state annotation the type's own data carries — "featured",
   *  "body · after §2", "now drafted". Never invented here. */
  annotation?: string | null;
};

/** One drawn row. */
export type RunArtifactListRow = {
  key: string;
  href: string;
  role: RunArtifactRole;
  /** The heading of the row. */
  title: string;
  /** The badge beside the title — the type's short label. */
  typeBadge: string;
  /** The muted line: `@vendor/package:type · revision rev_xxxx… · mime[ · annotation]`. */
  detail: string;
  /** `Used` on a consumed artifact; absent on a written one. */
  usedMark: boolean;
  /** The control that opens the artifact on its own page. */
  openLabel: "Open";
};

export type RunArtifactList =
  | { kind: "rows"; rows: RunArtifactListRow[]; wrote: number; used: number }
  | { kind: "empty"; reading: string };

/** The EMPTY reading, verbatim in substance: the page says the run kept
 *  nothing, rather than drawing an empty panel. */
export const RUN_MADE_NOTHING_READING =
  "This run wrote no artifact and used none — no step of it made work that outlives the run.";

/** The panel's heading, and the rail entry's label. */
export const RUN_MADE_PANEL_TITLE = "What this run made";

/** Shorten a revision id for the muted line the way the drawing shows it
 *  (`rev_7f10…`), without ever hiding which artifact a row points at — the id
 *  in full stays on the row's `key` and its link. */
export function shortRevision(revisionId: string): string {
  const trimmed = revisionId.trim();
  if (trimmed.length <= 8) return trimmed;
  return `${trimmed.slice(0, 8)}…`;
}

/** The type's short label, derived from its own identity when the type does not
 *  declare one: `@cinatra-ai/blog:post` → `Post`. Never a guess about meaning —
 *  only a readable rendering of the identity the row already carries. */
export function typeBadgeFor(objectTypeId: string, typeLabel?: string | null): string {
  if (typeLabel && typeLabel.trim().length > 0) return typeLabel.trim();
  const colon = objectTypeId.lastIndexOf(":");
  const leaf = colon >= 0 ? objectTypeId.slice(colon + 1) : objectTypeId;
  if (leaf.length === 0) return objectTypeId;
  return leaf.charAt(0).toUpperCase() + leaf.slice(1);
}

/**
 * Build the run's list. `hrefFor` makes the artifact's own page address — the
 * caller owns the route so this module stays pure.
 *
 * Rows keep the order they are given (the read hands them over oldest-first),
 * with USED artifacts trailing the written ones: a reader looks first at what
 * the run produced, then at what it started from.
 */
export function buildRunArtifactList(
  records: readonly RunArtifactRecord[],
  hrefFor: (artifactId: string) => string,
): RunArtifactList {
  if (records.length === 0) {
    return { kind: "empty", reading: RUN_MADE_NOTHING_READING };
  }
  const ordered = [
    ...records.filter((r) => r.role === "wrote"),
    ...records.filter((r) => r.role === "used"),
  ];
  const rows: RunArtifactListRow[] = ordered.map((r) => {
    const badge = typeBadgeFor(r.objectTypeId, r.typeLabel);
    const parts = [
      r.objectTypeId,
      `revision ${shortRevision(r.representationRevisionId)}`,
    ];
    if (r.mime && r.mime.trim().length > 0) parts.push(r.mime.trim());
    if (r.annotation && r.annotation.trim().length > 0) parts.push(r.annotation.trim());
    return {
      key: `${r.role}:${r.artifactId}:${r.representationRevisionId}`,
      href: hrefFor(r.artifactId),
      role: r.role,
      // A row NEVER shows a blank heading: an artifact whose type carries no
      // title reads as its type, which is still a true thing to say about it.
      title: r.title && r.title.trim().length > 0 ? r.title.trim() : badge,
      typeBadge: badge,
      detail: parts.join(" · "),
      usedMark: r.role === "used",
      openLabel: "Open",
    };
  });
  return {
    kind: "rows",
    rows,
    wrote: rows.filter((r) => r.role === "wrote").length,
    used: rows.filter((r) => r.role === "used").length,
  };
}

/**
 * The one-sentence summary above the rows, counting what the run wrote and what
 * it used. Plain arithmetic over the rows — never a claim the run made about
 * itself.
 */
export function runArtifactListSummary(list: RunArtifactList): string {
  if (list.kind === "empty") return list.reading;
  const wrote =
    list.wrote === 1 ? "One artifact written" : `${list.wrote} artifacts written`;
  const used =
    list.used === 0
      ? ""
      : list.used === 1
        ? ", and the artifact it came from"
        : `, and the ${list.used} artifacts it came from`;
  return `${wrote}${used}. Each opens on its own page; the run keeps the revision it filed or read.`;
}
