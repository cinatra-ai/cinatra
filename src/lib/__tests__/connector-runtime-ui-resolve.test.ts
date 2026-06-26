// The dispatch route's effective UI-render decision for a RUNTIME (marketplace-
// installed) connector — the BLOCKER fix. A schema-config connector installed at
// runtime declares its surface as DATA in the on-disk package store, NOT in the
// base-image static manifest. The route composes
// `chooseConnectorUiRender(runtimeUiRecord ?? staticManifest)`; these tests lock
// the trusted runtime resolution AND the static fallback.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { readRowsMock } = vi.hoisted(() => ({ readRowsMock: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionsByPackageName: readRowsMock,
}));

import {
  resolveRuntimeConnectorUiRecord,
  pickRuntimeConnectorUiRecord,
} from "@/lib/extension-install-resolution";
import { chooseConnectorUiRender } from "@/lib/connector-ui-render";
import type { ActorContext } from "@/lib/authz/actor-context";
import type { PackageStoreRecord } from "@cinatra-ai/sdk-extensions";
import type { InstallTrustAnchor } from "@/lib/extension-package-store";

const PKG = "@cinatra-ai/schema-config-fixture-connector";
const STATIC_BUNDLED = "@cinatra-ai/anthropic-connector";

const actor: ActorContext = {
  principalType: "HumanUser",
  principalId: "u1",
  organizationId: "org-1",
  authSource: "ui",
  policyVersion: "v2",
};

// A trusted anchor for a first-party package from the allowlisted registry with
// an explicit (approved) persisted trust decision — what the canonical install
// pipeline records for a real, finalized install. The trust gate verifies the
// materialized files against it AND classifies the package; both are DI'd below.
const trustedAnchor: InstallTrustAnchor = {
  integrity: "sha512-fixture-integrity",
  contentHash: "fixture-content-hash",
  registryUrl: "https://registry.cinatra.ai",
  trustDecision: true,
  approvedPorts: ["ui", "secrets"],
};

const SCHEMA = {
  title: "Fixture",
  fields: [
    { kind: "secret", key: "apiKey", label: "API key", required: true },
    { kind: "status-probe", label: "Connection", actionId: "probe" },
  ],
};

function storeRecord(over: Partial<PackageStoreRecord> = {}): PackageStoreRecord {
  return {
    packageName: PKG,
    serverEntry: "./register",
    requestedHostPorts: ["ui", "secrets"],
    sdkAbiRange: "^2",
    storeDir: "/data/extensions/packages/sc",
    uiSurface: "schema-config",
    configSchema: SCHEMA,
    ...over,
  };
}

function activeInstallRow() {
  return {
    id: "inst-1",
    status: "active",
    organizationId: "org-1",
    ownerId: "org-1",
    ownerLevel: "organization",
  };
}

beforeEach(() => {
  readRowsMock.mockReset();
});

describe("pickRuntimeConnectorUiRecord (pure)", () => {
  it("returns only uiSurface+configSchema for the matching package", () => {
    const rec = pickRuntimeConnectorUiRecord([storeRecord()], PKG);
    expect(rec).toEqual({ uiSurface: "schema-config", configSchema: SCHEMA });
  });

  it("returns null when no store record matches", () => {
    expect(pickRuntimeConnectorUiRecord([storeRecord()], "@x/other")).toBeNull();
    expect(pickRuntimeConnectorUiRecord([], PKG)).toBeNull();
  });
});

describe("resolveRuntimeConnectorUiRecord (trusted runtime install)", () => {
  it("resolves a trusted runtime schema-config record → route renders the schema-config form", async () => {
    // The anchor is trusted (approved decision, allowlisted registry, integrity
    // verified) but UNSIGNED. The hardened in-process trust default fails-closed
    // on unsigned packages, so this trusted-bootstrap resolution opts in the way
    // a dev/transition deployment would (CINATRA_EXTENSION_ALLOW_UNSIGNED_BOOTSTRAP
    // =true). The fail-closed default is covered by extension-trust-config.test.ts
    // and the FAIL-CLOSED cases below (which never set this flag).
    const priorAllowUnsignedBootstrap = process.env.CINATRA_EXTENSION_ALLOW_UNSIGNED_BOOTSTRAP;
    process.env.CINATRA_EXTENSION_ALLOW_UNSIGNED_BOOTSTRAP = "true";
    try {
      readRowsMock.mockResolvedValue([activeInstallRow()]);
      const runtimeRecord = await resolveRuntimeConnectorUiRecord(PKG, actor, {
        resolveTrustAnchor: async () => trustedAnchor,
        discoverRecords: async () => [storeRecord()],
        verifyIntegrity: async () => true, // on-disk files match the anchor
      });
      expect(runtimeRecord).toEqual({ uiSurface: "schema-config", configSchema: SCHEMA });

      // The route feeds the runtime record (preferred over the static manifest)
      // into the pure decision → schema-config branch (no React import).
      const decision = chooseConnectorUiRender(runtimeRecord);
      expect(decision.kind).toBe("schema-config");
    } finally {
      if (priorAllowUnsignedBootstrap === undefined) delete process.env.CINATRA_EXTENSION_ALLOW_UNSIGNED_BOOTSTRAP;
      else process.env.CINATRA_EXTENSION_ALLOW_UNSIGNED_BOOTSTRAP = priorAllowUnsignedBootstrap;
    }
  });

  it("FAIL-CLOSED: an active install with NO trusted anchor → null (route falls back to static)", async () => {
    readRowsMock.mockResolvedValue([activeInstallRow()]);
    const runtimeRecord = await resolveRuntimeConnectorUiRecord(PKG, actor, {
      resolveTrustAnchor: async () => null, // no real-pipeline install → refuse
      discoverRecords: async () => [storeRecord()],
      verifyIntegrity: async () => true,
    });
    expect(runtimeRecord).toBeNull();
  });

  it("FAIL-CLOSED: a non-null anchor whose persisted trust decision is FALSE (revoked) → null", async () => {
    // The trust gate must reject a revoked anchor even though it is non-null and
    // the on-disk integrity verifies. `classifyExtensionTrust` short-circuits on
    // `persistedTrustDecision === false`, so the real classifier runs here (no
    // classifyTrust override) and the package-store form is never rendered.
    readRowsMock.mockResolvedValue([activeInstallRow()]);
    const runtimeRecord = await resolveRuntimeConnectorUiRecord(PKG, actor, {
      resolveTrustAnchor: async () => ({ ...trustedAnchor, trustDecision: false }),
      discoverRecords: async () => [storeRecord()],
      verifyIntegrity: async () => true,
    });
    expect(runtimeRecord).toBeNull();
  });

  it("FAIL-CLOSED: a non-null anchor with a PENDING (undefined) trust decision → null", async () => {
    // An undecided decision never auto-trusts — only an explicit `true` does.
    readRowsMock.mockResolvedValue([activeInstallRow()]);
    const runtimeRecord = await resolveRuntimeConnectorUiRecord(PKG, actor, {
      resolveTrustAnchor: async () => ({ ...trustedAnchor, trustDecision: undefined }),
      discoverRecords: async () => [storeRecord()],
      verifyIntegrity: async () => true,
    });
    expect(runtimeRecord).toBeNull();
  });

  it("FAIL-CLOSED: a non-allowlisted registry → null", async () => {
    // First-party scope + approved decision, but the anchor's registry is not on
    // the allowlist → the classifier refuses → no schema-config form.
    readRowsMock.mockResolvedValue([activeInstallRow()]);
    const runtimeRecord = await resolveRuntimeConnectorUiRecord(PKG, actor, {
      resolveTrustAnchor: async () => ({
        ...trustedAnchor,
        registryUrl: "https://evil.example.com",
      }),
      discoverRecords: async () => [storeRecord()],
      verifyIntegrity: async () => true,
    });
    expect(runtimeRecord).toBeNull();
  });

  it("FAIL-CLOSED: a content-hash mismatch (integrity verification fails) → null", async () => {
    // A tampered materialized dir: the anchor + decision are valid, but the
    // on-disk files no longer match the trusted content hash. `verifyIntegrity`
    // returns false → `integrityVerified` false → classifier refuses.
    readRowsMock.mockResolvedValue([activeInstallRow()]);
    const runtimeRecord = await resolveRuntimeConnectorUiRecord(PKG, actor, {
      resolveTrustAnchor: async () => trustedAnchor,
      discoverRecords: async () => [storeRecord()],
      verifyIntegrity: async () => false, // tamper detected
    });
    expect(runtimeRecord).toBeNull();
  });

  it("FAIL-CLOSED: a trusted anchor but NO active install for the actor → null", async () => {
    readRowsMock.mockResolvedValue([]); // no install rows
    const runtimeRecord = await resolveRuntimeConnectorUiRecord(PKG, actor, {
      resolveTrustAnchor: async () => trustedAnchor,
      discoverRecords: async () => [storeRecord()],
      verifyIntegrity: async () => true,
    });
    expect(runtimeRecord).toBeNull();
  });

  it("FAIL-CLOSED: a trusted anchor + active install but NO store record for the package → null", async () => {
    readRowsMock.mockResolvedValue([activeInstallRow()]);
    const runtimeRecord = await resolveRuntimeConnectorUiRecord(PKG, actor, {
      resolveTrustAnchor: async () => trustedAnchor,
      discoverRecords: async () => [], // store holds nothing for this package
      verifyIntegrity: async () => true,
    });
    expect(runtimeRecord).toBeNull();
  });

  it("returns null for a missing actor (never auto-resolves)", async () => {
    const runtimeRecord = await resolveRuntimeConnectorUiRecord(PKG, null, {
      resolveTrustAnchor: async () => trustedAnchor,
      discoverRecords: async () => [storeRecord()],
      verifyIntegrity: async () => true,
    });
    expect(runtimeRecord).toBeNull();
    expect(readRowsMock).not.toHaveBeenCalled();
  });
});

describe("static bundled-react fallback (no runtime install)", () => {
  it("a static bundled-react connector keeps the legacy path when no runtime record resolves", async () => {
    readRowsMock.mockResolvedValue([]); // no install for the bundled connector
    const runtimeRecord = await resolveRuntimeConnectorUiRecord(STATIC_BUNDLED, actor, {
      resolveTrustAnchor: async () => null,
      discoverRecords: async () => [],
    });
    expect(runtimeRecord).toBeNull();

    // The route then falls back to the static manifest. A bundled-react static
    // record resolves to the bundled-react branch (legacy loadSetupPage path).
    const staticManifest = { uiSurface: "bundled-react" as const, configSchema: null };
    const decision = chooseConnectorUiRender(runtimeRecord ?? staticManifest);
    expect(decision.kind).toBe("bundled-react");
  });
});
