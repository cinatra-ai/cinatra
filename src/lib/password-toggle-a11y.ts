/**
 * Password show/hide toggle accessibility shim (cinatra#484).
 *
 * The password fields on the sign-up form are rendered by the third-party
 * `@daveyplate/better-auth-ui` `PasswordInput` (it passes `enableToggle`). That
 * component hard-codes a show/hide `<button type="button">` with NO `tabIndex`
 * and NO accessible name, and the library exposes no override hook to swap the
 * input, so we cannot fix the markup at the JSX level from our own tree without
 * patching the dependency.
 *
 * This module is a deterministic, idempotent DOM shim that runs after mount
 * (see `PasswordToggleA11y`) and, scoped to the rendered auth form:
 *
 *   - removes each toggle button from the natural field→field Tab flow
 *     (`tabIndex = -1`) — the toggle is a non-essential convenience that stays
 *     mouse-clickable and screen-reader reachable, matching the behavior in the
 *     issue;
 *   - gives each toggle a proper accessible name ("Show password" /
 *     "Hide password"), recomputed from the associated input's live `type`, plus
 *     `aria-pressed` reflecting whether the password is currently visible.
 *
 * The accessible name / pressed state are derived from the input's `type`
 * (`"password"` = hidden, `"text"` = visible) on every sync so they never drift
 * from the actual visibility — we hold no state of our own.
 */

export const SHOW_PASSWORD_LABEL = "Show password";
export const HIDE_PASSWORD_LABEL = "Hide password";

/** A password input together with its show/hide toggle button. */
interface TogglePair {
  input: HTMLInputElement;
  button: HTMLButtonElement;
}

function isPasswordInput(el: Element): el is HTMLInputElement {
  if (el.tagName !== "INPUT") return false;
  const type = (el as HTMLInputElement).type;
  // `@daveyplate/better-auth-ui` flips the input between "password" (hidden) and
  // "text" (visible). A bare "text" input is not necessarily a password field,
  // so only treat a "text" input as one when it carries the new-password
  // autocomplete hint the library always sets on its password fields.
  if (type === "password") return true;
  if (type === "text") {
    const autocomplete = (el as HTMLInputElement).autocomplete;
    return autocomplete === "new-password" || autocomplete === "current-password";
  }
  return false;
}

/**
 * Pair each password input inside `root` with its show/hide toggle button.
 *
 * The library renders the toggle as the only `<button type="button">` sibling of
 * the input inside a wrapper `<div class="relative">`, so we walk up to the
 * nearest ancestor that contains exactly one such button and use it. Inputs
 * without a matching toggle (e.g. a username field, or the sign-in password
 * field which renders no toggle) are skipped.
 */
export function findPasswordToggles(root: ParentNode): TogglePair[] {
  const pairs: TogglePair[] = [];
  const inputs = root.querySelectorAll("input");

  for (const input of inputs) {
    if (!isPasswordInput(input)) continue;

    let ancestor: Element | null = input.parentElement;
    let button: HTMLButtonElement | null = null;
    // Climb at most a couple of levels: the toggle lives in the immediate
    // `<div class="relative">` wrapper. Stop as soon as we find exactly one
    // `button[type="button"]` so we never grab the submit button further out.
    for (let depth = 0; ancestor && depth < 3 && !button; depth++) {
      const buttons = ancestor.querySelectorAll<HTMLButtonElement>('button[type="button"]');
      if (buttons.length === 1) {
        button = buttons[0];
        break;
      }
      ancestor = ancestor.parentElement;
    }

    if (button) pairs.push({ input, button });
  }

  return pairs;
}

/**
 * Apply the a11y attributes to a single toggle button, derived from the live
 * `type` of its associated input. Only writes when a value actually changes, so
 * it is safe to call from a `MutationObserver` without triggering observer
 * loops. Returns `true` when it mutated the DOM.
 */
function syncToggle({ input, button }: TogglePair): boolean {
  let changed = false;

  if (button.tabIndex !== -1) {
    button.tabIndex = -1;
    changed = true;
  }

  const isVisible = input.type === "text";
  const label = isVisible ? HIDE_PASSWORD_LABEL : SHOW_PASSWORD_LABEL;
  if (button.getAttribute("aria-label") !== label) {
    button.setAttribute("aria-label", label);
    changed = true;
  }

  const pressed = isVisible ? "true" : "false";
  if (button.getAttribute("aria-pressed") !== pressed) {
    button.setAttribute("aria-pressed", pressed);
    changed = true;
  }

  return changed;
}

/**
 * Find every password toggle inside `root` and apply the a11y attributes.
 * Returns the number of toggles found (whether or not they needed updating).
 * Idempotent: re-running on already-fixed markup is a no-op.
 */
export function applyPasswordToggleA11y(root: ParentNode): number {
  const pairs = findPasswordToggles(root);
  for (const pair of pairs) syncToggle(pair);
  return pairs.length;
}
