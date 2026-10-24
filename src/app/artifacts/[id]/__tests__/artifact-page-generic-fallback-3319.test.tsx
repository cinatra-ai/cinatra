/**
 * THE ARTIFACT PAGE'S GENERIC FALLBACK DRAWS THE WORK (cinatra#3319).
 *
 * `specs/app-artifacts.html` §III, the third dispatch case: "Generic fallback —
 * anything whose type ships no renderer and has no MIME handler falls back to a
 * read-only structured-data (JSON) view plus metadata. There is always a
 * renderer; the fallback is never a blank." The page's terminal floor drew a
 * host advisory alert instead — a warning glyph and two sentences drawn in no
 * spec — and nothing of the row, which is what the second picture round graded
 * on both palettes of its artifact-page cell.
 *
 * WHAT THIS FILE DRIVES: the page's own floor road — the node it builds for the
 * mount, the terminal arm and the degraded arm — and the view that node is. None
 * of those is replaced here. THE SEAMS IT REPLACES are the page's authorization
 * and row reads (`auth-session`, `artifact-service`, `artifact-read`,
 * `representation-store`, `review-surface-roads`, `authz/enforce`, the dashboard
 * surface and pointer resolvers) and the display mount's RESOLUTION, whose
 * answer is the case under test; the page header is replaced for the same reason
 * the sibling file replaces it — it is the chrome above the content region and
 * pulls the client graph.
 *
 * THE RENDERING IDIOM is this pull request's own
 * `artifact-page-dispatch-attribute-3319.test.tsx`: the async server component
 * is awaited and its element tree rendered to markup, with its data seams
 * replaced through `vi.hoisted`. ONE THING DIFFERS, deliberately: that file
 * stubs `ArtifactDisplayMountPoint` because it makes no claim about what draws
 * the artifact, and this file must NOT, because the mount's floor road is
 * exactly the code under test. The real mount is an async component, so the tree
 * is rendered through the streaming server renderer, which resolves it, rather
 * than through `renderToStaticMarkup`, which cannot.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToReadableStream } from "react-dom/server";
import type { ReactElement } from "react";

import type { EffectiveIdentity } from "@cinatra-ai/objects/effective-identity";

const EXTENSION_IDENTITY: EffectiveIdentity = {
  kind: "extension",
  extension: "@acme/notes",
};

/** The row's own authorized representation — an object-backed projection whose
 *  values are distinctive enough that finding them in the document proves the
 *  view drew THIS row's work and not a placeholder. */
const CONTENT = {
  kind: "object" as const,
  channelVersion: 1,
  source: "snapshot" as const,
  representationRevisionId: "rev-1",
  objectType: "@acme/support:case",
  data: { subject: "Login loop on SSO", priority: "high", open: true },
  digest: "d".repeat(64),
  byteLength: 64,
  projectedByteLength: 64,
  cap: 256 * 1024,
};

const mocks = vi.hoisted(() => ({
  getAuthSession: vi.fn(),
  requireActorContext: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  }),
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
  readArtifactForDetail: vi.fn(),
  resolveArtifactVersionForServe: vi.fn(),
  resolveEditorRevisionId: vi.fn(),
  getRepresentationByIdForReplay: vi.fn(),
  hostArtifactContentBuilder: vi.fn(),
  can: vi.fn(() => false),
  resolveArtifactDisplayMount: vi.fn(),
  isDashboardArtifactType: vi.fn(() => false),
  resolveDashboardArtifactPointer: vi.fn(async () => ({
    access: "ok",
    pointer: { artifactId: "a-1", dashboardId: "d-1", name: "A dashboard" },
  })),
}));

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: mocks.getAuthSession,
  requireActorContext: mocks.requireActorContext,
}));
vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
  notFound: mocks.notFound,
}));
vi.mock("@/lib/artifacts/artifact-service", () => ({
  readArtifactForDetail: mocks.readArtifactForDetail,
}));
vi.mock("@/lib/artifacts/artifact-read", () => ({
  resolveArtifactVersionForServe: mocks.resolveArtifactVersionForServe,
}));
vi.mock("@/lib/artifacts/representation-store", () => ({
  resolveEditorRevisionId: mocks.resolveEditorRevisionId,
  getRepresentationByIdForReplay: mocks.getRepresentationByIdForReplay,
}));
vi.mock("../review-surface-roads", () => ({
  hostArtifactContentBuilder: mocks.hostArtifactContentBuilder,
}));
vi.mock("@/lib/authz/enforce", () => ({ can: mocks.can }));
vi.mock("@/lib/dashboards/dashboard-artifact-surface", () => ({
  isDashboardArtifactType: mocks.isDashboardArtifactType,
}));
vi.mock("@/lib/dashboards/dashboard-artifact-pointer-resolvers", () => ({
  resolveDashboardArtifactPointer: mocks.resolveDashboardArtifactPointer,
}));
vi.mock("../renderer-resolution", () => ({
  resolveArtifactDisplayMount: mocks.resolveArtifactDisplayMount,
}));
vi.mock("@/components/page-header", () => ({
  PageHeader: ({ title }: { title?: string }) => <header data-page-header={title} />,
}));

import ArtifactDetailPage from "../page";

const ARTIFACT = {
  artifactId: "a-1",
  latestRepresentationRevisionId: "rev-1",
  objectType: "@acme/support:case",
  artifactType: "@acme/support:case",
  title: "Login loop on SSO",
  mime: "application/vnd.acme.case+json",
  size: 412,
  originKind: "upload",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
  ownerLevel: "organization",
  visibility: "organization",
  ownerId: null,
  organizationId: "org-1",
  projectId: null,
  eligibleExtensions: [],
  primaryExtension: "@acme/support",
  effectiveIdentity: EXTENSION_IDENTITY,
  presentationIdentity: EXTENSION_IDENTITY,
  presentationSuggestions: [],
  sourceUrl: null,
};

/** The terminal floor: nothing installed draws this row at all. */
const TERMINAL_FLOOR = {
  kind: "floor" as const,
  slot: "detail" as const,
  dispatch: "fallback" as const,
  packageName: null,
  reason: "no-display" as const,
};

/** The degraded arm: a claimant this build does not carry. */
const REBUILD_FLOOR = {
  kind: "floor" as const,
  slot: "detail" as const,
  dispatch: "requires-rebuild" as const,
  packageName: "@acme/support",
  reason: "requires-rebuild" as const,
};

/** The page's tree, rendered through the STREAMING server renderer because the
 *  display mount under test is an async server component. */
async function renderPage(): Promise<string> {
  const ui = (await ArtifactDetailPage({
    params: Promise.resolve({ id: "a-1" }),
  })) as ReactElement;
  const stream = await renderToReadableStream(ui);
  return await new Response(stream).text();
}

/** The content region's own opening tag — the same reading the sibling dispatch
 *  file takes: the one element carrying both the wrapper's max width and the
 *  page's own `pb-8`. */
function contentRegionAt(html: string): number {
  const tags = html.match(/<div[^>]*>/g) ?? [];
  const region = tags.filter(
    (tag) => tag.includes("max-w-7xl") && tag.includes("pb-8"),
  );
  expect(
    region.length,
    `expected exactly one content region in the rendered document, found ${region.length}`,
  ).toBe(1);
  return html.indexOf(region[0] ?? "");
}

const VIEW = 'data-conformance-id="artifact-render-fallback"';

beforeEach(() => {
  mocks.getAuthSession.mockResolvedValue({
    user: { id: "u-1" },
    session: { activeOrganizationId: "org-1" },
  });
  mocks.requireActorContext.mockResolvedValue({
    actorType: "human",
    userId: "u-1",
    organizationId: "org-1",
  });
  mocks.readArtifactForDetail.mockReturnValue({ kind: "ok", artifact: ARTIFACT });
  mocks.isDashboardArtifactType.mockReturnValue(false);
  mocks.resolveEditorRevisionId.mockResolvedValue("rev-1");
  mocks.getRepresentationByIdForReplay.mockReturnValue({ form: "object" });
  mocks.resolveArtifactVersionForServe.mockReturnValue({
    mime: "application/vnd.acme.case+json",
  });
  mocks.hostArtifactContentBuilder.mockReturnValue(async () => CONTENT);
  mocks.can.mockReturnValue(false);
  mocks.resolveArtifactDisplayMount.mockResolvedValue(TERMINAL_FLOOR);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe("a row nothing installed can draw still shows its work (cinatra#3319)", () => {
  it("the terminal floor draws the structured-data view of the row's own representation", async () => {
    const html = await renderPage();
    const regionAt = contentRegionAt(html);

    expect(html, "the drawn document").toContain(VIEW);
    expect(html.indexOf(VIEW)).toBeGreaterThan(regionAt);
    // The header strip §III draws: the row's TYPE ID beside the mono label.
    expect(html).toContain("@acme/support:case");
    expect(html).toContain("structured data");
    // The projection's OWN values, read out of the rendered markup — the view
    // drew this row's authorized representation, not a placeholder.
    expect(html).toContain("Login loop on SSO");
    expect(html).toContain("priority");
    expect(html).toContain("high");
  });

  it("the same view carries the row's metadata", async () => {
    const html = await renderPage();
    const viewAt = html.indexOf(VIEW);
    expect(viewAt, "the structured-data view is in the document").toBeGreaterThan(-1);
    const view = html.slice(viewAt);

    for (const field of [
      "Login loop on SSO",
      "@acme/support:case",
      "application/vnd.acme.case+json",
      "412",
      "organization",
      "2026-09-01T00:00:00.000Z",
      "2026-09-02T00:00:00.000Z",
    ]) {
      expect(view, `metadata field ${field} as drawn`).toContain(field);
    }
  });

  it("the retired notice's unspecified sentences are drawn nowhere", async () => {
    const html = await renderPage();
    // Neither sentence appears in any drawing at the design head this leg was
    // built to, so neither may appear on a surface this pull request owns.
    expect(html).not.toContain("No display is installed for this kind of work");
    expect(html).not.toContain("Nothing installed here can draw this artifact");
  });

  it("the rebuild arm draws its diagnostic ABOVE the same view", async () => {
    mocks.resolveArtifactDisplayMount.mockResolvedValue(REBUILD_FLOOR);

    const html = await renderPage();
    const viewAt = html.indexOf(VIEW);
    expect(viewAt, "the structured-data view is in the document").toBeGreaterThan(-1);
    // The degraded notice names the claimant this build does not carry, and it
    // sits above the view rather than replacing it.
    const noticeAt = html.indexOf("@acme/support");
    expect(noticeAt).toBeGreaterThan(-1);
    expect(noticeAt).toBeLessThan(viewAt);
    expect(html).toContain("Login loop on SSO");
  });
});
