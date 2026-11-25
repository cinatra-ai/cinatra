// @vitest-environment jsdom
/**
 * THE ARTIFACT PAGE DRAWS THE REVIEW TARGET'S TWO MARKERS (cinatra#3092,
 * specs/app-artifact-review.html §XI, §XI.5, §XI.7, §XI.8).
 *
 *   "On a review target every display draws the one revision the gate pinned …
 *    the meta line names the revision with its pinned marker"
 *   "The host draws only Continued / Decided on the revision above. beneath the
 *    whole display."
 *
 * The page is rendered as the server component it is and read as a DOM. The
 * seams are those of `core-data-road-artifact-page.test.tsx`; the store reads
 * are the mocked leaf, so the page's own reading of them runs for real, and the
 * settled marker is the review card's real component.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";

import type { EffectiveIdentity } from "@cinatra-ai/objects/effective-identity";

const EXTENSION_IDENTITY: EffectiveIdentity = { kind: "extension", extension: "@acme/notes" };

type RevisionReview =
  | { status: "none" }
  | { status: "open" }
  | { status: "settled"; disposition: string | null; decidedAt: string | null };

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
  resolveArtifactVersionForServe: vi.fn(() => null as { mime: string; sizeBytes: number } | null),
  resolveNonFileArtifactRevision: vi.fn(() => null as { mime: string } | null),
  resolveEditorRevisionId: vi.fn(async (): Promise<string | null> => null),
  getRepresentationByIdForReplay: vi.fn(() => null),
  hostArtifactContentBuilder: vi.fn(() => async () => ({ kind: "none" })),
  can: vi.fn(() => false),
  resolveArtifactDisplayMount: vi.fn(),
  isDashboardArtifactType: vi.fn((): boolean => false),
  mounted: [] as Array<Record<string, unknown>>,
  isArtifactUnderOpenReview: vi.fn(async (): Promise<boolean> => false),
  readArtifactRevisionReview: vi.fn(async (): Promise<RevisionReview> => ({ status: "none" })),
}));

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: mocks.getAuthSession,
  requireActorContext: mocks.requireActorContext,
}));
vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
  notFound: mocks.notFound,
  useRouter: () => ({ refresh: () => {} }),
}));
vi.mock("@/lib/artifacts/artifact-service", () => ({
  readArtifactForDetail: mocks.readArtifactForDetail,
}));
vi.mock("@/lib/artifacts/artifact-read", () => ({
  resolveArtifactVersionForServe: mocks.resolveArtifactVersionForServe,
  resolveNonFileArtifactRevision: mocks.resolveNonFileArtifactRevision,
}));
vi.mock("@/lib/artifacts/representation-store", () => ({
  resolveEditorRevisionId: mocks.resolveEditorRevisionId,
  getRepresentationByIdForReplay: mocks.getRepresentationByIdForReplay,
}));
vi.mock("../review-surface-roads", () => ({
  hostArtifactContentBuilder: mocks.hostArtifactContentBuilder,
}));
vi.mock("@/lib/authz/enforce", () => ({ can: mocks.can }));
vi.mock("@/lib/owner-display-names", () => ({ readOwnerDisplayName: async () => "Growth" }));
vi.mock("@cinatra-ai/agents/artifact-open-review-read", () => ({
  isArtifactUnderOpenReview: mocks.isArtifactUnderOpenReview,
  readArtifactRevisionReview: mocks.readArtifactRevisionReview,
}));
vi.mock("@/lib/dashboards/dashboard-artifact-surface", () => ({
  isDashboardArtifactType: mocks.isDashboardArtifactType,
  DASHBOARD_ARTIFACT_OBJECT_TYPE: "@cinatra-ai/dashboard-artifact:dashboard",
}));
vi.mock("../renderer-resolution", () => ({
  resolveArtifactDisplayMount: mocks.resolveArtifactDisplayMount,
}));
// THE MOUNT STANDS IN FOR A PACK'S DISPLAY: it draws what the dashboard and
// page displays draw for a continued reading (their reading anchor, and no
// settled marker of their own), so the one-marker rule is read off the page.
vi.mock("../artifact-display-mount", () => ({
  ArtifactDisplayMountPoint: (p: { props?: { review?: { reading?: string } } }) => {
    mocks.mounted.push(p as Record<string, unknown>);
    return (
      <div data-testid="artifact-display-mount">
        {p.props?.review?.reading === "continued" ? (
          <p data-conformance-id="dashboard-continued-reading" data-field="reading=review.reading" />
        ) : null}
      </div>
    );
  },
}));
vi.mock("@/components/page-header", () => ({
  PageHeader: ({ title, meta }: { title?: string; meta?: ReactNode }) => (
    <header data-page-header={title}>
      <p data-testid="artifact-meta-line">{meta}</p>
    </header>
  ),
}));

import ArtifactDetailPage from "../page";

const REVISION = "rev_2e77c410";
const DECIDED_AT = "2026-11-25T09:20:00.000Z";

const ARTIFACT = {
  artifactId: "a-1",
  latestRepresentationRevisionId: REVISION,
  objectType: "@acme/notes:note",
  artifactType: "@acme/notes:note",
  title: "Quarterly notes",
  mime: "text/markdown",
  size: 128,
  originKind: "upload",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  ownerLevel: "team",
  visibility: "private",
  ownerId: "team-1",
  organizationId: "org-1",
  projectId: null,
  eligibleExtensions: [],
  primaryExtension: "@acme/notes",
  effectiveIdentity: EXTENSION_IDENTITY,
  presentationIdentity: EXTENSION_IDENTITY,
  presentationSuggestions: [],
  sourceUrl: null,
};

async function renderPage(): Promise<HTMLElement> {
  const ui = (await ArtifactDetailPage({ params: Promise.resolve({ id: "a-1" }) })) as ReactElement;
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(ui);
  return container;
}

function metaLine(root: HTMLElement): HTMLElement {
  const line = root.querySelector<HTMLElement>('[data-testid="artifact-meta-line"]');
  if (!line) throw new Error("no meta line drawn");
  return line;
}

function pinnedMarker(root: HTMLElement): HTMLElement | null {
  return metaLine(root).querySelector<HTMLElement>("[data-artifact-meta-pinned]");
}

function settledMarkers(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-conformance-id="review-gate-settled"]'));
}

function handedReview(): unknown {
  return (mocks.mounted[0]?.props as { review?: unknown } | undefined)?.review;
}

function openReview(): void {
  mocks.isArtifactUnderOpenReview.mockResolvedValue(true);
  mocks.readArtifactRevisionReview.mockResolvedValue({ status: "open" });
}

function settledReview(disposition: string, decidedAt: string | null): void {
  mocks.isArtifactUnderOpenReview.mockResolvedValue(false);
  mocks.readArtifactRevisionReview.mockResolvedValue({ status: "settled", disposition, decidedAt });
}

beforeEach(() => {
  mocks.mounted.length = 0;
  mocks.isArtifactUnderOpenReview.mockReset();
  mocks.isArtifactUnderOpenReview.mockResolvedValue(false);
  mocks.readArtifactRevisionReview.mockReset();
  mocks.readArtifactRevisionReview.mockResolvedValue({ status: "none" });
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
  mocks.resolveEditorRevisionId.mockResolvedValue(REVISION);
  mocks.resolveArtifactVersionForServe.mockReturnValue({ mime: "text/markdown", sizeBytes: 128 });
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

describe("the revision shown is asked about as a review target", () => {
  it("asks about exactly the revision the page shows, in the reader's organization", async () => {
    await renderPage();
    expect(mocks.readArtifactRevisionReview).toHaveBeenCalledWith({
      orgId: "org-1",
      artifactId: "a-1",
      representationRevisionId: REVISION,
    });
  });

  it("a row the reader may not read is never asked about", async () => {
    mocks.readArtifactForDetail.mockReturnValue({ kind: "denied" });
    await renderPage();
    expect(mocks.readArtifactRevisionReview).not.toHaveBeenCalled();
  });

  it("a page with no revision asks nothing and draws neither marker", async () => {
    mocks.resolveEditorRevisionId.mockResolvedValue(null);
    mocks.readArtifactForDetail.mockReturnValue({
      kind: "ok",
      artifact: { ...ARTIFACT, latestRepresentationRevisionId: null },
    });
    const root = await renderPage();
    expect(mocks.readArtifactRevisionReview).not.toHaveBeenCalled();
    expect(pinnedMarker(root)).toBeNull();
    expect(settledMarkers(root)).toHaveLength(0);
  });
});

describe("while the review is open: pinned, and no settled marker", () => {
  it("names the revision with its pinned marker, right after the revision", async () => {
    openReview();
    const root = await renderPage();
    expect(metaLine(root).textContent?.startsWith(
      "@acme/notes:note · revision rev_2e77… · pinned · Team: Growth · Private · text/markdown · updated ",
    )).toBe(true);
    const pinned = pinnedMarker(root);
    expect(pinned?.textContent).toBe(" · pinned");
    expect(pinned?.classList.contains("text-mustard-ink")).toBe(true);
  });

  it("draws no settled marker and hands the pending reading", async () => {
    openReview();
    const root = await renderPage();
    expect(settledMarkers(root)).toHaveLength(0);
    expect(root.textContent).not.toContain("Decided on the revision above.");
    expect(handedReview()).toEqual({ reading: "pending", openLive: null });
  });
});

describe("once the review is settled: pinned, and one Continued marker below the whole display", () => {
  it("draws the pinned marker and the review card's settled marker, once, after the display", async () => {
    settledReview("approve", DECIDED_AT);
    const root = await renderPage();
    expect(pinnedMarker(root)?.textContent).toBe(" · pinned");
    const markers = settledMarkers(root);
    expect(markers).toHaveLength(1);
    const marker = markers[0]!;
    expect(
      marker.querySelector('[data-conformance-id="review-gate-settled-pill"]')?.textContent,
    ).toBe("Continued");
    expect(
      marker.querySelector('[data-conformance-id="review-gate-settled-sentence"]')?.textContent,
    ).toBe("Decided on the revision above.");
    expect(marker.getAttribute("data-review-outcome")).toBe("approved");
    const display = root.querySelector('[data-testid="artifact-display-mount"]');
    expect(display).not.toBeNull();
    // Beneath the display, and never inside it.
    expect(display!.contains(marker)).toBe(false);
    expect(display!.compareDocumentPosition(marker) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("hands a person's approval to the display as the continued reading, with its time", async () => {
    settledReview("approve", DECIDED_AT);
    await renderPage();
    expect(handedReview()).toEqual({ reading: "continued", openLive: null, decidedAt: DECIDED_AT });
  });

  it("a turned-back review draws the same one marker and hands no continued reading", async () => {
    settledReview("reject", DECIDED_AT);
    const root = await renderPage();
    expect(pinnedMarker(root)?.textContent).toBe(" · pinned");
    expect(settledMarkers(root)).toHaveLength(1);
    expect(mocks.mounted[0]?.props).not.toHaveProperty("review");
  });

  it("an approval no person made draws the marker and hands no continued reading", async () => {
    settledReview("approve", null);
    const root = await renderPage();
    expect(settledMarkers(root)).toHaveLength(1);
    expect(mocks.mounted[0]?.props).not.toHaveProperty("review");
  });

  it("a disposition this build cannot read stays pinned and draws no marker", async () => {
    settledReview("something-new", DECIDED_AT);
    const root = await renderPage();
    expect(pinnedMarker(root)?.textContent).toBe(" · pinned");
    expect(settledMarkers(root)).toHaveLength(0);
  });
});

describe("a revision no gate pinned, and an artifact never reviewed, draw neither", () => {
  it("another revision of a reviewed artifact: no pinned, no marker, the open reading kept", async () => {
    mocks.isArtifactUnderOpenReview.mockResolvedValue(true);
    mocks.readArtifactRevisionReview.mockResolvedValue({ status: "none" });
    const root = await renderPage();
    expect(pinnedMarker(root)).toBeNull();
    expect(metaLine(root).textContent).not.toContain("pinned");
    expect(settledMarkers(root)).toHaveLength(0);
    expect(handedReview()).toEqual({ reading: "pending", openLive: null });
  });

  it("never reviewed: the plain line, no marker, no reading", async () => {
    const root = await renderPage();
    expect(pinnedMarker(root)).toBeNull();
    expect(metaLine(root).textContent?.startsWith(
      "@acme/notes:note · revision rev_2e77… · Team: Growth · Private · text/markdown · updated ",
    )).toBe(true);
    expect(settledMarkers(root)).toHaveLength(0);
    expect(mocks.mounted[0]?.props).not.toHaveProperty("review");
  });

  it("a read that fails draws neither marker, warns once in fixed words, and the page still draws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.readArtifactRevisionReview.mockRejectedValue(new Error("Failed query: secret params"));
    const root = await renderPage();
    expect(pinnedMarker(root)).toBeNull();
    expect(settledMarkers(root)).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[artifact-page] the revision review read failed; drawing no review marker",
    );
    expect(root.querySelector('[data-testid="artifact-display-mount"]')).not.toBeNull();
    warn.mockRestore();
  });
});

describe("a dashboard: exactly one settled marker, the host's (§XI.5)", () => {
  it("the display draws its own continued reading and the host draws the one marker", async () => {
    mocks.readArtifactForDetail.mockReturnValue({
      kind: "ok",
      artifact: {
        ...ARTIFACT,
        objectType: "@cinatra-ai/dashboard-artifact:dashboard",
        artifactType: "@cinatra-ai/dashboard-artifact:dashboard",
      },
    });
    mocks.resolveArtifactVersionForServe.mockReturnValue(null);
    mocks.resolveNonFileArtifactRevision.mockReturnValue({ mime: "application/vnd.cinatra.dashboard+json" });
    settledReview("approve", DECIDED_AT);
    const root = await renderPage();
    expect(pinnedMarker(root)?.textContent).toBe(" · pinned");
    expect(root.querySelectorAll('[data-conformance-id="dashboard-continued-reading"]')).toHaveLength(1);
    expect(settledMarkers(root)).toHaveLength(1);
    expect(root.textContent?.split("Decided on the revision above.")).toHaveLength(2);
  });
});
