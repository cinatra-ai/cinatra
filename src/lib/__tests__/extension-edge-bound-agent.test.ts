import { describe, it, expect, vi } from "vitest";
import {
  resolveEdgeBoundAgentVersion,
  EdgeBoundAgentServingError,
  type ResolveEdgeBoundAgentDeps,
} from "@/lib/extension-edge-bound-agent";
import type { InstalledExtension } from "@cinatra-ai/extensions/canonical-types";

// cinatra#1040 S5 — edge-bound agent serving (DI-unit; no DB). Proves the
// resolver maps a KNOWN dependent install id + target package to the
// resolved-edge version, serves the default freely, serves a non-default
// version WITH a published snapshot, and REFUSES-WITH-EVIDENCE a non-default
// version WITHOUT one (never silently serving the default).

const DEP = "iext_dependent";
const TARGET = "@cinatra-ai/agent-d";

function install(over: Partial<InstalledExtension>): InstalledExtension {
  return {
    id: "iext_x",
    packageName: TARGET,
    ownerLevel: "organization",
    ownerId: "org1",
    organizationId: "org1",
    kind: "agent",
    status: "active",
    isDefault: true,
    dependencyEdges: [],
    ...over,
  } as InstalledExtension;
}

function deps(
  rows: Record<string, InstalledExtension | null>,
  opts: { snapshot?: boolean; template?: boolean } = {},
): ResolveEdgeBoundAgentDeps {
  return {
    readInstalledExtensionById: vi.fn(async (id: string) => rows[id] ?? null),
    readAgentTemplateByPackageName: vi.fn(async () =>
      opts.template === false ? null : { id: "tmpl-d" },
    ),
    readAgentTemplateVersionBySemver: vi.fn(async () =>
      opts.snapshot === false ? null : { id: "snap-1" },
    ),
  };
}

describe("resolveEdgeBoundAgentVersion", () => {
  it("returns { resolved: false } when the dependent has no resolved edge to the target", async () => {
    const dependent = install({ id: DEP, packageName: "@cinatra-ai/consumer", dependencyEdges: [] });
    const out = await resolveEdgeBoundAgentVersion(
      { dependentInstallId: DEP, targetPackageName: TARGET },
      deps({ [DEP]: dependent }),
    );
    expect(out).toEqual({ resolved: false });
  });

  it("returns { resolved: false } when the dependent row is missing", async () => {
    const out = await resolveEdgeBoundAgentVersion(
      { dependentInstallId: DEP, targetPackageName: TARGET },
      deps({ [DEP]: null }),
    );
    expect(out).toEqual({ resolved: false });
  });

  it("serves the DEFAULT resolved version without requiring a snapshot", async () => {
    const dependent = install({
      id: DEP,
      packageName: "@cinatra-ai/consumer",
      dependencyEdges: [
        { packageName: TARGET, versionConstraint: { kind: "range", range: "^0.2.0" }, resolvedInstallId: "iext_def", resolutionReason: "scoped:org" } as never,
      ],
    });
    const def = install({ id: "iext_def", version: "0.2.0", isDefault: true });
    const out = await resolveEdgeBoundAgentVersion(
      { dependentInstallId: DEP, targetPackageName: TARGET },
      deps({ [DEP]: dependent, iext_def: def }, { snapshot: false }), // snapshot not needed
    );
    expect(out).toEqual({ resolved: true, version: "0.2.0", isDefault: true, resolvedInstallId: "iext_def" });
  });

  it("serves a NON-DEFAULT resolved version that HAS a published snapshot", async () => {
    const dependent = install({
      id: DEP,
      packageName: "@cinatra-ai/consumer",
      dependencyEdges: [
        { packageName: TARGET, versionConstraint: { kind: "range", range: "^0.1.0" }, resolvedInstallId: "iext_sib", resolutionReason: "scoped:org" } as never,
      ],
    });
    const sib = install({ id: "iext_sib", version: "0.1.4", isDefault: false });
    const out = await resolveEdgeBoundAgentVersion(
      { dependentInstallId: DEP, targetPackageName: TARGET },
      deps({ [DEP]: dependent, iext_sib: sib }, { snapshot: true }),
    );
    expect(out).toEqual({ resolved: true, version: "0.1.4", isDefault: false, resolvedInstallId: "iext_sib", snapshotId: "snap-1" });
  });

  it("REFUSES-WITH-EVIDENCE a NON-DEFAULT resolved version with NO snapshot (never serves the default)", async () => {
    const dependent = install({
      id: DEP,
      packageName: "@cinatra-ai/consumer",
      dependencyEdges: [
        { packageName: TARGET, versionConstraint: { kind: "range", range: "^0.1.0" }, resolvedInstallId: "iext_sib", resolutionReason: "scoped:org" } as never,
      ],
    });
    const sib = install({ id: "iext_sib", version: "0.1.4", isDefault: false });
    await expect(
      resolveEdgeBoundAgentVersion(
        { dependentInstallId: DEP, targetPackageName: TARGET },
        deps({ [DEP]: dependent, iext_sib: sib }, { snapshot: false }),
      ),
    ).rejects.toBeInstanceOf(EdgeBoundAgentServingError);
    await expect(
      resolveEdgeBoundAgentVersion(
        { dependentInstallId: DEP, targetPackageName: TARGET },
        deps({ [DEP]: dependent, iext_sib: sib }, { snapshot: false }),
      ),
    ).rejects.toMatchObject({
      code: "EDGE_BOUND_AGENT_UNREACHABLE",
      dependentInstallId: DEP,
      targetPackageName: TARGET,
      resolvedInstallId: "iext_sib",
      resolvedVersion: "0.1.4",
    });
  });

  it("returns { resolved: false } when the resolved install row dangles (target deleted after the edge was written)", async () => {
    const dependent = install({
      id: DEP,
      packageName: "@cinatra-ai/consumer",
      dependencyEdges: [
        { packageName: TARGET, versionConstraint: { kind: "range", range: "^0.1.0" }, resolvedInstallId: "iext_gone", resolutionReason: "scoped:org" } as never,
      ],
    });
    const out = await resolveEdgeBoundAgentVersion(
      { dependentInstallId: DEP, targetPackageName: TARGET },
      deps({ [DEP]: dependent, iext_gone: null }),
    );
    expect(out).toEqual({ resolved: false });
  });
});
