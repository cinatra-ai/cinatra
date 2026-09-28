// @vitest-environment jsdom
/**
 * THE GLOBAL LIBRARY IS UNCHANGED (cinatra#2810, per-scope surfaces S4).
 *
 * The acceptance sentence this file proves, verbatim:
 *
 *   "The global `/artifacts` and `/skills` pages are proven unchanged by
 *    behavioral regression fixtures (same fixture data renders the same rows
 *    before/after), not by source-presence claims."
 *
 * So this file states no source fact at all. It drives the SAME fixture rows
 * through the global page's own code path — `LibraryMode` mounted exactly the
 * way `/artifacts` mounts it, with no ownership locus — and pins the row set it
 * renders, in order, against a literal.
 *
 * THE FILE IMPORTS NOTHING THIS SLICE ADDS, on purpose. Everything it touches
 * exists on the branch's base head too, so the identical file runs on BOTH
 * sides of the change and the "before/after" in the acceptance sentence is a
 * measurement rather than a claim. A regression fixture that only ran on the
 * new head could not tell you what the old head did.
 */
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    createElement("a", { href, ...rest }, children),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  notFound: vi.fn(),
  usePathname: () => "/artifacts",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

/** The library's identity dispatch is not this fixture's subject. */
vi.mock("@/app/artifacts/[id]/renderer-dispatch", () => ({
  isSelectionPreparing: () => false,
}));

/**
 * The renderer glyph and the pack's declared kind label resolve through the
 * artifact-UI dispatch spine, which loads the generated extension registry.
 * Neither is this fixture's subject — the ROW SET is — so both are stood in for
 * and the rows keep rendering their own title text.
 */
vi.mock("@/components/artifacts/library-row-glyph", () => ({
  isFileMime: () => true,
  LibraryRowGlyph: () => null,
}));

vi.mock("@/lib/artifacts/artifact-kind-label", () => ({
  artifactKindLabelFor: (extension: string) => extension,
}));

/**
 * The toolbar, the upload affordances and the dashboard row all sit in the
 * extension-registry graph. Each stand-in RENDERS ITS CHILDREN, so the list
 * below them is reached and read exactly as it is in the page.
 */
vi.mock("@/components/artifacts/library-toolbar", () => ({
  LibraryToolbar: ({ children }: { children?: ReactNode }) =>
    createElement("div", { "data-testid": "library-toolbar" }, children),
}));

vi.mock("@/components/artifacts/library-upload", () => ({
  LibraryUploadProvider: ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children),
  LibraryUploadDropZone: ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children),
  LibraryUploadButton: () => null,
}));

vi.mock("@/components/artifacts/dashboard-library-row", () => ({
  DashboardLibraryRow: () => null,
}));

vi.mock("@/lib/dashboards/dashboard-artifact-surface", () => ({
  isDashboardArtifactType: () => false,
}));

const store = vi.hoisted(() => ({
  rows: [] as unknown[],
}));

vi.mock("@/lib/artifacts/artifact-service", () => ({
  listArtifacts: vi.fn(() => store.rows),
}));

vi.mock("@/lib/better-auth-db", () => ({
  readOrgsWithTeamsForUserActiveOnly: vi.fn(async () => [
    { id: "org-a", name: "Org A", teams: [{ id: "team-a", name: "Team A" }] },
  ]),
  readProjectsForUser: vi.fn(async () => [{ id: "project-a", name: "Project A" }]),
}));

vi.mock("@/lib/dashboards/dashboard-artifact-pointer-resolvers", () => ({
  resolveLibraryDashboardPointers: vi.fn(async () => new Map()),
}));

import { LibraryMode } from "@/components/artifacts/library-mode";

/** A library row, in the shape `listArtifacts` returns. */
function artifact(
  artifactId: string,
  title: string,
  ownership: {
    ownerLevel: "user" | "team" | "organization" | "workspace";
    ownerId: string | null;
    organizationId: string | null;
    projectId: string | null;
  },
) {
  return {
    artifactId,
    latestRepresentationRevisionId: null,
    objectType: "artifact.document",
    artifactType: "document",
    title,
    mime: "text/markdown",
    size: 12,
    originKind: "upload",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    visibility: "private" as const,
    eligibleExtensions: [],
    primaryExtension: null,
    effectiveIdentity: { kind: "no-primary" as const },
    presentationIdentity: { kind: "no-primary" as const },
    presentationSuggestions: [],
    ...ownership,
  };
}

/**
 * THE FIXTURE SET — one row at each ownership locus, so a change that narrowed
 * the global list by ANY locus would drop a row from the literal below.
 */
const FIXTURE_ROWS = [
  artifact("art-1", "Alpha personal", {
    ownerLevel: "user",
    ownerId: "user-1",
    organizationId: "org-a",
    projectId: null,
  }),
  artifact("art-2", "Bravo another user", {
    ownerLevel: "user",
    ownerId: "user-2",
    organizationId: "org-a",
    projectId: null,
  }),
  artifact("art-3", "Charlie organization", {
    ownerLevel: "organization",
    ownerId: "org-a",
    organizationId: "org-a",
    projectId: null,
  }),
  artifact("art-4", "Delta team", {
    ownerLevel: "team",
    ownerId: "team-a",
    organizationId: "org-a",
    projectId: null,
  }),
  artifact("art-5", "Echo project", {
    ownerLevel: "user",
    ownerId: "user-1",
    organizationId: "org-a",
    projectId: "project-a",
  }),
  artifact("art-6", "Foxtrot workspace tier", {
    ownerLevel: "workspace",
    ownerId: null,
    organizationId: null,
    projectId: null,
  }),
  artifact("art-7", "Golf malformed team", {
    ownerLevel: "team",
    ownerId: null,
    organizationId: "org-a",
    projectId: null,
  }),
  artifact("art-8", "Hotel outside org", {
    ownerLevel: "organization",
    ownerId: "org-outside",
    organizationId: "org-outside",
    projectId: null,
  }),
];

/** The row titles the global library renders, in order. */
function renderedTitles(): string[] {
  const list = document.querySelector('[data-testid="artifacts-library-list"]');
  if (!list) return [];
  return [...list.querySelectorAll("li")].map((li) => li.textContent ?? "");
}

/** `/artifacts` mounts LibraryMode with exactly these props and no others. */
async function renderGlobalLibrary(props?: { query?: string; facet?: string; scopeParam?: string }) {
  const tree = await LibraryMode({
    orgId: "org-a",
    actor: { principalId: "user-1" } as never,
    userId: "user-1",
    query: props?.query,
    facet: props?.facet,
    scopeParam: props?.scopeParam,
  });
  render(tree as ReactNode);
}

beforeEach(() => {
  store.rows = FIXTURE_ROWS;
});

afterEach(() => {
  cleanup();
  store.rows = [];
  vi.clearAllMocks();
});

describe("the global /artifacts library renders the same rows it always did", () => {
  it("lists EVERY fixture row, in the order the listing returned them", async () => {
    await renderGlobalLibrary();
    const titles = renderedTitles();
    expect(titles).toHaveLength(FIXTURE_ROWS.length);
    for (const [i, row] of FIXTURE_ROWS.entries()) {
      expect(titles[i]).toContain(row.title);
    }
  });

  it("narrows by NOTHING on its own: the malformed and out-of-scope rows are listed too", async () => {
    // The global library is the actor's whole readable set. An ownership rule
    // that leaked into it would drop exactly these two rows, so they are the
    // fixture's tripwire.
    await renderGlobalLibrary();
    const joined = renderedTitles().join("|");
    expect(joined).toContain("Golf malformed team");
    expect(joined).toContain("Hotel outside org");
  });

  it("still applies its own free-text search", async () => {
    await renderGlobalLibrary({ query: "echo" });
    expect(renderedTitles()).toHaveLength(1);
    expect(renderedTitles()[0]).toContain("Echo project");
  });

  it("still applies its own ?scope= filter", async () => {
    // `?scope=team:team-a` is the filter's OWN question — does the row's
    // footprint intersect that selection — and it is untouched by this slice.
    await renderGlobalLibrary({ scopeParam: "team:team-a" });
    const joined = renderedTitles().join("|");
    expect(joined).toContain("Delta team");
    expect(joined).not.toContain("Charlie organization");
  });

  it("renders its empty state when the listing returns nothing", async () => {
    store.rows = [];
    await renderGlobalLibrary();
    expect(document.querySelector('[data-testid="artifacts-library-list"]')).toBeNull();
  });
});
