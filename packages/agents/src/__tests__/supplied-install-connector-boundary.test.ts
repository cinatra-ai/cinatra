/**
 * WHAT THE SUPPLIED ROAD PROMISES FOR A CONNECTOR, AND WHAT IT DOES NOT
 * (cinatra#3204 leg 3 — criteria 21, 22, 27).
 *
 * The issue is explicit that "success is not promised for every connector
 * package", and leg 1 settled HOW that refusal happens: a connector's whole
 * install exists to run `register(ctx)` in this process, so an unsigned supplied
 * connector is refused by the trust gate rather than activated. Criterion 27's
 * per-kind execution boundary is the same fact stated from the other side.
 *
 * A refusal is only honest if the operator can read it. These are the claims:
 *
 *   - a connector package is ACCEPTED at the door — the kind resolves, the scope
 *     question is asked — so the refusal happens where the reason is known, not
 *     as a file the screen would not take;
 *   - the TYPED `REQUIRES_REBUILD` state arrives as a named state with the
 *     packageName in it, never as a generic "the install failed";
 *   - the trust-gate refusal arrives in the PIPELINE's own words, so the reason
 *     the operator must act on is not replaced by a summary;
 *   - a refused install writes no access policy and rolls nothing back that it
 *     did not create.
 *
 * And the anchor claim criterion 22 names: the compensation addresses the row at
 * the CHOSEN identity and nothing else, so a coexisting bundled PLATFORM anchor
 * for the same package name is never read and never uninstalled.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const session = vi.hoisted(() => ({
  user: { id: "u1" },
  session: { activeOrganizationId: "org-1" },
}));
vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: vi.fn(async () => session),
  buildCanDoOptsFromSession: vi.fn(async () => ({ orgRole: "org_admin" })),
}));
vi.mock("../install-target-authz", () => ({
  readActorRolesForInstall: vi.fn(() => ({ principalId: "u1", organizationId: "org-1" })),
  assertTargetBelongsToActiveOrg: vi.fn(async () => ({ projectOwnership: null })),
  assertCanInstallAtTarget: vi.fn(async () => undefined),
}));

const road = vi.hoisted(() => ({
  prepareSuppliedArchiveSnapshot: vi.fn(async () => ({
    package: {
      kind: "connector",
      packageName: "@acme/thing-connector",
      version: "1.0.0",
      contentDigest: "a".repeat(64),
      provenance: { type: "local", path: "x.tgz", contentDigest: "a".repeat(64) },
    },
    tarball: new Uint8Array([1]),
    provenance: { type: "local", path: "x.tgz", contentDigest: "a".repeat(64) },
    validatorRan: true,
  })),
  candidateFromPreparedArchive: vi.fn(
    (p: { package: Record<string, unknown>; provenance: unknown; validatorRan: boolean }) => ({
      kind: p.package.kind,
      packageName: p.package.packageName,
      version: p.package.version,
      provenance: p.provenance,
      validatorRan: p.validatorRan,
    }),
  ),
  installSuppliedCandidate: vi.fn(async () => undefined),
  prepareSuppliedRepositorySnapshot: vi.fn(),
}));
vi.mock("@/lib/supplied-package-install", () => road);

const store = vi.hoisted(() => ({
  readInstalledExtensionByIdentity: vi.fn(
    async (_identity?: unknown) => null as Record<string, unknown> | null,
  ),
}));
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionByIdentity: (...a: unknown[]) =>
    store.readInstalledExtensionByIdentity(...(a as [])),
}));

const access = vi.hoisted(() => ({ setExtensionInstallAccess: vi.fn(async () => undefined) }));
vi.mock("@cinatra-ai/extensions/install-access-contract", () => access);

const registry = vi.hoisted(() => ({
  extensionRegistry: { uninstall: vi.fn(async () => undefined) },
}));
vi.mock("@cinatra-ai/extensions", () => registry);

vi.mock("../materialize-agent-package", () => ({
  withInstallLock: (_p: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock("../store", () => ({ readAgentTemplateByPackageName: vi.fn(async () => ({ id: "t" })) }));
vi.mock("@/lib/archive-supplied-install", () => ({
  previewSuppliedArchive: vi.fn(async () => ({
    kind: "connector",
    packageName: "@acme/thing-connector",
    version: "1.0.0",
    contentDigest: "a".repeat(64),
  })),
}));

import {
  installSuppliedArchiveAction,
  previewSuppliedArchiveAction,
} from "../supplied-install-actions";

const ZIP = Buffer.from("zip").toString("base64");
const TARGET = { level: "workspace", id: "org-1" };

const TRUST_REFUSAL =
  "[extension-install-pipeline] @acme/thing-connector@1.0.0: the install was refused — " +
  "the origin supplied:operator is not an allow-listed activation host.";

beforeEach(() => {
  vi.clearAllMocks();
  store.readInstalledExtensionByIdentity.mockResolvedValue(null as never);
  road.installSuppliedCandidate.mockResolvedValue(undefined as never);
});

describe("a connector is taken at the door and refused where the reason is known", () => {
  it("resolves the connector kind on preview, so the scope question is still asked", async () => {
    const result = await previewSuppliedArchiveAction(ZIP);
    expect(result.ok).toBe(true);
    expect(result.ok && result.preview.kind).toBe("connector");
  });

  it("surfaces the TYPED requires-rebuild state by name, not as a generic failure", async () => {
    road.installSuppliedCandidate.mockRejectedValue(
      Object.assign(new Error("ships a bundled React setup page"), {
        code: "REQUIRES_REBUILD",
      }) as never,
    );

    const result = await installSuppliedArchiveAction({
      zipBase64: ZIP,
      accessTarget: TARGET,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.stage).toBe("requires-rebuild");
    expect(result.ok === false && result.error).toContain("@acme/thing-connector");
    expect(result.ok === false && result.error).toMatch(/rebuild/i);
    // Nothing was recorded for a package that never installed.
    expect(access.setExtensionInstallAccess).not.toHaveBeenCalled();
    expect(registry.extensionRegistry.uninstall).not.toHaveBeenCalled();
  });

  it("passes the trust-gate refusal through in the pipeline's own words", async () => {
    road.installSuppliedCandidate.mockRejectedValue(new Error(TRUST_REFUSAL) as never);

    const result = await installSuppliedArchiveAction({
      zipBase64: ZIP,
      accessTarget: TARGET,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe(TRUST_REFUSAL);
    expect(result.ok === false && result.stage).toBeUndefined();
    expect(access.setExtensionInstallAccess).not.toHaveBeenCalled();
  });
});

describe("the compensation addresses the CHOSEN row and nothing else (criterion 22)", () => {
  it("never reads or uninstalls a row at an anchor the operator did not choose", async () => {
    access.setExtensionInstallAccess.mockRejectedValue(new Error("policy write failed") as never);
    store.readInstalledExtensionByIdentity.mockImplementation(async (identity: unknown) => {
      const id = identity as { ownerLevel: string };
      // A bundled PLATFORM anchor for the same package name exists. It must
      // never be the row this road reads, because it is not the row it wrote.
      if (id.ownerLevel === "platform") return { id: "bundled", kind: "connector", status: "active" };
      return { id: "chosen", kind: "connector", status: "active" };
    });

    await installSuppliedArchiveAction({ zipBase64: ZIP, accessTarget: TARGET });

    const levels = (
      store.readInstalledExtensionByIdentity.mock.calls as unknown as unknown[][]
    ).map(
      (c) => (c[0] as { ownerLevel: string }).ownerLevel,
    );
    expect(levels.length).toBeGreaterThan(0);
    expect(levels).not.toContain("platform");
    expect(new Set(levels)).toEqual(new Set(["workspace"]));
  });
});
