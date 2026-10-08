// @vitest-environment jsdom
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactSummary } from "@/lib/artifacts/artifact-service";
import type { DashboardArtifactPointer } from "@/lib/dashboards/dashboard-artifact-surface";

const reads = vi.hoisted(() => ({
  rows: [] as ArtifactSummary[],
  pointers: new Map<string, DashboardArtifactPointer>(),
  teams: vi.fn(async () => [{ id: "team-growth", name: "Growth" }]),
}));
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: async () => ({ session: { activeOrganizationId: "org-acme" }, user: { id: "reader" } }),
  requireActorContext: async () => ({ userId: "reader", orgId: "org-acme" }),
  signInRedirectTarget: async () => "/sign-in",
}));
vi.mock("next/navigation", () => ({ redirect: () => { throw new Error("redirect"); } }));
vi.mock("@/lib/better-auth-db", () => ({
  readOrgsWithTeamsForUserActiveOnly: async () => [{ id: "org-acme", name: "Acme Corp", teams: [] }],
  readProjectsForUser: async () => [{ id: "project-apollo", name: "Apollo" }],
  readTeamsByIdsForOrg: reads.teams,
}));
vi.mock("@/lib/artifacts/artifact-service", () => ({ listArtifacts: () => reads.rows }));
vi.mock("@/lib/dashboards/dashboard-artifact-pointer-resolvers", () => ({ resolveLibraryDashboardPointers: async () => reads.pointers }));
vi.mock("@/app/artifacts/[id]/renderer-resolution", () => ({
  resolveSemanticDispatch: () => null,
  resolveSemanticListRowDispatch: () => null,
  classifyLoadablePath: () => "none",
}));
vi.mock("@/lib/artifacts/artifact-renderer-loader", () => ({ loadArtifactRenderer: vi.fn() }));
vi.mock("@/lib/artifacts/artifact-kind-label", () => ({ artifactKindLabelFor: () => "Artifact" }));
// Keep the real page, LibraryMode, rows and glyphs; only surrounding islands
// and layouts are reduced because their controls are not exercised here.
vi.mock("@/components/layout/main", () => ({ Main: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
vi.mock("@/components/page-header", () => ({ PageHeader: ({ title }: { title: string }) => <h1>{title}</h1> }));
vi.mock("@/components/page-content", () => ({ PageContent: ({ children }: { children: React.ReactNode }) => <section>{children}</section> }));
vi.mock("@/components/artifacts/library-toolbar", () => ({ LibraryToolbar: () => <div data-slot="toolbar" /> }));
vi.mock("@/components/artifacts/library-upload", () => ({
  LibraryUploadProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  LibraryUploadDropZone: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  LibraryUploadButton: () => null,
}));

import ArtifactsPage from "../page";

function row(id: string, fields: Partial<ArtifactSummary> = {}): ArtifactSummary {
  return {
    artifactId: id, title: id, latestRepresentationRevisionId: null,
    objectType: "@fixture/idea:artifact", artifactType: "data",
    mime: "application/octet-stream", size: 0, originKind: "agent",
    createdAt: "2026-09-01T00:00:00Z", updatedAt: null,
    ownerLevel: "organization", ownerId: null, organizationId: "org-acme",
    projectId: null, visibility: "organization", eligibleExtensions: [],
    primaryExtension: null, effectiveIdentity: { kind: "no-primary" },
    presentationIdentity: { kind: "no-primary" }, presentationSuggestions: [],
    sourceUrl: null, ...fields,
  } as ArtifactSummary;
}

async function renderPage(query?: string): Promise<Element> {
  const { prerender } = await import("react-dom/static");
  const element = await ArtifactsPage({ searchParams: Promise.resolve({ q: query }) });
  const { prelude } = await prerender(element);
  const html = await new Response(prelude as unknown as ReadableStream).text();
  return new DOMParser().parseFromString(html, "text/html").body;
}

function meta(container: Element, title: string): string {
  const item = Array.from(container.querySelectorAll("li[data-state='kind:artifact']"))
    .find((li) => li.textContent?.includes(title));
  expect(item, title).toBeTruthy();
  return item!.querySelector("p")!.textContent!;
}

beforeEach(() => { reads.rows = []; reads.pointers.clear(); reads.teams.mockClear(); });

describe("Artifacts page resolves and passes each authorized row's owner name", () => {
  it("names organization and team owners, and words visibility without raw enum values", async () => {
    reads.rows = [row("Org ideas"), row("Team ideas", { ownerLevel: "team", ownerId: "team-growth", visibility: "private" })];
    const page = await renderPage();
    expect(meta(page, "Org ideas")).toBe("Organization: Acme Corp · Organization · updated recently");
    expect(meta(page, "Team ideas")).toBe("Team: Growth · Private · updated recently");
    expect(reads.teams).toHaveBeenCalledExactlyOnceWith(["team-growth"], "org-acme");
  });

  it("batches duplicate team IDs from visible rows and does not look up filtered-out teams", async () => {
    reads.rows = [
      row("Visible one", { ownerLevel: "team", ownerId: "team-growth" }),
      row("Visible two", { ownerLevel: "team", ownerId: "team-growth" }),
      row("Hidden row", { ownerLevel: "team", ownerId: "team-hidden" }),
    ];
    const page = await renderPage("Visible");
    expect(meta(page, "Visible one")).toContain("Team: Growth");
    expect(meta(page, "Visible two")).toContain("Team: Growth");
    expect(page.textContent).not.toContain("Hidden row");
    expect(reads.teams).toHaveBeenCalledExactlyOnceWith(["team-growth"], "org-acme");
  });

  it("uses readable level words when names are absent and never borrows another owner's name", async () => {
    reads.rows = [
      row("Unknown org", { organizationId: "org-outside" }),
      row("Unknown team", { ownerLevel: "team", ownerId: "team-unknown" }),
      row("Personal ideas", { ownerLevel: "user", ownerId: "reader", visibility: "private" }),
      row("Workspace ideas", { ownerLevel: "workspace", visibility: "public" }),
    ];
    const page = await renderPage();
    expect(meta(page, "Unknown org")).toBe("Organization · Organization · updated recently");
    expect(meta(page, "Unknown team")).toBe("Team · Organization · updated recently");
    expect(meta(page, "Personal ideas")).toBe("Personal · Private · updated recently");
    expect(meta(page, "Workspace ideas")).toBe("Workspace · Public · updated recently");
  });

  it("keeps authorized rows readable if the bounded team-name lookup is unavailable", async () => {
    reads.rows = [row("Org ideas"), row("Team ideas", { ownerLevel: "team", ownerId: "team-growth" })];
    reads.teams.mockRejectedValueOnce(new Error("name read unavailable"));
    const page = await renderPage();
    expect(meta(page, "Org ideas")).toContain("Organization: Acme Corp");
    expect(meta(page, "Team ideas")).toBe("Team · Organization · updated recently");
  });

  it("passes team, organization and project names to authorized dashboard rows only", async () => {
    const type = "@cinatra-ai/dashboard-artifact:dashboard";
    reads.rows = [
      row("team-dashboard", { objectType: type, ownerLevel: "team", ownerId: "team-growth" }),
      row("org-dashboard", { objectType: type }),
      row("project-dashboard", { objectType: type, projectId: "project-apollo" }),
      row("denied-dashboard", { objectType: type, ownerLevel: "team", ownerId: "team-denied" }),
    ];
    for (const [id, level, name] of [
      ["team-dashboard", "team", "Team dashboard"],
      ["org-dashboard", "organization", "Org dashboard"],
      ["project-dashboard", "project", "Project dashboard"],
    ] as const) {
      reads.pointers.set(id, {
        dashboardId: id, name, ownerLevel: level, projectId: level === "project" ? "project-apollo" : null,
        updatedAt: null, canonicalHref: `/dashboards/${id}`, scopeChips: [],
      });
    }
    const page = await renderPage();
    expect(meta(page, "Team dashboard")).toBe("Team: Growth · updated recently");
    expect(meta(page, "Org dashboard")).toBe("Organization: Acme Corp · updated recently");
    expect(meta(page, "Project dashboard")).toBe("Project: Apollo · updated recently");
    expect(page.textContent).not.toContain("denied-dashboard");
    expect(reads.teams).toHaveBeenCalledExactlyOnceWith(["team-growth"], "org-acme");
  });
});
