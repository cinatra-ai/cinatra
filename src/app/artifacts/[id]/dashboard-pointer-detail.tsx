import "server-only";
/**
 * §VIII pointer detail — `/artifacts/[id]` for a dashboard artifact
 * (cinatra#1895; spec `specs/app-artifacts.html` §VIII at design@5daf862;
 * owner ruling 2026-07-20).
 *
 * A dashboard-typed artifact's detail route is a POINTER surface: it NEVER
 * previews or renders the dashboard inline. It shows the artifact's metadata —
 * the dashboard glyph, its name, the defining-extension label, the scope chips
 * and the updated time — over a single primary "Open dashboard" affordance that
 * navigates to the dashboard's canonical surface. There is NO read-only grid, NO
 * embedded portlet render, and NO in-page rendering here — the canonical surface
 * owns both viewing and editing. There is also NO Download (a dashboard is a
 * live view, not a file).
 *
 * The three frames below carry the closed §IX data-state set for this surface
 * (loading · ready · error); the caller streams the READY frame behind a
 * Suspense whose fallback is the LOADING frame, and renders the ERROR frame when
 * the dashboards source fails.
 */
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import {
  AlertTriangle,
  ArrowUpRight,
  Building2,
  FolderKanban,
  LayoutDashboard,
  User,
  Users,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import type { ScopeLevel } from "@/components/scope-badge";
import {
  DASHBOARD_ARTIFACT_OBJECT_TYPE,
  type DashboardArtifactPointer,
  type DashboardScopeChip,
} from "@/lib/dashboards/dashboard-artifact-surface";
import { DASHBOARD_ARTIFACT_EXTENSION_LABEL } from "@/components/artifacts/dashboard-library-row";

/** The scope glyph for a chip — a STATIC component (switch inside) so no
 *  component is created during render. */
function ScopeChipIcon({ level }: { level: ScopeLevel }) {
  switch (level) {
    case "organization":
    case "workspace":
      return <Building2 aria-hidden className="size-3" />;
    case "team":
      return <Users aria-hidden className="size-3" />;
    case "project":
      return <FolderKanban aria-hidden className="size-3" />;
    default:
      return <User aria-hidden className="size-3" />;
  }
}

/** One scope listing chip (§VIII, D9). Clickable: opens the dashboard IN that
 *  scope's context (`open-scope -> scope-view`). */
function ScopeChip({ chip }: { chip: DashboardScopeChip }) {
  return (
    <Link
      href={chip.href}
      data-action="open-scope -> scope-view"
      className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-strong px-2.5 py-0.5 text-xs text-foreground transition-colors hover:bg-surface-muted"
    >
      <ScopeChipIcon level={chip.level} />
      {chip.label}
    </Link>
  );
}

/** The READY pointer frame — metadata + scope chips + Open dashboard. */
export function DashboardPointerDetail({
  pointer,
}: {
  pointer: DashboardArtifactPointer;
}) {
  const rel = pointer.updatedAt
    ? formatDistanceToNow(new Date(pointer.updatedAt), { addSuffix: true })
    : "recently";
  return (
    <div
      data-testid="artifact-dashboard-pointer"
      data-conformance-id="artifact-dashboard-pointer"
      data-field="name=identity.displayName"
      data-state="ready"
      className="overflow-hidden rounded-lg border border-line bg-surface-strong"
    >
      <div className="flex flex-wrap items-center gap-2.5 border-b border-line px-3.5 py-3">
        <span
          aria-hidden
          className="grid size-[30px] flex-none place-items-center rounded-lg bg-primary/10 text-primary"
        >
          <LayoutDashboard className="size-4" />
        </span>
        <span className="text-base font-bold text-foreground">
          {pointer.name}
        </span>
        <span className="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-badge-xs font-semibold text-primary">
          {DASHBOARD_ARTIFACT_EXTENSION_LABEL}
        </span>
        {/* Scope chips (§VIII, D9): one chip per listing — Phase-1 renders the
            single canonical home. */}
        <div
          data-conformance-id="artifact-dashboard-scope-chips"
          className="ml-auto inline-flex flex-wrap items-center gap-1.5"
        >
          <span className="self-center font-mono text-badge-2xs uppercase tracking-kicker-wide text-muted-foreground">
            In scope
          </span>
          {pointer.scopeChips.map((chip) => (
            <ScopeChip key={`${chip.level}:${chip.href}`} chip={chip} />
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3.5 px-3.5 py-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-foreground">
            A dashboard is a live view — this page <b>points</b> to it, it does
            not render here.
          </p>
          <p className="mt-1 font-mono text-badge-2xs tracking-wide text-muted-foreground">
            {DASHBOARD_ARTIFACT_OBJECT_TYPE} · updated {rel}
          </p>
        </div>
        {/* The single primary affordance: open the dashboard at its canonical
            surface (`open-dashboard -> dashboard-canonical`). */}
        <Button asChild className="flex-none">
          <Link
            href={pointer.canonicalHref}
            data-action="open-dashboard -> dashboard-canonical"
          >
            Open dashboard
            <ArrowUpRight data-icon="inline-end" aria-hidden className="size-3.5" />
          </Link>
        </Button>
      </div>
    </div>
  );
}

/** The LOADING frame (§IX `data-state="loading"`) — the Suspense fallback while
 *  the gated pointer resolves. */
export function DashboardPointerLoading() {
  return (
    <div
      data-testid="artifact-dashboard-pointer-loading"
      data-conformance-id="artifact-dashboard-pointer"
      data-state="loading"
      aria-busy="true"
      className="animate-pulse overflow-hidden rounded-lg border border-line bg-surface-strong"
    >
      <div className="h-12 border-b border-line" />
      <div className="h-20" />
    </div>
  );
}

/** The ERROR frame (§IX `data-state="error"`) — the dashboards source failed to
 *  resolve the pointer. */
export function DashboardPointerError() {
  return (
    <div
      data-testid="artifact-dashboard-pointer-error"
      data-conformance-id="artifact-dashboard-pointer"
      data-state="error"
      className="flex flex-col items-center gap-2 rounded-lg border border-line bg-surface-strong px-5 py-10 text-center"
    >
      <div className="grid size-10 place-items-center rounded-lg bg-destructive/10 text-destructive">
        <AlertTriangle aria-hidden className="size-5" />
      </div>
      <p className="text-sm font-semibold text-foreground">
        Couldn&apos;t load this dashboard
      </p>
      <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
        The dashboard source failed. Try again shortly.
      </p>
    </div>
  );
}
