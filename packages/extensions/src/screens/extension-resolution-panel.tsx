import Link from "next/link";
import { LifecycleBadge } from "@/components/lifecycle-badge";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExtensionResolutionPanelProps = {
  /** Display name of the extension. Pass empty string to trigger the not-found fallback. */
  name: string;
  version: string;
  vendor: string;
  /** Fully-qualified package identifier, e.g. "@cinatra/my-agent@1.0.0". */
  packageRef: string;
  status: "active" | "archived";
  /** Deep link target, e.g. "/configuration/extensions" or "/configuration/extensions?tab=archived". */
  extensionsHref: string;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Inline extension resolution panel rendered on run-detail surfaces.
 * Shows the extension's name, packageRef, lifecycle status badge, version,
 * vendor, and a deep-link back to the Extensions catalog.
 * When `name` is empty the panel renders a not-found fallback (handles
 * force-deleted records gracefully).
 */
export function ExtensionResolutionPanel(props: ExtensionResolutionPanelProps) {
  if (!props.name) {
    return (
      <div className="soft-panel rounded-card p-3">
        <p className="text-xs text-muted-foreground">
          Extension not found — record may have been force-deleted.
        </p>
      </div>
    );
  }

  return (
    <div className="soft-panel rounded-card p-3 flex flex-col gap-2">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-[0.1em]">
        Extension
      </p>
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-semibold text-foreground">{props.name}</span>
          <span className="text-xs text-muted-foreground font-mono">{props.packageRef}</span>
        </div>
        <LifecycleBadge status={props.status} />
      </div>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span>v{props.version}</span>
        <span>·</span>
        <span>{props.vendor}</span>
      </div>
      <Link href={props.extensionsHref} className="text-xs text-foreground hover:underline">
        View in Extensions →
      </Link>
    </div>
  );
}
