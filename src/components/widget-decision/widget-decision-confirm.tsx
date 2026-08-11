"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import type { WidgetDecisionConfirmResult } from "@/app/widget-decision/actions";

// ---------------------------------------------------------------------------
// The CONFIRM half of the hosted widget-decision window (cinatra#2575, epic
// #2564 S8b).
//
// THE CLICK IS THE PRODUCT. Its sibling on the login flow (`WidgetAuthGrant`)
// fires its server action unattended, because the owner ruled that signing in is
// the consent. This one deliberately does not: the epic's promise is that
// deciding from a widget "costs one extra confirmation, by design", and an
// unattended confirmation would be no confirmation at all. Nothing happens here
// until a person presses the button.
//
// THE CAPABILITY GOES TO CINATRA'S OWN OPENER AND NOWHERE ELSE. The delivery is
// `postMessage(..., window.location.origin)` — this page's own origin, which is
// Cinatra's, read from the browser rather than from a server-supplied value so a
// misconfigured environment cannot widen it. The window that opened this one is
// the Cinatra-origin embed iframe; a CMS page that opened it instead is a
// different origin, the browser drops the message, and the site learns nothing.
// `"*"` never appears.
//
// A LOST DELIVERY IS VISIBLE, NOT SILENT. If the opener is gone — the tab was
// closed, the window was opened directly — the confirmation has already been
// spent on the server and cannot be replayed, so the person is told plainly to
// go back and decide again rather than being left watching a spinner.
// ---------------------------------------------------------------------------

/** The message the Cinatra-origin embed listens for. Typed, versioned, and
 * matched on `type` by the receiver so it can ignore everything else. */
export const WIDGET_DECISION_MESSAGE_TYPE = "cinatra-widget-decision";

const FAILURE_MESSAGES: Record<string, string> = {
  not_authenticated: "Your session ended. Sign in again, then decide from the assistant.",
  unavailable:
    "This confirmation is no longer available. Go back to the assistant and decide again.",
  undelivered:
    "This window could not reach the assistant. Go back to the assistant and decide again.",
};

type Phase =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "delivered" }
  | { kind: "failed"; reason: string };

export function WidgetDecisionConfirm({
  capabilityId,
  confirmLabel,
}: {
  capabilityId: string;
  /** The act, in the imperative, so the button says what pressing it does. */
  confirmLabel: string;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  // Auto-close after a successful delivery, exactly as the login popup does.
  // If this page is not a popup, `close()` is a no-op and the delivered card
  // stays on screen.
  useEffect(() => {
    if (phase.kind !== "delivered") return;
    const timer = setTimeout(() => {
      try {
        window.close();
      } catch {
        /* not a popup, or the browser refused — the card stays */
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [phase.kind]);

  async function confirm(): Promise<void> {
    if (phase.kind === "working" || phase.kind === "delivered") return;
    setPhase({ kind: "working" });
    let result: WidgetDecisionConfirmResult;
    try {
      const { confirmWidgetDecisionAction } = await import("@/app/widget-decision/actions");
      result = await confirmWidgetDecisionAction(capabilityId);
    } catch {
      // A transport failure must not strand the window on a spinner. The
      // confirmation may or may not have landed; either way the honest advice is
      // the same, and the capability is single-use on the server.
      result = { ok: false, reason: "unavailable" };
    }
    if (!result.ok) {
      setPhase({ kind: "failed", reason: result.reason });
      return;
    }
    try {
      const opener = window.opener as Window | null;
      if (!opener) {
        setPhase({ kind: "failed", reason: "undelivered" });
        return;
      }
      opener.postMessage(
        { type: WIDGET_DECISION_MESSAGE_TYPE, capability: result.capability },
        window.location.origin,
      );
      setPhase({ kind: "delivered" });
    } catch {
      setPhase({ kind: "failed", reason: "undelivered" });
    }
  }

  if (phase.kind === "delivered") {
    return (
      <p className="text-sm text-muted-foreground" aria-live="polite">
        Confirmed. Returning to the assistant…
      </p>
    );
  }

  if (phase.kind === "failed") {
    return (
      <p className="text-sm text-destructive" role="alert">
        {FAILURE_MESSAGES[phase.reason] ?? FAILURE_MESSAGES.unavailable}
      </p>
    );
  }

  return (
    <div className="grid w-full gap-2">
      <Button
        type="button"
        onClick={() => {
          void confirm();
        }}
        disabled={phase.kind === "working"}
        aria-busy={phase.kind === "working"}
      >
        {phase.kind === "working" ? "Confirming…" : confirmLabel}
      </Button>
      <Button
        type="button"
        variant="ghost"
        onClick={() => {
          try {
            window.close();
          } catch {
            /* ignore */
          }
        }}
      >
        Cancel
      </Button>
    </div>
  );
}
