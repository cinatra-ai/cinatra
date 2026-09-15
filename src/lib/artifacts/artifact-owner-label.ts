/**
 * THE OWNER AND VISIBILITY WORDS A ROW DRAWS (cinatra#3475).
 *
 * MEASURED on a real Blog Idea Generator run: every Artifacts library row read
 * "Organization · organization · updated N minutes ago" — the owner level
 * printed once as a label and once as the RAW STORED VALUE, and the owner never
 * named at all.
 *
 * THE DRAWING (`specs/app-artifacts.html`, the library row) writes that line
 * with the owner NAMED and its level in front of the name:
 *
 *     Team: Growth · Draft · updated 8 minutes ago
 *     Organization: Acme Corp · updated 2 hours ago
 *
 * and §IV writes the same entity-named form for a stored object's scope —
 * "Team: Growth", "Organization: Acme Corp". So the level word is the drawing's
 * own vocabulary, the NAME is read from the owning team or organization, and a
 * stored enum value never reaches a surface.
 *
 * PURE. Import-free data in, a string out: the library row, the dashboard row
 * and the dashboard scope chip all read their words here, so the same row can
 * never be worded two ways on two surfaces.
 */

/** The owner loci a row can carry, plus the project locus a dashboard scope
 *  chip carries. One vocabulary for every surface that words a scope. */
export type ArtifactScopeLevel =
  | "user"
  | "team"
  | "organization"
  | "workspace"
  | "project";

export type ArtifactVisibility = "private" | "team" | "organization" | "public";

/**
 * THE DRAWN LEVEL WORDS. A personal locus is drawn "Personal" (the word every
 * scope surface already draws for it), never the stored "user"; the workspace
 * and project loci carry no entity of their own to name.
 */
export const ARTIFACT_SCOPE_LEVEL_WORD: Readonly<
  Record<ArtifactScopeLevel, string>
> = {
  user: "Personal",
  team: "Team",
  organization: "Organization",
  workspace: "Workspace",
  project: "Project",
};

/** The loci whose owning ENTITY has a name the drawing puts after the word. */
const NAMED_LEVELS: ReadonlySet<ArtifactScopeLevel> = new Set([
  "team",
  "organization",
  "project",
]);

/**
 * The owner cell: the drawn level word, and — where the locus names an entity
 * and that entity's name resolved — the name behind a colon, exactly as the
 * drawing writes it ("Team: Growth", "Organization: Acme Corp").
 *
 * A name that did not resolve (an archived organization outside the acting
 * user's set, a deleted team) FLOORS to the level word alone. The floor is the
 * drawn word, never the stored value, so no surface can regress to an enum.
 */
export function artifactOwnerLabel(
  level: ArtifactScopeLevel | string,
  ownerName?: string | null,
): string {
  const known = (level in ARTIFACT_SCOPE_LEVEL_WORD
    ? (level as ArtifactScopeLevel)
    : null);
  const word = known ? ARTIFACT_SCOPE_LEVEL_WORD[known] : capitalizedWord(String(level));
  if (!known || !NAMED_LEVELS.has(known)) return word;
  const named = (ownerName ?? "").trim();
  return named === "" ? word : `${word}: ${named}`;
}

/** The visibility cell — the word the drawing writes ("Private"), never the
 *  stored value ("private"). */
export function artifactVisibilityLabel(
  visibility: ArtifactVisibility | string,
): string {
  return capitalizedWord(String(visibility));
}

/**
 * THE WHOLE META LINE, in the order the drawing writes it: the owner, then the
 * visibility, then the relative updated time. One composer, so the library row
 * and the dashboard row cannot drift apart.
 *
 * `visibility` is omitted where a surface carries none (the §VIII dashboard
 * row draws its scope over the updated time and nothing between).
 */
export function artifactRowMetaLine(input: {
  readonly ownerLevel: ArtifactScopeLevel | string;
  readonly ownerName?: string | null;
  readonly visibility?: ArtifactVisibility | string | null;
  readonly relativeUpdated: string;
}): string {
  const cells = [artifactOwnerLabel(input.ownerLevel, input.ownerName)];
  if (input.visibility != null && String(input.visibility).trim() !== "") {
    cells.push(artifactVisibilityLabel(input.visibility));
  }
  cells.push(`updated ${input.relativeUpdated}`);
  return cells.join(" · ");
}

function capitalizedWord(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
