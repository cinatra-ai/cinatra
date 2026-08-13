"use client";

import { useEffect } from "react";

// The return step of the hosted /widget-auth flow (cinatra#407; rewritten by
// cinatra#2674, epic #2564 S8e).
//
// WHERE THE AUTHORIZATION RESULT GOES, AND WHY IT IS THE WHOLE SLICE. Until S8e
// this component posted the code to the CMS SITE's origin, because the site's
// backend was the party that would redeem it. That is what made the site a
// holder of the person's credential. Now the code is posted to the CINATRA
// ORIGIN and to nothing else — `window.location.origin`, this document's own —
// so the only window that can receive it is a Cinatra-origin one: the embed
// iframe that opened this popup.
//
// THIS IS THE LOAD-BEARING CONTROL OF THE WHOLE FLOW, and it is the browser's,
// not ours. `postMessage` with an exact target origin is enforced by the user
// agent: a CMS page listening for this message receives nothing, no matter what
// it claims, what headers it forges or what it opened. Every server-side check
// in S8e is defense in depth behind this one line.
//
// `window.location.origin` rather than a value passed in as a prop, deliberately.
// A prop is data that travelled; this component runs ON the Cinatra origin, so
// the correct target is a property of where it is, which nothing upstream can
// influence. There is no configuration here to get wrong and none to tamper with.
//
// The code and state are the only things crossing the boundary, and they cross
// it inside one origin. The raw Cinatra credentials never left this page.
export function WidgetAuthSuccess({ code, state }: { code: string; state: string }) {
  useEffect(() => {
    try {
      // Exact-origin targeting, and the origin is OURS. The browser drops the
      // message unless the opener is a Cinatra-origin document. Never "*".
      const target = window.location.origin;
      if (window.opener && target && target !== "null") {
        window.opener.postMessage({ type: "cinatra-widget-auth", code, state }, target);
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
