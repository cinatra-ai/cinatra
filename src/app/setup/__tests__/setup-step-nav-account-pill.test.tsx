/**
 * cinatra#2477 (owner acceptance review) — the sign-up step is a permanent
 * step-1 pill on every setup page, but it is NEVER a link: the bootstrap form
 * can only render once (before the first account exists), and afterwards
 * /setup/account unconditionally redirects forward, so a link would be a
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

import type { SetupWizardStep } from "@/lib/setup-wizard";

const STEPS: SetupWizardStep[] = [
  { id: "sign-up", title: "Account", href: "/setup/account", status: "done" },
  { id: "key", title: "Key", href: "/setup/key", status: "done" },
  { id: "name", title: "Name", href: "/setup/name", status: "upcoming" },
  { id: "ai", title: "Model", href: "/setup/model", status: "upcoming" },
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
    for (const title of ["Account", "Key", "Name", "Model"]) {
      expect(html).toContain(title);
    }
    // The completed key step keeps its revisit link…
    expect(html).toMatch(/href="\/setup\/key\?stay=1"/);
    // …but the completed account (sign-up) step is never one.
    expect(html).not.toMatch(/href="\/setup\/account/);
  });

  it("#2483 review: pill labels never wrap — nowrap pills in a max-content rail that scrolls instead of breaking", async () => {
    const { usePathname } = await import("next/navigation");
    (usePathname as unknown as ReturnType<typeof vi.fn>).mockReturnValue("/setup/name");

    const { SetupStepNav } = await import("../setup-step-nav");
    const fiveSteps = [
      ...STEPS.slice(0, 3),
      { id: "secrets", title: "Secrets", href: "/setup/secrets", status: "upcoming" as const },
      STEPS[3],
    ];
    const html = renderToStaticMarkup(<SetupStepNav steps={fiveSteps} />);

    // Every pill carries whitespace-nowrap (labels cannot break) and shrink-0
    // (a pill cannot be compressed below its label).
    const pillClasses = [...html.matchAll(/class="([^"]*rounded-full[^"]*)"/g)].map((m) => m[1]);
    expect(pillClasses).toHaveLength(5);
    for (const cls of pillClasses) {
      expect(cls).toContain("whitespace-nowrap");
      expect(cls).toContain("shrink-0");
    }
    // The rail itself scrolls when it outgrows the wizard column.
    expect(html).toMatch(/<nav[^>]*class="[^"]*overflow-x-auto/);
    expect(html).toMatch(/<ol[^>]*class="[^"]*w-max/);
  });

  it("#2505: a five-step rail halves its connector rule so the trailing pill is not clipped", async () => {
    const { usePathname } = await import("next/navigation");
    (usePathname as unknown as ReturnType<typeof vi.fn>).mockReturnValue("/setup/model");

    const { SetupStepNav } = await import("../setup-step-nav");
    const fiveSteps = [
      ...STEPS.slice(0, 3),
      { id: "secrets", title: "Secrets", href: "/setup/secrets", status: "upcoming" as const },
      STEPS[3],
    ];
    const html = renderToStaticMarkup(<SetupStepNav steps={fiveSteps} />);

    // Four connectors (one before every pill but the first), each HALVED.
    // Measured: the five-step rail wants 690.03px in a 672px column; four
    // 20px rules instead of four 40px ones bring it to 610.03px.
    const connectorClasses = [...html.matchAll(/class="([^"]*h-0\.5[^"]*)"/g)].map((m) => m[1]);
    expect(connectorClasses).toHaveLength(4);
    for (const cls of connectorClasses) {
      expect(cls).toContain("w-5");
      expect(cls).not.toContain("w-10");
    }

    // The space comes from DECORATION only. Pills stay rigid and unwrapped, so
    // nothing a reader has to read is ever compressed — the #2483 contract.
    const pillClasses = [...html.matchAll(/class="([^"]*rounded-full[^"]*)"/g)].map((m) => m[1]);
    expect(pillClasses).toHaveLength(5);
    for (const cls of pillClasses) {
      expect(cls).toContain("shrink-0");
      expect(cls).toContain("whitespace-nowrap");
    }
    // And the scroll fallback survives: a rail that STILL cannot fit degrades
    // to today's horizontal scroll, never to overlapping pills.
    expect(html).toMatch(/<nav[^>]*class="[^"]*overflow-x-auto/);
    expect(html).toMatch(/<ol[^>]*class="[^"]*w-max/);
  });

  // Scope of this test, stated exactly: it pins the four-step rail's connector
  // WIDTH and row classes. The stronger claim — that the rendered four-step
  // rail is unchanged pixel-for-pixel — is proven on the PR by the live
  // before/after capture, whose PNGs hash identically.
  it("#2505 leaves the ACCEPTED four-step rail alone — full-width connectors, unchanged row", async () => {
    const { usePathname } = await import("next/navigation");
    (usePathname as unknown as ReturnType<typeof vi.fn>).mockReturnValue("/setup/account");

    const { SetupStepNav } = await import("../setup-step-nav");
    const html = renderToStaticMarkup(
      <SetupStepNav steps={STEPS.map((s) => ({ ...s, status: "upcoming" as const }))} />,
    );

    // Three connectors, each still the accepted 40px: the four-step rail
    // measured 446.72px in a 672px column and never needed the space.
    const connectorClasses = [...html.matchAll(/class="([^"]*h-0\.5[^"]*)"/g)].map((m) => m[1]);
    expect(connectorClasses).toHaveLength(3);
    for (const cls of connectorClasses) {
      expect(cls).toContain("w-10");
      expect(cls).not.toContain("w-5");
    }
    expect(html).toMatch(/<ol[^>]*class="[^"]*w-max/);
  });

  it("renders an all-incomplete rail (the sessionless static forecast) with no links at all", async () => {
    const { usePathname } = await import("next/navigation");
    (usePathname as unknown as ReturnType<typeof vi.fn>).mockReturnValue("/setup/account");

    const { SetupStepNav } = await import("../setup-step-nav");
    const html = renderToStaticMarkup(
      <SetupStepNav steps={STEPS.map((s) => ({ ...s, status: "upcoming" as const }))} />,
    );

    expect(html).not.toMatch(/<a /);
    for (const title of ["Account", "Key", "Name", "Model"]) {
      expect(html).toContain(title);
    }
  });
});
