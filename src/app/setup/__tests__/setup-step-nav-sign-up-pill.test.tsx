/**
 * cinatra#2477 (owner acceptance review) — the sign-up step is a permanent
 * step-1 pill on every setup page, but it is NEVER a link: the bootstrap form
 * can only render once (before the first account exists), and afterwards
 * /setup/sign-up unconditionally redirects forward, so a link would be a
 * silent bounce. Every other completed step keeps its ?stay=1 revisit link.
 *
 * Same convention as ./sessionless-chrome.test.ts / ./layout-top-anchor.test.ts
 * (no RTL/jsdom runner is configured for this surface) — but SetupStepNav is a
 * leaf client component, so renderToStaticMarkup works once the Next.js
 * navigation/link seams are stubbed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

vi.mock("next/navigation", () => ({
  usePathname: vi.fn(),
}));
// Same next/link stub convention as
// src/app/configuration/llm/__tests__/default-llm-select-objects-classification-removed.test.tsx.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) =>
    React.createElement("a", { href, ...rest }, children),
}));

const STEPS = [
  { id: "sign-up", title: "Sign up", href: "/setup/sign-up", ready: true },
  { id: "key", title: "Key", href: "/setup/key", ready: true },
  { id: "name", title: "Name", href: "/setup/name", ready: false },
  { id: "ai", title: "LLM Provider", href: "/setup/ai", ready: false },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SetupStepNav — the sign-up pill (cinatra#2477)", () => {
  it("renders the completed sign-up step as a checked pill that is NOT a link, while other completed steps stay revisitable", async () => {
    const { usePathname } = await import("next/navigation");
    (usePathname as unknown as ReturnType<typeof vi.fn>).mockReturnValue("/setup/name");

    const { SetupStepNav } = await import("../setup-step-nav");
    const html = renderToStaticMarkup(<SetupStepNav steps={STEPS} />);

    // All four pills render (the universal indicator).
    for (const title of ["Sign up", "Key", "Name", "LLM Provider"]) {
      expect(html).toContain(title);
    }
    // The completed key step keeps its revisit link…
    expect(html).toMatch(/href="\/setup\/key\?stay=1"/);
    // …but the completed sign-up step is never one.
    expect(html).not.toMatch(/href="\/setup\/sign-up/);
  });

  it("renders an all-incomplete rail (the sessionless static forecast) with no links at all", async () => {
    const { usePathname } = await import("next/navigation");
    (usePathname as unknown as ReturnType<typeof vi.fn>).mockReturnValue("/setup/sign-up");

    const { SetupStepNav } = await import("../setup-step-nav");
    const html = renderToStaticMarkup(
      <SetupStepNav steps={STEPS.map((s) => ({ ...s, ready: false }))} />,
    );

    expect(html).not.toMatch(/<a /);
    for (const title of ["Sign up", "Key", "Name", "LLM Provider"]) {
      expect(html).toContain(title);
    }
  });
});
