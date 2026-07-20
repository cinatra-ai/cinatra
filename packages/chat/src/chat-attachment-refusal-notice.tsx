import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { ChatAttachmentRefusal } from "./ag-ui-chat-client";

// ---------------------------------------------------------------------------
// Visible upload-refusal surface for /chat (cinatra#1890, epic #1883 A2 / D3+D6).
//
// Before this, a chat upload the server refused (415 for an unsupported MIME,
// 413 too large, a 5xx, or a network error) disappeared silently — the epic's
// named "chat silent-drop failure". This notice makes each refusal VISIBLE with
// recourse: it names the file + reason, and for a MIME-not-accepted refusal it
// links to the marketplace ("install a type that accepts this"). The full
// in-app type picker is slice A4 — this is only the honest surface + link.
//
// Presentation-only: the wording + marketplaceHref are decided upstream (the
// transport module / server), so this component never string-matches statuses.
// ---------------------------------------------------------------------------

export type ChatAttachmentRefusalNoticeProps = {
  refusals: ChatAttachmentRefusal[];
  /** Dismiss the whole notice (clears the refusal list upstream). */
  onDismiss: () => void;
};

export function ChatAttachmentRefusalNotice({
  refusals,
  onDismiss,
}: ChatAttachmentRefusalNoticeProps) {
  if (refusals.length === 0) return null;
  return (
    <div
      role="alert"
      aria-label="Attachment not added"
      className="mb-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-semibold text-destructive">
          {refusals.length === 1
            ? "1 file wasn't attached"
            : `${refusals.length} files weren't attached`}
        </p>
        <Button
          type="button"
          variant="link"
          size="xs"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="h-auto shrink-0 p-0 text-xs font-medium text-destructive/70 underline underline-offset-2 hover:text-destructive"
        >
          Dismiss
        </Button>
      </div>
      <ul className="mt-1 flex flex-col gap-1">
        {refusals.map((refusal, i) => (
          <li
            key={`${refusal.filename}-${refusal.status}-${i}`}
            className="text-xs text-destructive/80"
          >
            <span className="break-words">{refusal.message}</span>
            {refusal.marketplaceHref && (
              <>
                {" "}
                <Link
                  href={refusal.marketplaceHref}
                  className="whitespace-nowrap font-medium text-destructive underline underline-offset-2"
                >
                  Install a type that accepts this →
                </Link>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
