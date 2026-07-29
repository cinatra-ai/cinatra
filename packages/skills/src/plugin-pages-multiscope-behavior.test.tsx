/**
 * BEHAVIORAL end-to-end coverage for the SkillsPage multi-scope `?scope=`
 * OR-filter (cinatra#1074 W5): executes the REAL server component (auth/DB/
 * registry/action boundaries mocked; the scope pipeline — canonical parser,
 * normalizedScopeForSkill, OR-predicate — is the REAL production code) and
 * asserts which skill rows render for multi-scope and single-scope URLs,
 * plus the sortable-header multi-scope URL preservation.
 */
import { describe, it, expect, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";

const ACTOR = "user-actor";
const ORG = "o1";

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => undefined })),
}));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("notFound");
  }),
}));
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn(async () => ({
    user: { id: ACTOR },
    session: { activeOrganizationId: ORG },
  })),
  // Non-admin: the "admin" filter token must be inaccessible and drop.
  isPlatformAdmin: vi.fn(() => false),
  requireActorContext: vi.fn(async () => ({ userId: ACTOR, organizationId: ORG })),
}));
vi.mock("@/lib/better-auth-db", () => ({
  // SkillsPage is a UI scope picker (cinatra#1942 archive V1, Decision 4) —
  // it calls the active-only sibling, not the mixed authz/UI reader.
  readOrgsWithTeamsForUserActiveOnly: vi.fn(async () => [
    { id: ORG, name: "Org One", teams: [{ id: "t1", name: "Team One" }] },
  ]),
  readProjectsForUser: vi.fn(async () => [{ id: "p1", name: "Project One" }]),
}));
vi.mock("@cinatra-ai/agents/auth-policy", () => ({
  // Per-row ACL is not under test here (covered by the W4 suites); admit all.
  requireResourceAccess: vi.fn(() => {}),
  buildSkillResourceRef: vi.fn((ref: unknown) => ref),
}));
vi.mock("@/lib/agents-store", () => ({
  readAgentsForSkillMatching: vi.fn(async () => []),
}));
vi.mock("./actions", () => ({
  createSkillFromTemplateAction: vi.fn(),
  deletePersonalSkillAction: vi.fn(),
  savePersonalSkillAction: vi.fn(),
}));
vi.mock("./skills-toolbar", () => ({ SkillsToolbar: vi.fn(() => null) }));
vi.mock("./skill-markdown-editor", () => ({ SkillMarkdownEditor: vi.fn(() => null) }));
vi.mock("@/components/extension-permissions-client", () => ({
  ExtensionPermissionsClient: vi.fn(() => null),
}));
vi.mock("@/components/data-safety/delete-item-form", () => ({
  DeleteItemForm: vi.fn(() => null),
}));
vi.mock("./permissions-page-data", () => ({
  loadSkillPermissionsContext: vi.fn(async () => null),
}));
vi.mock("./skills-store", () => ({
  getCustomSkillById: vi.fn(async () => null),
  readSkillsCatalog: vi.fn(async () => ({ skillPackages: [] })),
  resolveEffectiveSkillAccessPolicy: vi.fn(() => undefined),
}));
vi.mock("./skills-registry", () => {
  const skill = (
    id: string,
    level: string | undefined,
    scope: string | null | undefined,
  ) => ({
    id,
    name: `Name ${id}`,
    slug: id,
    packageName: "@cinatra-ai/pkg",
    description: `About ${id}`,
    usedBy: [],
    level,
    scope,
  });
  return {
    getInstalledSkillById: vi.fn(async () => null),
    listInstalledSkills: vi.fn(async () => [
      skill("s-personal", "personal", ACTOR),
      skill("s-team", "team", "t1"),
      skill("s-proj", "project", "p1"),
      skill("s-org", "organization", ORG),
      skill("s-ws", "workspace", null),
      skill("s-system", "system", null),
    ]),
  };
});

import { SkillsPage } from "./plugin-pages";

/** Collect every `href` prop in the (un-rendered) element tree. */
function collectHrefs(node: ReactNode, out: string[] = []): string[] {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collectHrefs(child, out);
    return out;
  }
  const props = (node as ReactElement).props as
    | { href?: unknown; children?: ReactNode }
    | undefined;
  if (typeof props?.href === "string") out.push(props.href);
  if (props?.children !== undefined) collectHrefs(props.children, out);
  return out;
}

const ALL_IDS = ["s-personal", "s-team", "s-proj", "s-org", "s-ws", "s-system"];

async function renderHrefs(params: Record<string, string>): Promise<string[]> {
  const page = await SkillsPage({ searchParams: Promise.resolve(params) });
  return collectHrefs(page);
}

async function visibleIds(scope?: string): Promise<string[]> {
  const hrefs = await renderHrefs(scope === undefined ? {} : { scope });
  return ALL_IDS.filter((id) => hrefs.includes(`/skills/${encodeURIComponent(id)}`));
}

describe("SkillsPage multi-scope ?scope= OR-filter (behavioral, cinatra#1074 W5)", () => {
  it("default view shows every authorized row", async () => {
    expect(await visibleIds()).toEqual(ALL_IDS);
  });

  it("single-scope URLs keep working", async () => {
    expect(await visibleIds("team:t1")).toEqual(["s-team"]);
    expect(await visibleIds("personal")).toEqual(["s-personal"]);
    expect(await visibleIds("project:p1")).toEqual(["s-proj"]);
  });

  it("a comma-separated multi-scope URL ORs across parents of different kinds", async () => {
    expect(await visibleIds("team:t1,project:p1")).toEqual(["s-team", "s-proj"]);
    expect(await visibleIds("personal,org:o1")).toEqual(["s-personal", "s-org"]);
    expect(await visibleIds("personal,team:t1,project:p1")).toEqual([
      "s-personal",
      "s-team",
      "s-proj",
    ]);
  });

  it("a non-admin's stale admin token drops; the valid remainder still filters", async () => {
    expect(await visibleIds("admin,team:t1")).toEqual(["s-team"]);
    // Nothing valid at all -> default (everything).
    expect(await visibleIds("admin")).toEqual(ALL_IDS);
  });

  it("invalid tokens drop; workspace-mixed collapses to the default (everything)", async () => {
    expect(await visibleIds("team:t1,team:evil,bogus")).toEqual(["s-team"]);
    expect(await visibleIds("workspace,team:t1")).toEqual(ALL_IDS);
  });

  it("sortable-header hrefs preserve the FULL multi-scope selection", async () => {
    const hrefs = await renderHrefs({ scope: "team:t1,project:p1", view: "table" });
    const sortHrefs = hrefs.filter((h) => h.includes("sort="));
    expect(sortHrefs.length).toBeGreaterThan(0);
    for (const href of sortHrefs) {
      expect(href).toContain(`scope=${encodeURIComponent("team:t1,project:p1")}`);
    }
    // ... and omit the scope param entirely under the default selection.
    const defaultSortHrefs = (await renderHrefs({ view: "table" })).filter((h) =>
      h.includes("sort="),
    );
    expect(defaultSortHrefs.length).toBeGreaterThan(0);
    for (const href of defaultSortHrefs) expect(href).not.toContain("scope=");
  });
});
