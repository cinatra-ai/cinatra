import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Concept B's SERVER READ (cinatra#2474 PR4) — every gate, driven through
// injected seams. No DB: the store readers, the canonical install store, the
// liveness oracle and the destination lister are all mocked, so this exercises
// the READ'S OWN decisions (and the REAL `evaluateExtensionAccess`, which is not
// mocked — the actor arm must be the platform's, never a restatement).
// ---------------------------------------------------------------------------

const ORG = "org-1";
const OTHER_ORG = "org-2";
const USER = "u-1";
const TEAM = "team-a";
const PKG = "@cinatra-ai/analytics-artifact";
const INSTALL_ID = "install-1";

type TemplateRow = {
  id: string;
  name: string;
  extensionId: string | null;
  isTemplate: boolean;
  templateScope: string | null;
  status: string;
  organizationId: string;
};

const state = {
  templates: [] as TemplateRow[],
  livePackages: new Set<string>([PKG]),
  installs: [] as Array<{
    id: string;
    packageName: string;
    kind: string;
    status: string;
    ownerLevel: string;
    ownerId: string | null;
    organizationId: string | null;
  }>,
  policy: null as unknown,
  coOwners: [] as Array<{ userId: string }>,
  installedBy: null as string | null,
  destinationNames: ["Overview"] as string[],
  destinationThrows: false,
};

vi.mock("@cinatra-ai/dashboards/extension-dashboard-reads", async () => {
  const actual = await vi.importActual<
    typeof import("@cinatra-ai/dashboards/extension-dashboard-reads")
  >("@cinatra-ai/dashboards/extension-dashboard-reads");
  return {
    ...actual,
    // The REAL `filterRenderableDashboards` stays in play (the canonical reader
    // gate must not be stubbed out); only the SQL read is replaced.
    listOrgExtensionTemplateRows: vi.fn(async (orgId: string) =>
      state.templates.filter((t) => t.organizationId === orgId),
    ),
    listEntityCollectionNames: vi.fn(async () => {
      if (state.destinationThrows) throw new Error("boom");
      return state.destinationNames;
    }),
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
  readExtensionCoOwners: vi.fn(async () => state.coOwners),
  readExtensionInstalledBy: vi.fn(async () => state.installedBy),
}));



import { listInstalledCatalogTemplates } from "@/lib/dashboards/installed-catalog-read";
import type { CatalogSurface } from "@/lib/dashboards/installed-catalog-contract";
import type { ActorContext } from "@/lib/authz/actor-context";

function actor(over: Partial<ActorContext> = {}): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: USER,
    organizationId: ORG,
    orgRole: "member",
    platformRole: "member",
    teamIds: [TEAM],
    projectIds: [],
    authSource: "ui",
    ...over,
  } as unknown as ActorContext;
}

const teamSurface: CatalogSurface = {
  kind: "team",
  orgId: ORG,
  scopeId: TEAM,
  userId: USER,
};
const personalSurface: CatalogSurface = {
  kind: "personal",
  orgId: ORG,
  userId: USER,
};

function template(over: Partial<TemplateRow> = {}): TemplateRow {
  return {
    id: "tmpl-1",
    name: "Analytics",
    extensionId: PKG,
    isTemplate: true,
    templateScope: "organization",
    status: "published",
    organizationId: ORG,
    ...over,
  };
}

function install(over: Record<string, unknown> = {}) {
  return {
    id: INSTALL_ID,
    packageName: PKG,
    kind: "artifact",
    status: "active",
    ownerLevel: "organization",
    ownerId: ORG,
    organizationId: ORG,
    ...over,
  };
}

beforeEach(() => {
  state.templates = [template()];
  state.livePackages = new Set([PKG]);
  state.installs = [install()];
  state.policy = null; // → the platform's own DEFAULT (workspace)
  state.coOwners = [];
  state.installedBy = null;
  state.destinationNames = ["Overview"];
  state.destinationThrows = false;
  vi.clearAllMocks();
});

const read = (surface: CatalogSurface = teamSurface, a: ActorContext = actor()) =>
  listInstalledCatalogTemplates({ actor: a, surface });

describe("the happy path", () => {
  it("returns safe display metadata plus the opaque handle, and nothing else", async () => {
    const rows = await read();
    expect(rows).toEqual([
      { templateId: "tmpl-1", name: "Analytics", packageName: PKG },
    ]);
    // No config, no owner axis, no policy, no install id leaked.
    expect(Object.keys(rows[0]).sort()).toEqual([
      "name",
      "packageName",
      "templateId",
    ]);
  });
});

describe("gate 1 — the tenant fence", () => {
  it("refuses when the actor's active org is not the surface's org", async () => {
    expect(await read(teamSurface, actor({ organizationId: OTHER_ORG }))).toEqual(
      [],
    );
  });

  it("refuses a structurally invalid surface", async () => {
    expect(
      await read({ kind: "team", orgId: ORG, scopeId: "", userId: USER }),
    ).toEqual([]);
    expect(
      await read({ kind: "team", orgId: "", scopeId: TEAM, userId: USER }),
    ).toEqual([]);
    expect(
      await read({ kind: "team", orgId: ORG, scopeId: TEAM, userId: "" }),
    ).toEqual([]);
  });
});

describe("gate 2 — the destination fence", () => {
  it("refuses a NON-HUMAN principal — there is no personal collection to own the copy", async () => {
    expect(
      await read(
        teamSurface,
        actor({ principalType: "ServiceAccount" } as Partial<ActorContext>),
      ),
    ).toEqual([]);
  });

  it("refuses a descriptor naming a user OTHER than the acting principal", async () => {
    // The destination is derived from the ACTOR, and the descriptor must agree.
    // Without this the "acting user" invariant would be only as strong as
    // whatever the caller placed in the surface (codex convergence r1).
    expect(
      await read({ ...teamSurface, userId: "someone-else" }),
    ).toEqual([]);
  });

  it("serves the ORGANIZATION surface with no ref input at all — it is derived", async () => {
    expect(
      await read({
        kind: "organization",
        orgId: ORG,
        scopeId: ORG,
        userId: USER,
      }),
    ).toHaveLength(1);
  });

  it("refuses an organization surface whose scope is not its own tenant", async () => {
    expect(
      await read({
        kind: "organization",
        orgId: ORG,
        scopeId: "org-other",
        userId: USER,
      }),
    ).toEqual([]);
  });
});

describe("gates 3-4 — the template pool and the canonical liveness gate", () => {
  it("drops a template whose package is not live", async () => {
    state.livePackages = new Set();
    expect(await read()).toEqual([]);
  });

  it("drops an ARCHIVED template row (the canonical reader gate, not restated here)", async () => {
    state.templates = [template({ status: "archived" })];
    expect(await read()).toEqual([]);
  });

  it("drops a row with no owning package", async () => {
    state.templates = [template({ extensionId: null })];
    expect(await read()).toEqual([]);
  });
});

describe("gate 5 — install identity", () => {
  it("drops a package with NO live artifact install row", async () => {
    state.installs = [];
    expect(await read()).toEqual([]);
  });

  it("drops a package whose install is not active/locked", async () => {
    state.installs = [install({ status: "archived" })];
    expect(await read()).toEqual([]);
  });

  it("drops a package installed in ANOTHER org", async () => {
    state.installs = [install({ organizationId: OTHER_ORG })];
    expect(await read()).toEqual([]);
  });

  it("keeps a SYSTEM (org-null) install row", async () => {
    state.installs = [install({ organizationId: null, ownerLevel: "workspace", ownerId: null })];
    expect(await read()).toHaveLength(1);
  });

  it("SKIPS a package with more than one live install row — the version-ambiguity fence", async () => {
    state.installs = [
      install({ id: "install-1" }),
      install({ id: "install-2" }),
    ];
    expect(await read()).toEqual([]);
  });

  it("ignores a live install of a non-artifact kind", async () => {
    state.installs = [install({ kind: "connector" })];
    expect(await read()).toEqual([]);
  });
});

describe("gate 6 — the two arms, off ONE policy snapshot", () => {
  it("takes ONE batched policy snapshot and feeds BOTH arms from it", async () => {
    const store = await import("@cinatra-ai/extensions/permissions-store");
    await read();
    // One batch call for every candidate — not N single reads, and not a second
    // read that could hand the two arms different policy versions.
    expect(store.readExtensionAccessPolicies).toHaveBeenCalledTimes(1);
  });

  it("spends NO per-candidate store read on a template the VANTAGE already refuses", async () => {
    // The pure arm runs first precisely so an ineligible candidate costs nothing.
    const store = await import("@cinatra-ai/extensions/permissions-store");
    state.policy = policy([`team:team-zzz`]);
    await read();
    expect(store.readExtensionCoOwners).not.toHaveBeenCalled();
    expect(store.readExtensionInstalledBy).not.toHaveBeenCalled();
  });

  it("denies when the ACTOR arm denies, even though the vantage admits", async () => {
    // `team:<T>` admits this team's generic member (the vantage arm passes), but
    // the actor is not in T, so the actor arm refuses.
    state.policy = policy([`team:${TEAM}`]);
    expect(await read(teamSurface, actor({ teamIds: [] }))).toEqual([]);
  });

  it("denies when the actor arm admits but the VANTAGE arm does not", async () => {
    // An org ADMIN is admitted by admin standing whatever the tier says; the
    // scope's generic member is not. The catalog withholds it.
    state.policy = policy(["admin"]);
    const admin = actor({ orgRole: "org_admin" });
    expect(
      await listInstalledCatalogTemplates({ actor: admin, surface: teamSurface }),
    ).toEqual([]);
  });

  it("admits a team-scoped extension on THAT team's surface, and no other", async () => {
    state.policy = policy([`team:${TEAM}`]);
    expect(await read()).toHaveLength(1);
    expect(
      await read({
        kind: "project",
        orgId: ORG,
        scopeId: "proj-a",
        userId: USER,
      }, actor({ projectIds: ["proj-a"] })),
    ).toEqual([]);
  });

  it("admits a team-scoped extension on PERSONAL — the scope is the actor", async () => {
    state.policy = policy([`team:${TEAM}`]);
    expect(await read(personalSurface)).toHaveLength(1);
  });

  it("does NOT admit on personal an extension the ACTOR may not use", async () => {
    // The personal vantage waives only the SCOPE arm. The actor arm still rules.
    state.policy = policy([`team:team-zzz`]);
    expect(await read(personalSurface)).toEqual([]);
  });

  it("with NO stored policy applies the platform's own default, no stricter", async () => {
    state.policy = null;
    expect(await read()).toHaveLength(1);
  });
});

describe("gate 7 — template scope", () => {
  it("never offers a project-scope template, even on a project surface", async () => {
    state.templates = [template({ templateScope: "project" })];
    expect(await read()).toEqual([]);
    expect(
      await read(
        { kind: "project", orgId: ORG, scopeId: "proj-a", userId: USER },
        actor({ projectIds: ["proj-a"] }),
      ),
    ).toEqual([]);
  });
});

describe("gate 8 — the name-collision filter", () => {
  it("withholds a template whose name already exists in the destination", async () => {
    state.destinationNames = ["Overview", "Analytics"];
    expect(await read()).toEqual([]);
  });

  it("offers it again once the colliding name is gone", async () => {
    state.destinationNames = ["Overview", "Analytics renamed"];
    expect(await read()).toHaveLength(1);
  });

  it("fails CLOSED when the destination collection cannot be read", async () => {
    state.destinationThrows = true;
    expect(await read()).toEqual([]);
  });

  it("counts an ARCHIVED dashboard's name as taken — it still owns the index slot", async () => {
    // The per-entity dropdown hides archived rows, but
    // `dashboards_entity_name_uniq` has no status predicate, so an archived
    // "Analytics" still makes the create fail. Advertising it would be offering
    // an add that cannot land (codex convergence r2). The read therefore goes
    // through `listEntityCollectionNames`, which is status-blind by design.
    const reads = await import("@cinatra-ai/dashboards/extension-dashboard-reads");
    state.destinationNames = ["Overview", "Analytics"]; // "Analytics" archived
    expect(await read()).toEqual([]);
    // …and it is the status-blind reader that was consulted.
    expect(reads.listEntityCollectionNames).toHaveBeenCalledWith({
      organizationId: ORG,
      entityType: "team",
      entityId: TEAM,
      ownerLevel: "user",
      ownerId: USER,
    });
  });
});

describe("ordering, bounds and failure posture", () => {
  it("orders deterministically and bounds the list", async () => {
    state.templates = Array.from({ length: 60 }, (_, i) =>
      template({ id: `t-${i}`, name: `Dash ${String(i).padStart(2, "0")}` }),
    );
    const rows = await read();
    expect(rows).toHaveLength(50);
    expect(rows[0].name).toBe("Dash 00");
    expect([...rows].map((r) => r.name)).toEqual(
      [...rows].map((r) => r.name).sort(),
    );
  });

  it("NEVER throws into the landing — a store failure renders no catalog", async () => {
    const reads = await import("@cinatra-ai/dashboards/extension-dashboard-reads");
    vi.mocked(reads.listOrgExtensionTemplateRows).mockRejectedValueOnce(
      new Error("store down"),
    );
    expect(await read()).toEqual([]);
  });
});

function policy(tokens: string[]) {
  return {
    runListVisibility: tokens,
    runDataVisibility: tokens,
    runExecuteVisibility: tokens,
    allowRunSharing: false,
  };
}
