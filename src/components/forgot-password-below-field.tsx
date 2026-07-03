"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { repositionForgotPasswordLink } from "@/lib/reposition-forgot-password-link";

/**
 * Scopes the "Forgot your password?" link reposition (cinatra#883) to the
 * auth form rendered as its children.
 *
 * The sign-in password field is rendered by the third-party
 * `@daveyplate/better-auth-ui` `SignInForm`, which hard-codes the link inline
 * with the "Password" label (above the input) and offers no position
 * override — only a `classNames` slot to style it. This wrapper runs
 * `repositionForgotPasswordLink` over its own subtree once mounted and keeps
 * it applied via a `MutationObserver`, so the link ends up directly below the
 * password input regardless of how/when better-auth-ui (re)renders the form.
 *
 * Mirrors `PasswordToggleA11y` (cinatra#484): only mutates the live
 * (hydrated) DOM scoped to this wrapper's ref, never touches `document`
 * globally, and produces no hydration mismatch (React renders the same
 * server/client markup; the reposition happens afterwards).
 *
 * Callers must render the `AuthView`/`SignInForm` inside with
 * `classNames={{ form: { forgotPasswordLink: FORGOT_PASSWORD_LINK_CLASS } }}`
 * so the link can be found — see `@/lib/reposition-forgot-password-link`.
 */
export function ForgotPasswordBelowField({ children }: { children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    repositionForgotPasswordLink(root);

    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => {
      repositionForgotPasswordLink(root);
    });
    observer.observe(root, { childList: true, subtree: true });

    return () => observer.disconnect();
  }, []);

  return (
    <div ref={rootRef} className="contents">
      {children}
    </div>
  );
}
