"use server";

// ---------------------------------------------------------------------------
// The paged assignable-skills SEARCH action (cinatra#2348 S3, epic #2345).
//
// One action, modeled on `searchExtensionCoOwnerCandidates` in
// `permissions-actions.ts` — same page cap, same `limit + 1` over-read for
// `hasMore`, same "the needle is literal" guarantee — because S4 mounts the
// SAME combobox widget the co-owner picker mounts.
//
// The ORDER of the gates below is load-bearing:
//
//   1. ADMIN, re-asserted server-side. The settings surface is admin-only, but
//      a surface being admin-only is not an authorization decision. A crafted
//      request that never rendered the page is refused here, BEFORE any
//      population read — a non-admin must not be able to enumerate the
//      installed skill catalog through a search box.
//   2. THE AGENT TARGET, derived server-side. The caller passes the agent
//      reference its authorized settings context is FOR; the shared S1 resolver
//      turns it into the canonical package name (refusing ambiguity rather than
//      guessing), and the shared write-target gate refuses a non-agent or an
//      assistant. This is not ceremony: the canonical package name is precisely
//      what makes the ALREADY-ASSIGNED EXCLUSION possible on the server, and
//      excluding client-side would leak the assignment set to any caller.
//   3. THE POPULATION, from the shared predicate (never re-derived here).
//   4. NARROW → ORDER → PAGE, entirely server-side, in the pure model module.
//
// "use server" modules may only export async functions — every helper lives in
// `assignable-skills-search-model.ts` (pure) or `assignable-skills-sources.ts`
// (the I/O seam).
// ---------------------------------------------------------------------------

import {
  selectAssignableSkillPage,
  type AssignableSkillInstallStatus,
  type AssignableSkillRow,
} from "./assignable-skills-search-model";
import {
  assertAgentTargetSource,
  listAssignableSkillCandidatesSource,
  readAssignedSkillIdsSource,
  readInstallRowsSource,
  requireAdminUserIdSource,
  resolveAgentPackageSource,
} from "./assignable-skills-sources";
import { resolveInstalledDisplayName } from "./screens/installed-display-name";
import { resolveInstalledVendorName } from "./screens/installed-vendor";
import { pickLifecycleBadgeStatus } from "./lifecycle-ui";
import type { InstalledExtension } from "./canonical-types";

/**
 * Why a search refused.
 *
 * The member names are deliberately the SAME vocabulary the S1 assignment
 * actions refuse with (`AgentSkillActionRefusal`), so S4 renders one
 * explanation table for the whole section. It is re-declared rather than
 * imported because the S1 module is itself a `"use server"` boundary and this
 * one must not depend on that module's runtime.
 */
export type AssignableSkillSearchRefusal =
  | "forbidden"
  | "unknown-agent"
  | "ambiguous-agent"
  | "not-an-agent"
  | "assistant"
  | "eligibility-unreadable";

export type AssignableSkillSearchResult =
  | {
      ok: true;
      /** The canonical package the exclusion was computed against. */
      agentPackageName: string;
      results: AssignableSkillRow[];
      /** True iff a further page exists past this window. */
      hasMore: boolean;
    }
  | { ok: false; reason: AssignableSkillSearchRefusal };

/**
 * Search the installed skill extensions an admin may pin to `agentRef`.
 *
 * Returns ONLY assignable skills (the shared predicate's three conjuncts:
 * live canonical install — `locked` counts as live — globally visible catalog
 * row, resolved role `injectable`) MINUS the ones this agent already carries.
 *
 * Paging is over a stable total order, so successive windows neither drop nor
 * duplicate a row.
 */
export async function searchAssignableSkillExtensions(
  agentRef: string,
  query: string,
  page?: { offset?: number; limit?: number },
): Promise<AssignableSkillSearchResult> {
  // (1) ADMIN — before any population read.
  try {
    const userId = await requireAdminUserIdSource();
    if (!userId) return { ok: false, reason: "forbidden" };
  } catch {
    // `requireAdminSession` throws for anonymous and non-admin callers alike.
    // A typeahead must degrade to an empty picker, not an unhandled rejection.
    return { ok: false, reason: "forbidden" };
  }

  // (2) TARGET — server-derived, then gated.
  const resolved = await resolveAgentPackageSource(String(agentRef ?? ""));
  if (!resolved.ok) {
    return { ok: false, reason: resolved.reason === "ambiguous" ? "ambiguous-agent" : "unknown-agent" };
  }
  const target = await assertAgentTargetSource(resolved.packageName);
  if (!target.ok) return { ok: false, reason: target.reason };

  // (3) POPULATION + the SERVER-SIDE already-assigned exclusion.
  const [candidates, assignedIds] = await Promise.all([
    listAssignableSkillCandidatesSource(),
    readAssignedSkillIdsSource(resolved.packageName),
  ]);
  const assigned = new Set(assignedIds);
  const offered = candidates.filter((c) => !assigned.has(c.skillId));

  // The canonical rows behind each offered skill, read under the SAME candidate
  // key union the assignability predicate used — `installed_extension`
  // `package_name` is not always the npm form, and an exact-only lookup would
  // read a legacy slug-keyed install as "no rows at all" and badge a locked
  // system extension as plainly active.
  const candidateKeys = [...new Set(offered.flatMap((c) => c.ownerPackageCandidates))];
  let installRows: Map<string, InstalledExtension[]> | null = null;
  try {
    installRows = candidateKeys.length > 0 ? await readInstallRowsSource(candidateKeys) : new Map();
  } catch (err) {
    // A LABEL outage is not a liveness verdict. The predicate already ruled
    // every offered skill live; degrade to the fail-live `active` badge rather
    // than emptying the picker.
    console.warn(
      "[extensions/assignable-skills] install-row label read failed — listing every " +
        "assignable skill as active:",
      err instanceof Error ? err.message : err,
    );
  }

  const rows: AssignableSkillRow[] = [];
  for (const c of offered) {
    // EXACT name first; the drift aliases only stand in when it has no rows —
    // `slugify` is lossy, so an unrelated package's rows must never be able to
    // outvote the canonical ones.
    const badge =
      installRows === null
        ? "active"
        : pickLifecycleBadgeStatus(
            installRows.get(c.ownerPackageName) ??
              c.ownerPackageCandidates.flatMap((k) => installRows!.get(k) ?? []),
          );
    // ARCHIVED here means the extension was archived between the population
    // read and this one. Drop the row rather than relabel it: the picker must
    // never offer a skill whose extension is no longer live, and the write path
    // would refuse it anyway.
    if (badge === "archived") continue;
    rows.push({
      skillId: c.skillId,
      skillName: c.skillName,
      skillDescription: c.skillDescription,
      packageName: c.ownerPackageName,
      // The STANDARD display-name resolver, with the tiers this surface has:
      // the extension's self-declared title, then the raw package name. The
      // per-kind native descriptor name is deliberately not fed in — for a
      // skill package that is the SKILL's name, which this row already carries
      // in its own field, and using it as the extension title would label every
      // row of a multi-skill package differently.
      displayName: resolveInstalledDisplayName({
        nativeName: null,
        registryTitle: null,
        manifestDisplayName: c.extensionDisplayName,
        packageName: c.ownerPackageName,
      }),
      // The STANDARD vendor resolver: declared vendor identity, else npm
      // author, else no byline. The raw npm scope segment is never a vendor.
      vendorName: resolveInstalledVendorName({
        manifestVendorName: c.extensionVendorName,
        author: c.extensionAuthor,
      }),
      // `locked` | `active` — `pickLifecycleBadgeStatus` is the platform's
      // ONE badge rule (any locked row wins), so a package never wears two
      // different badges on the Installed card and in this picker.
      status: badge satisfies AssignableSkillInstallStatus,
    });
  }

  // (4) NARROW → ORDER → PAGE, server-side.
  const { results, hasMore } = selectAssignableSkillPage(rows, query, page);
  return { ok: true, agentPackageName: resolved.packageName, results, hasMore };
}
