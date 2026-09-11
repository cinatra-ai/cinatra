// @vitest-environment jsdom
/**
 * `/artifacts` — the library toolbar REPLACES the page header's etched paired
 * rule; the two are never stacked (cinatra#3283).
 *
 *   pnpm vitest run --config vitest.config.ts --no-coverage \
 *     src/app/artifacts/__tests__/library-toolbar-replaces-rule-3283.test.tsx
 *
 * The ratified drawing, page header: "The etched paired-line rule closes the
 * header on every page — unless a toolbar sits directly beneath, which
 * replaces the rule (see Toolbar)."; Toolbar: "The toolbar sits directly below
 * the page header and replaces the section rule for that view — never stack a
 * toolbar and the etched paired rule."; section breaks: "If a toolbar sits
 * below the page header, the toolbar replaces the section rule entirely; never
 * stack both."
 *
 * The library page mounts its toolbar directly under the page header, so the
 * header hands its rule over: exactly one of {the header's rule, the toolbar}
 * is drawn, and the toolbar is what stands in the rule's place. The same
 * resolution the agents strip took in cinatra#3228.
 *
 * Renders the REAL page composition (ArtifactsPage -> PageHeader ->
 * PageContent -> LibraryMode -> LibraryToolbar) with the data reads mocked.
 */
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn(async () => ({
    session: { activeOrganizationId: "org-1" },
    user: { id: "user-1" },
  })),
  requireActorContext: vi.fn(async () => ({
    userId: "user-1",
    orgId: "org-1",
  })),
  signInRedirectTarget: vi.fn(async () => "/sign-in"),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  usePathname: () => "/artifacts",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/lib/better-auth-db", () => ({
  readOrgsWithTeamsForUserActiveOnly: vi.fn(async () => []),
  readProjectsForUser: vi.fn(async () => []),
}));
vi.mock("@/lib/artifacts/artifact-service", () => ({
  listArtifacts: vi.fn(() => []),
}));
vi.mock("@/lib/dashboards/dashboard-artifact-pointer-resolvers", () => ({
  resolveLibraryDashboardPointers: vi.fn(async () => new Map()),
}));
// The per-row renderer glyph resolves through the server-only extension
// dispatch spine (the generated extension registry). This library renders no
// rows — the header/toolbar order is the subject — so the loader is stubbed
// rather than dragging the whole registry into jsdom.
vi.mock("@/lib/artifacts/artifact-renderer-loader", () => ({
  loadArtifactRenderer: vi.fn(async () => null),
}));
// The upload island's server actions (marketplace browse / inline install)
// reach the generated extension registry, which is not resolvable in the root
// vitest sandbox. None of them fires while the page merely renders.
vi.mock("@/app/artifacts/upload-typing-actions", () => ({
  assertUploadMeaning: vi.fn(async () => ({ ok: true })),
  installArtifactPackInline: vi.fn(async () => ({ ok: true })),
  listArtifactMarketplacePacks: vi.fn(async () => []),
  listInstalledTypesForArtifact: vi.fn(async () => []),
  requestTypeInstall: vi.fn(async () => ({ ok: true })),
}));

import ArtifactsPage from "../page";
import { PageHeader } from "@/components/page-header";

afterEach(cleanup);

/** The etched paired-line section rule. */
const RULE = '[data-slot="separator"][data-major]';
const TOOLBAR = '[data-slot="toolbar"]';

/** Elements in document order, so "above"/"between" is a plain index range. */
function ordered(container: Element): Element[] {
  return Array.from(container.querySelectorAll("*"));
}

/**
 * The page is a real server composition — `LibraryMode` is an async server
 * component, which the CLIENT renderer refuses ("Only Server Components can be
 * async"). So the page is prerendered exactly as the server renders it, and the
 * emitted markup is parsed back into a document the DOM queries below read.
 */
async function renderLibrary(): Promise<Element> {
  const { prerender } = await import("react-dom/static");
  const element = await ArtifactsPage({ searchParams: Promise.resolve({}) });
  const { prelude } = await prerender(element as React.ReactElement);
  const html = await new Response(prelude as unknown as ReadableStream).text();
  const doc = new DOMParser().parseFromString(
    `<div id="page">${html}</div>`,
    "text/html",
  );
  return doc.getElementById("page")!;
}

describe("/artifacts — the library toolbar replaces the header's etched rule (cinatra#3283)", () => {
  it("1. no etched paired rule is drawn above the library toolbar", async () => {
    const container = await renderLibrary();
    const all = ordered(container);
    const toolbar = container.querySelector(TOOLBAR);
    expect(toolbar, "the library mounts its toolbar").toBeTruthy();
    const toolbarAt = all.indexOf(toolbar!);
    const rulesAbove = Array.from(container.querySelectorAll(RULE)).filter(
      (rule) => all.indexOf(rule) < toolbarAt,
    );
    expect(
      rulesAbove.length,
      "the toolbar replaces the section rule — the two are never stacked",
    ).toBe(0);
  });

  it("2. the page header draws no closing rule, the toolbar standing in its place", async () => {
    const container = await renderLibrary();
    const header = container.querySelector("header");
    expect(header, "the page opens with the standard page header").toBeTruthy();
    expect(container.querySelectorAll(TOOLBAR).length).toBe(1);
    expect(header!.querySelectorAll(RULE).length).toBe(0);
  });

  it("3. the toolbar is the first thing drawn after the header — nothing between them", async () => {
    const container = await renderLibrary();
    const all = ordered(container);
    const header = container.querySelector("header")!;
    const toolbar = container.querySelector(TOOLBAR)!;
    const headerEnd = Math.max(
      ...Array.from(header.querySelectorAll("*")).map((el) => all.indexOf(el)),
      all.indexOf(header),
    );
    const toolbarAt = all.indexOf(toolbar);
    expect(toolbarAt).toBeGreaterThan(headerEnd);
    // Every element between the header and the toolbar in document order is an
    // ANCESTOR of the toolbar (a layout wrapper opening around it) or is not
    // drawn at all (the upload island's hidden file input) — no visible sibling
    // content, and no rule, stands between the two.
    const between = all.slice(headerEnd + 1, toolbarAt);
    const undrawn = (el: Element) =>
      el.hasAttribute("hidden") || el.classList.contains("hidden");
    for (const el of between) {
      expect(
        el.contains(toolbar) || undrawn(el),
        `<${el.tagName.toLowerCase()} class="${el.className}"> is drawn between the header and the toolbar`,
      ).toBe(true);
    }
    expect(between.some((el) => el.matches(RULE))).toBe(false);
  });

  it("4. the fix is at the page — its PageHeader pins the no-divider form", () => {
    const source = readFileSync(join(__dirname, "..", "page.tsx"), "utf8");
    // [^>]* keeps the match inside the single opening tag — the prop must sit
    // on the PageHeader element itself, not merely somewhere later in the file.
    expect(source).toMatch(/<PageHeader\b[^>]*divider=\{false\}/);
  });

  it("5. the shared page header keeps its rule on a page that mounts no toolbar", () => {
    const { container } = render(
      <PageHeader title="Artifacts" description="Everything your agents and uploads have produced." />,
    );
    expect(container.querySelectorAll(TOOLBAR).length).toBe(0);
    expect(container.querySelectorAll(RULE).length).toBe(1);
  });
});
