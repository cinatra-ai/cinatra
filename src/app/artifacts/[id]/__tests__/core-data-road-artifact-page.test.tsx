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
import type { ReactElement, ReactNode } from "react";

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
  resolveArtifactVersionForServe: vi.fn(() => null as { mime: string; sizeBytes: number } | null),
  resolveNonFileArtifactRevision: vi.fn(() => null as { mime: string } | null),
  resolveEditorRevisionId: vi.fn(async (): Promise<string | null> => null),
  getRepresentationByIdForReplay: vi.fn(() => null),
  hostArtifactContentBuilder: vi.fn(() => async () => ({ kind: "none" })),
  can: vi.fn(() => false),
  resolveArtifactDisplayMount: vi.fn(),
  isDashboardArtifactType: vi.fn((_objectType: string | null | undefined): boolean => false),
  resolveDashboardArtifactPointer: vi.fn(async (_artifactId: string): Promise<{ access?: unknown; pointer?: unknown }> => ({
    access: "ok",
    pointer: { dashboardId: "d-1", name: "A dashboard" },
  })),
  mounted: [] as Array<Record<string, unknown>>,
  isArtifactUnderOpenReview: vi.fn(async () => false),
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
// The store read is the seam, so the page's own fail-closed reading runs for real.
vi.mock("@cinatra-ai/agents/artifact-open-review-read", () => ({
  isArtifactUnderOpenReview: mocks.isArtifactUnderOpenReview,
}));
vi.mock("@/lib/dashboards/dashboard-artifact-surface", () => ({
  isDashboardArtifactType: mocks.isDashboardArtifactType,
  // Read by the pointer frame's meta line.
  DASHBOARD_ARTIFACT_OBJECT_TYPE: "@cinatra-ai/dashboard-artifact:dashboard",
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
// The header draws its title and its actions, so the header's own links are read.
vi.mock("@/components/page-header", () => ({
  PageHeader: ({ title, actions }: { title?: string; actions?: ReactNode }) => (
    <header data-page-header={title}>{actions}</header>
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

const ROAD = { road: "session", apiUrl: "/api/dashboards/cubejs-api/v1" };

async function renderPage(): Promise<string> {
  const ui = (await ArtifactDetailPage({ params: Promise.resolve({ id: "a-1" }) })) as ReactElement;
  return renderToStaticMarkup(ui);
}

beforeEach(() => {
  mocks.mounted.length = 0;
  mocks.isArtifactUnderOpenReview.mockReset();
  mocks.isArtifactUnderOpenReview.mockResolvedValue(false);
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

describe("the head revision the artifact page opens on (cinatra#3092)", () => {
  const DASHBOARD_MIME = "application/vnd.cinatra.dashboard+json";

  function mountedProps() {
    return mocks.mounted[0]?.props as {
      representation?: unknown;
      bytes?: { preview: string | null; download: string | null };
    };
  }

  it("a head revision that is not a file hands its recorded mime and no byte address", async () => {
    mocks.resolveEditorRevisionId.mockResolvedValue("rev-1");
    mocks.resolveNonFileArtifactRevision.mockReturnValueOnce({ mime: DASHBOARD_MIME });
    await renderPage();
    expect(mountedProps().representation).toEqual({ revisionId: "rev-1", mime: DASHBOARD_MIME });
    expect(mountedProps().bytes).toBeUndefined();
  });

  it("a file head revision keeps its byte addresses and never asks the non-file reader", async () => {
    mocks.resolveEditorRevisionId.mockResolvedValue("rev-1");
    mocks.resolveArtifactVersionForServe.mockReturnValueOnce({ mime: "text/markdown", sizeBytes: 128 });
    await renderPage();
    expect(mocks.resolveNonFileArtifactRevision).not.toHaveBeenCalled();
    expect(mountedProps().representation).toEqual({ revisionId: "rev-1", mime: "text/markdown" });
    expect(mountedProps().bytes?.preview).toBe("/api/artifacts/a-1/versions/rev-1/preview");
    expect(mountedProps().bytes?.download).toBe("/api/artifacts/a-1/versions/rev-1/content");
  });
});

describe("the artifact page's review reading (cinatra#3092)", () => {
  function handedReview(): unknown {
    return (mocks.mounted[0]?.props as { review?: unknown } | undefined)?.review;
  }

  it("asks about this artifact in the reader's organization", async () => {
    await renderPage();
    expect(mocks.isArtifactUnderOpenReview).toHaveBeenCalledWith({ orgId: "org-1", artifactId: "a-1" });
  });

  it("an open gate hands the pending reading with no live address", async () => {
    mocks.isArtifactUnderOpenReview.mockResolvedValue(true);
    mocks.readArtifactForDetail.mockReturnValue({
      kind: "ok",
      artifact: { ...ARTIFACT, sourceUrl: "https://dash.example/live" },
    });
    await renderPage();
    expect(handedReview()).toEqual({ reading: "pending", openLive: null });
  });

  it("no open gate hands no reading", async () => {
    await renderPage();
    expect(mocks.mounted[0]?.props).toBeDefined();
    expect(mocks.mounted[0]?.props).not.toHaveProperty("review");
  });

  it("a read that fails hands the pending reading and the page still draws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.isArtifactUnderOpenReview.mockRejectedValue(new Error("the read failed"));
    await renderPage();
    expect(handedReview()).toEqual({ reading: "pending", openLive: null });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("a row the reader may not read is never asked about", async () => {
    mocks.readArtifactForDetail.mockReturnValue({ kind: "denied" });
    await renderPage();
    expect(mocks.mounted).toHaveLength(0);
    expect(mocks.isArtifactUnderOpenReview).not.toHaveBeenCalled();
  });

  it("a row that is not found is never asked about", async () => {
    mocks.readArtifactForDetail.mockReturnValue({ kind: "not-found" });
    await expect(renderPage()).rejects.toThrow("NOT_FOUND");
    expect(mocks.isArtifactUnderOpenReview).not.toHaveBeenCalled();
  });
});

describe("the open review read's warning carries nothing of the error (cinatra#3092)", () => {
  // The whole warning, one argument: a fixed text, never the message, the class
  // name or any other value of what was thrown.
  const WARNING = ["[artifact-page] the open review read failed; drawing the pending reading"];
  const PENDING = { reading: "pending", openLive: null };
  function handedReview(): unknown {
    return (mocks.mounted[0]?.props as { review?: unknown } | undefined)?.review;
  }

  it("logs the fixed text only, never a driver message with its parameters", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.isArtifactUnderOpenReview.mockRejectedValue(
      new Error('Failed query: select "id" from "artifact_review_gates" where ... params: org-1,pending,[{"artifactId":"a-1"}]'),
    );
    await renderPage();
    expect(warn.mock.calls).toEqual([WARNING]);
    warn.mockRestore();
  });

  it("logs the fixed text only when the read throws something that is not an Error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.isArtifactUnderOpenReview.mockRejectedValue("org-1 params a-1");
    await renderPage();
    expect(warn.mock.calls).toEqual([WARNING]);
    expect(handedReview()).toEqual(PENDING);
    warn.mockRestore();
  });

  it("never logs a class name, whatever its shape", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const named = (name: string) => {
      const C = class extends Error {};
      Object.defineProperty(C, "name", { value: name });
      return new C("x");
    };
    for (const name of ["Error", "org-1 a-1", "a".repeat(65), "1Error", "", "A".repeat(64), "sk_PRIVATE_ABC123"]) {
      warn.mockClear();
      mocks.isArtifactUnderOpenReview.mockRejectedValueOnce(named(name));
      await renderPage();
      expect(warn.mock.calls, name).toEqual([WARNING]);
    }
    warn.mockRestore();
  });

  it("never logs a value an Error's own constructor carries", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = new Error("x");
    Object.defineProperty(err, "constructor", { value: { name: "sk_PRIVATE_ABC123" } });
    mocks.isArtifactUnderOpenReview.mockRejectedValue(err);
    await renderPage();
    expect(warn.mock.calls).toEqual([WARNING]);
    expect(handedReview()).toEqual(PENDING);
    warn.mockRestore();
  });

  it("still hands the pending reading when the Error's constructor getter throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = new Error("x");
    Object.defineProperty(err, "constructor", {
      get() {
        throw new Error("constructor getter");
      },
    });
    mocks.isArtifactUnderOpenReview.mockRejectedValue(err);
    await renderPage();
    expect(handedReview()).toEqual(PENDING);
    expect(warn.mock.calls).toEqual([WARNING]);
    warn.mockRestore();
  });

  it("still hands the pending reading when the thrown value is a proxy whose every trap throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const trap = () => {
      throw new Error("trap");
    };
    const hostile = new Proxy(new Error("x"), { get: trap, getPrototypeOf: trap, has: trap, ownKeys: trap });
    mocks.isArtifactUnderOpenReview.mockRejectedValue(hostile);
    await renderPage();
    expect(handedReview()).toEqual(PENDING);
    expect(warn.mock.calls).toEqual([WARNING]);
    warn.mockRestore();
  });

  it("still hands the pending reading when the log itself throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("log sink down");
    });
    mocks.isArtifactUnderOpenReview.mockRejectedValue(new Error("the read failed"));
    await renderPage();
    expect(handedReview()).toEqual(PENDING);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("the dashboard's own read gate on the artifact page (cinatra#3092)", () => {
  const DASHBOARD_TYPE = "@cinatra-ai/dashboard-artifact:dashboard";
  function dashboardRow(): void {
    mocks.readArtifactForDetail.mockReturnValue({
      kind: "ok",
      artifact: { ...ARTIFACT, objectType: DASHBOARD_TYPE, artifactType: DASHBOARD_TYPE },
    });
    mocks.isDashboardArtifactType.mockImplementation((t) => t === DASHBOARD_TYPE);
  }
  beforeEach(() => {
    mocks.resolveDashboardArtifactPointer.mockReset();
  });

  it("a reader the dashboard's grant refuses is denied: nothing is mounted and no review is read", async () => {
    dashboardRow();
    mocks.resolveDashboardArtifactPointer.mockResolvedValue({ access: "denied" });
    await renderPage();
    expect(mocks.resolveDashboardArtifactPointer).toHaveBeenCalledWith("a-1");
    expect(mocks.mounted).toHaveLength(0);
    expect(mocks.isArtifactUnderOpenReview).not.toHaveBeenCalled();
  });

  it("a dashboard the gate does not find (a template, an orphaned or archived dashboard) is not found", async () => {
    dashboardRow();
    mocks.resolveDashboardArtifactPointer.mockResolvedValue({ access: "not-found" });
    await expect(renderPage()).rejects.toThrow("NOT_FOUND");
    expect(mocks.mounted).toHaveLength(0);
    expect(mocks.isArtifactUnderOpenReview).not.toHaveBeenCalled();
  });

  it("a gate that cannot be read throws, so no artifact display is drawn", async () => {
    dashboardRow();
    mocks.resolveDashboardArtifactPointer.mockRejectedValue(new Error("store down"));
    await expect(renderPage()).rejects.toThrow("store down");
    expect(mocks.mounted).toHaveLength(0);
  });

  it.each([
    ["an unknown access word", { access: "timeout" }],
    ["no access", { access: undefined }],
    ["ok without a pointer", { access: "ok" }],
  ])("a gate that answers %s throws: nothing is mounted and no review is read", async (_label, answer) => {
    dashboardRow();
    mocks.resolveDashboardArtifactPointer.mockResolvedValue(answer);
    await expect(renderPage()).rejects.toThrow("the dashboard read gate answered no known access");
    expect(mocks.mounted).toHaveLength(0);
    expect(mocks.isArtifactUnderOpenReview).not.toHaveBeenCalled();
    expect(mocks.resolveArtifactDisplayMount).not.toHaveBeenCalled();
  });

  const POINTER = {
    dashboardId: "a-1",
    name: "A dashboard",
    ownerLevel: "team",
    projectId: null,
    updatedAt: null,
    canonicalHref: "/dashboards/a-1",
    scopeChips: [],
  };

  it("a dashboard the gate admits and an installed display claims draws through that display, not the pointer", async () => {
    dashboardRow();
    mocks.resolveDashboardArtifactPointer.mockResolvedValue({ access: "ok", pointer: POINTER });
    const html = await renderPage();
    expect(mocks.resolveArtifactDisplayMount).toHaveBeenCalledTimes(1);
    expect(mocks.mounted).toHaveLength(1);
    expect(html).not.toContain('data-testid="artifact-dashboard-pointer"');
    expect(html).not.toContain('data-render-dispatch="dashboard-pointer"');
  });

  // cinatra#4311: where the dispatch answers a floor for an admitted dashboard,
  // whatever the floor's reason, the page keeps the pointer, so the dashboard
  // keeps its Open dashboard affordance.
  it("a dashboard the gate admits and no installed display claims keeps its pointer, never the generic floor", async () => {
    dashboardRow();
    mocks.resolveDashboardArtifactPointer.mockResolvedValue({ access: "ok", pointer: POINTER });
    mocks.resolveArtifactDisplayMount.mockResolvedValue({
      dispatch: "fallback",
      kind: "floor",
      slot: "detail",
      packageName: "@cinatra-ai/dashboard-artifact",
      reason: "no-display",
    });
    const html = await renderPage();
    expect(mocks.resolveArtifactDisplayMount).toHaveBeenCalledTimes(1);
    expect(html).toContain('data-render-dispatch="dashboard-pointer"');
    expect(html).toContain('data-testid="artifact-dashboard-pointer"');
    expect(html).toContain('href="/dashboards/a-1"');
    expect(html).toContain("Open dashboard");
    expect(mocks.mounted).toHaveLength(0);
  });

  // An installed display that claims the dashboard but needs a rebuild is a
  // floor too, so the page draws the pointer there as well.
  it("a dashboard whose claiming display needs a rebuild keeps its pointer too", async () => {
    dashboardRow();
    mocks.resolveDashboardArtifactPointer.mockResolvedValue({ access: "ok", pointer: POINTER });
    mocks.resolveArtifactDisplayMount.mockResolvedValue({
      dispatch: "fallback",
      kind: "floor",
      slot: "detail",
      packageName: "@cinatra-ai/dashboard-artifact",
      reason: "requires-rebuild",
    });
    const html = await renderPage();
    expect(html).toContain('data-render-dispatch="dashboard-pointer"');
    expect(html).toContain("Open dashboard");
    expect(mocks.mounted).toHaveLength(0);
  });

  it("a row of another type that no installed display claims still draws the generic floor through the mount", async () => {
    mocks.resolveArtifactDisplayMount.mockResolvedValue({
      dispatch: "fallback",
      kind: "floor",
      slot: "detail",
      packageName: "@acme/notes",
      reason: "no-display",
    });
    const html = await renderPage();
    expect(mocks.mounted).toHaveLength(1);
    expect(html).not.toContain('data-testid="artifact-dashboard-pointer"');
    expect(mocks.resolveDashboardArtifactPointer).not.toHaveBeenCalled();
  });

  it("a row of another type never asks the dashboard gate", async () => {
    await renderPage();
    expect(mocks.resolveDashboardArtifactPointer).not.toHaveBeenCalled();
    expect(mocks.mounted).toHaveLength(1);
  });
});

describe("the live address of a dashboard row (cinatra#4311)", () => {
  const DASHBOARD_TYPE = "@cinatra-ai/dashboard-artifact:dashboard";
  const POINTER = {
    dashboardId: "a-1",
    name: "A dashboard",
    ownerLevel: "team",
    projectId: null,
    updatedAt: null,
    canonicalHref: "/teams/t-1/dashboards/a-1",
    scopeChips: [],
  };
  function handedArtifact(): { sourceUrl?: unknown } | undefined {
    return (mocks.mounted[0]?.props as { artifact?: { sourceUrl?: unknown } } | undefined)?.artifact;
  }
  beforeEach(() => {
    mocks.resolveDashboardArtifactPointer.mockReset();
  });

  it("a dashboard row the gate admits hands its display the canonical path, and the header draws no source-application link", async () => {
    mocks.readArtifactForDetail.mockReturnValue({
      kind: "ok",
      artifact: { ...ARTIFACT, objectType: DASHBOARD_TYPE, artifactType: DASHBOARD_TYPE },
    });
    mocks.isDashboardArtifactType.mockImplementation((t) => t === DASHBOARD_TYPE);
    mocks.resolveDashboardArtifactPointer.mockResolvedValue({ access: "ok", pointer: POINTER });
    const html = await renderPage();
    expect(mocks.mounted).toHaveLength(1);
    expect(handedArtifact()?.sourceUrl).toBe("/teams/t-1/dashboards/a-1");
    expect(html).not.toContain("Open in source application");
    expect(html).not.toContain('href="/teams/t-1/dashboards/a-1"');
  });

  it("a dashboard row under an open review still hands the pending reading with no live address", async () => {
    mocks.readArtifactForDetail.mockReturnValue({
      kind: "ok",
      artifact: { ...ARTIFACT, objectType: DASHBOARD_TYPE, artifactType: DASHBOARD_TYPE },
    });
    mocks.isDashboardArtifactType.mockImplementation((t) => t === DASHBOARD_TYPE);
    mocks.resolveDashboardArtifactPointer.mockResolvedValue({ access: "ok", pointer: POINTER });
    mocks.isArtifactUnderOpenReview.mockResolvedValue(true);
    await renderPage();
    expect((mocks.mounted[0]?.props as { review?: unknown }).review).toEqual({ reading: "pending", openLive: null });
  });

  it("a connector row is unchanged: its display and its header carry the record's own address", async () => {
    const SOURCE = "https://source.example/records/7";
    mocks.readArtifactForDetail.mockReturnValue({ kind: "ok", artifact: { ...ARTIFACT, sourceUrl: SOURCE } });
    const html = await renderPage();
    expect(handedArtifact()?.sourceUrl).toBe(SOURCE);
    expect(html).toContain("Open in source application");
    expect(html).toContain(`href="${SOURCE}"`);
    expect(mocks.resolveDashboardArtifactPointer).not.toHaveBeenCalled();
  });

  it("a row of another type with no record address carries none and draws no source-application link", async () => {
    const html = await renderPage();
    expect(handedArtifact()?.sourceUrl).toBeNull();
    expect(html).not.toContain("Open in source application");
  });
});
