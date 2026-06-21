"use client";

import { useEffect } from "react";

// cinatra#407 — success step of the hosted /widget-auth flow.
//
// After the logged-in member consents and the server issues the user auth code,
// this component postMessage's the code + state to ONLY the verified opener
// origin (`siteOrigin`, NEVER "*"), then attempts to close the popup. The
// targetOrigin is the server-pinned, transaction-bound site origin — a hostile
// page cannot receive the code because the browser enforces the exact-origin
// targetOrigin on postMessage.
//
// The code/state are the only things crossing the boundary; the raw Cinatra
// credentials never left the Cinatra-hosted page. The widget relays the code to
// its OWN backend, which redeems it (server-to-server, cnx_-authed) for the
// opaque user token.
export function WidgetAuthSuccess({
  code,
  state,
  siteOrigin,
}: {
  code: string;
  state: string;
  siteOrigin: string;
}) {
  useEffect(() => {
    try {
      // Exact-origin targeting: the browser drops the message if the opener's
      // origin does not match siteOrigin. We never use "*".
      if (window.opener && siteOrigin) {
        window.opener.postMessage(
          { type: "cinatra-widget-auth", code, state },
          siteOrigin,
        );
      }
    } catch {
      /* opener gone / cross-origin access denied — fall through to manual close */
    }
    // Best-effort auto-close shortly after delivery (popup flow). If this page
    // is not a popup, window.close() is a no-op and the success card stays.
    const t = setTimeout(() => {
      try {
        window.close();
      } catch {
        /* ignore */
      }
    }, 400);
    return () => clearTimeout(t);
    // Run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="grid gap-3 text-center" aria-live="polite">
      <p className="text-sm text-muted-foreground">
        Signed in. Returning to the assistant…
      </p>
    </div>
  );
}
