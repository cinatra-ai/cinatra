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
 * ONE assignment to label: the catalog skill id, plus the package the
 * assignment read says owns it.
 *
 * The OWNER is part of the key, not decoration (codex round B finding 3). A
 * catalog id is expected to be globally unique, but "expected to be" is not a
 * guarantee this module gets to assume: keying on the id alone means that if
 * two scanned packages ever surface the same id, whichever one the population
 * happens to list FIRST wins, and a row is labelled with a different vendor's
 * name. Matching the owner too makes a collision produce NO label — which the
 * caller's package-name fallback already handles truthfully — instead of a
 * confident wrong one.
 */
export type AssignedSkillRef = {
  skillId: string;
  /** The owning package per the assignment read; `null` when it is unknown. */
  ownerPackageName: string | null;
};

/**
 * Labels for the subset of `refs` that is still assignable.
 *
 * Returns a possibly-PARTIAL map — never throws, never invents a label. A
 * population read failure yields an EMPTY map (every row falls back) rather
 * than a half-labelled list that would make one row look degraded and the next
 * one fine for no reason the admin can see. A ref whose owner is unknown gets
 * no entry either: there is nothing to match it against safely.
 */
export async function resolveAssignedSkillDisplay(
  refs: readonly AssignedSkillRef[],
  deps: AssignedSkillDisplayDeps = {},
): Promise<Map<string, AssignedSkillDisplay>> {
  const out = new Map<string, AssignedSkillDisplay>();
  const wanted = new Map<string, string>();
  for (const ref of refs) {
    if (!ref || typeof ref.skillId !== "string" || ref.skillId.length === 0) continue;
    if (typeof ref.ownerPackageName !== "string" || ref.ownerPackageName.length === 0) continue;
    if (!wanted.has(ref.skillId)) wanted.set(ref.skillId, ref.ownerPackageName);
  }
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
    // Both halves of the key must agree, or this candidate is not the one the
    // assignment refers to.
    if (wanted.get(c.skillId) !== c.ownerPackageName || out.has(c.skillId)) continue;
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
