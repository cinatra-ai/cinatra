import type { ReactNode } from "react";

import type { RuntimeRendererFloorReason } from "@/lib/artifacts/runtime-renderer-descriptor";
import { runtimeRendererFloorDiagnostic } from "@/lib/artifacts/runtime-renderer-descriptor";

// The NEVER-BLANK floor for the main-realm dynamic loader (epic #1620 M1 Slice A
// — cinatra#1630, plan §2.6 / AC-5). On EVERY dynamic-path failure state the
// loader renders the host's generic floor node (`fallback`) plus a sanitized,
// telemetry-safe diagnostic naming ONLY package + slot + reason — never a raw
// error or a manifest value. Presentational + client-safe (no restricted raw
// JSX elements).

export function DynamicRendererFloor({
  packageName,
  slot,
  reason,
  fallback,
}: {
  packageName: string;
  slot: string;
  reason: RuntimeRendererFloorReason;
  fallback: ReactNode;
}): ReactNode {
  return (
    <div data-dynamic-renderer-floor={reason}>
      <p role="status" className="text-muted-foreground text-sm">
        {runtimeRendererFloorDiagnostic(packageName, slot, reason)}
      </p>
      {fallback}
    </div>
  );
}
