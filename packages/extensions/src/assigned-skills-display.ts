import "server-only";

// ---------------------------------------------------------------------------
// Display metadata for the skills an agent ALREADY carries (cinatra#2349 S4,
// epic #2345).
//
// The settings section hydrates its rows from S1's `listAssignedAgentSkills`,
// which is the only read that keeps an archived or role-changed assignment
// visible. That read answers "which skills, in what order, in what state" — it
// deliberately does not answer "what is the providing extension called and who
// makes it", because those come from the extension's own manifest, not from
// the assignment row or the catalog row.
//
// This module answers exactly that second question, and it answers it with the
// SAME resolvers the picker rows use (`resolveInstalledDisplayName` /
// `resolveInstalledVendorName` over the scanned manifest declarations), for one
// concrete reason: an admin picks a row labelled "Research Toolkit · by
// Northstar" and the chosen row that appears must carry that same label. Two
// independent label derivations would eventually disagree, and the disagreement
// would look like the wrong skill was added.
//
// SCOPE, stated honestly: the population it joins against is the ASSIGNABLE
// one, so a skill that has since been archived or re-declared is NOT in it. A
// caller therefore gets no entry for a degraded row and must fall back — the
// owning package name is the platform's own last-resort display tier, and the
// row's state badge is what explains its condition. Widening the population to
// cover degraded rows would mean re-deriving the shared assignability predicate
// with its conjuncts disabled, which is precisely the fork this epic refuses.
// ---------------------------------------------------------------------------

import { listAssignableSkillCandidatesSource } from "./assignable-skills-sources";
import { resolveInstalledDisplayName } from "./screens/installed-display-name";
import { resolveInstalledVendorName } from "./screens/installed-vendor";

/** The providing extension's human labels for ONE assigned skill. */
export type AssignedSkillDisplay = {
  skillId: string;
  /** The providing extension's resolved title. Never empty. */
  displayName: string;
  /** The providing extension's resolved vendor byline, or `null`. */
  vendorName: string | null;
};

export type AssignedSkillDisplayDeps = {
  /** The assignable population. Default = the shared S3 seam. */
  listCandidates?: typeof listAssignableSkillCandidatesSource;
};

/**
 * Labels for the subset of `skillIds` that is still assignable.
 *
 * Returns a possibly-PARTIAL map — never throws, never invents a label. A
 * population read failure yields an EMPTY map (every row falls back) rather
 * than a half-labelled list that would make one row look degraded and the next
 * one fine for no reason the admin can see.
 */
export async function resolveAssignedSkillDisplay(
  skillIds: readonly string[],
  deps: AssignedSkillDisplayDeps = {},
): Promise<Map<string, AssignedSkillDisplay>> {
  const out = new Map<string, AssignedSkillDisplay>();
  const wanted = new Set(skillIds.filter((id) => typeof id === "string" && id.length > 0));
  if (wanted.size === 0) return out;

  let candidates: Awaited<ReturnType<typeof listAssignableSkillCandidatesSource>>;
  try {
    candidates = await (deps.listCandidates ?? listAssignableSkillCandidatesSource)();
  } catch (err) {
    console.warn(
      "[extensions/assigned-skills-display] assignable population read failed — every " +
        "chosen row falls back to its package name:",
      err instanceof Error ? err.message : err,
    );
    return out;
  }

  for (const c of candidates) {
    if (!wanted.has(c.skillId) || out.has(c.skillId)) continue;
    out.set(c.skillId, {
      skillId: c.skillId,
      // The per-kind native descriptor name is deliberately not fed in: for a
      // skill package that IS the skill's name, which the row already carries
      // on its own line. Same call shape as the picker rows.
      displayName: resolveInstalledDisplayName({
        nativeName: null,
        registryTitle: null,
        manifestDisplayName: c.extensionDisplayName,
        packageName: c.ownerPackageName,
      }),
      vendorName: resolveInstalledVendorName({
        manifestVendorName: c.extensionVendorName,
        author: c.extensionAuthor,
      }),
    });
  }
  return out;
}
