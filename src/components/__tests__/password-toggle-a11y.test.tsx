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
import { PasswordToggleA11y } from "../password-toggle-a11y";
import { HIDE_PASSWORD_LABEL, SHOW_PASSWORD_LABEL } from "@/lib/password-toggle-a11y";

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
      <input type={type} autoComplete="new-password" />
      <button type="button">eye</button>
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
          <button type="button" data-testid="reveal" onClick={() => setShow(true)}>
            reveal
          </button>
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
            <input type={visible ? "text" : "password"} autoComplete="new-password" />
            <button type="button" onClick={() => setVisible((v) => !v)}>
              eye
            </button>
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
