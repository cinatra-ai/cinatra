// buildWorkflowHandlerDeps().assertTemplateSourceDependencyClosure — the host
// half of the workflow "fail-instantiate" optional-missing behavior:
// governing-row selection (actor org → platform → first live), the
// archived-only DENY (mirrors assertExtensionAccess), the actor-scoped
// dependency lookup (no cross-org bleed), and the ungoverned allow.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ExtensionDependency,
  InstalledExtension,
} from "@cinatra-ai/extensions/canonical-types";

const readByPackageNameMock = vi.fn();
const listAllMock = vi.fn();
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionsByPackageName: (...args: unknown[]) => readByPackageNameMock(...args),
  listInstalledExtensions: (...args: unknown[]) => listAllMock(...args),
}));
vi.mock("@cinatra-ai/extensions/enforce-extension-access", () => ({
  enforceExtensionAccess: vi.fn(),
}));
vi.mock("@/lib/project-writable", () => ({
  assertProjectWritableSync: vi.fn(),
  assertProjectWritable: vi.fn(),
}));
vi.mock("@/lib/better-auth-db", () => ({ readProjectGrantsForUser: vi.fn() }));
vi.mock("@/lib/workflow-agent-executor", () => ({ workflowAgentRefAvailable: vi.fn() }));
vi.mock("@/lib/workflow-approvers", () => ({ approverResolvable: vi.fn() }));
vi.mock("@/lib/auth-session", () => ({ resolveOrgRoleForUser: vi.fn() }));
vi.mock("@/lib/authz/actor-context", () => ({ POLICY_VERSION: "test" }));

import { buildWorkflowHandlerDeps } from "@/lib/workflow-host-deps";

function row(
  packageName: string,
  over: Partial<InstalledExtension> = {},
): InstalledExtension {
  return {
    id: `id-${packageName}-${over.organizationId ?? "platform"}`,
    packageName,
    ownerLevel: "platform",
    ownerId: null,
    organizationId: null,
    kind: "workflow",
    status: "active",
    source: { type: "local", path: `/x/${packageName}`, resolvedCommitOrTreeHash: "h" },
    requiredInProd: false,
    dependencies: [],
    manifestHash: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}
const dep = (packageName: string, requirement: "required" | "optional"): ExtensionDependency => ({
  packageName,
  edgeType: "runtime",
  versionConstraint: { kind: "semver-range", range: "*" },
  requirement,
});

const PKG = "@cinatra-ai/demo-workflow";
const actor = { userId: "u", orgId: "org-b" };
const gate = () => buildWorkflowHandlerDeps().assertTemplateSourceDependencyClosure!;

beforeEach(() => {
  listAllMock.mockResolvedValue([]);
});
afterEach(() => {
  readByPackageNameMock.mockReset();
  listAllMock.mockReset();
  vi.restoreAllMocks();
});

describe("assertTemplateSourceDependencyClosure", () => {
  it("no workflow rows at all → ungoverned, allows", async () => {
    readByPackageNameMock.mockResolvedValue([]);
    await expect(gate()(actor, PKG)).resolves.toBeUndefined();
    expect(listAllMock).not.toHaveBeenCalled();
  });

  it("non-workflow rows of the same package do not govern", async () => {
    readByPackageNameMock.mockResolvedValue([row(PKG, { kind: "skill" })]);
    await expect(gate()(actor, PKG)).resolves.toBeUndefined();
  });

  it("governed but archived-only → DENIES (mirrors assertExtensionAccess)", async () => {
    readByPackageNameMock.mockResolvedValue([row(PKG, { status: "archived" })]);
    await expect(gate()(actor, PKG)).rejects.toThrow(/not active/);
  });

  it("intact closure → allows", async () => {
    const wf = row(PKG, { dependencies: [dep("@x/lib", "required")] });
    readByPackageNameMock.mockResolvedValue([wf]);
    listAllMock.mockResolvedValue([wf, row("@x/lib")]);
    await expect(gate()(actor, PKG)).resolves.toBeUndefined();
  });

  it("broken REQUIRED closure → throws naming the missing dep", async () => {
    const wf = row(PKG, { dependencies: [dep("@x/lib", "required")] });
    readByPackageNameMock.mockResolvedValue([wf]);
    listAllMock.mockResolvedValue([wf]);
    await expect(gate()(actor, PKG)).rejects.toThrow(/required dependencies: @x\/lib/);
  });

  it("missing OPTIONAL dep → fail-instantiate throw (workflow per-kind behavior)", async () => {
    const wf = row(PKG, { dependencies: [dep("@x/maybe", "optional")] });
    readByPackageNameMock.mockResolvedValue([wf]);
    listAllMock.mockResolvedValue([wf]);
    await expect(gate()(actor, PKG)).rejects.toThrow(/fails instantiation on missing optional/);
  });

  it("governing-row selection: the actor-org row wins over the platform row", async () => {
    // Org row's closure is broken; platform row's is clean. The actor's org
    // row governs, so the gate must throw.
    const orgRow = row(PKG, {
      organizationId: "org-b",
      dependencies: [dep("@x/lib", "required")],
    });
    const platRow = row(PKG);
    readByPackageNameMock.mockResolvedValue([platRow, orgRow]);
    listAllMock.mockResolvedValue([platRow, orgRow]);
    await expect(gate()(actor, PKG)).rejects.toThrow(/required dependencies: @x\/lib/);
  });

  it("no cross-org bleed: a dep live ONLY in a foreign org does not satisfy; a platform dep does", async () => {
    const wf = row(PKG, {
      organizationId: "org-b",
      dependencies: [dep("@x/lib", "required")],
    });
    readByPackageNameMock.mockResolvedValue([wf]);

    listAllMock.mockResolvedValue([wf, row("@x/lib", { organizationId: "org-a" })]);
    await expect(gate()(actor, PKG)).rejects.toThrow(/required dependencies: @x\/lib/);

    listAllMock.mockResolvedValue([wf, row("@x/lib")]); // platform-scoped dep
    await expect(gate()(actor, PKG)).resolves.toBeUndefined();
  });
});
