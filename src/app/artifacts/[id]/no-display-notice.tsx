import type { ReactElement } from "react";
import { AlertTriangle } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/**
 * THE HOST DIAGNOSTIC that stands where the core metadata card used to stand.
 *
 * The card it replaces drew the artifact itself — its name, its media type, its
 * size, its origin, its created date and its download — which is artifact
 * CONTENT, and content belongs to the artifact's own display. This notice draws
 * none of it. It says only that this instance carries no display for the kind of
 * work the row holds, which is a fact about the INSTALLATION and therefore the
 * host's to state.
 *
 * It is also the never-blank floor every degrade path passes down: a failure
 * state renders a host diagnostic, or an extension-owned base display, and
 * nothing else.
 */
export function NoDisplayNotice(): ReactElement {
  return (
    <Alert variant="default" data-testid="artifact-no-display">
      <AlertTriangle aria-hidden="true" />
      <AlertTitle>No display is installed for this kind of work</AlertTitle>
      <AlertDescription>
        Nothing installed here can draw this artifact. Install an extension that
        claims its type or its media type, and this page draws it.
      </AlertDescription>
    </Alert>
  );
}
