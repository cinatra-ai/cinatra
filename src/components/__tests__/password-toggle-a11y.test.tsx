// @vitest-environment jsdom
/**
 * `PasswordToggleA11y` wrapper contract (cinatra#484).
 *
 * The wrapper scopes the password show/hide toggle a11y shim to the auth form
 * rendered as its children. It must fix toggles present at mount AND toggles that
 * appear later (better-auth-ui only renders the toggle once a password field has
 * a value) via its `MutationObserver`, and keep `aria-label`/`aria-pressed` in
 * sync when the input's `type` flips between "password" and "text".
 */
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ForgotPasswordBelowField, PasswordToggleA11y } from "../password-toggle-a11y";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  FORGOT_PASSWORD_LINK_CLASS,
  HIDE_PASSWORD_LABEL,
  SHOW_PASSWORD_LABEL,
} from "@/lib/password-toggle-a11y";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Markup mirroring better-auth-ui's `PasswordInput` (relative wrapper). */
function PasswordField({ type = "password" }: { type?: "password" | "text" }) {
  return (
    <div className="relative">
      <Input type={type} autoComplete="new-password" />
      <Button type="button">eye</Button>
    </div>
  );
}

/** Wait a microtask/animation frame so the MutationObserver flushes. */
async function flushObserver() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("PasswordToggleA11y", () => {
  it("fixes a toggle present at mount", async () => {
    await act(async () => {
      root.render(
        <PasswordToggleA11y>
          <PasswordField />
        </PasswordToggleA11y>,
      );
    });

    const button = container.querySelector("button")!;
    expect(button.tabIndex).toBe(-1);
    expect(button.getAttribute("aria-label")).toBe(SHOW_PASSWORD_LABEL);
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it("fixes a toggle that mounts LATER via the MutationObserver", async () => {
    function Late() {
      const [show, setShow] = React.useState(false);
      return (
        <PasswordToggleA11y>
          <Button type="button" data-testid="reveal" onClick={() => setShow(true)}>
            reveal
          </Button>
          {show ? <PasswordField /> : null}
        </PasswordToggleA11y>
      );
    }

    await act(async () => {
      root.render(<Late />);
    });

    // No password field yet.
    expect(container.querySelector('input[type="password"]')).toBeNull();

    await act(async () => {
      (container.querySelector('[data-testid="reveal"]') as HTMLButtonElement).click();
    });
    await flushObserver();

    const toggle = container.querySelector(".relative button")!;
    expect((toggle as HTMLButtonElement).tabIndex).toBe(-1);
    expect(toggle.getAttribute("aria-label")).toBe(SHOW_PASSWORD_LABEL);
  });

  it("re-syncs the label when the input type flips to 'text' (password shown)", async () => {
    function Toggleable() {
      const [visible, setVisible] = React.useState(false);
      return (
        <PasswordToggleA11y>
          <div className="relative">
            <Input type={visible ? "text" : "password"} autoComplete="new-password" />
            <Button type="button" onClick={() => setVisible((v) => !v)}>
              eye
            </Button>
          </div>
        </PasswordToggleA11y>
      );
    }

    await act(async () => {
      root.render(<Toggleable />);
    });

    const button = container.querySelector(".relative button")!;
    expect(button.getAttribute("aria-label")).toBe(SHOW_PASSWORD_LABEL);

    await act(async () => {
      (button as HTMLButtonElement).click();
    });
    await flushObserver();

    expect(button.getAttribute("aria-label")).toBe(HIDE_PASSWORD_LABEL);
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });
});

/**
 * Markup mirroring better-auth-ui `SignInForm`'s password `FormItem` as
 * SERVER-rendered: the "Forgot your password?" link (tagged via the
 * `classNames.form.forgotPasswordLink` hook) sits inline with the label,
 * ABOVE the input, and `data-slot="form-control"` is carried by the input
 * itself (inside the library's `.relative` wrapper).
 *
 * Injected as a literal HTML string (not our JSX): this is third-party
 * library output — the raw `<a>`/`<input>` are better-auth-ui's, deliberately
 * NOT the shadcn wrappers the design-system lint enforces for app JSX.
 */
const SIGN_IN_PASSWORD_FORM_ITEM_HTML = `
  <div data-slot="form-item" class="grid gap-2">
    <div class="flex items-center justify-between">
      <label data-slot="form-label">Password</label>
      <a class="text-sm hover:underline ${FORGOT_PASSWORD_LINK_CLASS}" href="/forgot-password">Forgot your password?</a>
    </div>
    <div class="relative">
      <input type="password" data-slot="form-control" autocomplete="current-password" />
    </div>
  </div>`;

function SignInPasswordFormItem() {
  return <div dangerouslySetInnerHTML={{ __html: SIGN_IN_PASSWORD_FORM_ITEM_HTML }} />;
}

describe("ForgotPasswordBelowField (cinatra#883)", () => {
  it("renders the link directly after the password input (rendered order) at mount", async () => {
    await act(async () => {
      root.render(
        <ForgotPasswordBelowField>
          <SignInPasswordFormItem />
        </ForgotPasswordBelowField>,
      );
    });

    const input = container.querySelector('input[type="password"]')!;
    const link = container.querySelector(`a.${FORGOT_PASSWORD_LINK_CLASS}`)!;
    const labelRow = container.querySelector(".flex.items-center.justify-between")!;

    // Rendered order: input first, link immediately after it — not in the label row.
    expect(link.previousElementSibling).toBe(input);
    expect(input.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(labelRow.contains(link)).toBe(false);
  });

  it("relocates a link that mounts LATER via the MutationObserver", async () => {
    function Late() {
      const [show, setShow] = React.useState(false);
      return (
        <ForgotPasswordBelowField>
          <Button type="button" data-testid="reveal" onClick={() => setShow(true)}>
            reveal
          </Button>
          {show ? <SignInPasswordFormItem /> : null}
        </ForgotPasswordBelowField>
      );
    }

    await act(async () => {
      root.render(<Late />);
    });

    expect(container.querySelector(`a.${FORGOT_PASSWORD_LINK_CLASS}`)).toBeNull();

    await act(async () => {
      (container.querySelector('[data-testid="reveal"]') as HTMLButtonElement).click();
    });
    await flushObserver();

    const input = container.querySelector('input[type="password"]')!;
    const link = container.querySelector(`a.${FORGOT_PASSWORD_LINK_CLASS}`)!;
    expect(link.previousElementSibling).toBe(input);
  });
});
