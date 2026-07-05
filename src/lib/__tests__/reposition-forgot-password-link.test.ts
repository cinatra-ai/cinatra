// @vitest-environment jsdom
/**
 * "Forgot your password?" link placement fix (cinatra#883).
 *
 * `repositionForgotPasswordLink` moves the better-auth-ui `SignInForm`'s
 * "Forgot your password?" link from its default spot (inline with the
 * "Password" label, above the input) to directly below the password input.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FORGOT_PASSWORD_LINK_CLASS, repositionForgotPasswordLink } from "../password-toggle-a11y";

/**
 * Build markup matching better-auth-ui's rendered password `FormItem`:
 *
 *   <div data-slot="form-item">
 *     <div class="flex items-center justify-between">
 *       <label>Password</label>
 *       <a class="cinatra-forgot-password-link">Forgot your password?</a>
 *     </div>
 *     <div data-slot="form-control"><input type="password" /></div>
 *   </div>
 */
function passwordFormItem(): HTMLDivElement {
  const formItem = document.createElement("div");
  formItem.setAttribute("data-slot", "form-item");

  const row = document.createElement("div");
  row.className = "flex items-center justify-between";

  const label = document.createElement("label");
  label.textContent = "Password";
  row.appendChild(label);

  const link = document.createElement("a");
  link.className = `text-sm hover:underline ${FORGOT_PASSWORD_LINK_CLASS}`;
  link.href = "/forgot-password";
  link.textContent = "Forgot your password?";
  row.appendChild(link);

  formItem.appendChild(row);

  const control = document.createElement("div");
  control.setAttribute("data-slot", "form-control");
  const input = document.createElement("input");
  input.type = "password";
  control.appendChild(input);
  formItem.appendChild(control);

  return formItem;
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

describe("repositionForgotPasswordLink", () => {
  it("moves the link to directly after the password field's control", () => {
    const field = mount(passwordFormItem());
    const control = field.querySelector('[data-slot="form-control"]')!;
    const link = field.querySelector<HTMLAnchorElement>(`a.${FORGOT_PASSWORD_LINK_CLASS}`)!;

    expect(link.previousElementSibling).not.toBe(control); // starts above the field

    expect(repositionForgotPasswordLink(field)).toBe(true);

    expect(link.previousElementSibling).toBe(control);
    expect(link.classList.contains("block")).toBe(true);
  });

  it("no longer shares a row with the password label after the move", () => {
    const field = mount(passwordFormItem());
    const row = field.querySelector(".flex.items-center.justify-between")!;

    repositionForgotPasswordLink(field);

    expect(row.contains(field.querySelector(`a.${FORGOT_PASSWORD_LINK_CLASS}`))).toBe(false);
  });

  it("is idempotent — re-running after the move is a no-op", () => {
    const field = mount(passwordFormItem());
    repositionForgotPasswordLink(field);
    const link = field.querySelector<HTMLAnchorElement>(`a.${FORGOT_PASSWORD_LINK_CLASS}`)!;
    const before = field.innerHTML;

    expect(repositionForgotPasswordLink(field)).toBe(true);

    expect(field.innerHTML).toBe(before);
    expect(link.previousElementSibling).toBe(field.querySelector('[data-slot="form-control"]'));
  });

  it("returns false when the link isn't rendered on this view (e.g. sign-up)", () => {
    const field = document.createElement("div");
    field.setAttribute("data-slot", "form-item");
    document.body.appendChild(field);
    root = field;

    expect(repositionForgotPasswordLink(field)).toBe(false);
  });
});

/**
 * Pre-hydration (SSR) placement CSS coupling (cinatra#883 reopen).
 *
 * `repositionForgotPasswordLink` only runs in the browser AFTER hydration, so
 * the server-rendered markup still carries better-auth-ui's old inline-with-
 * label layout until the wrapper's effect runs. src/app/globals.css therefore
 * ships `:has()` rules that already render the tagged link BELOW the field in
 * the server-rendered state (flatten the label row via `display: contents`,
 * push the link after the input via `order`), keyed to the SAME
 * `FORGOT_PASSWORD_LINK_CLASS` the JS shim uses. jsdom cannot compute
 * `:has()`/`order`, so this guards the coupling statically: if the class
 * constant or the CSS drifts, this fails.
 */
describe("pre-hydration placement CSS (globals.css)", () => {
  const globalsCss = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../../app/globals.css"),
    "utf8",
  );

  it("flattens the SSR label row that still contains the tagged link", () => {
    const flattenRule = new RegExp(
      String.raw`\[data-slot="form-item"\]\s*>\s*div:has\(>\s*\[data-slot="form-label"\]\):has\(>\s*a\.${FORGOT_PASSWORD_LINK_CLASS}\)\s*\{\s*display:\s*contents;`,
    );
    expect(globalsCss).toMatch(flattenRule);
  });

  it("orders the tagged link after the input while it is still in the label row", () => {
    const orderRule = new RegExp(
      String.raw`\[data-slot="form-item"\]\s*>\s*div:has\(>\s*\[data-slot="form-label"\]\)\s*>\s*a\.${FORGOT_PASSWORD_LINK_CLASS}\s*\{\s*order:\s*\d+;`,
    );
    expect(globalsCss).toMatch(orderRule);
  });
});
