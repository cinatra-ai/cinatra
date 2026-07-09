/**
 * Extension-submission moderator surfaces: transient ACTION outcomes toast
 * (codes-only flash island), while a content-LOAD failure stays inline (it's a
 * persistent "the queue couldn't load" state, not a one-shot action result —
 * adjudication: load failures stay in-page).
 *
 * The action emitters (./actions.ts) redirect with `?ok=<op>` / `?error=<code>`;
 * both map to STATIC messages here (never the URL-supplied text — the raw MCP
 * error is logged server-side, not reflected into a toast).
 */

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { SearchParamToastConfig } from "@/components/search-param-toast";

// `?ok=<op>` success codes. Kept in lockstep with the redirects in ./actions.ts.
const OP_LABELS: Record<string, string> = {
  withdraw: "Submission withdrawn",
  approve:  "Submission approved — promotion saga started",
  reject:   "Submission rejected",
  retry:    "Promotion saga retry submitted",
};

// `?error=<code>` failure codes → static messages. The specific MCP error text
// is logged server-side in ./actions.ts; only a stable code rides the URL.
const ERROR_MESSAGES: Record<string, string> = {
  "missing-id":     "Missing submission id.",
  "token-missing":  "Marketplace token is not configured.",
  "reason-required": "A reject reason is required.",
  "reason-too-long": "The reject reason is too long.",
  "withdraw-failed": "Could not withdraw the submission. See server logs for details.",
  "approve-failed":  "Could not approve the submission. See server logs for details.",
  "reject-failed":   "Could not reject the submission. See server logs for details.",
  "retry-failed":    "Could not retry the promotion. See server logs for details.",
};

export const SUBMISSION_FLASH_TOASTS: SearchParamToastConfig[] = [
  ...Object.entries(OP_LABELS).map(([op, message]) => ({
    param: "ok" as const,
    value: op,
    message,
    variant: "success" as const,
  })),
  ...Object.entries(ERROR_MESSAGES).map(([code, message]) => ({
    param: "error" as const,
    value: code,
    message,
    variant: "error" as const,
  })),
];

/**
 * Inline banner for a content-LOAD failure (the list fetch could not complete).
 * This is a persistent state — it stays in-page rather than toasting.
 */
export function FetchErrorBanner({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <Alert variant="destructive">
      <AlertTitle>Couldn&apos;t load submissions</AlertTitle>
      <AlertDescription className="break-words">{error}</AlertDescription>
    </Alert>
  );
}
