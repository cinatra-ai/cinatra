import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../store", () => ({
  listWorkflowTemplates: vi.fn(),
  listWorkflowTemplatesForOrgIds: vi.fn(),
}));
vi.mock("../extension-ops", () => ({
  installWorkflowExtension: vi.fn(),
  archiveWorkflowExtensionDashboards: vi.fn(),
  restoreWorkflowExtensionDashboards: vi.fn(),
}));

import { createWorkflowExtensionHandler } from "../extension-handler";
import { listWorkflowTemplates, listWorkflowTemplatesForOrgIds } from "../store";
import type {
  ActiveExtensionManifest,
  ExtensionDiscoveryScope,
} from "@cinatra-ai/extension-types";

const handler = createWorkflowExtensionHandler({
  agentExists: () => true,
  approverResolvable: () => true,
});

function mani(over: Partial<ActiveExtensionManifest> = {}): ActiveExtensionManifest {
  return {
    id: over.id ?? "m1",
    packageName: over.packageName ?? "@x/wf",
    kind: over.kind ?? "workflow",
    ownerLevel: over.ownerLevel ?? "platform",
    ownerId: over.ownerId ?? null,
    organizationId: over.organizationId ?? null,
    status: over.status ?? "active",
  };
}

function scope(over: Partial<ExtensionDiscoveryScope> = {}): ExtensionDiscoveryScope {
  // Use `in` so an EXPLICIT null (e.g. organizationId: null) is honoured and not
  // coalesced back to the default — the null-org case must actually test null.
  return {
    userId: "userId" in over ? (over.userId ?? null) : "u1",
    organizationId: "organizationId" in over ? (over.organizationId ?? null) : "org-1",
    teamIds: over.teamIds ?? [],
    projectIds: over.projectIds,
    vendorScope: over.vendorScope,
    platformRole: over.platformRole,
  };
}

// A workflow_template row (ScopedRow + packageName). Defaults to an org-readable
// extension-origin row whose package is live.
function tmpl(over: Record<string, unknown> = {}) {
  // `in` so an EXPLICIT null (packageName: null = in-app template) is honoured.
  return {
    id: "id" in over ? over.id : "t",
    key: "key" in over ? over.key : "k",
    packageName: "packageName" in over ? over.packageName : "@x/wf",
    orgId: "orgId" in over ? over.orgId : "org-1",
    ownerLevel: "ownerLevel" in over ? over.ownerLevel : "organization",
    ownerId: "ownerId" in over ? over.ownerId : null,
    projectId: "projectId" in over ? over.projectId : null,
  };
}

function run(
  templates: unknown[],
  manifests: ActiveExtensionManifest[],
  s: ExtensionDiscoveryScope,
) {
  vi.mocked(listWorkflowTemplates).mockResolvedValue(templates as never);
  return handler.listActive!({ actor: {} as never, scope: s, manifests }) as Promise<
    Array<{ id: string }>
  >;
}

describe("workflow listActive reader facet", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns [] (without querying) when the actor has no active org", async () => {
    const res = await handler.listActive!({
      actor: {} as never,
      scope: scope({ organizationId: null }),
      manifests: [mani()],
    });
    expect(res).toEqual([]);
    expect(listWorkflowTemplates).not.toHaveBeenCalled();
  });

  it("keeps only extension-origin templates whose package is visible+live", async () => {
    const templates = [
      tmpl({ id: "t1", packageName: "@x/wf" }), // ext + live -> keep
      tmpl({ id: "t2", packageName: null }), // in-app (no package) -> drop
      tmpl({ id: "t3", packageName: "@x/other" }), // package not live -> drop
    ];
    const res = await run(templates, [mani({ packageName: "@x/wf" })], scope());
    expect(res.map((t) => t.id)).toEqual(["t1"]);
  });

  it("excludes a package whose only live manifest is owned by a different org", async () => {
    const templates = [tmpl({ id: "t1", packageName: "@x/wf" })];
    const res = await run(
      templates,
      [mani({ packageName: "@x/wf", ownerLevel: "organization", organizationId: "org-OTHER" })],
      scope({ organizationId: "org-1" }),
    );
    expect(res).toEqual([]);
  });

  // filterReadable row-level visibility (same-org, package live) ------------
  it("drops a team-owned template when the actor is not in the team", async () => {
    const templates = [
      tmpl({ id: "t-team", ownerLevel: "team", ownerId: "team-A", packageName: "@x/wf" }),
    ];
    const denied = await run(templates, [mani()], scope({ teamIds: ["team-B"] }));
    expect(denied).toEqual([]);
    const allowed = await run(templates, [mani()], scope({ teamIds: ["team-A"] }));
    expect(allowed.map((t) => t.id)).toEqual(["t-team"]);
  });

  it("drops a user-owned template belonging to a different user", async () => {
    const templates = [
      tmpl({ id: "t-user", ownerLevel: "user", ownerId: "u-other", packageName: "@x/wf" }),
    ];
    const denied = await run(templates, [mani()], scope({ userId: "u1" }));
    expect(denied).toEqual([]);
    const allowed = await run(templates, [mani()], scope({ userId: "u-other" }));
    expect(allowed.map((t) => t.id)).toEqual(["t-user"]);
  });

  it("drops a project-sealed template without a project grant", async () => {
    const templates = [
      tmpl({ id: "t-proj", projectId: "proj-1", packageName: "@x/wf" }),
    ];
    const denied = await run(templates, [mani()], scope({ projectIds: [] }));
    expect(denied).toEqual([]);
    const allowed = await run(templates, [mani()], scope({ projectIds: ["proj-1"] }));
    expect(allowed.map((t) => t.id)).toEqual(["t-proj"]);
  });

  // D5: platform-admin cross-org discovery without an active org ------------
  describe("platform-admin cross-org discovery (D5)", () => {
    function crossOrg(
      resolver: ((userId: string) => string[] | Promise<string[]>) | undefined,
      rowsForOrgIds: unknown[],
      manifests: ActiveExtensionManifest[],
      s: ExtensionDiscoveryScope,
    ) {
      const h = createWorkflowExtensionHandler(resolver ? { orgListResolver: resolver } : {});
      // A single resolved org id uses the single-org query; >1 uses the batch.
      // Mock both so either path returns the same rows.
      vi.mocked(listWorkflowTemplatesForOrgIds).mockResolvedValue(rowsForOrgIds as never);
      vi.mocked(listWorkflowTemplates).mockResolvedValue(rowsForOrgIds as never);
      return h.listActive!({ actor: {} as never, scope: s, manifests }) as Promise<Array<{ id: string }>>;
    }

    it("unions templates across the admin's member orgs (platform manifest live for all)", async () => {
      const rows = [
        tmpl({ id: "a", orgId: "org-1", packageName: "@x/wf" }),
        tmpl({ id: "b", orgId: "org-2", packageName: "@x/wf" }),
      ];
      const res = await crossOrg(
        () => ["org-1", "org-2"],
        rows,
        [mani({ packageName: "@x/wf", ownerLevel: "platform" })],
        scope({ organizationId: null, userId: "admin", platformRole: "platform_admin" }),
      );
      expect(res.map((t) => t.id).sort()).toEqual(["a", "b"]);
      expect(listWorkflowTemplatesForOrgIds).toHaveBeenCalledWith(["org-1", "org-2"]);
      expect(listWorkflowTemplates).not.toHaveBeenCalled();
    });

    it("uses a SYNTHETIC per-org scope for manifest visibility (org-owned manifest live only for its org)", async () => {
      const rows = [
        tmpl({ id: "a", orgId: "org-1", packageName: "@x/wf" }),
        tmpl({ id: "b", orgId: "org-2", packageName: "@x/wf" }),
      ];
      // The only live manifest is org-2-owned → only org-2's row may surface.
      const res = await crossOrg(
        () => ["org-1", "org-2"],
        rows,
        [mani({ packageName: "@x/wf", ownerLevel: "organization", organizationId: "org-2" })],
        scope({ organizationId: null, userId: "admin", platformRole: "platform_admin" }),
      );
      expect(res.map((t) => t.id)).toEqual(["b"]);
    });

    it("returns [] for a platform admin with no active org when NO orgListResolver is injected", async () => {
      const res = await crossOrg(
        undefined,
        [tmpl({ id: "a", orgId: "org-1" })],
        [mani()],
        scope({ organizationId: null, userId: "admin", platformRole: "platform_admin" }),
      );
      expect(res).toEqual([]);
      expect(listWorkflowTemplatesForOrgIds).not.toHaveBeenCalled();
    });

    it("returns [] for a NON-admin with no active org even when a resolver is present (no privilege escalation)", async () => {
      const res = await crossOrg(
        () => ["org-1", "org-2"],
        [tmpl({ id: "a", orgId: "org-1" })],
        [mani()],
        scope({ organizationId: null, userId: "u1", platformRole: "member" }),
      );
      expect(res).toEqual([]);
      expect(listWorkflowTemplatesForOrgIds).not.toHaveBeenCalled();
    });

    it("dedupes by (orgId,id) so a repeated row surfaces once", async () => {
      const rows = [
        tmpl({ id: "a", orgId: "org-1", packageName: "@x/wf" }),
        tmpl({ id: "a", orgId: "org-1", packageName: "@x/wf" }),
      ];
      const res = await crossOrg(
        () => ["org-1"],
        rows,
        [mani({ packageName: "@x/wf", ownerLevel: "platform" })],
        scope({ organizationId: null, userId: "admin", platformRole: "platform_admin" }),
      );
      expect(res.map((t) => t.id)).toEqual(["a"]);
    });
  });
});
