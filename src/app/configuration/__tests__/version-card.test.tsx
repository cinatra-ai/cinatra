/**
 * /configuration "Version" card (cinatra#2260).
 *
 * The card answers "which cinatra release is this instance running?" WITHOUT
 * navigation, so the contract worth pinning is: the value the page renders is
 * the running build's package-manifest version — derived, never restated — and
 * the card closes the grid.
 *
 * The manifest version is read straight off disk here (not imported from the
 * module under test) so the assertion is a genuine equality between the
 * RENDERED value and the manifest, not a tautology.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ComponentProps, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

/** The app package-manifest version, read from disk — the expected value. */
const MANIFEST_VERSION = (
  JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { version: string }
).version;

vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: vi.fn(async () => ({})),
}));

vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: vi.fn(() => ({ registries: { remote: { status: "connected" } } })),
}));

// next/link is a client component with router context it cannot get here, so it
// is stubbed — but the stub PRESERVES the target as `data-href` (the raw-anchor
// design-system ban rules out emitting an <a>), which is what the link
// assertions read.
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: ComponentProps<"a">) => (
    <span data-href={typeof href === "string" ? href : ""} {...rest}>
      {children}
    </span>
  ),
}));

vi.mock("@/components/layout/main", () => ({
  Main: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/page-content", () => ({
  PageContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/page-header", () => ({
  PageHeader: () => null,
}));

import AdministrationPage from "../page";

const RELEASES_URL = "https://github.com/cinatra-ai/cinatra/releases";

async function renderPage(): Promise<string> {
  return renderToStaticMarkup(await AdministrationPage());
}

/** Card titles in DOM order — the grid renders one per section. */
function cardTitles(markup: string): string[] {
  // Element-agnostic: keyed on the design-system slot, not on CardTitle's tag.
  return [...markup.matchAll(/data-slot="card-title"[^>]*>(.*?)</g)].map((m) => m[1]);
}

/**
 * Markup of the LAST card, sliced from its CARD ROOT. `data-slot="card"`
 * matches the root only — every nested slot is `card-title`, `card-action`, …,
 * so the closing quote excludes them. The slice still runs to the end of the
 * document, so assertions on it are paired with a whole-page uniqueness check
 * rather than trusting the slice to be an exact element boundary.
 */
function lastCardMarkup(markup: string): string {
  return markup.slice(markup.lastIndexOf('data-slot="card"'));
}

describe("/configuration Version card", () => {
  it("renders as the last card in the grid", async () => {
    const titles = cardTitles(await renderPage());

    expect(titles.length).toBeGreaterThan(1);
    expect(titles.at(-1)).toBe("Version");
    // Exactly one Version card — not a duplicate appended twice.
    expect(titles.filter((t) => t === "Version")).toHaveLength(1);
  });

  it("comes after Development", async () => {
    const titles = cardTitles(await renderPage());

    // Deliberately an ORDERING assertion, not adjacency: a future card inserted
    // between the two is legitimate; Version being pushed off the end is not.
    expect(titles.indexOf("Version")).toBeGreaterThan(titles.indexOf("Development"));
  });

  it("shows the running build's package-manifest version on the card itself", async () => {
    const markup = await renderPage();
    const card = lastCardMarkup(markup);

    expect(MANIFEST_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    // Exactly one occurrence page-wide — that, plus the containment check
    // below, pins the value INSIDE the last card rather than merely somewhere
    // after it. Visible without navigating anywhere.
    expect(markup.split(MANIFEST_VERSION)).toHaveLength(2);
    expect(card).toContain(`>${MANIFEST_VERSION}<`);
  });

  it("links to the public releases page", async () => {
    const card = lastCardMarkup(await renderPage());

    expect(card).toContain(`data-href="${RELEASES_URL}"`);
  });

  it("derives the version — no source file restates the version literal", () => {
    const sources = [
      path.join(REPO_ROOT, "src", "app", "configuration", "page.tsx"),
      // The deriving module itself is checked too: a hardcoded constant there
      // would satisfy every other assertion here and only start lying at the
      // next version bump — exactly the drift this card must not have.
      path.join(REPO_ROOT, "src", "lib", "app-version.ts"),
    ];

    for (const file of sources) {
      expect(readFileSync(file, "utf8")).not.toContain(MANIFEST_VERSION);
    }
  });
});

describe("APP_VERSION", () => {
  it("equals the app package-manifest version", async () => {
    const { APP_VERSION } = await import("@/lib/app-version");

    expect(APP_VERSION).toBe(MANIFEST_VERSION);
  });
});
