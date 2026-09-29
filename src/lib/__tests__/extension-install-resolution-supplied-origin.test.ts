import { describe, it, expect, vi, beforeEach } from "vitest";

// The canonical-store read is the ONE IO seam gate (a) of the trusted-runtime
// resolver uses that carries no dependency-injection hook; every other seam the
// resolver touches (the trust anchor, the store root, record discovery,
// integrity verification, the manifest read) is injected below. The trust
// CLASSIFIER itself is deliberately NOT injected: this test exists to measure
// the real classifier is asked the right question.
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionsByPackageName: vi.fn(async () => [
    {
      id: "iext_supplied_1",
      status: "active",
      organizationId: null,
      ownerId: null,
      ownerLevel: "workspace",
      isDefault: true,
    },
  ]),
}));

import { resolveRuntimeConnectorCardRecord } from "@/lib/extension-install-resolution";
import type { ActorContext } from "@/lib/authz/actor-context";
import type { InstallTrustAnchor } from "@/lib/extension-package-store";
import type { PackageStoreRecord } from "@cinatra-ai/sdk-extensions";

const PACKAGE = "@acme/supplied-origin-connector";

const actor = {
  principalType: "HumanUser" as const,
  principalId: "user-1",
  platformRole: "platform_admin" as const,
  authSource: "session",
  policyVersion: "1",
} as unknown as ActorContext;

function record(): PackageStoreRecord {
  return {
    packageName: PACKAGE,
    storeDir: "/store/acme/supplied-origin-connector/d1",
    declaredDigest: "d1",
    kind: "connector",
    uiSurface: "schema-config",
  } as unknown as PackageStoreRecord;
}

function anchor(extra: Partial<InstallTrustAnchor>): InstallTrustAnchor {
  return {
    integrity: "sha512-x",
    contentHash: "c1",
    registryUrl: null,
    trustDecision: true,
    digest: "d1",
    kind: "connector",
    ...extra,
  } as unknown as InstallTrustAnchor;
}

function deps(a: InstallTrustAnchor) {
  return {
    resolveTrustAnchor: async () => a,
    storeRoot: "/store",
    discoverRecords: async () => [record()],
    verifyIntegrity: async () => true,
    readManifest: async () => ({ cinatra: { displayName: "Supplied Origin" } }),
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe("the trusted-runtime connector gate asks the classifier the ORIGIN question the anchor records (cinatra#3204)", () => {
  it("renders an OPERATOR-SUPPLIED install whose anchor names no registry host", async () => {
    // The exact row the upload road writes: no registry host at all (the bytes
    // were supplied), an unsigned package, a persisted trust decision, verified
    // integrity — and the supplied origin recorded on the anchor.
    const card = await resolveRuntimeConnectorCardRecord(
      PACKAGE,
      actor,
      deps(anchor({ operatorSuppliedOrigin: true })),
    );

    expect(card).not.toBeNull();
    expect(card?.vendor).toBe("acme");
    expect(card?.slug).toBe("supplied-origin-connector");
  });

  it("still refuses the SAME package when the anchor records no supplied origin", async () => {
    // The fail-closed twin: without the recorded origin there is no allowlisted
    // registry host to answer the origin factor, so the gate refuses — the
    // registry road is unchanged by the fix above.
    const card = await resolveRuntimeConnectorCardRecord(
      PACKAGE,
      actor,
      deps(anchor({})),
    );

    expect(card).toBeNull();
  });
});
