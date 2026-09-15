import "server-only";
/**
 * §VIII library row — a dashboard artifact (cinatra#1895; spec
 * `specs/app-artifacts.html` §VIII at design@5daf862).
 *
 * A dashboard reads as a normal library row — a dashboard glyph, its name, the
 * muted defining-extension label (Dashboards), scope + updated time — with ONE
 * difference from a file row: no Download. A dashboard is a live view, not a
 * file, so the row offers only Open, which navigates STRAIGHT to the dashboard's
 * canonical surface (owner ruling 2026-07-20: a dashboard is never previewed or
 * rendered inline in the library).
 */
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { LayoutDashboard } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { DashboardArtifactPointer } from "@/lib/dashboards/dashboard-artifact-surface";
import { artifactRowMetaLine } from "@/lib/artifacts/artifact-owner-label";

/** The defining-extension label a dashboard row shows (§VIII): the Dashboards
 *  extension that DEFINES `@cinatra-ai/dashboard-artifact:dashboard`. */
export const DASHBOARD_ARTIFACT_EXTENSION_LABEL = "Dashboards";

/** The row's muted meta line: the dashboard's scope over its relative updated
 *  time (mirrors the file-row meta shape).
 *
 *  §VIII draws that scope with its entity NAMED — "Team: Growth · updated 20
 *  minutes ago" — so the line is composed by the one owner-label composer the
 *  artifact row uses (cinatra#3475); the level word alone is the floor for a
 *  locus that names no entity, or a name that did not resolve. */
function scopeMeta(
  pointer: DashboardArtifactPointer,
  ownerName: string | null,
): string {
  const rel = pointer.updatedAt
    ? formatDistanceToNow(new Date(pointer.updatedAt), { addSuffix: true })
    : "recently";
  return artifactRowMetaLine({
    ownerLevel: pointer.ownerLevel,
    ownerName,
    relativeUpdated: rel,
  });
}

export function DashboardLibraryRow({
  pointer,
  ownerName,
  isLast,
}: {
  pointer: DashboardArtifactPointer;
  /** The owning team / organization / project's display name, resolved by the
   *  page. Null where the locus names no entity or the name did not resolve. */
  ownerName: string | null;
  isLast: boolean;
}) {
  return (
    <li
      data-testid="artifacts-dashboard-row"
      data-conformance-id="artifacts-dashboard-row"
      data-field="name=identity.displayName"
      data-state="kind:artifact"
      className={
        "flex items-center gap-3.5 px-3.5 py-3" +
        (isLast ? "" : " border-b border-line")
      }
    >
      <span
        aria-hidden
        className="grid size-[34px] flex-none place-items-center rounded-lg bg-primary/10 text-primary"
      >
        <LayoutDashboard className="size-[17px]" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-foreground">
            {pointer.name}
          </span>
          <span className="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
            {DASHBOARD_ARTIFACT_EXTENSION_LABEL}
          </span>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {scopeMeta(pointer, ownerName)}
        </p>
      </div>
      {/* A dashboard is a live view, not a file: the row offers ONLY Open, which
          navigates straight to the dashboard's canonical surface — never a
          Download, never an inline render (§VIII). */}
      <Button asChild variant="outline" size="sm" className="flex-none">
        <Link
          href={pointer.canonicalHref}
          data-action="open-dashboard -> dashboard-canonical"
        >
          Open
        </Link>
      </Button>
    </li>
  );
}
