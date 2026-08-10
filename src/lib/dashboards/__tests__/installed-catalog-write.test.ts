import { describe, it, expect, vi, beforeEach } from "vitest";

import type { ActorContext } from "@/lib/authz/actor-context";
import {
  addInstalledCatalogDashboard,
  type CatalogWriteDeps,
} from "@/lib/dashboards/installed-catalog-write";
import { resolveCatalogDestination } from "@/lib/dashboards/installed-catalog-read";
import type { CatalogSurface } from "@/lib/dashboards/installed-catalog-contract";

// ---------------------------------------------------------------------------
// Concept B's INSTANTIATE core (cinatra#2474 PR5).
//
// Every gate driven through the injected seams, with the REAL destination fence
// (`resolveCatalogDestination`, PR4's own) in play — it is never faked, because
// it is the fence the whole eligibility model rests on.
//
//   pnpm exec vitest run src/lib/dashboards/__tests__/installed-catalog-write.test.ts
// ---------------------------------------------------------------------------

const ORG = "org-1";
const USER = "user-1";
const TEMPLATE_ID = "tpl-1";
const PACKAGE = "@cinatra-ai/analytics-artifact";

const actor: ActorContext = {
  principalType: "HumanUser",
  principalId: USER,
  organizationId: ORG,
  // The scope-reach axes each landing's own view gate reads — every one a
  // live-resolved membership projection.
  orgRole: "member",
  teamIds: ["team-9"],
  projectGrants: [{ projectId: "proj-3", effectiveRole: "read", accessSource: "user" }],
  authSource: "session",
  policyVersion: "v2",
} as unknown as ActorContext;

const personal: CatalogSurface = {
  kind: "personal",
  orgId: ORG,
  userId: USER,
};

const team: CatalogSurface = {
  kind: "team",
  orgId: ORG,
  scopeId: "team-9",
  userId: USER,
};

/** What the pack DECLARES today — the seed, once gate 9 pins the identity. */
const DECLARED = { apiVersion: "v1.2", scopeLevel: "organization", portlets: [] };
/** What the ROW cached — deliberately different, so a test can tell them apart. */
const CACHED = {
  apiVersion: "v1.2",
  scopeLevel: "organization",
  portlets: [{ instanceId: "stale" }],
};

/** An admitted template as `resolveAdmittedTemplates` returns it. */
function admitted(over: Record<string, unknown> = {}) {
  return [
    {
      row: {
        id: TEMPLATE_ID,
        name: "Pipeline health",
        configJson: CACHED,
        ...over,
      },
      packageName: PACKAGE,
    },
  ] as never;
}

function deps(over: Partial<CatalogWriteDeps> = {}): CatalogWriteDeps {
  return {
    // NOT faked — the real fence.
    resolveDestination: resolveCatalogDestination,
    resolveAdmitted: vi.fn(async () => admitted()),
    readNames: vi.fn(async () => new Set<string>()),
    readDeclaration: vi.fn(async () => ({
      rowName: "Pipeline health",
      templateScope: "organization",
      config: DECLARED,
    })),
    write: vi.fn(async () => ({
      ok: true as const,
      dashboard: { id: "d-new", name: "Pipeline health", isDefault: false, canWrite: true },
    })),
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("the happy path", () => {
  it("writes into the ACTOR'S OWN collection for the surface, seeded from the CURRENT declaration", async () => {
    const d = deps();
    const res = await addInstalledCatalogDashboard(
      { actor, surface: team, templateId: TEMPLATE_ID },
      d,
    );

    expect(res).toEqual({
      ok: true,
      dashboard: { id: "d-new", name: "Pipeline health", isDefault: false, canWrite: true },
    });
    expect(d.write).toHaveBeenCalledWith({
      // DERIVED — the ref is never supplied by the caller.
      ref: {
        entityType: "team",
        entityId: "team-9",
        ownerLevel: "user",
        ownerId: USER,
      },
      name: "Pipeline health",
      // What the pack declares NOW — never the row's cached copy.
      seedConfig: DECLARED,
      organizationId: ORG,
    });
  });

  it("derives the personal destination from the actor, not from the descriptor's word", async () => {
    const d = deps();
    await addInstalledCatalogDashboard(
      { actor, surface: personal, templateId: TEMPLATE_ID },
      d,
    );
    expect(d.write).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: {
          entityType: "personal",
          entityId: ORG,
          ownerLevel: "user",
          ownerId: USER,
        },
      }),
    );
  });
});

describe("the destination fence (gates 1-2) — PR4's own, re-taken at write time", () => {
  it("refuses a descriptor naming ANOTHER user's collection", async () => {
    const d = deps();
    const res = await addInstalledCatalogDashboard(
      {
        actor,
        surface: { ...team, userId: "someone-else" },
        templateId: TEMPLATE_ID,
      },
      d,
    );
    expect(res).toEqual({ ok: false, reason: "ineligible" });
    // Nothing downstream even ran — no eligibility read, no write.
    expect(d.resolveAdmitted).not.toHaveBeenCalled();
    expect(d.write).not.toHaveBeenCalled();
  });

  it("refuses a surface in a DIFFERENT tenant than the actor's active org", async () => {
    const res = await addInstalledCatalogDashboard(
      { actor, surface: { ...team, orgId: "org-2" }, templateId: TEMPLATE_ID },
      deps(),
    );
    expect(res).toEqual({ ok: false, reason: "ineligible" });
  });

  it("refuses a NON-HUMAN principal — it has no personal collection to own the copy", async () => {
    const worker = {
      ...actor,
      principalType: "InternalWorker",
      principalId: USER,
    } as unknown as ActorContext;
    const res = await addInstalledCatalogDashboard(
      { actor: worker, surface: personal, templateId: TEMPLATE_ID },
      deps(),
    );
    expect(res).toEqual({ ok: false, reason: "ineligible" });
  });

  it("refuses an organization surface whose scope is not its own tenant", async () => {
    const res = await addInstalledCatalogDashboard(
      {
        actor,
        surface: { kind: "organization", orgId: ORG, scopeId: "org-9", userId: USER },
        templateId: TEMPLATE_ID,
      },
      deps(),
    );
    expect(res).toEqual({ ok: false, reason: "ineligible" });
  });
});

describe("re-running the eligibility gates (3-7) at write time", () => {
  it("refuses a handle that is no longer in the admitted set", async () => {
    const d = deps({ resolveAdmitted: vi.fn(async () => [] as never) });
    const res = await addInstalledCatalogDashboard(
      { actor, surface: team, templateId: TEMPLATE_ID },
      d,
    );
    expect(res).toEqual({ ok: false, reason: "ineligible" });
    expect(d.write).not.toHaveBeenCalled();
  });

  it("refuses a handle for a DIFFERENT admitted template — the id must match, not merely exist", async () => {
    const res = await addInstalledCatalogDashboard(
      { actor, surface: team, templateId: "tpl-other" },
      deps(),
    );
    expect(res).toEqual({ ok: false, reason: "ineligible" });
  });

  it("re-runs the gates against the surface the destination was derived from", async () => {
    const d = deps();
    await addInstalledCatalogDashboard(
      { actor, surface: team, templateId: TEMPLATE_ID },
      d,
    );
    expect(d.resolveAdmitted).toHaveBeenCalledWith(
      actor,
      team,
      expect.objectContaining({ orgId: ORG, actorUserId: USER }),
    );
  });

  it.each([["" as string], [null], [undefined], [{} as never]])(
    "refuses a malformed handle (%p) without touching the store",
    async (handle) => {
      const d = deps();
      const res = await addInstalledCatalogDashboard(
        { actor, surface: team, templateId: handle as never },
        d,
      );
      expect(res).toEqual({ ok: false, reason: "ineligible" });
      expect(d.resolveAdmitted).not.toHaveBeenCalled();
    },
  );

  it("refuses a template whose name is not creatable at all", async () => {
    // Blank and the reserved "Overview" are refused by the writer's own rule; a
    // row carrying one must never be offered as an add that could never land.
    for (const name of ["   ", "Overview"]) {
      const d = deps({
        resolveAdmitted: vi.fn(async () => admitted({ name })),
        readDeclaration: vi.fn(async () => ({
          rowName: name,
          templateScope: "organization",
          config: DECLARED,
        })),
      });
      const res = await addInstalledCatalogDashboard(
        { actor, surface: team, templateId: TEMPLATE_ID },
        d,
      );
      expect(res).toEqual({ ok: false, reason: "ineligible" });
      expect(d.write).not.toHaveBeenCalled();
    }
  });
});

describe("the scope-reach gate — the render's proof does not outlive the render", () => {
  it("refuses a team the actor is no longer a member of", async () => {
    const removed = { ...actor, teamIds: [] } as unknown as ActorContext;
    const d = deps();
    const res = await addInstalledCatalogDashboard(
      { actor: removed, surface: team, templateId: TEMPLATE_ID },
      d,
    );
    expect(res).toEqual({ ok: false, reason: "ineligible" });
    expect(d.resolveAdmitted).not.toHaveBeenCalled();
  });

  it("refuses an org manager who is not a MEMBER of the team (the stated narrowing)", async () => {
    // The team landing lets a manager view without a membership row; this
    // predicate deliberately does not, because membership is what proves the
    // team still EXISTS without a query. Recorded rather than silent.
    const orgAdmin = {
      ...actor,
      teamIds: [],
      orgRole: "org_admin",
    } as unknown as ActorContext;
    expect(
      await addInstalledCatalogDashboard(
        { actor: orgAdmin, surface: team, templateId: TEMPLATE_ID },
        deps(),
      ),
    ).toEqual({ ok: false, reason: "ineligible" });
  });

  it("refuses an actor with no resolved MEMBERSHIP role in the tenant", async () => {
    // A removed member whose session still points at the org. The org-write
    // kernel would refuse the insert anyway (no minted authority) — this turns
    // them away before any store read.
    const removed = { ...actor, orgRole: undefined } as unknown as ActorContext;
    const d = deps();
    expect(
      await addInstalledCatalogDashboard(
        { actor: removed, surface: personal, templateId: TEMPLATE_ID },
        d,
      ),
    ).toEqual({ ok: false, reason: "ineligible" });
    expect(d.resolveAdmitted).not.toHaveBeenCalled();
  });

  it("refuses a project whose grant has been revoked (the sealed-room read gate)", async () => {
    const project = {
      kind: "project" as const,
      orgId: ORG,
      scopeId: "proj-3",
      userId: USER,
    };
    expect(
      await addInstalledCatalogDashboard(
        { actor, surface: project, templateId: TEMPLATE_ID },
        deps(),
      ),
    ).toMatchObject({ ok: true });

    const revoked = { ...actor, projectGrants: [] } as unknown as ActorContext;
    expect(
      await addInstalledCatalogDashboard(
        { actor: revoked, surface: project, templateId: TEMPLATE_ID },
        deps(),
      ),
    ).toEqual({ ok: false, reason: "ineligible" });
  });
});

describe("gate 9 — CURRENTNESS (the gap PR4 deferred here)", () => {
  it("refuses a template the pack no longer declares, even though its row is live and published", async () => {
    const d = deps({ readDeclaration: vi.fn(async () => null) });
    const res = await addInstalledCatalogDashboard(
      { actor, surface: team, templateId: TEMPLATE_ID },
      d,
    );
    expect(res).toEqual({ ok: false, reason: "no-longer-declared" });
    expect(d.write).not.toHaveBeenCalled();
  });

  it("refuses a REPLACED declaration — the package still ships a dashboard, but not this one", async () => {
    // The window a package-level yes/no would miss entirely: v2 drops dashboard
    // A and ships dashboard B, and the stale A row survives until the next
    // reconcile. The identity pin is the name the reconcile WOULD write.
    const d = deps({
      readDeclaration: vi.fn(async () => ({
        rowName: "Revenue",
        templateScope: "organization",
        config: DECLARED,
      })),
    });
    const res = await addInstalledCatalogDashboard(
      { actor, surface: team, templateId: TEMPLATE_ID },
      d,
    );
    expect(res).toEqual({ ok: false, reason: "no-longer-declared" });
    expect(d.write).not.toHaveBeenCalled();
  });

  it("asks about THIS row's providing package, in THIS org", async () => {
    const d = deps();
    await addInstalledCatalogDashboard(
      { actor, surface: team, templateId: TEMPLATE_ID },
      d,
    );
    expect(d.readDeclaration).toHaveBeenCalledWith({
      organizationId: ORG,
      packageName: PACKAGE,
    });
  });

  it("is taken AFTER the collision read — the cheap refusal answers a replayed add", async () => {
    // Gate 9 walks the filesystem (and, for a marketplace pack, the runtime
    // store); gate 8 is one indexed query. A replayed add for an
    // already-copied template must not buy a store walk.
    const d = deps({ readNames: vi.fn(async () => new Set(["Pipeline health"])) });
    const res = await addInstalledCatalogDashboard(
      { actor, surface: team, templateId: TEMPLATE_ID },
      d,
    );
    expect(res).toEqual({ ok: false, reason: "name-taken" });
    expect(d.readDeclaration).not.toHaveBeenCalled();
  });
});

describe("gate 8 — name collision, with a verdict the user can act on", () => {
  it("refuses a taken name with `name-taken`, not a silent omission", async () => {
    const d = deps({ readNames: vi.fn(async () => new Set(["Pipeline health"])) });
    const res = await addInstalledCatalogDashboard(
      { actor, surface: team, templateId: TEMPLATE_ID },
      d,
    );
    expect(res).toEqual({ ok: false, reason: "name-taken" });
    expect(d.write).not.toHaveBeenCalled();
  });

  it("counts an ARCHIVED dashboard's name — it still owns it under the unique index", async () => {
    // `readDestinationNames` reads EVERY status precisely so this holds; the
    // write inherits that, and the archived row is indistinguishable here from
    // any other collision — which is the point.
    const d = deps({
      readNames: vi.fn(async () => new Set(["Pipeline health", "Some archived thing"])),
    });
    expect(
      await addInstalledCatalogDashboard(
        { actor, surface: team, templateId: TEMPLATE_ID },
        d,
      ),
    ).toEqual({ ok: false, reason: "name-taken" });
  });

  it("compares the name the WRITER would persist, not the raw template name", async () => {
    const d = deps({
      resolveAdmitted: vi.fn(async () => admitted({ name: "  Pipeline health  " })),
      readNames: vi.fn(async () => new Set(["Pipeline health"])),
      readDeclaration: vi.fn(async () => ({
        rowName: "  Pipeline health  ",
        templateScope: "organization",
        config: DECLARED,
      })),
    });
    expect(
      await addInstalledCatalogDashboard(
        { actor, surface: team, templateId: TEMPLATE_ID },
        d,
      ),
    ).toEqual({ ok: false, reason: "name-taken" });
  });

  it("FAILS CLOSED when the destination collection cannot be read", async () => {
    const d = deps({ readNames: vi.fn(async () => null) });
    const res = await addInstalledCatalogDashboard(
      { actor, surface: team, templateId: TEMPLATE_ID },
      d,
    );
    expect(res).toEqual({ ok: false, reason: "failed" });
    expect(d.write).not.toHaveBeenCalled();
  });
});

describe("failure posture", () => {
  it("never throws into the action — an unexpected fault becomes `failed`", async () => {
    const d = deps({
      resolveAdmitted: vi.fn(async () => {
        throw new Error("store down");
      }),
    });
    const res = await addInstalledCatalogDashboard(
      { actor, surface: team, templateId: TEMPLATE_ID },
      d,
    );
    expect(res).toEqual({ ok: false, reason: "failed" });
  });

  it("passes a writer refusal straight through as its own reason", async () => {
    const d = deps({
      write: vi.fn(async () => ({ ok: false as const, reason: "denied" as const })),
    });
    expect(
      await addInstalledCatalogDashboard(
        { actor, surface: team, templateId: TEMPLATE_ID },
        d,
      ),
    ).toEqual({ ok: false, reason: "denied" });
  });
});

describe("gate 7, RE-TAKEN against what is actually copied", () => {
  it("refuses a declaration that is now PROJECT-scope, even though the stored row was not", async () => {
    // The eligibility pass judged the row's cached `template_scope`; the seed is
    // the CURRENT declaration. A release that kept the name while switching to
    // `scopeLevel:"project"` must not slip past a rule that only saw the old row
    // (codex convergence r1/HIGH).
    const d = deps({
      readDeclaration: vi.fn(async () => ({
        rowName: "Pipeline health",
        templateScope: "project",
        config: DECLARED,
      })),
    });
    const res = await addInstalledCatalogDashboard(
      { actor, surface: team, templateId: TEMPLATE_ID },
      d,
    );
    expect(res).toEqual({ ok: false, reason: "ineligible" });
    expect(d.write).not.toHaveBeenCalled();
  });

  it("refuses a declaration whose scope could not be read at all (fail-closed)", async () => {
    const d = deps({
      readDeclaration: vi.fn(async () => ({
        rowName: "Pipeline health",
        templateScope: null,
        config: DECLARED,
      })),
    });
    expect(
      await addInstalledCatalogDashboard(
        { actor, surface: team, templateId: TEMPLATE_ID },
        d,
      ),
    ).toEqual({ ok: false, reason: "ineligible" });
    expect(d.write).not.toHaveBeenCalled();
  });
});
