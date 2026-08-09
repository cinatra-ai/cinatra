/**
 * cinatra#2502 item A — the TERMINAL step is cardless too.
 *
 * The issue asked whether the terminal step intentionally keeps its card. The
 * design spec answers it: `specs/app-setup.html` revision 0.3.0 §I —
 * "Every step renders into that same column with the same bound, FROM THE
 * FIRST STEP TO THE TERMINAL ONE", and "The step body is cardless". So the
 * elevated white section goes here as well.
 *
 * What STAYS is the success mark's tinted disc: that is a glyph treatment on
 * the success tint, not container chrome, and Rule #8 is untouched by it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import type { ReactElement, ReactNode } from "react";

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    React.createElement("a", { href }, children),
}));
vi.mock("@/lib/setup-wizard", () => ({
  isSetupWizardComplete: vi.fn().mockResolvedValue(true),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SetupCompletePage — cardless (cinatra#2502 item A)", () => {
  it("renders the terminal step directly on the column, with no elevated white card", async () => {
    const { default: SetupCompletePage } = await import("../page");
    const html = renderToStaticMarkup((await SetupCompletePage()) as ReactElement);

    // The step still says what it says and still offers both exits…
    expect(html).toContain("Setup complete");
    expect(html).toMatch(/href="\/connectors"/);
    expect(html).toMatch(/href="\/"/);

    // …without the card chrome.
    expect(html).not.toMatch(/rounded-card/);
    expect(html).not.toMatch(/bg-surface-strong/);
    expect(html).not.toMatch(/shadow-sm/);
  });

  it("keeps the success mark's tinted disc — a glyph treatment, not container chrome", async () => {
    const { default: SetupCompletePage } = await import("../page");
    const html = renderToStaticMarkup((await SetupCompletePage()) as ReactElement);
    expect(html).toContain("bg-success/10");
    expect(html).toContain("text-success");
  });
});
