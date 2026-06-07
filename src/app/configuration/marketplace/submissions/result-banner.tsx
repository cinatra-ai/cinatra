/**
 * Inline result banner — surfaces ?ok=/?error= query params from the post-
 * action redirect into a visible Alert. Avoids the toast-only pattern so the
 * result is preserved across page refreshes and visible without animation.
 */

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

const OP_LABELS: Record<string, string> = {
  withdraw: "Submission withdrawn",
  approve:  "Submission approved — promotion saga started",
  reject:   "Submission rejected",
  retry:    "Promotion saga retry submitted",
};

export function ResultBanner({
  ok,
  error,
  id,
}: {
  ok?: string;
  error?: string | null;
  id?: string;
}) {
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Action failed</AlertTitle>
        <AlertDescription className="break-words">{error}</AlertDescription>
      </Alert>
    );
  }
  if (ok && OP_LABELS[ok]) {
    return (
      <Alert>
        <AlertTitle>{OP_LABELS[ok]}</AlertTitle>
        {id ? (
          <AlertDescription className="font-mono text-xs">
            submission_id: {id}
          </AlertDescription>
        ) : null}
      </Alert>
    );
  }
  return null;
}
