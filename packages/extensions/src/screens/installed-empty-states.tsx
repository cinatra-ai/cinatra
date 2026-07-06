import { Archive, Package } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";

// ---------------------------------------------------------------------------
// §VI Installed-extensions empty states.
//
// Extracted from registry-catalog-screen.tsx (cinatra#986) so the
// design-conformance seeded harness can mount the SAME empty-state
// presentations the real /configuration/extensions screen renders — a single
// source of truth, not a copy. Server-renderable, no data reads.
// data-testid attrs: conformance stable-id contract (testid-contract.json).
// ---------------------------------------------------------------------------

export function ActiveEmptyState() {
  return (
    <div
      data-testid="installed-extensions-empty"
      data-tab="active"
      className="soft-panel rounded-card flex flex-col items-center justify-center py-16 text-center gap-3"
    >
      <Package className="h-8 w-8 text-muted-foreground" />
      <p className="font-semibold text-foreground">No active extensions</p>
      <p className="text-sm text-muted-foreground">
        No extensions are installed yet. Browse the marketplace to add one.
      </p>
      <Button asChild variant="outline" size="sm">
        <Link href="/configuration/marketplace">Browse marketplace</Link>
      </Button>
    </div>
  );
}

export function ArchivedEmptyState() {
  return (
    <div
      data-testid="installed-extensions-empty"
      data-tab="archived"
      className="soft-panel rounded-card flex flex-col items-center justify-center py-16 text-center gap-3"
    >
      <Archive className="h-8 w-8 text-muted-foreground" />
      <p className="font-semibold text-foreground">No archived extensions</p>
      <p className="text-sm text-muted-foreground">
        Extensions uninstalled after first use appear here. Their run history
        remains intact.
      </p>
    </div>
  );
}
