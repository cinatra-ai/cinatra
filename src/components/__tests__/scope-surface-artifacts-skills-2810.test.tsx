// @vitest-environment jsdom
/**
 * THE TWO TABS RENDER THEIR OWNERSHIP SUBSET THROUGH THE LANDED LISTS
 * (cinatra#2810, per-scope surfaces S4).
 *
 * The acceptance sentences this file proves, verbatim:
 *
 *   "Rendering reuses the landed list components (`LibraryMode`; the skills
 *    catalog rows)."
 *
 *   "Per-scope ownership fixtures (each scope lists only its owned rows;
 *    workspace = the `WorkspaceVantage` union incl. workspace-tier rows;
 *    malformed missing-owner rows excluded everywhere) — including MIXED-AXIS
 *    fixtures (a row carrying both `projectId` and a non-project owner locus
 *    appears exactly once, on the project tab)."
 *
 * The readers' own rules are pinned by their pure fixtures; what is proven HERE
 * is that the rules reach the screen — that the rendered list of a scope tab is
 * the ownership subset, drawn by the SAME components the global pages draw.
 *
 * The artifacts half drives the real `LibraryMode`, the one component
 * `/artifacts` mounts, with an ownership locus. The skills half drives the real
 * `SkillsCatalogRows`, the one component `/skills` mounts in its cards view.
 * Neither tab has a list of its own to test.
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
  usePathname: () => "/workspace/artifacts",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/app/artifacts/[id]/renderer-dispatch", () => ({
  isSelectionPreparing: () => false,
}));

/** The extension-registry graph, stood in for exactly as the global library's
 *  own invariance fixture stands it in. The ROW SET is the subject. */
vi.mock("@/components/artifacts/library-row-glyph", () => ({
  isFileMime: () => true,
  LibraryRowGlyph: () => null,
}));
vi.mock("@/lib/artifacts/artifact-kind-label", () => ({
  artifactKindLabelFor: (extension: string) => extension,
}));
vi.mock("@/components/artifacts/library-toolbar", () => ({
  LibraryToolbar: ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children),
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
vi.mock("@/lib/dashboards/dashboard-artifact-pointer-resolvers", () => ({
  resolveLibraryDashboardPointers: vi.fn(async () => new Map()),
}));

const store = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("@/lib/artifacts/artifact-service", () => ({
  listArtifacts: vi.fn(() => store.rows),
}));
vi.mock("@/lib/better-auth-db", () => ({
  readOrgsWithTeamsForUserActiveOnly: vi.fn(async () => [
    { id: "org-a", name: "Org A", teams: [{ id: "team-a", name: "Team A" }] },
  ]),
  readProjectsForUser: vi.fn(async () => [{ id: "project-a", name: "Project A" }]),
}));

import { LibraryMode } from "@/components/artifacts/library-mode";
import { SkillsCatalogRows } from "@cinatra-ai/skills/catalog-rows";
import { buildWorkspaceVantage } from "@/lib/scope-surface-eligibility";
import {
  selectScopeOwnedSkills,
  type SkillOwnershipLocus,
} from "@/lib/scope-surface-skill-rows";
import type { ArtifactOwnershipLocus } from "@/lib/scope-surface-artifact-rows";

const ACTOR = "user-1";
const ORG_A = "org-a";
const TEAM_A = "team-a";
const PROJECT_A = "project-a";

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

const PERSONAL_ART = artifact("art-personal", "Alpha personal", {
  ownerLevel: "user",
  ownerId: ACTOR,
  organizationId: ORG_A,
  projectId: null,
});
const ORG_ART = artifact("art-org", "Charlie organization", {
  ownerLevel: "organization",
  ownerId: ORG_A,
  organizationId: ORG_A,
  projectId: null,
});
const TEAM_ART = artifact("art-team", "Delta team", {
  ownerLevel: "team",
  ownerId: TEAM_A,
  organizationId: ORG_A,
  projectId: null,
});
/** BOTH axes: a project id AND an organization owner locus. */
const MIXED_AXIS_ART = artifact("art-mixed", "Echo mixed axis", {
  ownerLevel: "organization",
  ownerId: ORG_A,
  organizationId: ORG_A,
  projectId: PROJECT_A,
});
const WORKSPACE_ART = artifact("art-workspace", "Foxtrot workspace tier", {
  ownerLevel: "workspace",
  ownerId: null,
  organizationId: null,
  projectId: null,
});
/** MALFORMED: a non-workspace level with a missing owner id. */
const MALFORMED_ART = artifact("art-malformed", "Golf malformed", {
  ownerLevel: "team",
  ownerId: null,
  organizationId: ORG_A,
  projectId: null,
});

const ALL_ARTIFACTS = [
  PERSONAL_ART,
  ORG_ART,
  TEAM_ART,
  MIXED_AXIS_ART,
  WORKSPACE_ART,
  MALFORMED_ART,
];

async function vantage() {
  return buildWorkspaceVantage(
    {
      readMemberOrganizations: async () => [{ orgId: ORG_A }],
      readVisibleTeams: async () => [TEAM_A],
      readVisibleProjects: async () => [PROJECT_A],
    },
    { userId: ACTOR },
  );
}

/** The rows the library list rendered, by their titles. */
function renderedRows(): string[] {
  const list = document.querySelector('[data-testid="artifacts-library-list"]');
  if (!list) return [];
  return [...list.querySelectorAll("li")].map((li) => li.textContent ?? "");
}

/** The scope tab mounts `LibraryMode` — the SAME component `/artifacts` does. */
async function renderScopeLibrary(ownership: ArtifactOwnershipLocus) {
  const tree = await LibraryMode({
    orgId: ORG_A,
    actor: { principalId: ACTOR } as never,
    userId: ACTOR,
    ownership,
  });
  render(tree as ReactNode);
}

function titlesContain(fragment: string): boolean {
  return renderedRows().some((row) => row.includes(fragment));
}

beforeEach(() => {
  store.rows = ALL_ARTIFACTS;
});

afterEach(() => {
  cleanup();
  store.rows = [];
  vi.clearAllMocks();
});

describe("the Artifacts tab renders its ownership subset through LibraryMode", () => {
  it("mounts the library's own list, not a second list implementation", async () => {
    await renderScopeLibrary({ kind: "personal", userId: ACTOR });
    // The landed component's own list node, with its conformance id.
    const list = document.querySelector('[data-testid="artifacts-library-list"]');
    expect(list).toBeTruthy();
    expect(list!.getAttribute("data-conformance-id")).toBe("artifacts-library-list");
  });

  it("the personal tab draws only the actor's own rows", async () => {
    await renderScopeLibrary({ kind: "personal", userId: ACTOR });
    expect(renderedRows()).toHaveLength(1);
    expect(titlesContain("Alpha personal")).toBe(true);
  });

  it("the organization tab draws only that organization's own rows", async () => {
    await renderScopeLibrary({ kind: "organization", orgId: ORG_A });
    expect(renderedRows()).toHaveLength(1);
    expect(titlesContain("Charlie organization")).toBe(true);
  });

  it("the team tab draws only that team's rows", async () => {
    await renderScopeLibrary({ kind: "team", teamId: TEAM_A });
    expect(renderedRows()).toHaveLength(1);
    expect(titlesContain("Delta team")).toBe(true);
  });

  it("the project tab draws the MIXED-AXIS row, and the organization tab does not", async () => {
    await renderScopeLibrary({ kind: "project", projectId: PROJECT_A });
    expect(renderedRows()).toHaveLength(1);
    expect(titlesContain("Echo mixed axis")).toBe(true);
    cleanup();
    await renderScopeLibrary({ kind: "organization", orgId: ORG_A });
    expect(titlesContain("Echo mixed axis")).toBe(false);
  });

  it("the workspace tab draws the vantage union, the workspace-tier row included", async () => {
    await renderScopeLibrary({ kind: "workspace", vantage: await vantage() });
    const rows = renderedRows();
    expect(rows).toHaveLength(5);
    for (const fragment of [
      "Alpha personal",
      "Charlie organization",
      "Delta team",
      "Echo mixed axis",
      "Foxtrot workspace tier",
    ]) {
      expect(titlesContain(fragment)).toBe(true);
    }
  });

  it("draws the MALFORMED row on no tab at all", async () => {
    for (const locus of [
      { kind: "personal", userId: ACTOR },
      { kind: "organization", orgId: ORG_A },
      { kind: "team", teamId: TEAM_A },
      { kind: "project", projectId: PROJECT_A },
      { kind: "workspace", vantage: await vantage() },
    ] as ArtifactOwnershipLocus[]) {
      await renderScopeLibrary(locus);
      expect(titlesContain("Golf malformed")).toBe(false);
      cleanup();
    }
  });

  it("draws the library's own empty state when the scope owns nothing", async () => {
    await renderScopeLibrary({ kind: "team", teamId: "team-with-nothing" });
    expect(document.querySelector('[data-testid="artifacts-library-list"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The skills half: the catalog rows, driven by the ownership reader's output.
// ---------------------------------------------------------------------------

type SkillRow = {
  id: string;
  name: string;
  slug: string;
  description: string;
  packageId: string;
  packageName: string;
  packageSlug: string;
  content: string;
  usedBy: string[];
  level?: string;
  scope?: string;
  ownerUserId?: string;
};

function skill(id: string, name: string, ownership: Partial<SkillRow>): SkillRow {
  return {
    id,
    name,
    slug: id,
    description: `${name} description`,
    packageId: "pkg-1",
    packageName: "@cinatra-ai/example-skills",
    packageSlug: "example-skills",
    content: "",
    usedBy: [],
    ...ownership,
  };
}

const PERSONAL_SKILL = skill("skill-personal", "Personal skill", {
  level: "personal",
  scope: "personal",
  ownerUserId: ACTOR,
});
const TEAM_SKILL = skill("skill-team", "Team skill", { level: "team", scope: TEAM_A });
const PROJECT_SKILL = skill("skill-project", "Project skill", {
  level: "project",
  scope: PROJECT_A,
});
const WORKSPACE_SKILL = skill("skill-workspace", "Workspace skill", {
  level: "workspace",
  scope: "workspace",
});
const MALFORMED_SKILL = skill("skill-malformed", "Malformed skill", {
  level: "team",
  scope: null as unknown as string,
});

const ALL_SKILLS = [
  PERSONAL_SKILL,
  TEAM_SKILL,
  PROJECT_SKILL,
  WORKSPACE_SKILL,
  MALFORMED_SKILL,
];

/** The Skills tab's body: the reader's output, drawn by the landed rows. */
function renderScopeSkills(locus: SkillOwnershipLocus) {
  const owned = selectScopeOwnedSkills(ALL_SKILLS, locus);
  render(
    createElement(SkillsCatalogRows, {
      skills: owned as never,
    }) as ReactNode,
  );
  return owned.map((row) => row.id);
}

/** The skill names the catalog rows rendered. */
function renderedSkillNames(): string[] {
  return [...document.querySelectorAll("h2")].map((h) => h.textContent?.trim() ?? "");
}

describe("the Skills tab renders its ownership subset through the catalog rows", () => {
  it("draws the landed catalog row for each owned skill, linking to that skill's own page", () => {
    renderScopeSkills({ kind: "personal", userId: ACTOR });
    expect(renderedSkillNames()).toEqual(["Personal skill"]);
    const link = document.querySelector('a[href="/skills/skill-personal"]');
    expect(link).toBeTruthy();
  });

  it("the team tab draws only that team's skills", () => {
    renderScopeSkills({ kind: "team", teamId: TEAM_A });
    expect(renderedSkillNames()).toEqual(["Team skill"]);
  });

  it("the project tab draws the project's own skills, never as a team proxy", () => {
    renderScopeSkills({ kind: "project", projectId: PROJECT_A });
    expect(renderedSkillNames()).toEqual(["Project skill"]);
    cleanup();
    renderScopeSkills({ kind: "team", teamId: TEAM_A });
    expect(renderedSkillNames()).not.toContain("Project skill");
  });

  it("the workspace tab draws the union, the workspace-tier skill included", async () => {
    renderScopeSkills({ kind: "workspace", vantage: await vantage() });
    expect(renderedSkillNames()).toEqual([
      "Personal skill",
      "Team skill",
      "Project skill",
      "Workspace skill",
    ]);
  });

  it("draws the MALFORMED skill on no tab at all", async () => {
    for (const locus of [
      { kind: "personal", userId: ACTOR },
      { kind: "organization", orgId: ORG_A },
      { kind: "team", teamId: TEAM_A },
      { kind: "project", projectId: PROJECT_A },
      { kind: "workspace", vantage: await vantage() },
    ] as SkillOwnershipLocus[]) {
      renderScopeSkills(locus);
      expect(renderedSkillNames()).not.toContain("Malformed skill");
      cleanup();
    }
  });

  it("draws nothing at all when the scope owns no skill", () => {
    const owned = renderScopeSkills({ kind: "organization", orgId: ORG_A });
    expect(owned).toEqual([]);
    expect(renderedSkillNames()).toEqual([]);
  });
});
