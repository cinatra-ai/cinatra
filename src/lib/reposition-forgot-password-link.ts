/**
 * "Forgot your password?" link placement fix (cinatra#883).
 *
 * The sign-in password field is rendered by the third-party
 * `@daveyplate/better-auth-ui` `SignInForm`. It hard-codes the "Forgot your
 * password?" link inline, sharing a row with the "Password" label, ABOVE the
 * password input:
 *
 *   <div class="flex items-center justify-between">
 *     <FormLabel>Password</FormLabel>
 *     <Link>Forgot your password?</Link>
 *   </div>
 *   <FormControl><PasswordInput /></FormControl>
 *
 * The library exposes no position override — only a `classNames` slot to
 * STYLE the link (`classNames.form.forgotPasswordLink`), not to relocate it —
 * so moving it requires a DOM relocation scoped to our own rendered subtree,
 * same pattern as `applyPasswordToggleA11y` (cinatra#484): idempotent, keyed
 * off the library's own stable `data-slot` attributes (`form-item`,
 * `form-control`), never touches `document` globally, and is safe to re-run
 * from a MutationObserver.
 *
 * We identify the link itself via the classNames hook rather than by text or
 * href, so this survives localization overrides: callers must pass
 * `classNames={{ form: { forgotPasswordLink: FORGOT_PASSWORD_LINK_CLASS } }}`
 * to `AuthView`/`SignInForm`.
 */

export const FORGOT_PASSWORD_LINK_CLASS = "cinatra-forgot-password-link";

/**
 * Relocate the "Forgot your password?" link (tagged with
 * `FORGOT_PASSWORD_LINK_CLASS`) to directly below the password field's input,
 * scoped to `root`.
 *
 * Returns `true` when the link is present and correctly positioned
 * (immediately after the field's `[data-slot="form-control"]`) after this
 * call — whether it just moved it or it was already in place — and `false`
 * when there is nothing to reposition (e.g. the link isn't rendered on this
 * view, or the library's markup doesn't match the expected shape).
 */
export function repositionForgotPasswordLink(root: ParentNode): boolean {
  const link = root.querySelector<HTMLAnchorElement>(`a.${FORGOT_PASSWORD_LINK_CLASS}`);
  if (!link) return false;

  const formItem = link.closest('[data-slot="form-item"]');
  if (!formItem) return false;

  const control = formItem.querySelector<HTMLElement>('[data-slot="form-control"]');
  if (!control) return false;

  // Idempotent: already directly after the control — nothing to do (also
  // covers the MutationObserver re-firing off our own DOM move below).
  if (link.previousElementSibling === control) return true;

  control.insertAdjacentElement("afterend", link);
  // The link is an inline `<a>`; force it onto its own line below the
  // (block-level) input with a little breathing room above it.
  link.classList.add("block", "mt-1.5");
  return true;
}
