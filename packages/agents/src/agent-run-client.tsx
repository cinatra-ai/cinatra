"use client";

// ---------------------------------------------------------------------------
// AgentRunClient — filterable card-grid for /agents (the "All Agents" tab).
//
// Receives the pre-built `rows` array from the server component (NewAgentPage)
// and renders a search toolbar using the same ToolbarSearchInput primitive used
// by the marketplace and notifications archive pages. Filter-as-you-type on
// name and description; no URL params needed for a picker page.
//
// Card design (cinatra#1007 / design#25 §VII "Agent card (All Agents)"):
// reuses <InstalledExtensionCard> — the same three-panel §VI Installed-
// extensions card (coloured logo-tile panel, byline + description middle
// panel, hairline-divided actions panel) — but WITHOUT the version and
// Active/Archived status row (both props simply go unpassed), the
// description clamped to 2 lines instead of 3, and a single primary action:
// Run, with a play icon in place of the settings gear.
// ---------------------------------------------------------------------------

import { useState } from "react";
import Link from "next/link";
import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Toolbar,
  ToolbarSearchGroup,
  ToolbarSearchInput,
} from "@/components/ui/toolbar";
import { InstalledExtensionCard } from "@/components/extensions/installed-extension-card";
import { extensionKindEmblem } from "@/components/extension-kind-emblem";
import { deriveExtensionAccent } from "@/lib/extension-accent";

export type AgentRunRowModel = {
  key: string;
  name: string;
  description: string;
  version: string;
  skills: string[];
  /** "local" for Cinatra-hosted agents; connector slug for external A2A. */
  host: "local" | string;
  runHref: string;
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
        {filtered.map((row) => {
          const vendor = row.host === "local" ? "Cinatra" : row.host;
          return (
            <InstalledExtensionCard
              key={row.key}
              name={row.name}
              accentColor={deriveExtensionAccent(row.key)}
              emblem={extensionKindEmblem("agent")}
              kindIcon={extensionKindEmblem("agent", "size-3.5")}
              kindLabel="Agent"
              vendor={vendor}
              description={row.description || undefined}
              descriptionLineClamp={2}
              // No `version` / `status` — design#25 §VII derives the Agent
              // card from §VI minus the version + Active/Archived indicator.
              actions={
                <Button asChild size="sm">
                  <Link href={row.runHref}>
                    <Play data-icon="inline-start" aria-hidden="true" />
                    Run
                  </Link>
                </Button>
              }
            />
          );
        })}
        {filtered.length === 0 && q.length > 0 && (
          <p className="col-span-full py-8 text-center text-sm text-muted-foreground">
            No agents match &ldquo;{query}&rdquo;.
          </p>
        )}
      </section>
    </div>
  );
}
