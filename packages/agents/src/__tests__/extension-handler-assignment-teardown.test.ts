/**
 * AGENT-SIDE lifecycle teardown (cinatra#2350 S5, epic #2345, scope item 2).
 *
 * Uninstalling an AGENT extension deletes every `agent_assigned_skills` row
 * keyed on its package name, ordered BEFORE the handler's provider-only early
 * return (`readAgentTemplateByPackageName` → `if (!existing) return`).
 *
 * That ordering is the whole point: assignment rows are ACTOR-INDEPENDENT and
 * keyed on the agent PACKAGE NAME, not on a template id, so they exist for a
 * provider-declared on-disk agent that has no `agent_templates` row at all —
 * exactly the shape that takes the early return. Sweeping after it would leave
 * those agents' assignments behind forever.
 *
 * The suite drives the REAL handler and the REAL `withInstallLock`; only the
 * leaf stores are doubled. Moving the sweep below the early return turns the
 * provider-declared test red; removing it turns all of them red.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  rmDirForRolledBackInstall: vi.fn(async () => undefined),
  triggerReloadAfterRollback: vi.fn(async () => undefined),
  readAgentTemplateByPackageName: vi.fn(),
  deleteAgentTemplate: vi.fn(async () => true),
  deleteAgentSkillsForSlugs: vi.fn(async () => undefined),
  cleanupForAgent: vi.fn(async () => undefined),
  deleteAssignedSkillsForAgentPackage: vi.fn(
    async (_pkg: string): Promise<{ removed: Array<{ agentPackageName: string; skillId: string }> }> => ({
      removed: [],
    }),
  ),
  /** Call order across the doubled leaves, so ORDERING is asserted, not assumed. */
  order: [] as string[],
}));

vi.mock("../extension-handler-rollback", () => ({
  rmDirForRolledBackInstall: mocks.rmDirForRolledBackInstall,
  triggerReloadAfterRollback: mocks.triggerReloadAfterRollback,
}));
vi.mock("@cinatra-ai/skills", () => ({
  upsertSkill: vi.fn(),
  deleteAgentSkillsForSlugs: mocks.deleteAgentSkillsForSlugs,
  parseFrontmatter: vi.fn(),
  enqueueInlineForAgent: vi.fn(),
  cleanupForAgent: mocks.cleanupForAgent,
}));
vi.mock("@cinatra-ai/agents", () => ({
  installAgentPackageWithDependencies: vi.fn(),
  extractAgentPackage: vi.fn(),
  cleanupExtractedAgentPackage: vi.fn(),
  deleteAgentTemplate: mocks.deleteAgentTemplate,
  readAgentTemplateByPackageName: mocks.readAgentTemplateByPackageName,
  updateAgentTemplate: vi.fn(),
}));
vi.mock("@cinatra-ai/registries", () => {
  class PluginDependencyCycleError extends Error {}
  class InstanceNamespaceNotConfiguredError extends Error {}
  return { PluginDependencyCycleError, InstanceNamespaceNotConfiguredError };
});
vi.mock("@/lib/verdaccio-config", () => ({ loadVerdaccioConfigForServer: vi.fn() }));
vi.mock("@/lib/agent-assigned-skills-store", () => ({
  deleteAssignedSkillsForAgentPackage: mocks.deleteAssignedSkillsForAgentPackage,
}));

import { createAgentExtensionHandler } from "../extension-handler";
import { withInstallLock } from "../materialize-agent-package";

const actor = {
  userId: "user-1",
  organizationId: "org-1",
  source: "ui" as const,
  actorType: "human" as const,
};
const AGENT_PKG = "@cinatra-ai/web-scrape-agent";
const ref = { registryUrl: "https://r.example.com", packageName: AGENT_PKG, version: "1.0.0" };

beforeEach(() => {
  mocks.order.length = 0;
  vi.clearAllMocks();
  mocks.deleteAssignedSkillsForAgentPackage.mockImplementation(async () => {
    mocks.order.push("sweep-assignments");
    return { removed: [] };
  });
  mocks.readAgentTemplateByPackageName.mockImplementation(async () => {
    mocks.order.push("read-template");
    return { id: "tpl-1" };
  });
  mocks.deleteAgentSkillsForSlugs.mockImplementation(async () => {
    mocks.order.push("delete-agent-skills");
    return undefined;
  });
  mocks.deleteAgentTemplate.mockImplementation(async () => {
    mocks.order.push("delete-template");
    return true;
  });
  mocks.cleanupForAgent.mockImplementation(async () => {
    mocks.order.push("cleanup-matches");
    return undefined;
  });
});

describe("agent extension uninstall — direct skill-assignment teardown", () => {
  it("sweeps the agent's assignments BEFORE reading the template", async () => {
    await createAgentExtensionHandler().uninstall(ref, actor);

    expect(mocks.deleteAssignedSkillsForAgentPackage).toHaveBeenCalledWith(AGENT_PKG);
    expect(mocks.order[0]).toBe("sweep-assignments");
    expect(mocks.order).toEqual([
      "sweep-assignments",
      "read-template",
      "delete-agent-skills",
      "delete-template",
      "cleanup-matches",
    ]);
  });

  it("sweeps a PROVIDER-DECLARED agent that has no template row (the early return)", async () => {
    // No `agent_templates` row: the handler returns early. Assignment rows are
    // keyed on the PACKAGE NAME and exist regardless, so the sweep must already
    // have run.
    mocks.readAgentTemplateByPackageName.mockImplementation(async () => {
      mocks.order.push("read-template");
      return null;
    });

    await createAgentExtensionHandler().uninstall(ref, actor);

    expect(mocks.deleteAssignedSkillsForAgentPackage).toHaveBeenCalledWith(AGENT_PKG);
    expect(mocks.order).toEqual(["sweep-assignments", "read-template"]);
    expect(mocks.deleteAgentTemplate).not.toHaveBeenCalled();
  });

  it("is keyed on the AGENT PACKAGE NAME, not the slug the skill cleanup uses", async () => {
    await createAgentExtensionHandler().uninstall(ref, actor);
    expect(mocks.deleteAssignedSkillsForAgentPackage).toHaveBeenCalledWith(AGENT_PKG);
    // The sibling agent-skill cleanup keys on the SLUG — a different key space.
    expect(mocks.deleteAgentSkillsForSlugs).toHaveBeenCalledWith(["cinatra-ai-web-scrape-agent"]);
  });

  it("ABORTS the uninstall when the sweep fails — nothing destructive has run", async () => {
    mocks.deleteAssignedSkillsForAgentPackage.mockRejectedValueOnce(new Error("db down"));

    await expect(createAgentExtensionHandler().uninstall(ref, actor)).rejects.toThrow(/db down/);

    expect(mocks.readAgentTemplateByPackageName).not.toHaveBeenCalled();
    expect(mocks.deleteAgentTemplate).not.toHaveBeenCalled();
    expect(mocks.rmDirForRolledBackInstall).not.toHaveBeenCalled();
  });

  it("waits for a COMPETING holder of its own package lock before sweeping", async () => {
    // Proof that the handler takes the lock ITSELF (codex round 1): a separate
    // async context holds the same key first, so a handler that never acquired
    // it would sweep immediately. Deliberately NOT wrapped around the handler —
    // an enclosing acquire would be re-entrant and prove nothing.
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const holder = withInstallLock(AGENT_PKG, () => held);
    await Promise.resolve();

    const uninstalling = createAgentExtensionHandler().uninstall(ref, actor);
    await new Promise((r) => setTimeout(r, 20));
    expect(mocks.deleteAssignedSkillsForAgentPackage).not.toHaveBeenCalled();

    release();
    await Promise.all([holder, uninstalling]);
    expect(mocks.deleteAssignedSkillsForAgentPackage).toHaveBeenCalledWith(AGENT_PKG);
  });

  it("an assign attempted CONCURRENTLY never interleaves with the uninstall's critical section", async () => {
    // The real lock, two async contexts. The "assign" stands in for S1's
    // `assignAgentSkill`, which wraps its revalidate→insert section in
    // `withInstallLock`; the global extension-lifecycle queue inside
    // `withInstallLock` orders it against ANY package's uninstall.
    //
    // BOTH ends of the sweep are marked (codex round 1): asserting only that
    // "sweep" precedes "assign" would still pass if the assign ran DURING the
    // sweep's await, which is precisely the interleaving under test.
    const observed: string[] = [];
    mocks.deleteAssignedSkillsForAgentPackage.mockImplementation(async () => {
      observed.push("sweep:start");
      await new Promise((r) => setTimeout(r, 5));
      observed.push("sweep:end");
      return { removed: [] };
    });
    // …and the LAST destructive step of the handler, so the window under test is
    // the whole uninstall rather than the sweep alone.
    mocks.triggerReloadAfterRollback.mockImplementation(async () => {
      observed.push("handler:end");
      return undefined;
    });

    const uninstalling = createAgentExtensionHandler().uninstall(ref, actor);
    const assigning = withInstallLock("@cinatra-ai/list-curation-skill", async () => {
      observed.push("assign");
    });

    await Promise.all([uninstalling, assigning]);
    // The assertion is the WHOLE critical section, not just the sweep (codex
    // round 2): every handler marker is contiguous, so the assign landed
    // strictly before the handler started or strictly after it finished — never
    // inside the window between "the sweep passed this agent" and "the template
    // and disk are gone".
    expect(observed).toContain("assign");
    const handlerMarkers = observed.filter((e) => e !== "assign");
    const firstHandler = observed.indexOf(handlerMarkers[0]!);
    expect(observed.slice(firstHandler, firstHandler + handlerMarkers.length)).toEqual(
      handlerMarkers,
    );
  });
});

describe("REINSTALL-NO-RESURRECTION — agent side (cinatra#2350 scope item 3)", () => {
  it("reinstalling the same agent does NOT bring back the swept assignments", async () => {
    const rows = new Map<string, string[]>([[AGENT_PKG, ["@cinatra-ai/list-curation-skill:list-curation"]]]);
    mocks.deleteAssignedSkillsForAgentPackage.mockImplementation(async (pkg: string) => {
      const removed = (rows.get(pkg) ?? []).map((skillId) => ({ agentPackageName: pkg, skillId }));
      rows.delete(pkg);
      return { removed };
    });

    // 1. Uninstall sweeps the row.
    await createAgentExtensionHandler().uninstall(ref, actor);
    const first = await mocks.deleteAssignedSkillsForAgentPackage.mock.results[0]?.value;
    expect(first.removed).toHaveLength(1);
    expect(rows.has(AGENT_PKG)).toBe(false);

    // 2. Reinstall the SAME package name — nothing on the install path writes
    //    assignment rows (the admin's assign action is the store's only
    //    writer), so the second uninstall finds nothing.
    await createAgentExtensionHandler().uninstall(ref, actor);
    const second = await mocks.deleteAssignedSkillsForAgentPackage.mock.results[1]?.value;
    expect(second.removed).toEqual([]);
  });
});
