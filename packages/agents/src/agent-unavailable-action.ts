import type { AgentRunAvailability } from "./runtime-install-gate";

export type AgentUnavailableAction = {
  reason: string;
  ctaLabel: string | null;
  ctaHref: string | null;
  ctaAriaLabel: string;
};

/**
 * The truthful action for a LISTED agent the picker may still not offer a Run
 * for (cinatra#2605, narrowed by cinatra#2679).
 *
 * Since #2679 an agent the gate can prove is NOT INSTALLED is not listed at all
 * (owner ruling on PR #2658: "Agents that are not installed yet should not show
 * up in /agents at all, neither with an Install button"), so /agents no longer
 * builds an Install CTA — discovery and installation belong to the marketplace
 * (/configuration/marketplace and the per-agent listing under it), which the
 * empty state still points at.
 *
 * That leaves exactly ONE unavailable verdict a listed row can carry: a missing
 * required dependency. The agent itself IS installed; one of its own required
 * packages is not. The primary action then stops promising a run that cannot
 * start and points at what is missing — "View requirements", a DETAILS
 * destination, so the label never promises an install the target page cannot
 * perform (the missing package may be a connector / artifact / skill whose
 * detail route is details-only).
 *
 * Returns `null` for every other verdict (the card renders Run, unchanged).
 */
export function buildUnavailableAction(
  name: string,
  availability: AgentRunAvailability,
  detailHref: string | null,
): AgentUnavailableAction | null {
  if (availability.state !== "missing-required-dependency") return null;
  // No marketplace fallback for a viewer who cannot reach it (cinatra#2701,
  // epic #2699 S2): `detailHref` is already null for a non-admin (the caller
  // withholds it), and the bare `/configuration/marketplace` substitute would
  // reintroduce exactly the dead link this slice removes. Without a
  // destination the row still states the truth — it just states it without a CTA.
  const marketplaceHref = detailHref;
  const missing = availability.missing
    .map((m) => m.displayName?.trim() ? m.displayName : m.packageName)
    .join(", ");
  if (!marketplaceHref) {
    return {
      reason: `This agent cannot run: ${missing} ${availability.missing.length === 1 ? "is" : "are"} not installed.`,
      ctaLabel: null,
      ctaHref: null,
      ctaAriaLabel: `${name} cannot run — ${missing} not installed.`,
    };
  }
  return {
    reason: `This agent cannot run: ${missing} ${availability.missing.length === 1 ? "is" : "are"} not installed.`,
    ctaLabel: "View requirements",
    ctaHref: marketplaceHref,
    ctaAriaLabel: `${name} cannot run — ${missing} not installed. View requirements`,
  };
}
