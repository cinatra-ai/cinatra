// Unit test for the IoC reader facet `listActive` on the agent handler.
// Lives in the UNIT suite (not *.integration.test.ts) so it runs with no DB —
// the visibility-correct agent reader (`readActiveExtensionTemplates`) is mocked.
//
// Contract: the agent native store is the VISIBILITY authority.
// listActive asks readActiveExtensionTemplates(scope.vendorScope) for the
// templates the actor may see, then keeps only those whose package is
// lifecycle-live per the dispatcher's `manifests` (the coarse status gate). This
// fixes BOTH over-exposure (never reads another owner's row by package name) and
// under-exposure (private/vendor rows included via the scope).

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs/promises", () => ({ readdir: vi.fn(), readFile: vi.fn() }));

vi.mock("@cinatra-ai/agents", () => ({
  installAgentPackageWithDependencies: vi.fn(),
  extractAgentPackage: vi.fn(),
  cleanupExtractedAgentPackage: vi.fn(),
  deleteAgentTemplate: vi.fn(),
  readAgentTemplateByPackageName: vi.fn(),
  updateAgentTemplate: vi.fn(),
  readActiveExtensionTemplates: vi.fn(),
}));

vi.mock("@cinatra-ai/skills", () => ({
  upsertSkill: vi.fn(),
  deleteAgentSkillsForSlugs: vi.fn(),
  parseFrontmatter: vi.fn(),
}));

vi.mock("@cinatra-ai/registries", () => {
  class PluginDependencyCycleError extends Error {}
  class InstanceNamespaceNotConfiguredError extends Error {}
  return { PluginDependencyCycleError, InstanceNamespaceNotConfiguredError };
});

vi.mock("@/lib/verdaccio-config", () => ({ loadVerdaccioConfigForServer: vi.fn() }));

import { createAgentExtensionHandler } from "../extension-handler";
import { readActiveExtensionTemplates } from "@cinatra-ai/agents";

const actor = { userId: "u1", actorType: "human", source: "ui" } as never;

function m(packageName: string) {
  return {
    id: packageName, packageName, kind: "agent",
    ownerLevel: "platform", ownerId: null, organizationId: null, status: "active",
  };
}
function scopeWith(vendorScope: string | null) {
  return { userId: "u1", organizationId: null, teamIds: [], vendorScope } as never;
}

describe("agent handler listActive (IoC reader facet)", () => {
  let handler: ReturnType<typeof createAgentExtensionHandler>;
  beforeEach(() => {
    vi.resetAllMocks();
    handler = createAgentExtensionHandler();
  });

  it("INTERSECTS visible-active templates with the lifecycle-live manifest set", async () => {
    // The visibility-correct reader returns 3 visible templates; only 2 are in
    // the lifecycle-live manifest set -> the third is excluded.
    vi.mocked(readActiveExtensionTemplates).mockResolvedValue([
      { id: "1", packageName: "@cinatra-ai/auditor-agent" } as never,
      { id: "2", packageName: "@cinatra-ai/author-agent" } as never,
      { id: "3", packageName: "@cinatra-ai/not-live-agent" } as never,
    ]);
    const result = (await handler.listActive!({
      actor,
      scope: scopeWith(null),
      manifests: [m("@cinatra-ai/auditor-agent"), m("@cinatra-ai/author-agent")],
    })) as Array<{ packageName: string }>;
    expect(result.map((t) => t.packageName).sort()).toEqual([
      "@cinatra-ai/author-agent",
      "@cinatra-ai/auditor-agent",
    ].sort());
  });

  it("passes the actor's vendorScope to the visibility reader (private rows are included, not under-exposed)", async () => {
    vi.mocked(readActiveExtensionTemplates).mockResolvedValue([
      { id: "p", packageName: "@acme-private/secret-agent" } as never,
    ]);
    const result = await handler.listActive!({
      actor,
      scope: scopeWith("@acme-private"),
      manifests: [m("@acme-private/secret-agent")],
    });
    expect(vi.mocked(readActiveExtensionTemplates)).toHaveBeenCalledWith("@acme-private");
    expect(result).toHaveLength(1);
  });

  it("does NOT surface a visible template that is not lifecycle-live (no manifest entry)", async () => {
    vi.mocked(readActiveExtensionTemplates).mockResolvedValue([
      { id: "1", packageName: "@cinatra-ai/auditor-agent" } as never,
      { id: "2", packageName: "@cinatra-ai/archived-agent" } as never,
    ]);
    const result = await handler.listActive!({
      actor,
      scope: scopeWith(null),
      manifests: [m("@cinatra-ai/auditor-agent")], // archived-agent absent from live set
    });
    expect(result).toHaveLength(1);
  });

  it("drops templates with no packageName", async () => {
    vi.mocked(readActiveExtensionTemplates).mockResolvedValue([
      { id: "1", packageName: null } as never,
      { id: "2", packageName: "@cinatra-ai/auditor-agent" } as never,
    ]);
    const result = await handler.listActive!({
      actor,
      scope: scopeWith(null),
      manifests: [m("@cinatra-ai/auditor-agent")],
    });
    expect(result).toHaveLength(1);
  });
});
