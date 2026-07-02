"use client";

// ---------------------------------------------------------------------------
// AgentRunClient — filterable card-grid for /agents/run.
//
// Receives the pre-built `rows` array from the server component (NewAgentPage)
// and renders a search toolbar using the same ToolbarSearchInput primitive used
// by the marketplace and notifications archive pages. Filter-as-you-type on
// name and description; no URL params needed for a picker page.
// ---------------------------------------------------------------------------

import { useState } from "react";
import Link from "next/link";
import { Bot } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Toolbar,
  ToolbarSearchGroup,
  ToolbarSearchInput,
} from "@/components/ui/toolbar";
import { ExtensionCard, deriveExtensionAccent } from "@cinatra-ai/sdk-ui";

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
        <ToolbarSearchGroup>
          <ToolbarSearchInput
            placeholder="Search agents…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </ToolbarSearchGroup>
      </Toolbar>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {filtered.map((row) => {
          const visibleSkills = row.skills.slice(0, 3);
          const remainingSkills = row.skills.slice(3);
          const truncatedHost =
            row.host.length > 24 ? `${row.host.slice(0, 23)}…` : row.host;
          const hostBadge =
            row.host === "local" ? (
              <Badge variant="secondary" className="rounded-chip">
                Cinatra
              </Badge>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="outline" className="rounded-chip cursor-default">
                    {truncatedHost}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>{row.host}</TooltipContent>
              </Tooltip>
            );
          return (
            <ExtensionCard
              key={row.key}
              name={row.name}
              accentColor={deriveExtensionAccent(row.key)}
              emblem={<Bot aria-hidden="true" />}
              description={row.description || undefined}
              meta={
                <div className="flex flex-wrap items-center gap-2">
                  {row.version ? (
                    <Badge
                      variant="outline"
                      className="rounded-chip text-xs font-mono"
                    >
                      v{row.version}
                    </Badge>
                  ) : null}
                  {row.skills.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {visibleSkills.map((s) => (
                        <Badge
                          key={s}
                          variant="secondary"
                          className="rounded-chip text-xs"
                        >
                          {s}
                        </Badge>
                      ))}
                      {remainingSkills.length > 0 ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge
                              variant="outline"
                              className="rounded-chip text-xs cursor-default"
                            >
                              +{remainingSkills.length}
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent>
                            {remainingSkills.join(", ")}
                          </TooltipContent>
                        </Tooltip>
                      ) : null}
                    </div>
                  ) : null}
                  {hostBadge}
                </div>
              }
              footer={
                <Button asChild size="sm">
                  <Link href={row.runHref}>
                    <Bot data-icon="inline-start" aria-hidden="true" />
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
