import "server-only";

import { eq } from "drizzle-orm";
import { betterAuthDb, betterAuthOrganizations } from "@/lib/better-auth-db";
import { readSingleOrgModeStrict } from "@/lib/authz/instance-mode";

/**
 * Shared structural-eligibility primitive for organization LIFECYCLE
 * operations — delete today, archive from cinatra#1937's program (S2+).
 * Extracted from the delete guards (cinatra#1928) per the #1510 archive
 * program spec ("shared lifecycle-eligibility primitive, fail-closed").
 *
 * An organization is lifecycle-eligible when ALL hold:
 *  - the instance is NOT in single-org compatibility mode (STRICT read: a
 *    failing mode read is `mode-unavailable`, never "assume multi-org" — this
 *    is the deliberate fail-closed HARDENING over the pre-#1937 delete path,
 *    which silently proceeded when the config read errored);
 *  - the org row exists;
 *  - it is not the Default organization (slug 'default' — the bootstrap
 *    recreates it, so lifecycle ops on it are refuse-always).
 *
 * This is the PRE-CHECK shared shape. Transactional operations (delete's
 * row-locked slug re-check, archive's future exclusive-lock path) keep their
 * own in-tx re-verification — this primitive never replaces those.
 */
export type OrganizationLifecycleIneligibleReason =
  | "single-org-mode"
  | "default-org"
  | "not-found"
  | "mode-unavailable"
  | "lookup-failed";

export type OrganizationLifecycleEligibility =
  | { readonly eligible: true }
  | {
      readonly eligible: false;
      readonly reason: OrganizationLifecycleIneligibleReason;
    };

export async function resolveOrganizationLifecycleEligibility(
  organizationId: string,
): Promise<OrganizationLifecycleEligibility> {
  let singleOrg: boolean;
  try {
    singleOrg = await readSingleOrgModeStrict();
  } catch {
    return { eligible: false, reason: "mode-unavailable" };
  }
  if (singleOrg) return { eligible: false, reason: "single-org-mode" };

  try {
    const rows = await betterAuthDb
      .select({ slug: betterAuthOrganizations.slug })
      .from(betterAuthOrganizations)
      .where(eq(betterAuthOrganizations.id, organizationId))
      .limit(1);
    if (rows.length === 0) return { eligible: false, reason: "not-found" };
    if (rows[0].slug === "default") {
      return { eligible: false, reason: "default-org" };
    }
  } catch {
    return { eligible: false, reason: "lookup-failed" };
  }

  return { eligible: true };
}
