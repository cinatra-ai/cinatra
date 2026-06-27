"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { applyPasswordToggleA11y } from "@/lib/password-toggle-a11y";

/**
 * Scopes the password show/hide toggle a11y shim (cinatra#484) to the auth form
 * rendered as its children.
 *
 * The sign-up password fields are rendered by the third-party
 * `@daveyplate/better-auth-ui` `PasswordInput`, whose toggle button ships with
 * no `tabIndex` and no accessible name and offers no override hook. This wrapper
 * runs `applyPasswordToggleA11y` (see `@/lib/password-toggle-a11y`) over its own
 * subtree once mounted and keeps it applied via a `MutationObserver`, so the
 * toggle is kept out of the field→field Tab flow and is correctly announced to
 * assistive tech.
 *
 * The shim only mutates the live (hydrated) DOM, scoped to this wrapper's ref —
 * it never touches `document` globally and produces no hydration mismatch (React
 * renders the same server/client markup; the attributes are added afterwards).
 * The toggle button only exists while a password field has a value, so we rely
 * on the observer rather than assuming it is present on first paint.
 */
export function PasswordToggleA11y({ children }: { children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    // Apply once immediately for any toggle already present, then keep it in
    // sync as better-auth-ui mounts/replaces the toggle or flips the input's
    // `type` between "password" and "text".
    applyPasswordToggleA11y(root);

    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => {
      applyPasswordToggleA11y(root);
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["type"],
    });

    return () => observer.disconnect();
  }, []);

  return (
    <div ref={rootRef} className="contents">
      {children}
    </div>
  );
}
