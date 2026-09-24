// THE WORKSPACE INSTALLED-CATALOG FEDERATION (cinatra#2811, item 4).
//
// The workspace sits above every organization, so its catalog has no single
// tenant to read under. The landed gates are run once per MEMBER ORGANIZATION
// of the viewer's vantage, each with that organization's own actor, and the
// admitted sets are folded into one list.
//
// This suite drives that end to end through the same injected seams the tenant
// read uses: no database, the real `evaluateExtensionAccess`, and the real
// eligibility core. What it holds the federation to is the issue's own
// acceptance sentence: the union across two organizations, anchors admitted
// once, package-level dedupe, a collision check against the organization-free
// destination, one organization-free row through the single writer, and no
// read or write past a tenant fence the viewer does not hold.

import { describe, it, expect, vi, beforeEach } from "vitest";

const ORG_A = "org-a";
const ORG_B = "org-b";
const ORG_C = "org-c";
const USER = "u-1";
const PKG_SHARED = "@cinatra-ai/analytics-artifact";
const PKG_ONLY_B = "@cinatra-ai/pipeline-artifact";
const PKG_ANCHOR = "@cinatra-ai/anchor-artifact";

type TemplateRow = {
  id: string;
  name: string;
  extensionId: string | null;
  isTemplate: boolean;
  templateScope: string | null;
  status: string;
  organizationId: string;
};

type InstallRow = {
  id: string;
  packageName: string;
  kind: string;
  status: string;
  ownerLevel: string;
  ownerId: string | null;
  organizationId: string | null;
};

const state = {
  templates: [] as TemplateRow[],
  livePackages: new Set<string>(),
  installs: [] as InstallRow[],
  policy: null as unknown,
  /** Names by collection key, so the org-NULL destination is distinguishable
   *  from any tenant collection. */
  names: new Map<string, string[]>(),
  nameReads: [] as Array<Record<string, unknown>>,
  namesThrow: false,
};

const collectionKey = (k: {
  organizationId: string | null;
  entityType: string;
  entityId: string;
  ownerId: string;
}) => `${k.organizationId ?? "NULL"}|${k.entityType}|${k.entityId}|${k.ownerId}`;

vi.mock("@cinatra-ai/dashboards/extension-dashboard-reads", async () => {
  const actual = await vi.importActual<
    typeof import("@cinatra-ai/dashboards/extension-dashboard-reads")
  >("@cinatra-ai/dashboards/extension-dashboard-reads");
  return {
    ...actual,
    listOrgExtensionTemplateRows: vi.fn(async (orgId: string) =>
      state.templates.filter((t) => t.organizationId === orgId),
    ),
    listEntityCollectionNames: vi.fn(
      async (key: {
        organizationId: string | null;
        entityType: string;
        entityId: string;
        ownerLevel: string;
        ownerId: string;
      }) => {
        state.nameReads.push({ ...key });
        if (state.namesThrow) throw new Error("boom");
        return state.names.get(collectionKey(key)) ?? [];
      },
    ),
  };
});

vi.mock("@/lib/dashboards/live-extension-oracle", () => ({
  resolveLiveExtensionPredicate: vi.fn(
    async () => (pkg: string) => state.livePackages.has(pkg),
  ),
}));

vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  listInstalledExtensions: vi.fn(async (f: { kind?: string }) =>
    state.installs.filter((r) => !f.kind || r.kind === f.kind),
  ),
}));

vi.mock("@cinatra-ai/extensions/permissions-store", () => ({
  readExtensionAccessPolicies: vi.fn(async (_kind: string, ids: string[]) => {
    const m = new Map<string, unknown>();
    if (state.policy !== null) for (const id of ids) m.set(id, state.policy);
    return m;
  }),
  readExtensionCoOwners: vi.fn(async () => [] as Array<{ userId: string }>),
  readExtensionInstalledBy: vi.fn(async () => null),
}));

import {
  listInstalledCatalogTemplates,
  listWorkspaceCatalogTemplates,
  resolveWorkspaceAdmitted,
  type WorkspaceCatalogMembership,
} from "@/lib/dashboards/installed-catalog-read";
import { addWorkspaceCatalogDashboard } from "@/lib/dashboards/installed-catalog-write";
import {
  destinationRefForSurface,
  vantageForSurface,
} from "@/lib/dashboards/installed-catalog-eligibility";
import type { CatalogSurface } from "@/lib/dashboards/installed-catalog-contract";
import type { ActorContext } from "@/lib/authz/actor-context";

function actorIn(orgId: string, over: Partial<ActorContext> = {}): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: USER,
    organizationId: orgId,
    orgRole: "member",
    platformRole: "member",
    teamIds: [],
    projectGrants: [],
    projectIds: [],
    authSource: "ui",
    ...over,
  } as unknown as ActorContext;
}

const membership = (orgId: string, actor?: ActorContext): WorkspaceCatalogMembership => ({
  orgId,
  actor: actor ?? actorIn(orgId),
});

function template(over: Partial<TemplateRow> = {}): TemplateRow {
  return {
    id: "tmpl-a",
    name: "Analytics",
    extensionId: PKG_SHARED,
    isTemplate: true,
    templateScope: "organization",
    status: "published",
    organizationId: ORG_A,
    ...over,
  };
}

function install(over: Partial<InstallRow> = {}): InstallRow {
  return {
    id: "install-a",
    packageName: PKG_SHARED,
    kind: "artifact",
    status: "active",
    ownerLevel: "organization",
    ownerId: ORG_A,
    organizationId: ORG_A,
    ...over,
  };
}

/** The viewer's organization-free workspace collection. */
const WORKSPACE_COLLECTION = collectionKey({
  organizationId: null,
  entityType: "workspace",
  entityId: "__workspace__",
  ownerId: USER,
});

beforeEach(() => {
  // Organization A and organization B each install and materialize the SAME
  // package, and B additionally has one of its own.
  state.templates = [
    template({ id: "tmpl-a", organizationId: ORG_A }),
    template({ id: "tmpl-b", organizationId: ORG_B }),
    template({
      id: "tmpl-b2",
      organizationId: ORG_B,
      name: "Pipelines",
      extensionId: PKG_ONLY_B,
    }),
  ];
  state.installs = [
    install({ id: "install-a", organizationId: ORG_A, ownerId: ORG_A }),
    install({ id: "install-b", organizationId: ORG_B, ownerId: ORG_B }),
    install({
      id: "install-b2",
      packageName: PKG_ONLY_B,
      organizationId: ORG_B,
      ownerId: ORG_B,
    }),
  ];
  state.livePackages = new Set([PKG_SHARED, PKG_ONLY_B, PKG_ANCHOR]);
  state.policy = null; // → the platform's own DEFAULT
  state.names = new Map([[WORKSPACE_COLLECTION, ["Overview"]]]);
  state.nameReads = [];
  state.namesThrow = false;
  vi.clearAllMocks();
});

const federate = (memberships: readonly WorkspaceCatalogMembership[]) =>
  listWorkspaceCatalogTemplates({ userId: USER, memberships });

describe("the union across two organizations", () => {
  it("shows both organizations' packages to a viewer who belongs to both", async () => {
    const rows = await federate([membership(ORG_A), membership(ORG_B)]);
    expect(rows.map((r) => r.packageName).sort()).toEqual(
      [PKG_ONLY_B, PKG_SHARED].sort(),
    );
  });

  it("shows a one-membership viewer only that organization's rows", async () => {
    const onlyA = await federate([membership(ORG_A)]);
    expect(onlyA.map((r) => r.packageName)).toEqual([PKG_SHARED]);
    // Organization B's own package is absent, and so is B's copy of the shared
    // one: nothing of B reaches a viewer who is not in B.
    expect(onlyA.map((r) => r.templateId)).toEqual(["tmpl-a"]);
  });

  it("shows a package present in BOTH organizations exactly once", async () => {
    const rows = await federate([membership(ORG_A), membership(ORG_B)]);
    const shared = rows.filter((r) => r.packageName === PKG_SHARED);
    expect(shared).toHaveLength(1);
  });

  it("admits an organization-free ANCHOR install once, not once per membership", async () => {
    // A system anchor: no organization, addressable from every one of them.
    state.installs.push(
      install({
        id: "install-anchor",
        packageName: PKG_ANCHOR,
        ownerLevel: "workspace",
        ownerId: null,
        organizationId: null,
      }),
    );
    // Both organizations materialized their own template row off it.
    state.templates.push(
      template({
        id: "tmpl-anchor-a",
        organizationId: ORG_A,
        name: "Anchor",
        extensionId: PKG_ANCHOR,
      }),
      template({
        id: "tmpl-anchor-b",
        organizationId: ORG_B,
        name: "Anchor",
        extensionId: PKG_ANCHOR,
      }),
    );
    const rows = await federate([membership(ORG_A), membership(ORG_B)]);
    expect(rows.filter((r) => r.packageName === PKG_ANCHOR)).toHaveLength(1);
  });

  it("is stable: the same membership state reads the same both times", async () => {
    const first = await federate([membership(ORG_A), membership(ORG_B)]);
    const second = await federate([membership(ORG_B), membership(ORG_A)]);
    expect(second).toEqual(first);
  });

  it("ignores a duplicated membership row rather than doubling the read", async () => {
    const rows = await federate([membership(ORG_A), membership(ORG_A)]);
    expect(rows).toHaveLength(1);
  });
});

describe("the tenant fence", () => {
  it("reads nothing for an organization the viewer's actor is not resolved for", async () => {
    // The membership names B, but the actor handed in is A's. Gate 1 refuses.
    const rows = await federate([{ orgId: ORG_B, actor: actorIn(ORG_A) }]);
    expect(rows).toEqual([]);
  });

  it("reads nothing for an organization the viewer holds no ROLE in", async () => {
    const rows = await federate([
      { orgId: ORG_A, actor: actorIn(ORG_A, { orgRole: undefined }) },
    ]);
    expect(rows).toEqual([]);
  });

  it("never reaches an organization absent from the membership list", async () => {
    state.templates.push(
      template({ id: "tmpl-c", organizationId: ORG_C, name: "Secret" }),
    );
    state.installs.push(install({ id: "install-c", organizationId: ORG_C, ownerId: ORG_C }));
    const rows = await federate([membership(ORG_A), membership(ORG_B)]);
    expect(rows.map((r) => r.templateId)).not.toContain("tmpl-c");
  });

  it("refuses a non-human principal outright", async () => {
    const rows = await federate([
      {
        orgId: ORG_A,
        actor: actorIn(ORG_A, {
          principalType: "InternalWorker",
        } as Partial<ActorContext>),
      },
    ]);
    expect(rows).toEqual([]);
  });

  it("reads nothing at all without a membership", async () => {
    expect(await federate([])).toEqual([]);
  });
});

describe("the collision check against the organization-free destination", () => {
  it("asks the workspace collection, with a NULL tenant", async () => {
    await federate([membership(ORG_A), membership(ORG_B)]);
    const workspaceReads = state.nameReads.filter(
      (r) => r.entityType === "workspace",
    );
    expect(workspaceReads).toHaveLength(1);
    expect(workspaceReads[0]).toEqual({
      organizationId: null,
      entityType: "workspace",
      entityId: "__workspace__",
      ownerLevel: "user",
      ownerId: USER,
    });
  });

  it("withholds a template whose name the workspace collection already holds", async () => {
    state.names.set(WORKSPACE_COLLECTION, ["Overview", "Analytics"]);
    const rows = await federate([membership(ORG_A), membership(ORG_B)]);
    expect(rows.map((r) => r.name)).toEqual(["Pipelines"]);
  });

  it("IGNORES a name taken in a tenant collection: a different collection", async () => {
    state.names.set(
      collectionKey({
        organizationId: ORG_A,
        entityType: "workspace",
        entityId: "__workspace__",
        ownerId: USER,
      }),
      ["Analytics", "Pipelines"],
    );
    const rows = await federate([membership(ORG_A), membership(ORG_B)]);
    expect(rows.map((r) => r.name).sort()).toEqual(["Analytics", "Pipelines"]);
  });

  it("renders no catalog at all when the destination cannot be read", async () => {
    state.namesThrow = true;
    expect(await federate([membership(ORG_A)])).toEqual([]);
  });
});

describe("the write", () => {
  const declaration = {
    rowName: "Analytics",
    templateScope: "organization",
    config: { apiVersion: "1.2", portlets: [] },
  };

  it("lands ONE organization-free workspace row through the single writer", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const result = await addWorkspaceCatalogDashboard(
      { userId: USER, memberships: [membership(ORG_A), membership(ORG_B)], templateId: "tmpl-a" },
      {
        readDeclaration: async () => declaration,
        write: async (args) => {
          writes.push(args as unknown as Record<string, unknown>);
          return {
            ok: true,
            dashboard: { id: "new-1", name: "Analytics", isDefault: false, canWrite: true },
          };
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.ref).toEqual({
      entityType: "workspace",
      entityId: "__workspace__",
      ownerLevel: "user",
      ownerId: USER,
    });
    // Gate 9 read the pack under the organization whose install the earlier
    // gates judged, not under some other membership.
    expect(writes[0]!.organizationId).toBe(ORG_A);
    expect(writes[0]!.name).toBe("Analytics");
  });

  it("re-runs every gate: a template of an organization the viewer left is refused", async () => {
    const result = await addWorkspaceCatalogDashboard(
      // The handle names organization B's row, but the viewer is only in A now.
      { userId: USER, memberships: [membership(ORG_A)], templateId: "tmpl-b2" },
      { readDeclaration: async () => declaration, write: async () => ({ ok: true, dashboard: { id: "x", name: "n", isDefault: false, canWrite: true } }) },
    );
    expect(result).toEqual({ ok: false, reason: "ineligible" });
  });

  it("refuses a handle admitted by no membership, indistinguishably", async () => {
    const result = await addWorkspaceCatalogDashboard(
      { userId: USER, memberships: [membership(ORG_A)], templateId: "no-such-row" },
      { readDeclaration: async () => declaration, write: async () => ({ ok: true, dashboard: { id: "x", name: "n", isDefault: false, canWrite: true } }) },
    );
    expect(result).toEqual({ ok: false, reason: "ineligible" });
  });

  it("says name-taken for a name the WORKSPACE collection holds", async () => {
    state.names.set(WORKSPACE_COLLECTION, ["Overview", "Analytics"]);
    const result = await addWorkspaceCatalogDashboard(
      { userId: USER, memberships: [membership(ORG_A)], templateId: "tmpl-a" },
      { readDeclaration: async () => declaration, write: async () => ({ ok: true, dashboard: { id: "x", name: "n", isDefault: false, canWrite: true } }) },
    );
    expect(result).toEqual({ ok: false, reason: "name-taken" });
  });

  it("refuses when the pack no longer declares this row", async () => {
    const result = await addWorkspaceCatalogDashboard(
      { userId: USER, memberships: [membership(ORG_A)], templateId: "tmpl-a" },
      {
        readDeclaration: async () => ({ ...declaration, rowName: "Something else" }),
        write: async () => ({ ok: true, dashboard: { id: "x", name: "n", isDefault: false, canWrite: true } }),
      },
    );
    expect(result).toEqual({ ok: false, reason: "no-longer-declared" });
  });

  it("re-takes the scope rule against the CURRENT declaration", async () => {
    const result = await addWorkspaceCatalogDashboard(
      { userId: USER, memberships: [membership(ORG_A)], templateId: "tmpl-a" },
      {
        readDeclaration: async () => ({ ...declaration, templateScope: "project" }),
        write: async () => ({ ok: true, dashboard: { id: "x", name: "n", isDefault: false, canWrite: true } }),
      },
    );
    expect(result).toEqual({ ok: false, reason: "ineligible" });
  });

  it("writes nothing for a malformed handle", async () => {
    const writes: unknown[] = [];
    const result = await addWorkspaceCatalogDashboard(
      { userId: USER, memberships: [membership(ORG_A)], templateId: "" },
      { write: async (a) => { writes.push(a); return { ok: true, dashboard: { id: "x", name: "n", isDefault: false, canWrite: true } }; } },
    );
    expect(result).toEqual({ ok: false, reason: "ineligible" });
    expect(writes).toEqual([]);
  });
});

describe("the two contract unions are exhaustive over their kinds", () => {
  const KINDS = ["personal", "team", "organization", "project", "workspace"] as const;

  it("projects a vantage for EVERY catalog surface kind", () => {
    for (const kind of KINDS) {
      const surface = (kind === "personal" || kind === "workspace"
        ? { kind, orgId: ORG_A, userId: USER }
        : { kind, orgId: ORG_A, scopeId: "s-1", userId: USER }) as CatalogSurface;
      const vantage = vantageForSurface(surface);
      // No arm falls through to a shape that admits nothing by accident.
      expect(vantage.kind).toBe(kind);
      expect(vantage.orgId).toBe(ORG_A);
    }
  });

  it("resolves a destination for EVERY catalog surface kind", () => {
    for (const kind of KINDS) {
      const surface = (kind === "personal" || kind === "workspace"
        ? { kind, orgId: ORG_A, userId: USER }
        : { kind, orgId: ORG_A, scopeId: kind === "organization" ? ORG_A : "s-1", userId: USER }) as CatalogSurface;
      const ref = destinationRefForSurface(surface, USER);
      expect(ref, `no destination for ${kind}`).not.toBeNull();
      // Every destination is the ACTING USER'S OWN collection.
      expect(ref!.ownerLevel).toBe("user");
      expect(ref!.ownerId).toBe(USER);
    }
  });

  it("gives the workspace the organization-free ref, whatever the leg's organization", () => {
    const fromA = destinationRefForSurface(
      { kind: "workspace", orgId: ORG_A, userId: USER },
      USER,
    );
    const fromB = destinationRefForSurface(
      { kind: "workspace", orgId: ORG_B, userId: USER },
      USER,
    );
    expect(fromA).toEqual(fromB);
    expect(fromA).toEqual({
      entityType: "workspace",
      entityId: "__workspace__",
      ownerLevel: "user",
      ownerId: USER,
    });
  });

  it("refuses a workspace descriptor naming another user's collection", () => {
    expect(
      destinationRefForSurface(
        { kind: "workspace", orgId: ORG_A, userId: "someone-else" },
        USER,
      ),
    ).toBeNull();
  });

  it("carries the leg's organization on every leg's destination", async () => {
    const legs = await resolveWorkspaceAdmitted({
      userId: USER,
      memberships: [membership(ORG_A), membership(ORG_B)],
    });
    expect(legs.map((l) => l.orgId)).toEqual([ORG_A, ORG_B]);
    for (const leg of legs) {
      expect(leg.destination.orgId).toBe(leg.orgId);
      // …while the COLLECTION it writes into has no organization at all.
      expect(leg.destination.collectionOrgId).toBeNull();
    }
  });
});

describe("Personal is untouched by the federation", () => {
  const personalSurface: CatalogSurface = { kind: "personal", orgId: ORG_A, userId: USER };

  it("still reads its own per-organization collection, with its own tenant", async () => {
    state.names.set(
      collectionKey({
        organizationId: ORG_A,
        entityType: "personal",
        entityId: ORG_A,
        ownerId: USER,
      }),
      ["Overview"],
    );
    const rows = await listInstalledCatalogTemplates({
      actor: actorIn(ORG_A),
      surface: personalSurface,
    });
    expect(rows.map((r) => r.packageName)).toEqual([PKG_SHARED]);
    const personalRead = state.nameReads.find((r) => r.entityType === "personal");
    expect(personalRead).toEqual({
      organizationId: ORG_A,
      entityType: "personal",
      entityId: ORG_A,
      ownerLevel: "user",
      ownerId: USER,
    });
  });

  it("never returns a row of an organization the actor is not in", async () => {
    const rows = await listInstalledCatalogTemplates({
      actor: actorIn(ORG_A),
      surface: personalSurface,
    });
    expect(rows.map((r) => r.templateId)).toEqual(["tmpl-a"]);
  });

  it("keeps its permissive vantage: a personal scope still admits every token", () => {
    expect(vantageForSurface(personalSurface)).toEqual({
      kind: "personal",
      orgId: ORG_A,
    });
  });

  it("keeps its own destination, which is NOT the workspace collection", () => {
    const personalRef = destinationRefForSurface(personalSurface, USER);
    const workspaceRef = destinationRefForSurface(
      { kind: "workspace", orgId: ORG_A, userId: USER },
      USER,
    );
    expect(personalRef).not.toEqual(workspaceRef);
    expect(personalRef!.entityType).toBe("personal");
  });
});
