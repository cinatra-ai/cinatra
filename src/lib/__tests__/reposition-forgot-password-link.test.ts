// @vitest-environment jsdom
/**
 * "Forgot your password?" link placement fix (cinatra#883).
 *
 * `repositionForgotPasswordLink` moves the better-auth-ui `SignInForm`'s
 * "Forgot your password?" link from its default spot (inline with the
 * "Password" label, above the input) to directly below the password input.
 */
import { afterEach, describe, expect, it } from "vitest";
import { FORGOT_PASSWORD_LINK_CLASS, repositionForgotPasswordLink } from "../reposition-forgot-password-link";

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
