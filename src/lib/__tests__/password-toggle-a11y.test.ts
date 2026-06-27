// @vitest-environment jsdom
/**
 * Password show/hide toggle a11y shim (cinatra#484).
 *
 * The sign-up password fields render a third-party (`@daveyplate/better-auth-ui`)
 * show/hide toggle button with no `tabIndex` and no accessible name, reachable by
 * Tab between fields. `applyPasswordToggleA11y` fixes the live DOM:
 *
 *   - the toggle is removed from the Tab flow (`tabIndex = -1`) — it stays
 *     mouse-clickable / screen-reader reachable;
 *   - the toggle gets an accessible name ("Show password" / "Hide password") and
 *     `aria-pressed`, derived from the input's live `type` so it never drifts.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  applyPasswordToggleA11y,
  findPasswordToggles,
  HIDE_PASSWORD_LABEL,
  SHOW_PASSWORD_LABEL,
} from "../password-toggle-a11y";

/**
 * Build markup matching better-auth-ui's `PasswordInput`: a `.relative` wrapper
 * holding the input and the toggle button (the only `button[type="button"]`).
 */
function passwordField(opts: { type?: "password" | "text"; autocomplete?: string } = {}): HTMLDivElement {
  const wrapper = document.createElement("div");
  wrapper.className = "relative";

  const input = document.createElement("input");
  input.type = opts.type ?? "password";
  input.setAttribute("autocomplete", opts.autocomplete ?? "new-password");
  wrapper.appendChild(input);

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "eye";
  wrapper.appendChild(button);

  return wrapper;
}

let root: HTMLElement;

afterEach(() => {
  root?.remove();
});

function mount(...children: HTMLElement[]): HTMLElement {
  root = document.createElement("form");
  for (const c of children) root.appendChild(c);
  document.body.appendChild(root);
  return root;
}

describe("findPasswordToggles", () => {
  it("pairs each password input with its toggle button", () => {
    const form = mount(passwordField(), passwordField());
    const pairs = findPasswordToggles(form);
    expect(pairs).toHaveLength(2);
    for (const { input, button } of pairs) {
      expect(input.tagName).toBe("INPUT");
      expect(button.type).toBe("button");
    }
  });

  it("ignores non-password inputs (e.g. username/email) with no toggle", () => {
    const username = document.createElement("input");
    username.type = "text";
    username.setAttribute("autocomplete", "username");
    const form = mount(username, passwordField());
    expect(findPasswordToggles(form)).toHaveLength(1);
  });

  it("does not grab the submit button as a toggle", () => {
    const form = mount(passwordField());
    const submit = document.createElement("button");
    submit.type = "submit";
    form.appendChild(submit);
    const pairs = findPasswordToggles(form);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].button.type).toBe("button");
  });

  it("treats a visible password input (type=text + new-password) as a password field", () => {
    const form = mount(passwordField({ type: "text", autocomplete: "new-password" }));
    expect(findPasswordToggles(form)).toHaveLength(1);
  });
});

describe("applyPasswordToggleA11y", () => {
  it("removes the toggle from the Tab flow and labels it (hidden state)", () => {
    const field = passwordField({ type: "password" });
    const form = mount(field);
    const button = field.querySelector("button")!;

    expect(applyPasswordToggleA11y(form)).toBe(1);
    expect(button.tabIndex).toBe(-1);
    expect(button.getAttribute("aria-label")).toBe(SHOW_PASSWORD_LABEL);
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it("labels the toggle as 'Hide password' / aria-pressed=true when the password is visible", () => {
    const field = passwordField({ type: "text" });
    const form = mount(field);
    const button = field.querySelector("button")!;

    applyPasswordToggleA11y(form);
    expect(button.getAttribute("aria-label")).toBe(HIDE_PASSWORD_LABEL);
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });

  it("fixes BOTH sign-up password fields (password + confirm-password)", () => {
    const form = mount(passwordField(), passwordField());
    expect(applyPasswordToggleA11y(form)).toBe(2);
    for (const button of form.querySelectorAll("button")) {
      expect((button as HTMLButtonElement).tabIndex).toBe(-1);
      expect(button.getAttribute("aria-label")).toBe(SHOW_PASSWORD_LABEL);
    }
  });

  it("re-syncs the label/pressed state after the input toggles visibility", () => {
    const field = passwordField({ type: "password" });
    const form = mount(field);
    const input = field.querySelector("input")!;
    const button = field.querySelector("button")!;

    applyPasswordToggleA11y(form);
    expect(button.getAttribute("aria-label")).toBe(SHOW_PASSWORD_LABEL);

    input.type = "text"; // user clicked the toggle → now visible
    applyPasswordToggleA11y(form);
    expect(button.getAttribute("aria-label")).toBe(HIDE_PASSWORD_LABEL);
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });

  it("is idempotent — re-running does not change already-fixed markup", () => {
    const field = passwordField();
    const form = mount(field);
    const button = field.querySelector("button")!;

    applyPasswordToggleA11y(form);
    const before = button.outerHTML;
    applyPasswordToggleA11y(form);
    expect(button.outerHTML).toBe(before);
  });
});
