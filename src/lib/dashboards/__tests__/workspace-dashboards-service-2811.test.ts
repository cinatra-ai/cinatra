/**
 * The workspace Dashboards tab's SERVER service (cinatra#2811, per-scope
 * surfaces S5), over mocked reads.
 *
 * The pure decisions are pinned in `workspace-dashboards-model-2811.test.ts`;
 * this file pins that the service feeds them the right facts and that every
 * mutation RE-AUTHORIZES on its own:
 *   - the viewer is built from the viewer's own memberships (the vantage), so
 *     the tab, the curation authority and the home access read the same under
 *     every active organization;
 *   - home access is the dashboards resolver plus the project grant, evaluated
 *     under the TARGET's home organization for the viewer's membership there;
 *   - adding a reference needs the viewer to see the target AND curate its home
 *     organization, and files the link under the target's own organization;
 *   - removing needs curation of the link; granting needs a platform
 *     administrator;
 *   - no filtered reference leaves a name behind, in the tab or the picker;
 *   - the Overview summary reads the two non-secret identity fields only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const reads = vi.hoisted(() => ({
  orgs: [] as Array<{ id: string; name: string; teams: Array<{ id: string; name: string }> }>,
  projects: {} as Record<string, Array<{ id: string; name: string }>>,
  roles: {} as Record<string, string | undefined>,
  grants: {} as Record<string, Array<{ projectId: string; effectiveRole: "read" | "write" | "admin" | "owner" }>>,
  orgRows: {} as Record<string, Array<Record<string, unknown>>>,
  byId: {} as Record<string, Record<string, unknown>>,
  references: [] as Array<Record<string, unknown>>,
  links: {} as Record<string, { linkId: string; homeOrgId: string; granted: boolean }>,
  own: [] as Array<Record<string, unknown>>,
  identity: null as Record<string, unknown> | null,
  calls: [] as Array<[string, ...unknown[]]>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/better-auth-db", () => ({
  readOrgsWithTeamsForUserActiveOnly: async () => reads.orgs,
  readProjectsForUser: async (_u: string, orgId: string) => reads.projects[orgId] ?? [],
  readProjectGrantsForUser: async (_u: string, orgId: string) => reads.grants[orgId] ?? [],
}));
vi.mock("@/lib/auth-session", () => ({
  resolveOrgRoleForUser: async (orgId: string) => reads.roles[orgId],
  getAuthSession: async () => null,
  isPlatformAdmin: () => false,
}));
vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: () => reads.identity,
}));
vi.mock("@/lib/dashboards/live-extension-oracle", () => ({
  resolveLiveExtensionPredicate: async () => () => true,
}));
vi.mock("@cinatra-ai/dashboards/extension-dashboard-reads", () => ({
  listOrgDashboardRows: async (orgId: string) => reads.orgRows[orgId] ?? [],
  readDashboardRowById: async (id: string) => reads.byId[id],
  isProjectTemplate: (r: { isTemplate: boolean; templateScope: string | null }) =>
    r.isTemplate === true && r.templateScope === "project",
  isDashboardRowRenderable: () => true,
}));
vi.mock("@cinatra-ai/dashboards/entity-links", () => ({
  listWorkspaceReferenceRows: async () => reads.references,
  listWorkspaceReferencedDashboardIds: async () =>
    new Set(reads.references.map((r) => r.dashboardId as string)),
  listUserWorkspaceDashboards: async () => reads.own,
  readWorkspaceReferenceLink: async (id: string) => reads.links[id] ?? null,
  addWorkspaceReferenceLink: async (input: unknown) => {
    reads.calls.push(["add", input]);
    return { created: true };
  },
  removeWorkspaceReferenceLink: async (input: unknown, actor: string) => {
    reads.calls.push(["remove", input, actor]);
    return { removed: true };
  },
  setWorkspaceReferenceReadGrant: async (input: unknown, actor: string) => {
    reads.calls.push(["grant", input, actor]);
    return { changed: true };
  },
}));

import {
  addWorkspaceReference,
  buildWorkspaceViewer,
  workspaceCatalogMemberships,
  getWorkspaceDashboardsRows,
  listWorkspaceReferenceCandidates,
  readWorkspaceOverviewSummary,
  removeWorkspaceReference,
  setWorkspaceEveryoneGrant,
} from "@/lib/dashboards/workspace-dashboards.server";

const NOW = new Date("2026-09-22T10:00:00Z");
const dash = (over: Record<string, unknown>) => ({
  id: "d",
  name: "D",
  organizationId: "org-a",
  ownerLevel: "organization",
  ownerId: "org-a",
  projectId: null,
  entityType: "organization",
  entityId: "org-a",
  extensionId: null,
  status: "published",
  isTemplate: false,
  templateScope: null,
  updatedAt: NOW,
  isDefault: false,
  ...over,
});

beforeEach(() => {
  reads.orgs = [
    { id: "org-a", name: "Acme", teams: [{ id: "t-sup", name: "Support" }] },
    { id: "org-b", name: "Bolt", teams: [] },
  ];
  reads.projects = { "org-a": [], "org-b": [{ id: "p-1", name: "Apollo" }] };
  reads.roles = { "org-a": "org_admin", "org-b": "member" };
  reads.grants = { "org-a": [], "org-b": [{ projectId: "p-1", effectiveRole: "read" }] };
  reads.orgRows = {
    "org-a": [
      dash({ id: "a-org", name: "Spend by project" }),
      dash({ id: "a-team", name: "Support load", ownerLevel: "team", ownerId: "t-sup", entityType: "team", entityId: "t-sup" }),
      dash({ id: "a-hidden-team", name: "Board pay", ownerLevel: "team", ownerId: "t-board", entityType: "team", entityId: "t-board" }),
      dash({ id: "a-tmpl", name: "Template", isTemplate: true, templateScope: "project" }),
      dash({ id: "a-mine", name: "Weekly focus", ownerLevel: "user", ownerId: "u1", entityType: "personal", entityId: "org-a" }),
    ],
    "org-b": [dash({ id: "b-org", name: "Bolt KPIs", organizationId: "org-b", ownerId: "org-b", entityId: "org-b" })],
  };
  reads.byId = Object.fromEntries(
    [...reads.orgRows["org-a"], ...reads.orgRows["org-b"]].map((r) => [r.id as string, r]),
  );
  reads.byId["w-ov"] = dash({
    id: "w-ov",
    organizationId: null,
    ownerLevel: "user",
    ownerId: "u1",
    entityType: "workspace",
    entityId: "__workspace__",
    isDefault: true,
  });
  reads.references = [];
  reads.links = {};
  reads.own = [{ dashboardId: "w-ov", name: "Overview", updatedAt: NOW, isDefault: true }];
  reads.identity = null;
  reads.calls = [];
});

const viewer = (platformAdmin = false, userId = "u1") =>
  buildWorkspaceViewer({ userId, platformAdmin, activeOrganizationId: "org-a" });

describe("buildWorkspaceViewer", () => {
  it("builds the vantage, the curator set and the per-organization home access from memberships", async () => {
    const v = await viewer();
    expect(v.vantage.organizations.map((o) => o.orgId)).toEqual(["org-a", "org-b"]);
    expect([...v.curator.managedOrgIds]).toEqual(["org-a"]);
    expect(v.curator.platformAdmin).toBe(false);
  });

  it("is identical whichever organization is active", async () => {
    const a = await buildWorkspaceViewer({ userId: "u1", platformAdmin: false, activeOrganizationId: "org-a" });
    const b = await buildWorkspaceViewer({ userId: "u1", platformAdmin: false, activeOrganizationId: "org-b" });
    const none = await buildWorkspaceViewer({ userId: "u1", platformAdmin: false, activeOrganizationId: null });
    expect(JSON.stringify(b.vantage)).toBe(JSON.stringify(a.vantage));
    expect([...b.curator.managedOrgIds]).toEqual([...a.curator.managedOrgIds]);
    expect([...none.curator.managedOrgIds]).toEqual([...a.curator.managedOrgIds]);
    expect(await getWorkspaceDashboardsRows(b)).toEqual(await getWorkspaceDashboardsRows(a));
  });
});

describe("the installed catalog's per-organization memberships", () => {
  it("carries one actor per member organization, with that organization's own standing", async () => {
    const v = await viewer();
    const memberships = workspaceCatalogMemberships(v);
    expect(memberships.map((m) => m.orgId)).toEqual(["org-a", "org-b"]);
    for (const m of memberships) {
      // The actor is resolved FOR its own organization, never borrowed.
      expect(m.actor.organizationId).toBe(m.orgId);
      expect(m.actor.principalType).toBe("HumanUser");
      expect(m.actor.principalId).toBe("u1");
    }
    expect(memberships[0]!.actor.orgRole).toBe(reads.roles["org-a"]);
    expect(memberships[1]!.actor.orgRole).toBe(reads.roles["org-b"]);
  });

  it("MINTS NO ROLE: an organization whose role lookup resolves nothing gets no leg", async () => {
    // The enumeration that put the organization in the vantage and the role
    // lookup are two reads. A membership revoked between them resolves to no
    // role, and defaulting it to "member" would manufacture the very
    // membership the catalog's first gate exists to test.
    reads.roles = { ...reads.roles, "org-b": undefined };
    const memberships = workspaceCatalogMemberships(await viewer());
    expect(memberships.map((m) => m.orgId)).toEqual(["org-a"]);
  });

  it("MINTS NO ROLE: an unrecognized stored role is not a membership either", async () => {
    reads.roles = { ...reads.roles, "org-b": "something_else" };
    const memberships = workspaceCatalogMemberships(await viewer());
    expect(memberships.map((m) => m.orgId)).toEqual(["org-a"]);
  });

  it("reads the same under every active organization", async () => {
    const a = await buildWorkspaceViewer({ userId: "u1", platformAdmin: false, activeOrganizationId: "org-a" });
    const b = await buildWorkspaceViewer({ userId: "u1", platformAdmin: false, activeOrganizationId: "org-b" });
    expect(workspaceCatalogMemberships(b)).toEqual(workspaceCatalogMemberships(a));
  });
});

describe("getWorkspaceDashboardsRows", () => {
  it("keeps a reference the viewer cannot reach out of the tab entirely (no name leak)", async () => {
    reads.references = [
      { linkId: "l1", ...dash({ id: "a-team", name: "Support load", ownerLevel: "team", ownerId: "t-sup", entityType: "team", entityId: "t-sup" }), dashboardId: "a-team", homeOrgId: "org-a", granted: false },
      { linkId: "l2", ...dash({ id: "a-hidden-team", name: "Board pay", ownerLevel: "team", ownerId: "t-board", entityType: "team", entityId: "t-board" }), dashboardId: "a-hidden-team", homeOrgId: "org-a", granted: false },
      { linkId: "l3", ...dash({ id: "x-foreign", name: "Other tenant plan", organizationId: "org-x", ownerId: "org-x", entityId: "org-x" }), dashboardId: "x-foreign", homeOrgId: "org-x", granted: false },
    ];
    const rows = await getWorkspaceDashboardsRows(await viewer());
    expect(rows.map((r) => r.dashboardId)).toEqual(["w-ov", "a-team"]);
    const text = JSON.stringify(rows);
    expect(text).not.toContain("Board pay");
    expect(text).not.toContain("Other tenant plan");
  });

  it("lists a granted reference to a viewer outside its home, read-only in the mark", async () => {
    reads.references = [
      { linkId: "l3", ...dash({ id: "x-foreign", name: "Other tenant plan", organizationId: "org-x", ownerId: "org-x", entityId: "org-x" }), dashboardId: "x-foreign", homeOrgId: "org-x", granted: true },
    ];
    const rows = await getWorkspaceDashboardsRows(await viewer());
    const ref = rows.find((r) => r.dashboardId === "x-foreign");
    expect(ref?.everyone).toEqual({ granted: true, canSet: false });
    expect(ref?.canRemove).toBe(false);
  });

  it("evaluates a project dashboard's home access with the project grant of ITS organization", async () => {
    reads.references = [
      { linkId: "l4", ...dash({ id: "b-proj", name: "Apollo burn", organizationId: "org-b", ownerId: "org-b", projectId: "p-1", entityType: null, entityId: null }), dashboardId: "b-proj", homeOrgId: "org-b", granted: false },
      { linkId: "l5", ...dash({ id: "b-proj2", name: "Zeus burn", organizationId: "org-b", ownerId: "org-b", projectId: "p-2", entityType: null, entityId: null }), dashboardId: "b-proj2", homeOrgId: "org-b", granted: false },
    ];
    const rows = await getWorkspaceDashboardsRows(await viewer());
    expect(rows.map((r) => r.dashboardId)).toEqual(["w-ov", "b-proj"]);
  });
});

describe("the reference picker", () => {
  it("offers what the viewer can see in the organizations it curates, minus templates and present links", async () => {
    reads.references = [
      { linkId: "l1", ...dash({ id: "a-org" }), dashboardId: "a-org", homeOrgId: "org-a", granted: false },
    ];
    const candidates = await listWorkspaceReferenceCandidates(await viewer());
    expect(candidates.map((c) => [c.dashboardId, c.homeNote, c.disposition])).toEqual([
      ["a-team", "homed in Team: Support", "addable"],
      ["a-mine", "homed in Personal", "addable"],
    ]);
    const text = JSON.stringify(candidates);
    expect(text).not.toContain("Board pay");
    expect(text).not.toContain("Bolt KPIs");
  });

  it("never offers a default Overview", async () => {
    reads.orgRows["org-a"].push(
      dash({ id: "a-ov", name: "Overview", ownerLevel: "user", ownerId: "u1", entityType: "personal", entityId: "org-a", isDefault: true }),
    );
    const candidates = await listWorkspaceReferenceCandidates(await viewer());
    expect(candidates.map((c) => c.dashboardId)).not.toContain("a-ov");
  });

  it("offers nothing to a viewer who curates no organization", async () => {
    reads.roles = { "org-a": "member", "org-b": "member" };
    expect(await listWorkspaceReferenceCandidates(await viewer())).toEqual([]);
  });
});

describe("addWorkspaceReference", () => {
  it("files the link under the target's own home organization", async () => {
    expect(await addWorkspaceReference(await viewer(), "a-team")).toEqual({ ok: true });
    expect(reads.calls).toEqual([["add", { dashboardId: "a-team", homeOrgId: "org-a", createdBy: "u1" }]]);
  });

  it("refuses a target in an organization the viewer does not curate", async () => {
    expect(await addWorkspaceReference(await viewer(), "b-org")).toEqual({ ok: false, reason: "denied" });
    expect(reads.calls).toEqual([]);
  });

  it("refuses a target the viewer cannot see, even in a curated organization", async () => {
    expect(await addWorkspaceReference(await viewer(), "a-hidden-team")).toEqual({ ok: false, reason: "denied" });
    expect(reads.calls).toEqual([]);
  });

  it("refuses a default Overview: a per-user shell default is not a shareable dashboard", async () => {
    reads.byId["a-ov"] = dash({ id: "a-ov", name: "Overview", ownerLevel: "user", ownerId: "u1", entityType: "personal", entityId: "org-a", isDefault: true });
    expect(await addWorkspaceReference(await viewer(), "a-ov")).toEqual({ ok: false, reason: "invalid" });
    expect(reads.calls).toEqual([]);
  });

  it("refuses a workspace row, a template and an unknown id", async () => {
    expect(await addWorkspaceReference(await viewer(), "w-ov")).toEqual({ ok: false, reason: "invalid" });
    expect(await addWorkspaceReference(await viewer(), "a-tmpl")).toEqual({ ok: false, reason: "invalid" });
    expect(await addWorkspaceReference(await viewer(), "nope")).toEqual({ ok: false, reason: "not-found" });
    expect(reads.calls).toEqual([]);
  });
});

describe("removeWorkspaceReference", () => {
  it("lets the home organization's admin remove the link, and nobody below", async () => {
    reads.links = { "a-team": { linkId: "l1", homeOrgId: "org-a", granted: false } };
    expect(await removeWorkspaceReference(await viewer(), "a-team")).toEqual({ ok: true });
    expect(reads.calls).toEqual([["remove", { dashboardId: "a-team", homeOrgId: "org-a" }, "u1"]]);
    reads.calls = [];
    reads.roles = { "org-a": "member" };
    expect(await removeWorkspaceReference(await viewer(), "a-team")).toEqual({ ok: false, reason: "denied" });
    expect(reads.calls).toEqual([]);
  });

  it("lets a platform administrator remove any link, and reports a missing one", async () => {
    reads.links = { "x-foreign": { linkId: "l3", homeOrgId: "org-x", granted: true } };
    expect(await removeWorkspaceReference(await viewer(true), "x-foreign")).toEqual({ ok: true });
    expect(await removeWorkspaceReference(await viewer(true), "gone")).toEqual({ ok: false, reason: "not-found" });
  });
});

describe("setWorkspaceEveryoneGrant", () => {
  it("is a platform administrator's alone", async () => {
    reads.links = { "a-team": { linkId: "l1", homeOrgId: "org-a", granted: false } };
    expect(await setWorkspaceEveryoneGrant(await viewer(), "a-team", true)).toEqual({ ok: false, reason: "denied" });
    expect(reads.calls).toEqual([]);
    expect(await setWorkspaceEveryoneGrant(await viewer(true), "a-team", true)).toEqual({ ok: true });
    expect(reads.calls).toEqual([["grant", { dashboardId: "a-team", homeOrgId: "org-a", granted: true }, "u1"]]);
  });

  it("rides a link: no link, no grant", async () => {
    expect(await setWorkspaceEveryoneGrant(await viewer(true), "a-org", true)).toEqual({ ok: false, reason: "not-found" });
  });
});

describe("readWorkspaceOverviewSummary", () => {
  it("reads the display name and namespace only, and counts the vantage", async () => {
    reads.identity = {
      instanceDisplayName: "Northwind",
      instanceNamespace: "northwind",
      instanceId: "3f1c2d4e-0000-4000-8000-000000000000",
      tokenCiphertext: "secret",
    };
    const summary = await readWorkspaceOverviewSummary(await viewer());
    expect(summary).toEqual({
      instanceName: "Northwind",
      namespace: "northwind",
      organizationCount: 2,
      teamCount: 1,
      projectCount: 1,
    });
  });
});
