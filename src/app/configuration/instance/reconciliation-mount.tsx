// -----------------------------------------------------------------------------
// ReconciliationMount client component.
//
// Calls the reconcileFirstPublishedAtAndPersist server action once per page
// mount. Keeping the write in a client-side mount effect avoids a render-time
// writeInstanceIdentity side effect, so React Server Component caching
// expectations stay clean.
//
// React Strict Mode invokes effects twice in dev. The useRef guard prevents
// duplicate fire-and-forget calls within a single mount; the server action
// is also idempotent (re-checks firstPublishedAt !== null before write), so
// duplicate invocation is safe by design.
// -----------------------------------------------------------------------------

"use client";

import { useEffect, useRef } from "react";
import { reconcileFirstPublishedAtAndPersist } from "./actions";

/**
 * Renders nothing. Side-effect-only component: triggers a one-shot
 * reconciliation server action on mount.
 */
export function ReconciliationMount(): null {
  const ranRef = useRef(false);
  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    // Fire-and-forget; server action is idempotent and graceful on failure.
    reconcileFirstPublishedAtAndPersist().catch(() => {
      // No-op — reconciliation is best-effort; failures are logged
      // server-side by the action itself if needed.
    });
  }, []);
  return null;
}
