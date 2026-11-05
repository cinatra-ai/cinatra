/**
 * THE ARTIFACT PAGE HANDS ITS DISPLAY THE DATA ROAD, BEHAVIOURALLY (cinatra#4311).
 *
 * The page is rendered as the server component it is, and the props snapshot it
 * hands the display mount is read off the mount itself: `props.data` is the
 * session data road. The rendering idiom and the replaced seams (authorization,
 * row reads, the mount's resolution, the pack display) are those of
 * `artifact-page-dispatch-attribute-3319.test.tsx`; the props builder and the
 * page's own call are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

import type { EffectiveIdentity } from "@cinatra-ai/objects/effective-identity";

const EXTENSION_IDENTITY: EffectiveIdentity = { kind: "extension", extension: "@acme/notes" };

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
  mounted: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: mocks.getAuthSession,
  requireActorContext: mocks.requireActorContext,
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect, notFound: mocks.notFound }));
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
// THE MOUNT RECORDS WHAT THE PAGE HANDED IT — the value under test.
vi.mock("../artifact-display-mount", () => ({
  ArtifactDisplayMountPoint: (p: Record<string, unknown>) => {
    mocks.mounted.push(p);
    return <div data-testid="artifact-display-mount" />;
  },
}));
vi.mock("@/components/page-header", () => ({
  PageHeader: ({ title }: { title?: string }) => <header data-page-header={title} />,
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

const ROAD = { road: "session", apiUrl: "/api/dashboards/cubejs-api/v1" };

async function renderPage(): Promise<string> {
  const ui = (await ArtifactDetailPage({ params: Promise.resolve({ id: "a-1" }) })) as ReactElement;
  return renderToStaticMarkup(ui);
}

beforeEach(() => {
  mocks.mounted.length = 0;
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
  mocks.resolveEditorRevisionId.mockResolvedValue(null);
  mocks.can.mockReturnValue(false);
  mocks.resolveArtifactDisplayMount.mockResolvedValue({
    dispatch: "semantic",
    kind: "build-map",
    slot: "detail",
    packageName: "@acme/notes",
    generatedKey: "k",
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("the artifact page hands its display the session data road", () => {
  it("the props the display mount receives carry data = the session road", async () => {
    const html = await renderPage();
    expect(html).toContain('data-testid="artifact-display-mount"');
    expect(mocks.mounted).toHaveLength(1);
    const props = mocks.mounted[0]?.props as { data?: unknown; propsApiVersion?: number } | undefined;
    expect(props?.propsApiVersion).toBeGreaterThanOrEqual(3);
    expect(props?.data).toEqual(ROAD);
  });

  it("the page draws no backend address of its own", async () => {
    const html = await renderPage();
    expect(html).not.toContain(ROAD.apiUrl);
  });
});
