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

const STEPS = [
  { id: "sign-up", title: "Account", href: "/setup/account", ready: true },
  { id: "key", title: "Key", href: "/setup/key", ready: true },
  { id: "name", title: "Name", href: "/setup/name", ready: false },
  { id: "ai", title: "Model", href: "/setup/model", ready: false },
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
      { id: "connections", title: "Connections", href: "/setup/connections", ready: false },
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

  it("renders an all-incomplete rail (the sessionless static forecast) with no links at all", async () => {
    const { usePathname } = await import("next/navigation");
    (usePathname as unknown as ReturnType<typeof vi.fn>).mockReturnValue("/setup/account");

    const { SetupStepNav } = await import("../setup-step-nav");
    const html = renderToStaticMarkup(
      <SetupStepNav steps={STEPS.map((s) => ({ ...s, ready: false }))} />,
    );

    expect(html).not.toMatch(/<a /);
    for (const title of ["Account", "Key", "Name", "Model"]) {
      expect(html).toContain(title);
    }
  });
});
