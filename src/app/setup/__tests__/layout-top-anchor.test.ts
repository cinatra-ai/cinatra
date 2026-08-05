/**
 * cinatra#2459 (setup-flow S4/S5 chrome) — SetupLayout's shared wizard
 * container must be TOP-ANCHORED, not vertically centered.
 *
 * `justify-center` on the `min-h-screen` flex column vertically centered the
 * whole wizard (logo + step rail + step card), so the persistent chrome
 * jumped between steps depending on content height — worst on the short
 * /setup/complete card, which floated mid-viewport with a large gap above
 * the logo. The container must use `justify-start` (top-anchored) while
 * keeping `items-center` (horizontal centering) and `py-12` (top breathing
 * room).
 *
 * Same convention as ./sessionless-chrome.test.ts: inspect the returned React
 * element tree directly (no DOM renderer — no RTL/jsdom runner is configured
 * for this surface), which is sufficient to pin the container's className.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn(),
}));
vi.mock("@/lib/setup-wizard", () => ({
  getSetupWizardSteps: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SetupLayout — shared wizard container anchoring (#2459)", () => {
  it("top-anchors the wizard column (justify-start), keeps horizontal centering and top padding", async () => {
    const { getAuthSession } = await import("@/lib/auth-session");
    (getAuthSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { default: SetupLayout } = await import("../layout");
    const ui = (await SetupLayout({ children: null })) as ReactElement<{ className?: string }>;

    // The root element of the layout is the shared <main> wizard container.
    expect(ui.type).toBe("main");
    const className = ui.props.className ?? "";
    const classes = className.split(/\s+/);

    // Top-anchored: the chrome (logo + step rail) keeps a fixed vertical
    // position on every step instead of floating with content height.
    expect(classes).toContain("justify-start");
    expect(classes).not.toContain("justify-center");

    // Horizontal centering and top breathing room are preserved.
    expect(classes).toContain("items-center");
    expect(classes).toContain("py-12");
    expect(classes).toContain("min-h-screen");
  });
});
