import { resolveVendorPresentation, type VendorPresentation } from "@/lib/vendor-presentation";

/**
 * Resolve the /agents "All Agents" card vendor byline (§IV, cinatra#1528).
 *
 * A Cinatra-hosted ("local") agent has the genuine "Cinatra" vendor display
 * name. An external A2A agent is reached through a connector whose `host` is a
 * SLUG — a machine identifier, never a vendor display name — so it resolves to
 * the explicit missing-vendor state (the localized placeholder), NEVER the raw
 * host slug. Extracted as a pure helper so the derivation is unit-testable
 * without importing the (server-only) agent detail-modal chain, and so the
 * /agents card never renders `row.host` as a vendor label.
 */
export function resolveAgentCardVendor(input: {
  /** "local" for Cinatra-hosted agents; a connector host SLUG for external A2A. */
  host: "local" | string;
  /** Diagnostic-only locator (package name / agent key); never rendered. */
  ref: string;
}): VendorPresentation {
  return resolveVendorPresentation(
    { name: input.host === "local" ? "Cinatra" : null },
    { surface: "agent-all-card", ref: input.ref },
  );
}
