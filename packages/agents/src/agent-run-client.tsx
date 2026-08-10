"use client";

// ---------------------------------------------------------------------------
// AgentRunClient — filterable card-grid for /agents (the "All Agents" tab).
//
// Receives the pre-built `rows` array from the server component (NewAgentPage)
// and renders a search toolbar using the same ToolbarSearchInput primitive used
// by the marketplace and notifications archive pages. Filter-as-you-type on
// name and description; no URL params needed for a picker page.
//
// Card design (cinatra#1007 / design#25 §VIII "Agent card (All Agents)"):
// reuses <InstalledExtensionCard> — the same three-panel §VI Installed-
// extensions card (coloured logo-tile panel, byline + description middle
// panel, hairline-divided actions panel) — but WITHOUT the version and
// Active/Archived status row (both props simply go unpassed), the
// description clamped to 2 lines instead of 3, and the right panel dropping to
// the primary action Run (a solid, fill-current play icon in place of the
// settings gear) PLUS "More details". Run stays a filled button; More details
// takes the design's `btn link` treatment, never a second filled button.
//
// "More details" opens the §V detail modal IN PLACE (owner ruling, 2026-07-06:
// design#25 §VIII) — the SAME <MarketplaceDetailModal> the §VI installed-
// extensions card (registry-catalog-screen.tsx) uses, details-only (no footer
// CTA — an agent picker never installs/uninstalls from this surface). The
// `linkTrigger` renders "More details" as the §VI link-styled anchor whose
// `href` is the agent's full-page marketplace detail (a no-JS progressive-
// enhancement fallback); JS intercepts the click to open the modal.
//
// ACCESS CONSISTENCY (the owner's core point): the modal loads its content via
// `getAgentMarketplaceDetailAction`, gated at requireAuthSession() — the SAME
// member floor as /agents itself — NOT the admin-gated
// `getPublicMarketplaceDetailAction` the browse/installed surfaces use. So a
// member who can already see the agent card can open its More-details modal
// (no /not-authorized bounce); the data is the truly-public storefront listing.
//
// External A2A / unscoped agents carry no listing → packageName + detailHref
// are null → no More-details rendered at all (Run only).
// ---------------------------------------------------------------------------

import { useState } from "react";
import {
  Toolbar,
  ToolbarSearchGroup,
  ToolbarSearchInput,
} from "@/components/ui/toolbar";
import { AgentAllCard } from "@/components/extensions/agent-all-card";
import { DraftAgentCard } from "./draft-agent-card";

export type AgentRunRowModel = {
  key: string;
  name: string;
  description: string;
  version: string;
  skills: string[];
  /** "local" for Cinatra-hosted agents; connector slug for external A2A. */
  host: "local" | string;
  runHref: string;
  /**
   * The scoped npm package name of the agent's marketplace listing — the
   * loader key for the §V detail modal (design#25 §VIII). null for external
   * A2A agents (no listing) and unscoped/legacy packages, in lockstep with
   * `detailHref` (both null together → no More-details action).
   */
  packageName: string | null;
  /**
   * "More details" target (design#25 §VIII): the agent's marketplace listing
   * detail route (/configuration/marketplace/<scope>/<name>). Used as the §V
   * modal's no-JS `linkTrigger` fallback href; JS opens the modal in place.
   * null for external A2A agents and unscoped/legacy packages — those render
   * no More-details action.
   */
  detailHref: string | null;
  /**
   * Set when the agent CANNOT run (cinatra#2605): it is a bundled opt-in package
   * with no canonical install row, or a required dependency of its is not
   * installed. The card then renders this action in the primary slot INSTEAD of
   * Run — the run affordance is the lie the issue is about. `null`/absent for a
   * runnable agent. Derived server-side (NewAgentPage) so the card carries no
   * lifecycle policy of its own.
   */
  unavailable?: {
    /** One plain sentence naming why no run is offered. */
    reason: string;
    /** Visible button label — never promises more than the target can do. */
    ctaLabel: string;
    ctaHref: string;
    /** Full accessible name (the visible label alone is not self-explanatory). */
    ctaAriaLabel: string;
  } | null;
  /**
   * Set for a DRAFT template surfaced for publishing (cinatra#2653): the row
   * renders through <DraftAgentCard> — the amber DRAFT indicator plus a
   * Publish primary action instead of Run. Derived server-side (NewAgentPage
   * surfaces drafts only to platform admins); absent/null for every runnable
   * row.
   */
  draft?: {
    templateId: string;
    /**
     * True when the agent will STILL be listed on this picker once
     * published (it carries its own HITL signal). False for a HITL-less
     * agent — the #1007 filter drops it from this run picker after
     * publish (it serves as a sub-agent / A2A surface instead), and the
     * card's success toast says so instead of promising a card that
     * will not be there.
     */
    staysListedAfterPublish: boolean;
  } | null;
};

export function AgentRunClient({ rows }: { rows: AgentRunRowModel[] }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();

  const filtered = q
    ? rows.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.description.toLowerCase().includes(q),
      )
    : rows;

  return (
    <div className="flex flex-col gap-6">
      <Toolbar aria-label="Agent filters">
        {/* w-full max-w-md flex-none — same non-stretch override as the
            marketplace + notifications-archive toolbars (cinatra#1007):
            ToolbarSearchGroup's base `flex-1` would otherwise stretch this
            lone search field across the entire toolbar. */}
        <ToolbarSearchGroup className="w-full max-w-md flex-none">
          <ToolbarSearchInput
            placeholder="Search agents…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </ToolbarSearchGroup>
      </Toolbar>

      <section className="grid grid-cols-1 gap-4">
        {/* Each row is its own client component (cinatra#1121): it lifts the §V
            detail-modal open state so the card's coloured accent panel and its
            "More details" link open the SAME modal. */}
        {filtered.map((row) =>
          row.draft ? (
            // cinatra#2653 — a draft row publishes; it never offers Run.
            <DraftAgentCard key={row.key} row={{ ...row, draft: row.draft }} />
          ) : (
            <AgentAllCard key={row.key} row={row} />
          ),
        )}
        {filtered.length === 0 && q.length > 0 && (
          <p className="col-span-full py-8 text-center text-sm text-muted-foreground">
            No agents match &ldquo;{query}&rdquo;.
          </p>
        )}
      </section>
    </div>
  );
}
