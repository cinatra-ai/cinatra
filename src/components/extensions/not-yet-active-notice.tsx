// The explicit "installed, not active yet" notice a connector setup surface
// shows when a live install row exists but the package registered NOTHING in
// this process (cinatra#2762).
//
// A schema-config connector's fields dispatch to
// `/api/extensions/{installId}/actions/...`. A package that committed its
// install but never activated here registers no actions, so every one of those
// POSTs 404s: option lists cannot load, record lists cannot load, saves cannot
// run. Without this notice the page reads as broken and states no cause.
//
// It is a NOTICE, not a degraded branch: the form still renders below it, the
// operator can still read their saved settings, and the page keeps its shape.
// The degraded branches (a rebuild requirement, an invalid declared schema)
// keep routing through ConnectorSetupColumns in its error state.
//
// Siblings the route already renders in this position: InstallActivateCta (no
// install row at all). shadcn-only, semantic tokens, no raw colors.

import { ClockAlertIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export type NotYetActiveNoticeProps = {
  /** The connector's user-facing display name. */
  displayName: string;
};

export function NotYetActiveNotice({ displayName }: NotYetActiveNoticeProps) {
  return (
    <Alert data-testid="connector-not-yet-active">
      <ClockAlertIcon />
      <AlertTitle>{displayName} is installed but not active yet</AlertTitle>
      <AlertDescription>
        It starts working after the next restart of the app. Until then this page
        cannot load or save its settings.
      </AlertDescription>
    </Alert>
  );
}
