/**
 * THE PAGE RESOLVES AT THE HEAD REVISION'S MIME (cinatra#3319, acceptance 6).
 *
 * "... identical type, identity and mime inputs resolve the same package, key
 *  and slot on both roads, the page at the latest revision and the review at
 *  its pinned revision."
 *
 * `w4-shared-display-revision-legs.test.ts` drives the review half. This file
 * drives the PAGE half through the page's own code: the artifact row's cached
 * `latestRepresentationRevisionId` names an OLDER revision whose media type
 * differs from the head the store answers, so a page that read the cached
 * pointer (or the row's own mime) would hand the shared resolver the wrong mime
 * and fail here. Asserted: the page asks the store for the head with the cached
 * pointer as its fallback, reads that head revision's version, hands the shared
 * resolver the head's mime, and builds the display props at that revision and
 * mime. A second case pins the fallback with no head at all: no version read,
 * the row's own mime, no representation in the props.
 *
 * THE RENDERING IDIOM and the seams replaced are those of
 * `artifact-page-dispatch-attribute-3319.test.tsx`: the page's authorization and
 * row reads, the store, the shared resolver (whose INPUT is the value under
 * test here) and the pack display mount (whose props are read, not drawn).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

import type { EffectiveIdentity } from "@cinatra-ai/objects/effective-identity";

const EXTENSION_IDENTITY: EffectiveIdentity = {
  kind: "extension",
  extension: "@acme/notes",
};

/** The pointer the row cached at creation: an older revision, plain text. */
const CACHED_REVISION = "rev_cached";
const CACHED_MIME = "text/plain";
/** The head the store answers: a newer revision, markdown. */
const HEAD_REVISION = "rev_head";
const HEAD_MIME = "text/markdown";

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
  getRepresentationByIdForReplay: vi.fn(() => null),
  hostArtifactContentBuilder: vi.fn(() => async () => ({ kind: "none" })),
  can: vi.fn(() => false),
  resolveArtifactDisplayMount: vi.fn(),
  isDashboardArtifactType: vi.fn(() => false),
  resolveDashboardArtifactPointer: vi.fn(),
  mountPointProps: vi.fn(),
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
vi.mock("../artifact-display-mount", () => ({
  ArtifactDisplayMountPoint: (props: unknown) => {
    mocks.mountPointProps(props);
    return <div data-testid="artifact-display-mount" />;
  },
}));
vi.mock("@/components/page-header", () => ({
  PageHeader: ({ title }: { title?: string }) => <header data-page-header={title} />,
}));

import ArtifactDetailPage from "../page";

const ARTIFACT = {
  artifactId: "a-1",
  latestRepresentationRevisionId: CACHED_REVISION,
  objectType: "acme.note",
  artifactType: "acme.note",
  title: "Quarterly notes",
  // The row's own mime is the CACHED revision's, so a page that fell back to it
  // while a head exists fails as surely as one that read the cached pointer.
  mime: CACHED_MIME,
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

const FLOOR_MOUNT = {
  dispatch: "fallback",
  kind: "floor",
  slot: "detail",
  packageName: null,
  reason: "no-display",
};

async function renderPage(): Promise<string> {
  const ui = (await ArtifactDetailPage({
    params: Promise.resolve({ id: "a-1" }),
  })) as ReactElement;
  return renderToStaticMarkup(ui);
}

/** The store's version reader: each revision answers its OWN media type. */
function versionFor(input: { representationRevisionId: string }) {
  if (input.representationRevisionId === HEAD_REVISION) return { mime: HEAD_MIME };
  if (input.representationRevisionId === CACHED_REVISION) return { mime: CACHED_MIME };
  return null;
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
  mocks.readArtifactForDetail.mockReturnValue({ kind: "ok", artifact: ARTIFACT });
  mocks.isDashboardArtifactType.mockReturnValue(false);
  mocks.resolveArtifactVersionForServe.mockImplementation(versionFor);
  mocks.getRepresentationByIdForReplay.mockReturnValue(null);
  mocks.can.mockReturnValue(false);
  mocks.resolveArtifactDisplayMount.mockResolvedValue(FLOOR_MOUNT);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe("acceptance 6 - the page resolves at the head revision the store answers", () => {
  it("hands the shared resolver the HEAD revision's mime, never the cached pointer's", async () => {
    mocks.resolveEditorRevisionId.mockResolvedValue(HEAD_REVISION);

    const html = await renderPage();
    expect(html).toContain('data-testid="artifact-display-mount"');

    // The head is asked of the store, with the row's cached pointer as fallback.
    expect(mocks.resolveEditorRevisionId).toHaveBeenCalledWith("org-1", "a-1", CACHED_REVISION);
    // The version read is the head's, and the cached revision is never read.
    expect(mocks.resolveArtifactVersionForServe).toHaveBeenCalledWith(
      expect.objectContaining({ artifactId: "a-1", representationRevisionId: HEAD_REVISION }),
    );
    expect(mocks.resolveArtifactVersionForServe).not.toHaveBeenCalledWith(
      expect.objectContaining({ representationRevisionId: CACHED_REVISION }),
    );
    // The shared resolver resolves at the head's mime ...
    expect(mocks.resolveArtifactDisplayMount).toHaveBeenCalledTimes(1);
    expect(mocks.resolveArtifactDisplayMount.mock.calls[0][0]).toMatchObject({
      orgId: "org-1",
      baseType: "acme.note",
      identity: EXTENSION_IDENTITY,
      mime: HEAD_MIME,
    });
    // ... and the display is handed props built at that revision and mime.
    expect(mocks.mountPointProps).toHaveBeenCalledTimes(1);
    const [mountProps] = mocks.mountPointProps.mock.calls[0] as [
      { props: { representation: unknown } },
    ];
    expect(mountProps.props.representation).toEqual({
      revisionId: HEAD_REVISION,
      mime: HEAD_MIME,
    });
  });

  it("with no head at all, reads no version and resolves at the row's own mime", async () => {
    // The store has no representation and the row cached none either.
    mocks.readArtifactForDetail.mockReturnValue({
      kind: "ok",
      artifact: { ...ARTIFACT, latestRepresentationRevisionId: null },
    });
    mocks.resolveEditorRevisionId.mockResolvedValue(null);

    await renderPage();

    expect(mocks.resolveEditorRevisionId).toHaveBeenCalledWith("org-1", "a-1", null);
    expect(mocks.resolveArtifactVersionForServe).not.toHaveBeenCalled();
    expect(mocks.resolveArtifactDisplayMount.mock.calls[0][0]).toMatchObject({
      mime: CACHED_MIME,
    });
    const [mountProps] = mocks.mountPointProps.mock.calls[0] as [
      { props: { representation: unknown } },
    ];
    expect(mountProps.props.representation).toBeNull();
  });
});
