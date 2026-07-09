/**
 * NangoUserConnectButton optional leading-icon slot (github-connector#43, item 7).
 *
 * A connector setup page needs the §II indigo-plug "Connect" glyph beside the
 * button label, but must NOT re-implement this button's Nango connect-session
 * logic. The button therefore exposes a strictly-additive, purely-presentational
 * `leadingIcon?: ReactNode` slot: omitting it renders the button exactly as
 * before; passing it renders a decorative glyph before the label.
 *
 * This repo's sdk-ui component tests use source-text assertions because
 * @testing-library/react is not available (vitest env is "node" — no DOM
 * render). We assert the slot's contract at the source level: the prop is
 * declared, destructured, and rendered before the label, aria-hidden, and
 * suppressed while pending so it never sits beside the "Opening..." label.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import * as ButtonMod from "../nango-user-connect-button";

const BUTTON_SOURCE = readFileSync(
  fileURLToPath(new URL("../nango-user-connect-button.tsx", import.meta.url)),
  "utf-8",
);

describe("NangoUserConnectButton leading-icon slot (github-connector#43 item 7)", () => {
  it("still exports the connect surfaces (additive change)", () => {
    expect(typeof ButtonMod.NangoUserConnectButton).toBe("function");
    expect(typeof ButtonMod.NangoUserConnectCard).toBe("function");
  });

  it("declares an optional ReactNode leadingIcon prop", () => {
    expect(BUTTON_SOURCE).toMatch(/leadingIcon\?: ReactNode;/);
  });

  it("destructures leadingIcon in the button component", () => {
    // Between the props destructure opening and the function body, leadingIcon
    // must be pulled off props (so it is not silently ignored).
    const destructure = BUTTON_SOURCE.slice(
      BUTTON_SOURCE.indexOf("export function NangoUserConnectButton({"),
      BUTTON_SOURCE.indexOf("}: NangoUserConnectButtonProps)"),
    );
    expect(destructure).toMatch(/\bleadingIcon\b/);
  });

  it("renders the icon before the label, decorative, and only when not pending", () => {
    expect(BUTTON_SOURCE).toMatch(
      /\{leadingIcon && !pending \? \([\s\S]*?aria-hidden="true"[\s\S]*?\{leadingIcon\}[\s\S]*?\) : null\}/,
    );
    // The label render must still follow the icon slot on the next line.
    expect(BUTTON_SOURCE).toMatch(
      /\{leadingIcon && !pending \?[\s\S]*?\) : null\}\s*\{pending \? "Opening\.\.\." : connected \? reconnectLabel : connectLabel\}/,
    );
  });

  it("keeps the slot optional — the default render path passes no icon", () => {
    // No default value is assigned to leadingIcon (undefined ⇒ slot omitted),
    // so existing call sites are unaffected.
    expect(BUTTON_SOURCE).not.toMatch(/leadingIcon\s*=\s*[^,)]/);
  });
});
