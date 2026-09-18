/**
 * THE ARTIFACT PAGE'S PROVENANCE ATTRIBUTE REACHES THE DOCUMENT (cinatra#3319).
 *
 * The page writes `data-render-dispatch` on its CONTENT REGION so that every
 * surface — and this pull request's own proof round — can read WHICH precedence
 * rung answered for an artifact. Nothing in the tree asserted that attribute, so
 * nothing noticed that the shared `PageContent` wrapper declared only `children`
 * and `className` and dropped the attribute before React rendered the node: the
 * resolver suites beside this one drive the RESOLVER and the MOUNT and never
 * render the page's own element tree, which is exactly the seam the drop lived
 * in.
 *
 * WHAT THIS FILE DRIVES, and it is the point of it: the page's own JSX, the
 * wrapper it draws inside, and the attribute road between them. None of those
 * three is replaced here. The seams it DOES replace are the page's authorization
 * and row reads (`auth-session`, `artifact-service`, `artifact-read`,
 * `representation-store`, `review-surface-roads`, `authz/enforce`, the dashboard
 * pointer resolver), the display mount's RESOLUTION — the value under test is
 * its `dispatch` field, supplied per case — and the pack display itself
 * (`ArtifactDisplayMountPoint`), which draws the artifact and has its own
 * suites. The rendering idiom (an async server component rendered with
 * `renderToStaticMarkup`, its data seams replaced through `vi.hoisted`) is
 * copied from
 * `src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/__tests__/page.settled-gate.test.tsx`;
 * that file mocks `@/components/page-content` away, and this one must not,
 * because the wrapper is the code under test.
 *
 * THE RUNGS ARE DERIVED, NOT LISTED. `enumerateDispatchRungs` drives the pure
 * resolver `pickArtifactRenderer` over a probe matrix and collects the answers it
 * actually gives; the case table is then checked against that set in BOTH
 * directions, so a rung the resolver gains and this file has no case for fails
 * here rather than slipping past the way the drop did. The page also writes one
 * literal the resolver never produces — the dashboard-pointer arm — and that is
 * driven as its own case.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

import type { EffectiveIdentity } from "@cinatra-ai/objects/effective-identity";
import {
  pickArtifactRenderer,
  type ArtifactRenderDispatch,
} from "../renderer-dispatch";

const EXTENSION_IDENTITY: EffectiveIdentity = {
  kind: "extension",
  extension: "@acme/notes",
};
const NO_PRIMARY_IDENTITY: EffectiveIdentity = { kind: "no-primary" };

/**
 * THE RUNG SET, READ OFF THE RESOLVER'S OWN ANSWERS. Every branch of
 * `pickArtifactRenderer` is driven and the `kind` it answers is collected; the
 * result is the universe of values `mount.dispatch` can carry, derived from the
 * code rather than transcribed from it.
 */
function enumerateDispatchRungs(): ArtifactRenderDispatch["kind"][] {
  const built = { packageName: "@acme/notes", generatedKey: "k", built: true };
  const unbuilt = { ...built, built: false };
  const representation = {
    tier: "extension" as const,
    packageName: "@acme/viewer",
    generatedKey: "k2",
    pattern: "text/*",
    slot: "detail" as const,
    built: true,
  };
  const answers = [
    pickArtifactRenderer({
      identity: EXTENSION_IDENTITY,
      semantic: built,
      representation: null,
    }),
    pickArtifactRenderer({
      identity: EXTENSION_IDENTITY,
      semantic: unbuilt,
      representation: null,
    }),
    pickArtifactRenderer({
      identity: NO_PRIMARY_IDENTITY,
      semantic: null,
      representation,
    }),
    pickArtifactRenderer({
      identity: NO_PRIMARY_IDENTITY,
      semantic: null,
      representation: { ...representation, built: false },
    }),
    pickArtifactRenderer({
      identity: NO_PRIMARY_IDENTITY,
      semantic: null,
      representation: null,
    }),
  ];
  return [...new Set(answers.map((answer) => answer.kind))].sort();
}

/** The mount the page would be handed for each rung. Only `dispatch` is under
 * test; the rest is the loosest shape the mount point accepts, and the mount
 * point itself is stubbed. */
const MOUNT_FOR_RUNG: Record<string, Record<string, unknown>> = {
  semantic: {
    dispatch: "semantic",
    kind: "build-map",
    slot: "detail",
    packageName: "@acme/notes",
    generatedKey: "k",
  },
  representation: {
    dispatch: "representation",
    kind: "build-map",
    slot: "detail",
    packageName: "@acme/viewer",
    generatedKey: "k2",
  },
  "requires-rebuild": {
    dispatch: "requires-rebuild",
    kind: "floor",
    slot: "detail",
    packageName: "@acme/notes",
    reason: "requires-rebuild",
  },
  fallback: {
    dispatch: "fallback",
    kind: "floor",
    slot: "detail",
    packageName: null,
    reason: "no-display",
  },
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
  resolveArtifactVersionForServe: vi.fn(() => null),
  resolveEditorRevisionId: vi.fn(async () => null),
  getRepresentationByIdForReplay: vi.fn(() => null),
  hostArtifactContentBuilder: vi.fn(() => async () => ({ kind: "none" })),
  can: vi.fn(() => false),
  resolveArtifactDisplayMount: vi.fn(),
  isDashboardArtifactType: vi.fn(() => false),
  resolveDashboardArtifactPointer: vi.fn(async () => ({
    access: "ok",
    pointer: { artifactId: "a-1", dashboardId: "d-1", name: "A dashboard" },
  })),
}));

// ── The page's authorization and row reads ──────────────────────────────────
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

// ── The display mount's RESOLUTION and the pack display ─────────────────────
// The resolution is replaced because its `dispatch` field is the value under
// test; the mount point is replaced because it draws the ARTIFACT, which this
// file makes no claim about. Neither is the wrapper, the page's JSX, or the
// attribute road.
vi.mock("../renderer-resolution", () => ({
  resolveArtifactDisplayMount: mocks.resolveArtifactDisplayMount,
}));
vi.mock("../artifact-display-mount", () => ({
  ArtifactDisplayMountPoint: () => <div data-testid="artifact-display-mount" />,
}));
// The page header is the chrome ABOVE the content region and pulls the client
// graph (the vendored sdk-ui merge, the title-sync broadcast). It is not the
// region this file reads, and mocking it keeps the page's own composition —
// `Main`, `PageContent` and the attribute — entirely real.
vi.mock("@/components/page-header", () => ({
  PageHeader: ({ title }: { title?: string }) => (
    <header data-page-header={title} />
  ),
}));

import ArtifactDetailPage from "../page";

const ARTIFACT = {
  artifactId: "a-1",
  latestRepresentationRevisionId: null,
  objectType: "acme.note",
  artifactType: "acme.note",
  title: "Quarterly notes",
  mime: "text/markdown",
  size: 128,
  originKind: "upload",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  ownerLevel: "organization",
  visibility: "organization",
  ownerId: null,
  organizationId: "org-1",
  projectId: null,
  eligibleExtensions: [],
  primaryExtension: "@acme/notes",
  effectiveIdentity: EXTENSION_IDENTITY,
  presentationIdentity: EXTENSION_IDENTITY,
  presentationSuggestions: [],
  sourceUrl: null,
};

async function renderPage(): Promise<string> {
  const ui = (await ArtifactDetailPage({
    params: Promise.resolve({ id: "a-1" }),
  })) as ReactElement;
  return renderToStaticMarkup(ui);
}

/**
 * THE CONTENT REGION'S OWN OPENING TAG. The page draws exactly one region
 * carrying both the wrapper's max width and its own `pb-8`; the header above it
 * shares the max width, so both classes are required to name the region rather
 * than the chrome.
 */
function contentRegionTag(html: string): string | null {
  const tags = html.match(/<div[^>]*>/g) ?? [];
  const region = tags.filter(
    (tag) => tag.includes("max-w-7xl") && tag.includes("pb-8"),
  );
  expect(
    region.length,
    `expected exactly one content region in the rendered document, found ${region.length}`,
  ).toBe(1);
  return region[0] ?? null;
}

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
  mocks.readArtifactForDetail.mockReturnValue({
    kind: "ok",
    artifact: ARTIFACT,
  });
  mocks.isDashboardArtifactType.mockReturnValue(false);
  mocks.resolveEditorRevisionId.mockResolvedValue(null);
  mocks.can.mockReturnValue(false);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe("the rung universe is read off the resolver, not transcribed", () => {
  it("the case table covers every rung the resolver can answer, and no other", () => {
    const rungs = enumerateDispatchRungs();
    expect(rungs.length).toBeGreaterThan(0);
    expect(Object.keys(MOUNT_FOR_RUNG).sort()).toEqual(rungs);
  });
});

describe("the content region carries the rung that answered (cinatra#3319)", () => {
  for (const rung of enumerateDispatchRungs()) {
    it(`writes data-render-dispatch="${rung}" onto the content region`, async () => {
      const mount = MOUNT_FOR_RUNG[rung];
      expect(mount, `no case for the rung "${rung}"`).toBeDefined();
      mocks.resolveArtifactDisplayMount.mockResolvedValue(mount);

      const html = await renderPage();
      const tag = contentRegionTag(html);

      expect(
        tag,
        `content region opening tag as rendered: ${tag}`,
      ).toContain(`data-render-dispatch="${rung}"`);
      // The attribute is on the region itself, never on a node added to carry
      // it: exactly one element in the whole document has it.
      expect(html.match(/data-render-dispatch=/g) ?? []).toHaveLength(1);
      // The display still draws inside that region.
      expect(html).toContain('data-testid="artifact-display-mount"');
    });
  }
});

describe("the dashboard-pointer arm writes its own literal", () => {
  it('writes data-render-dispatch="dashboard-pointer" onto the content region', async () => {
    mocks.isDashboardArtifactType.mockReturnValue(true);

    const html = await renderPage();
    const tag = contentRegionTag(html);

    expect(
      tag,
      `content region opening tag as rendered: ${tag}`,
    ).toContain('data-render-dispatch="dashboard-pointer"');
    expect(html.match(/data-render-dispatch=/g) ?? []).toHaveLength(1);
    // The pointer arm resolves no display mount at all — its rung is the page's
    // own literal, which is why it is a case of its own here.
    expect(mocks.resolveArtifactDisplayMount).not.toHaveBeenCalled();
  });
});
