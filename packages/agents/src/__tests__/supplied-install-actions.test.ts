/**
 * THE UPLOAD SCREEN'S SERVER BOUNDARY (cinatra#3204 leg 3 — criteria 13, 14, 15,
 * 21, and the scope half of 32).
 *
 * The claims under test are the ones an operator cannot see and therefore cannot
 * check for themselves:
 *
 *   - an ABSENT install scope refuses, for every kind, before anything is
 *     installed (the supplied road's fail-closed rule);
 *   - a target the actor lacks authority for is refused SERVER-SIDE even though
 *     the client sent it;
 *   - the chosen target becomes the canonical row ANCHOR through the shared
 *     contract, not through a second derivation;
 *   - a failed access write ROLLS A FRESH INSTALL BACK, and never touches a row
 *     that was already live.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const session = vi.hoisted(() => ({
  user: { id: "u1" },
  session: { activeOrganizationId: "org-1" },
}));
const authState = vi.hoisted(() => ({
  requireAdminSession: vi.fn(async () => session),
  buildCanDoOptsFromSession: vi.fn(async () => ({ orgRole: "org_admin" })),
}));
vi.mock("@/lib/auth-session", () => authState);

const authz = vi.hoisted(() => ({
  readActorRolesForInstall: vi.fn(() => ({ principalId: "u1", organizationId: "org-1" })),
  assertTargetBelongsToActiveOrg: vi.fn(async () => ({ projectOwnership: null })),
  assertCanInstallAtTarget: vi.fn(async () => undefined),
}));
vi.mock("../install-target-authz", () => authz);

const road = vi.hoisted(() => ({
  prepareSuppliedArchiveSnapshot: vi.fn(async () => ({
    package: {
      kind: "artifact",
      packageName: "@acme/thing-artifact",
      version: "1.0.0",
      contentDigest: "a".repeat(64),
      provenance: { type: "local", path: "x.tgz", contentDigest: "a".repeat(64) },
    },
    tarball: new Uint8Array([1]),
    provenance: { type: "local", path: "x.tgz", contentDigest: "a".repeat(64) },
    validatorRan: true,
  })),
  candidateFromPreparedArchive: vi.fn((prepared: { package: Record<string, unknown>; provenance: unknown; validatorRan: boolean }) => ({
    kind: prepared.package.kind,
    packageName: prepared.package.packageName,
    version: prepared.package.version,
    provenance: prepared.provenance,
    validatorRan: prepared.validatorRan,
  })),
  installSuppliedCandidate: vi.fn(async () => undefined),
  prepareSuppliedRepositorySnapshot: vi.fn(),
}));
vi.mock("@/lib/supplied-package-install", () => road);

const store = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  readInstalledExtensionByIdentity: vi.fn(async () => null as Record<string, unknown> | null),
}));
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionByIdentity: (...a: unknown[]) =>
    store.readInstalledExtensionByIdentity(...(a as [])),
}));

const access = vi.hoisted(() => ({
  setExtensionInstallAccess: vi.fn(async () => undefined),
}));
vi.mock("@cinatra-ai/extensions/install-access-contract", () => access);

const registry = vi.hoisted(() => ({
  extensionRegistry: { uninstall: vi.fn(async () => undefined) },
}));
vi.mock("@cinatra-ai/extensions", () => registry);

vi.mock("../materialize-agent-package", () => ({
  withInstallLock: (_pkg: string, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("../store", () => ({
  readAgentTemplateByPackageName: vi.fn(async () => ({ id: "tpl-1" })),
}));

// The skill kind's consent recorder — server state this suite is not about.
vi.mock("@/lib/anthropic-skill-config-service", () => ({
  snapshotSkillPackageIds: () => new Set<string>(),
  resolveInstalledClosure: () => [],
  recordSkillInstallConsent: () => ({
    grant: false,
    reason: "not-asked",
    outcome: "The skill stays excluded from upload.",
  }),
  buildInstallConsentPrompt: () => ({
    headline: "h",
    advisory: "a",
    closureLines: [],
    closureDigest: "d",
    consentApplies: false,
  }),
}));

import { installSuppliedArchiveAction } from "../supplied-install-actions";

const ZIP = Buffer.from("zip").toString("base64");

beforeEach(() => {
  vi.clearAllMocks();
  store.readInstalledExtensionByIdentity.mockResolvedValue({
    id: "iext-1",
    kind: "artifact",
    status: "active",
  } as never);
  access.setExtensionInstallAccess.mockResolvedValue(undefined as never);
  authz.assertCanInstallAtTarget.mockResolvedValue(undefined as never);
});

describe("the fail-closed scope rule (criterion 13)", () => {
  it("refuses an install with no chosen scope, and installs nothing", async () => {
    const result = await installSuppliedArchiveAction({ zipBase64: ZIP });
    expect(result.ok).toBe(false);
    expect("error" in result && result.error).toMatch(/install scope is required/);
    expect(road.installSuppliedCandidate).not.toHaveBeenCalled();
    expect(road.prepareSuppliedArchiveSnapshot).not.toHaveBeenCalled();
  });

  it("refuses when the session has no active organization", async () => {
    authState.requireAdminSession.mockResolvedValueOnce({
      user: { id: "u1" },
      session: { activeOrganizationId: null },
    } as never);
    const result = await installSuppliedArchiveAction({
      zipBase64: ZIP,
      accessTarget: { level: "workspace", id: "org-1" },
    });
    expect(result.ok).toBe(false);
    expect(road.installSuppliedCandidate).not.toHaveBeenCalled();
  });
});

describe("installer authority stays server-side (criterion 14)", () => {
  it("refuses a target the actor lacks authority for, even when the client sends it", async () => {
    authz.assertCanInstallAtTarget.mockRejectedValueOnce(new Error("forbidden"));
    const result = await installSuppliedArchiveAction({
      zipBase64: ZIP,
      accessTarget: { level: "team", id: "team-9" },
    });
    expect(result.ok).toBe(false);
    expect(road.installSuppliedCandidate).not.toHaveBeenCalled();
  });
});

describe("the chosen target becomes the row anchor (criterion 15)", () => {
  it("installs a WORKSPACE target at the workspace anchor, not the actor's org", async () => {
    const result = await installSuppliedArchiveAction({
      zipBase64: ZIP,
      accessTarget: { level: "workspace", id: "forged-by-the-client" },
    });
    expect(result.ok).toBe(true);
    const call = (road.installSuppliedCandidate.mock.calls[0] as unknown as unknown[])[0] as {
      rowOwnership: { ownerLevel: string; organizationId: string | null };
    };
    expect(call.rowOwnership.ownerLevel).toBe("workspace");
    expect(call.rowOwnership.organizationId).toBeNull();
  });

  it("installs an ORGANIZATION target at the organization anchor", async () => {
    await installSuppliedArchiveAction({
      zipBase64: ZIP,
      accessTarget: { level: "organization", id: "org-1" },
    });
    const call = (road.installSuppliedCandidate.mock.calls[0] as unknown as unknown[])[0] as {
      rowOwnership: { ownerLevel: string; organizationId: string | null };
    };
    expect(call.rowOwnership.ownerLevel).toBe("organization");
    expect(call.rowOwnership.organizationId).toBe("org-1");
  });
});

describe("the access write is fail-closed (criteria 13, 32)", () => {
  it("rolls a FRESH install back when the access write fails", async () => {
    store.readInstalledExtensionByIdentity
      // pre-install snapshot: nothing was there
      .mockResolvedValueOnce(null as never)
      // the post-install row the access write keys on
      .mockResolvedValueOnce({ id: "iext-1", kind: "artifact", status: "active" } as never)
      // the rollback's own read
      .mockResolvedValueOnce({ id: "iext-1", kind: "artifact", status: "active" } as never)
      // after the rollback
      .mockResolvedValueOnce(null as never);
    access.setExtensionInstallAccess.mockRejectedValueOnce(new Error("policy write failed"));

    const result = await installSuppliedArchiveAction({
      zipBase64: ZIP,
      accessTarget: { level: "workspace", id: "org-1" },
    });
    expect(result.ok).toBe(false);
    expect("stage" in result && result.stage).toBe("access");
    expect(registry.extensionRegistry.uninstall).toHaveBeenCalledTimes(1);
  });

  it("never uninstalls a row that was ALREADY live — it reports the partial state", async () => {
    store.readInstalledExtensionByIdentity
      .mockResolvedValueOnce({ id: "iext-1", kind: "artifact", status: "active" } as never)
      .mockResolvedValueOnce({ id: "iext-1", kind: "artifact", status: "active" } as never);
    access.setExtensionInstallAccess.mockRejectedValueOnce(new Error("policy write failed"));

    const result = await installSuppliedArchiveAction({
      zipBase64: ZIP,
      accessTarget: { level: "workspace", id: "org-1" },
    });
    expect(result.ok).toBe(false);
    expect("stage" in result && result.stage).toBe("access-partial");
    expect(registry.extensionRegistry.uninstall).not.toHaveBeenCalled();
  });
});

describe("what a successful install points the operator at (criterion 21)", () => {
  it("names the artifact kind's own observable", async () => {
    const result = await installSuppliedArchiveAction({
      zipBase64: ZIP,
      accessTarget: { level: "workspace", id: "org-1" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.kind).toBe("artifact");
      expect(result.observable.href).toBe("/configuration/extensions");
    }
  });
});

// ---------------------------------------------------------------------------
// EVERY kind's own observable (criterion 21), not only the artifact one.
//
// The artifact case above proved the shape. It could not prove the map, and the
// map is the whole claim: a kind whose install ends on a surface the screen does
// not point at is an install the operator cannot see.
// ---------------------------------------------------------------------------
describe("what a successful install points the operator at, per kind (criterion 21)", () => {
  const CASES = [
    { kind: "agent", packageName: "@acme/thing-agent", href: "/agents" },
    { kind: "skill", packageName: "@acme/thing-skill", href: "/skills" },
    { kind: "artifact", packageName: "@acme/thing-artifact", href: "/configuration/extensions" },
    { kind: "connector", packageName: "@acme/thing-connector", href: "/configuration/connectors" },
  ] as const;

  for (const testCase of CASES) {
    it(`the ${testCase.kind} kind lands on ${testCase.href}`, async () => {
      road.prepareSuppliedArchiveSnapshot.mockResolvedValueOnce({
        package: {
          kind: testCase.kind,
          packageName: testCase.packageName,
          version: "1.0.0",
          contentDigest: "a".repeat(64),
          provenance: { type: "local", path: "x.tgz", contentDigest: "a".repeat(64) },
        },
        tarball: new Uint8Array([1]),
        provenance: { type: "local", path: "x.tgz", contentDigest: "a".repeat(64) },
        validatorRan: true,
      } as never);
      store.readInstalledExtensionByIdentity.mockResolvedValue({
        id: "iext-1",
        kind: testCase.kind,
        status: "active",
      } as never);

      const result = await installSuppliedArchiveAction({
        zipBase64: ZIP,
        accessTarget: { level: "workspace", id: "org-1" },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.kind).toBe(testCase.kind);
        expect(result.observable.href).toBe(testCase.href);
        expect(result.observable.label.length).toBeGreaterThan(0);
      }
    });
  }
});
