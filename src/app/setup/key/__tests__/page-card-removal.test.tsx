/**
 * cinatra#2483 review (follows cinatra#2477) — the Key step's instruction
 * blocks sit directly on the page: the white-background card (`rounded-card
 * border border-line bg-surface-strong p-6 shadow-sm` section) that used to
 * encapsulate them is REMOVED, exactly like the Name page's card. The
 * section element itself stays for its FUNCTIONAL role: once the key is set
 * it dims (opacity-60) and de-activates (pointer-events-none) the
 * instructions.
 *
 * Same conventions as ../../name/__tests__/page-card-removal.test.tsx:
 * renderToStaticMarkup over the server component with the heavy seams
 * stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import type { ReactElement } from "react";

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
// Same next/link stub convention as the repo's other page tests.
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
vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
}));
vi.mock("@/lib/setup-wizard", () => ({
  getSetupWizardSteps: vi.fn().mockResolvedValue([]),
  getFirstIncompleteStep: vi.fn().mockReturnValue({ id: "key", href: "/setup/key" }),
}));

const ORIGINAL_KEY = process.env.CINATRA_ENCRYPTION_KEY;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.CINATRA_ENCRYPTION_KEY;
  else process.env.CINATRA_ENCRYPTION_KEY = ORIGINAL_KEY;
});

async function renderKeyPage(): Promise<string> {
  const { default: SetupSecretKeyPage } = await import("../page");
  const ui = (await SetupSecretKeyPage({
    searchParams: Promise.resolve({ stay: "1" }),
  })) as ReactElement;
  return renderToStaticMarkup(ui);
}

describe("SetupSecretKeyPage — no card around the instructions (cinatra#2483 review)", () => {
  it("key unset: renders the instruction blocks directly on the page, without the card wrapper", async () => {
    delete process.env.CINATRA_ENCRYPTION_KEY;
    const html = await renderKeyPage();

    // Both instruction blocks are present…
    expect(html).toMatch(/Generate a key/);
    expect(html).toMatch(/Configure the key/);

    // …but no card chrome wraps them.
    expect(html).not.toMatch(/rounded-card/);
    expect(html).not.toMatch(/bg-surface-strong/);
  });

  it("key set: the functional dimmed state survives the card removal", async () => {
    process.env.CINATRA_ENCRYPTION_KEY =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const html = await renderKeyPage();

    expect(html).not.toMatch(/rounded-card/);
    expect(html).not.toMatch(/bg-surface-strong/);
    // The section still dims and de-activates the instructions.
    expect(html).toMatch(/<section[^>]*aria-disabled="true"[^>]*class="[^"]*pointer-events-none/);
    expect(html).toMatch(/opacity-60/);
  });
});
