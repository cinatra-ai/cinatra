// Lifecycle-discovery UX logic.
//
// Pure (no React) so it is fully unit-testable. The badge descriptors map to
// shadcn <Badge variant> values; the component layer (lifecycle-badges.tsx)
// renders them. Disabled-action reasons drive the marketplace's
// disabled-affordance copy.

import type {
  ExtensionLifecycleStatus,
  ExtensionSourceType,
  InstalledExtension,
} from "./canonical-types";

// Dev-version prefix + detection. Mirrors DEV_VERSION_PREFIX / isDevVersion in
// ./dev-version, kept inline here on purpose: dev-version.ts is `server-only`
// (it imports node:child_process + the canonical store), and this module is the
// pure, client-renderable badge-descriptor layer consumed by the "use client"
// lifecycle-badges.tsx. Importing dev-version would drag server-only into the
// client bundle and break the build. The string contract ("0.0.0-dev.") is a
// stable, append-only convention; the verdaccio-immutability + dev-version unit
// tests pin the producing side.
const DEV_VERSION_PREFIX = "0.0.0-dev.";
function isDevVersion(version: string): boolean {
  return version.startsWith(DEV_VERSION_PREFIX);
}

// shadcn Badge variant union (see src/components/ui/badge.tsx).
export type BadgeVariant =
  | "default"
  | "secondary"
  | "destructive"
  | "success"
  | "warning"
  | "info"
  | "outline"
  | "ghost"
  | "link";

export type LifecycleBadgeDescriptor = {
  key: string;
  label: string;
  variant: BadgeVariant;
  title?: string;
};

/**
 * Compute the badge descriptors for an extension. Order is stable: locked →
 * required → source → version.
 */
export function lifecycleBadgesFor(ext: InstalledExtension): LifecycleBadgeDescriptor[] {
  const badges: LifecycleBadgeDescriptor[] = [];

  if (ext.status === "locked") {
    badges.push({
      key: "locked",
      label: "Locked",
      variant: "warning",
      title: "System extension — cannot be archived or uninstalled.",
    });
  }
  if (ext.status === "archived") {
    badges.push({ key: "archived", label: "Archived", variant: "secondary" });
  }
  if (ext.requiredInProd) {
    badges.push({
      key: "required",
      label: "Required",
      variant: "info",
      title: "Required in production — auto-locked.",
    });
  }

  badges.push(sourceBadge(ext.source.type));

  const version = sourceVersion(ext);
  if (version) {
    badges.push({ key: "version", label: version, variant: "outline" });
  }

  return badges;
}

function sourceBadge(type: ExtensionSourceType): LifecycleBadgeDescriptor {
  switch (type) {
    case "verdaccio":
      return { key: "source", label: "Verdaccio", variant: "outline" };
    case "github":
      return { key: "source", label: "GitHub", variant: "outline" };
    case "local":
      return { key: "source", label: "Local", variant: "outline" };
  }
}

function sourceVersion(ext: InstalledExtension): string | null {
  if (ext.source.type === "verdaccio") {
    // A dev recompile records a verdaccio version of `0.0.0-dev.<sha>`; render
    // it as the human-readable "dev / <short-sha>" instead of the raw string.
    if (isDevVersion(ext.source.version)) {
      const sha = ext.source.version.slice(DEV_VERSION_PREFIX.length);
      return `dev / ${sha.slice(0, 7)}`;
    }
    return `v${ext.source.version}`;
  }
  if (ext.source.type === "github") return ext.source.ref;
  // A local source is always a dev / in-tree build — render "dev / <short-sha>"
  // rather than the bare 7-char hash so it reads as a dev version, not a tag.
  if (ext.source.type === "local") {
    return `dev / ${ext.source.resolvedCommitOrTreeHash.slice(0, 7)}`;
  }
  return null;
}

export type LifecycleAction = "archive" | "activate" | "uninstall" | "force_delete" | "purge";

/**
 * Reason a lifecycle action is disabled for an extension, or null if the
 * action is permitted.
 */
export function disabledActionReason(
  ext: InstalledExtension,
  action: LifecycleAction,
): string | null {
  const destructive: LifecycleAction[] = ["archive", "uninstall", "force_delete", "purge"];
  if (ext.status === "locked" && destructive.includes(action)) {
    if (ext.requiredInProd) {
      return action === "archive"
        ? "Cannot archive — required-in-prod"
        : `Cannot ${action.replace("_", " ")} — locked & required-in-prod`;
    }
    return action === "uninstall"
      ? "Cannot uninstall — locked; archive instead"
      : `Cannot ${action.replace("_", " ")} — locked`;
  }
  if (ext.status === "archived" && action === "archive") {
    return "Already archived";
  }
  if (ext.status === "active" && action === "activate") {
    return "Already active";
  }
  return null;
}

// ── Filter / search ────────────────────────────────────────────────────────

export type LifecycleFilter = {
  kind?: InstalledExtension["kind"];
  status?: ExtensionLifecycleStatus;
  sourceType?: ExtensionSourceType;
  requiredInProd?: boolean;
  locked?: boolean;
  search?: string; // free-text over package name + provenance
};

export function matchesLifecycleFilter(
  ext: InstalledExtension,
  filter: LifecycleFilter,
): boolean {
  if (filter.kind && ext.kind !== filter.kind) return false;
  if (filter.status && ext.status !== filter.status) return false;
  if (filter.sourceType && ext.source.type !== filter.sourceType) return false;
  if (filter.requiredInProd !== undefined && ext.requiredInProd !== filter.requiredInProd) {
    return false;
  }
  if (filter.locked !== undefined) {
    const isLocked = ext.status === "locked";
    if (isLocked !== filter.locked) return false;
  }
  if (filter.search) {
    const needle = filter.search.toLowerCase();
    const haystack = [
      ext.packageName,
      ext.source.type,
      ext.source.type === "verdaccio" ? ext.source.version : "",
      ext.source.type === "github" ? `${ext.source.repo} ${ext.source.ref}` : "",
      ext.source.type === "local" ? ext.source.path : "",
    ]
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}
