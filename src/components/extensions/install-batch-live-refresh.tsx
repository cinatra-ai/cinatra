"use client";

// Live-refresh loop for the install-batch panel (cinatra #851 finding 3).
//
// The extensions admin view renders the `extension_install_batches` ledger as
// a SERVER snapshot (`InstallBatchPanel` is a pure presenter). While any batch
// is in a non-terminal phase, this invisible client component periodically
// calls `router.refresh()` so the server read re-runs and the per-member
// progress / compensation outcome stays current — no manual reload needed.
//
// Deliberately POLLING, not SSE: the ledger lives in Postgres, so a streaming
// endpoint would poll the DB server-side anyway while adding a brand-new
// authenticated, org-scoped surface. Refreshing the existing server read keeps
// auth + org scoping exactly where they already are. The parent (server)
// screen computes `active` via `hasActiveInstallBatch`, so this component
// stays free of server-flavored imports; polling stops on its own once the
// refreshed snapshot reports every batch terminal (`active` flips to false).

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const DEFAULT_INTERVAL_MS = 5_000;

export function InstallBatchLiveRefresh({
  active,
  intervalMs = DEFAULT_INTERVAL_MS,
}: {
  /** True while any rendered batch is in a non-terminal phase. */
  active: boolean;
  intervalMs?: number;
}) {
  const router = useRouter();

  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => {
      // Skip background tabs — the refresh would be wasted work and the
      // snapshot re-syncs on the first visible tick anyway.
      if (document.visibilityState === "visible") {
        router.refresh();
      }
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [active, intervalMs, router]);

  return null;
}
