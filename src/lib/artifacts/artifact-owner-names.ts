import "server-only";
/**
 * THE OWNER'S NAME FOR A LIBRARY ROW (cinatra#3475).
 *
 * The drawing writes the library row's meta line with the owner NAMED —
 * "Team: Growth", "Organization: Acme Corp" — but an `ArtifactSummary` carries
 * only the owning locus (`ownerLevel` + `ownerId` / `organizationId`), so the
 * name is resolved here, ONCE per page, for the rows actually being drawn.
 *
 * BOUNDED AND BATCHED. Team names come from `readTeamsByIdsForOrg`, which is
 * doubly bounded — only the ids handed to it AND only teams inside the page's
 * organization — in ONE query, so a library page is never an N+1 and never a
 * name oracle for a team outside the org. The ids are derived from the object
 * rows the read path already authorized, never from a search param.
 *
 * Organization names are supplied by the caller, which already reads the acting
 * user's organizations for the scope picker; an organization outside that set
 * simply has no name here and the row floors to the drawn level word.
 */
import { readTeamsByIdsForOrg } from "@/lib/better-auth-db";

/** Owning locus → its display name. Keys are minted by `ownerNameKey`. */
export type ArtifactOwnerNames = ReadonlyMap<string, string>;

type OwnerLocus = {
  readonly ownerLevel: string;
  readonly ownerId: string | null;
  readonly organizationId: string | null;
};

/** The map key for a row's owning locus, or null where the locus names no
 *  entity (a personal or workspace-owned row). */
export function ownerNameKey(row: OwnerLocus): string | null {
  if (row.ownerLevel === "team") {
    return row.ownerId ? `team:${row.ownerId}` : null;
  }
  if (row.ownerLevel === "organization") {
    return row.organizationId ? `org:${row.organizationId}` : null;
  }
  return null;
}

/** The owning entity's name for a row, or null (⇒ the drawn level word alone). */
export function artifactOwnerNameFor(
  row: OwnerLocus,
  names: ArtifactOwnerNames,
): string | null {
  const key = ownerNameKey(row);
  return key === null ? null : (names.get(key) ?? null);
}

/**
 * Resolve every owning entity's name for one page of rows: the organizations
 * from the caller's already-read set, the teams in ONE bounded batch.
 */
export async function resolveArtifactOwnerNames(input: {
  readonly orgId: string | null;
  readonly rows: readonly OwnerLocus[];
  /** Organization id → name, from the caller's own organization read. */
  readonly organizationNames: ReadonlyMap<string, string>;
}): Promise<ArtifactOwnerNames> {
  const names = new Map<string, string>();

  for (const row of input.rows) {
    if (row.ownerLevel !== "organization" || !row.organizationId) continue;
    const name = input.organizationNames.get(row.organizationId);
    if (name && name.trim() !== "") names.set(`org:${row.organizationId}`, name);
  }

  const teamIds = Array.from(
    new Set(
      input.rows
        .filter((r) => r.ownerLevel === "team" && r.ownerId)
        .map((r) => r.ownerId as string),
    ),
  );
  if (input.orgId && teamIds.length > 0) {
    const teams = await readTeamsByIdsForOrg(teamIds, input.orgId);
    for (const team of teams) {
      if (team.name && team.name.trim() !== "") names.set(`team:${team.id}`, team.name);
    }
  }

  return names;
}
