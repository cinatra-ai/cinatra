import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CG-5 cross-org denial on BOTH transports (cinatra#660). A runtime cube
// contributed by an org-A install must NOT serve for an org-B actor on EITHER
// the HTTP cubejs transport or the MCP cube transport — proving neither path is
// a tenant-isolation bypass. A BUNDLED cube serves on both (install-row bypass;
// the drizzle-cube tenant predicate still applies downstream and is exercised by
// the cube SQL tests).

import type { ActorContext } from "@/lib/authz/actor-context";
import type { InstalledExtensionReadModel } from "@/lib/installed-extension-read-model.server";

// Mock the read-model so we control actor-scoped visibility + trust per actor.
const readModelMock = vi.fn<
  (pkg: string, actor: ActorContext | null | undefined) => Promise<InstalledExtensionReadModel>
>();
vi.mock("@/lib/installed-extension-read-model.server", () => ({
  buildInstalledExtensionReadModel: (pkg: string, actor: ActorContext | null | undefined) =>
    readModelMock(pkg, actor),
}));

import {
  __resetRuntimeCubeRegistryForTests,
  registerRuntimeCubes,
} from "@cinatra-ai/dashboards/runtime-cube-registry";
import {
  assertRuntimeCubeServeable,
  assertMcpRuntimeCubeServeable,
  filterCubeIdsForActor,
} from "@/lib/dashboards/runtime-cube-serve-host";

const PKG = "@vendor/runtime-cube-ext";
const orgScope = { ownerLevel: "organization", ownerId: "org_A", organizationId: "org_A" };

function actor(orgId: string): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: `user_${orgId}`,
    authSource: "ui",
    policyVersion: "v2",
    organizationId: orgId,
    teamIds: [],
  } as ActorContext;
}

function readModel(over: Partial<InstalledExtensionReadModel>): InstalledExtensionReadModel {
  return {
    packageName: PKG,
    actorVisible: false,
    status: "absent",
    kind: null,
    ownerScope: null,
    trust: null,
    signatureVerified: null,
    sourcePackageStoreRecordPresent: false,
    activationGeneration: 1,
    teardownState: "torn-down",
    ...over,
  };
}

beforeEach(() => {
  __resetRuntimeCubeRegistryForTests();
  readModelMock.mockReset();
  registerRuntimeCubes({
    sourcePackageName: PKG,
    ownerScope: orgScope,
    descriptors: [{ cubeId: "ext_runtime_cube", fromTable: "agent_runs", members: ["count"] }],
    activationGeneration: 1,
  });
});
afterEach(() => {
  __resetRuntimeCubeRegistryForTests();
});

describe("CG-5 runtime-cube serve-gate — cross-org denial on BOTH transports", () => {
  it("HTTP: an org-A runtime cube serves for an org-A actor (install-active + trusted)", async () => {
    readModelMock.mockResolvedValue(
      readModel({ actorVisible: true, status: "active", trust: { tier: "trusted-signed", trusted: true, reason: "ok" } }),
    );
    const r = await assertRuntimeCubeServeable("ext_runtime_cube", actor("org_A"));
    expect(r.ok).toBe(true);
  });

  it("HTTP: the SAME runtime cube is DENIED for an org-B actor (not addressable) — cube_not_active", async () => {
    // org-B actor: the read-model returns absent (no addressable row for this actor).
    readModelMock.mockResolvedValue(readModel({ actorVisible: false, status: "absent" }));
    const r = await assertRuntimeCubeServeable("ext_runtime_cube", actor("org_B"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("cube_not_active");
  });

  it("MCP: an org-A runtime cube serves for an org-A actor", async () => {
    readModelMock.mockResolvedValue(
      readModel({ actorVisible: true, status: "active", trust: { tier: "trusted-signed", trusted: true, reason: "ok" } }),
    );
    const r = await assertMcpRuntimeCubeServeable("ext_runtime_cube", { userId: "user_A", organizationId: "org_A" });
    expect(r.ok).toBe(true);
  });

  it("MCP: the SAME runtime cube is DENIED for an org-B actor — cube_not_active", async () => {
    readModelMock.mockResolvedValue(readModel({ actorVisible: false, status: "absent" }));
    const r = await assertMcpRuntimeCubeServeable("ext_runtime_cube", { userId: "user_B", organizationId: "org_B" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("cube_not_active");
  });

  it("BOTH: a BUNDLED cube serves for ANY actor without an install-row lookup (install-row bypass)", async () => {
    // The read-model must NOT be consulted for a bundled cube.
    const http = await assertRuntimeCubeServeable("agent_runs", actor("org_B"));
    const mcp = await assertMcpRuntimeCubeServeable("agent_runs", { userId: "user_B", organizationId: "org_B" });
    expect(http.ok).toBe(true);
    expect(mcp.ok).toBe(true);
    expect(readModelMock).not.toHaveBeenCalled();
  });

  it("untrusted runtime cube is DENIED even when install-active — cube_untrusted", async () => {
    readModelMock.mockResolvedValue(
      readModel({ actorVisible: true, status: "active", trust: { tier: "untrusted", trusted: false, reason: "no sig" } }),
    );
    const r = await assertRuntimeCubeServeable("ext_runtime_cube", actor("org_A"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("cube_untrusted");
  });

  it("catalog filter: a runtime cube the actor cannot serve is dropped from /meta + discover", async () => {
    readModelMock.mockResolvedValue(readModel({ actorVisible: false, status: "absent" }));
    const out = await filterCubeIdsForActor(["agent_runs", "ext_runtime_cube"], actor("org_B"));
    expect(out).toEqual(["agent_runs"]); // bundled kept, runtime dropped
  });
});
