"use client";

/**
 * §I segmented mode control + admin sub-nav for `/artifacts` (cinatra#1431,
 * spec design@4c6799db §I). Switching modes never leaves the page — it swaps
 * the `?mode=` search param in place, preserving the other params. The control
 * is affordance ONLY: for a non-administrator the admin segments/sub-views are
 * not rendered at all, and the server independently enforces the authorization
 * boundary (a hand-typed admin-mode URL still lands on the refusal panel).
 */
import { useCallback } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Lock } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  type ArtifactsMode,
  ARTIFACTS_MODE_LABEL,
} from "./artifacts-modes";

export function ArtifactsModeControl({
  activeMode,
  isAdmin,
}: {
  activeMode: ArtifactsMode;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const goToMode = useCallback(
    (mode: ArtifactsMode) => {
      const next = new URLSearchParams(searchParams?.toString() ?? "");
      if (mode === "library") next.delete("mode");
      else next.set("mode", mode);
      const qs = next.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname);
    },
    [router, pathname, searchParams],
  );

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3.5"
      data-testid="artifacts-mode-control"
      data-conformance-id="artifacts-mode-control"
      data-action="switch-mode -> mode-changed"
    >
      {/* Segmented control: Library (all) + Raw objects (admin only). */}
      <div
        role="tablist"
        aria-label="Artifacts mode"
        className="inline-flex h-9 overflow-hidden rounded-lg border border-line-strong text-sm"
      >
        <SegmentTab
          label={ARTIFACTS_MODE_LABEL.library}
          selected={activeMode === "library"}
          onSelect={() => goToMode("library")}
        />
        {isAdmin ? (
          <SegmentTab
            label={ARTIFACTS_MODE_LABEL.raw}
            icon={<Lock aria-hidden className="size-3 text-muted-foreground" />}
            selected={activeMode === "raw"}
            onSelect={() => goToMode("raw")}
            leftBorder
          />
        ) : null}
      </div>

      {/* Admin sub-nav: Types & approvals, Undo. */}
      {isAdmin ? (
        <div
          className="inline-flex items-center gap-1 text-sm"
          data-testid="artifacts-admin-subnav"
        >
          <span className="mr-1 font-mono text-badge-2xs uppercase tracking-kicker text-muted-foreground">
            Admin
          </span>
          <SubNavLink
            label={ARTIFACTS_MODE_LABEL.types}
            active={activeMode === "types"}
            onSelect={() => goToMode("types")}
          />
          <SubNavLink
            label={ARTIFACTS_MODE_LABEL.undo}
            active={activeMode === "undo"}
            onSelect={() => goToMode("undo")}
          />
          <SubNavLink
            label={ARTIFACTS_MODE_LABEL.merge}
            active={activeMode === "merge"}
            onSelect={() => goToMode("merge")}
          />
        </div>
      ) : null}
    </div>
  );
}

function SegmentTab({
  label,
  selected,
  onSelect,
  icon,
  leftBorder,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
  icon?: React.ReactNode;
  leftBorder?: boolean;
}) {
  return (
    <Button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
      variant="ghost"
      className={cn(
        "inline-flex h-full items-center gap-1.5 rounded-none px-4 text-xs transition-colors",
        leftBorder && "border-l border-line-strong",
        selected
          ? "bg-primary font-semibold text-primary-foreground hover:bg-primary"
          : "bg-surface-strong font-medium text-foreground hover:bg-surface-muted",
      )}
    >
      {icon}
      {label}
    </Button>
  );
}

function SubNavLink({
  label,
  active,
  onSelect,
}: {
  label: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <Button
      type="button"
      onClick={onSelect}
      aria-current={active ? "page" : undefined}
      variant="ghost"
      className={cn(
        "h-auto rounded-md px-2.5 py-1.5 text-xs transition-colors hover:bg-transparent hover:text-foreground",
        active ? "font-semibold text-foreground" : "text-muted-foreground",
      )}
    >
      {label}
    </Button>
  );
}
