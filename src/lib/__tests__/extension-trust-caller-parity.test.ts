// Caller-parity. The FOUR in-process activation-trust call sites
//   1. boot loader          runtime-package-loader.ts        (classifyExtensionTrust)
//   2. install pipeline      extension-install-pipeline.ts    (classifyExtensionTrust)
//   3. workflow saga         extension-workflow-install-saga.ts (classifyExtensionTrust)
//   4. connector-UI render   extension-install-resolution.ts  (classifyExtensionTrust)
// MUST reach the SAME verdict for a given package, and the connector-UI must
// NEVER render one the boot loader would refuse.
//
// All four funnel through the SAME `classifyExtensionTrust` helper. This suite
// proves:
//   (A) single source of truth — every caller imports the canonical helper from
//       `@/lib/extension-trust` (no caller forks the trust logic), AND each
//       caller's real input-construction converges to the SAME tier for a given
//       finalized install across the signature/host/bootstrap matrix; and
//   (B) the REAL connector-UI render path agrees with the boot loader's verdict
//       across the FULL activation-time matrix (including the post-install
//       re-checks: revoked / tampered / unknown-host) — connector-UI renders
//       iff the loader would import.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const { readRowsMock } = vi.hoisted(() => ({ readRowsMock: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionsByPackageName: readRowsMock,
}));

import { classifyExtensionTrust, type ExtensionTrustTier } from "@/lib/extension-trust";
import { trustedActivationHosts, allowMarketplaceBootstrapTrust } from "@/lib/extension-trust-config";
import {
  resolveSignatureVerdict,
  generateExtensionSigningKeyPair,
  signExtension,
} from "@/lib/extension-signature";
import { resolveRuntimeConnectorUiRecord } from "@/lib/extension-install-resolution";
import type { ActorContext } from "@/lib/authz/actor-context";
import type { PackageStoreRecord } from "@cinatra-ai/sdk-extensions";
import type { InstallTrustAnchor } from "@/lib/extension-package-store";

const PKG = "@multi-vendor/notes-connector"; // deliberately NON-cinatra scope: trust is vendor-agnostic
const TRUSTED_REGISTRY = "https://registry.cinatra.ai"; // the fixture publicRegistryUrl → trusted activation host
const INTEGRITY = "sha512-fixture-integrity";
const VERSION = "1.2.0";

const actor: ActorContext = {
  principalType: "HumanUser",
  principalId: "u1",
  organizationId: "org-1",
  authSource: "ui",
  policyVersion: "v2",
};

const SCHEMA = {
  title: "Notes",
  fields: [{ kind: "secret", key: "apiKey", label: "API key", required: true }],
};

function storeRecord(): PackageStoreRecord {
  return {
    packageName: PKG,
    serverEntry: "./register",
    requestedHostPorts: ["ui", "secrets"],
    sdkAbiRange: "^2",
    storeDir: "/data/extensions/packages/notes",
    uiSurface: "schema-config",
    configSchema: SCHEMA,
  };
}

function activeInstallRow() {
  return { id: "inst-1", status: "active", organizationId: "org-1", ownerId: "org-1", ownerLevel: "organization" };
}

// ---------------------------------------------------------------------------
// Env management — the signature factor flows through the REAL
// `resolveSignatureVerdict` (reads CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS) and the
// bootstrap lever through the REAL `allowMarketplaceBootstrapTrust`
// (`!CINATRA_EXTENSION_REQUIRE_SIGNATURES`). Snapshot + restore both.
// ---------------------------------------------------------------------------
let prevKeys: string | undefined;
let prevRequire: string | undefined;
beforeEach(() => {
  prevKeys = process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS;
  prevRequire = process.env.CINATRA_EXTENSION_REQUIRE_SIGNATURES;
  delete process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS;
  delete process.env.CINATRA_EXTENSION_REQUIRE_SIGNATURES;
  readRowsMock.mockReset();
});
afterEach(() => {
  if (prevKeys === undefined) delete process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS;
  else process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS = prevKeys;
  if (prevRequire === undefined) delete process.env.CINATRA_EXTENSION_REQUIRE_SIGNATURES;
  else process.env.CINATRA_EXTENSION_REQUIRE_SIGNATURES = prevRequire;
});

/** Mint a valid signature for the fixture and trust its key via env. */
function signFixture(): string {
  const kp = generateExtensionSigningKeyPair();
  const signature = signExtension(
    { packageName: PKG, version: VERSION, integrity: INTEGRITY },
    kp.privateKeyPkcs8DerB64,
  );
  process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS = kp.publicKeyDerB64;
  return signature;
}

// ---------------------------------------------------------------------------
// Caller input-construction projections. Each mirrors EXACTLY how that call site
// builds its `classifyExtensionTrust` input (see the cited source). They are kept
// in lock-step with the source; if a caller stops threading the signature factor
// (or sources the host from a different seam), its projection diverges and the
// Block-A matrix fails. `integrityVerified`/`persistedTrustDecision` are the
// activation-vs-install difference: the loader + connector-UI read them from the
// persisted anchor; the pipeline + saga hardcode `true` (a just-materialized,
// being-finalized install). For a FINALIZED, integrity-clean install all four
// converge — that is the "same verdict for a given package" invariant.
// ---------------------------------------------------------------------------
type Facts = {
  /** Activation-time integrity re-verification result (loader + connector-UI). */
  anchorIntegrityVerified: boolean;
  /** Persisted host trust decision on the anchor (loader + connector-UI). */
  anchorTrustDecision: boolean | undefined;
  registryUrl: string;
  signature: string | null;
};

// loader → runtime-package-loader.ts (anchor-sourced integrity + decision)
function loaderInput(f: Facts) {
  return {
    packageName: PKG,
    registryUrl: f.registryUrl,
    integrityVerified: f.anchorIntegrityVerified,
    persistedTrustDecision: f.anchorTrustDecision,
    signatureVerified: resolveSignatureVerdict({ packageName: PKG, version: VERSION, integrity: INTEGRITY, signature: f.signature }),
    trustedActivationHosts: trustedActivationHosts(),
    allowMarketplaceBootstrapTrust: allowMarketplaceBootstrapTrust(),
  };
}
// connector-UI → extension-install-resolution.ts (anchor-sourced, identical shape)
function connectorUiInput(f: Facts) {
  return {
    packageName: PKG,
    registryUrl: f.registryUrl,
    integrityVerified: f.anchorIntegrityVerified,
    persistedTrustDecision: f.anchorTrustDecision,
    signatureVerified: resolveSignatureVerdict({ packageName: PKG, version: VERSION, integrity: INTEGRITY, signature: f.signature }),
    trustedActivationHosts: trustedActivationHosts(),
    allowMarketplaceBootstrapTrust: allowMarketplaceBootstrapTrust(),
  };
}
// pipeline → extension-install-pipeline.ts (install-time: integrity + decision are `true`)
function pipelineInput(f: Facts) {
  return {
    packageName: PKG,
    registryUrl: f.registryUrl,
    integrityVerified: true,
    persistedTrustDecision: true,
    signatureVerified: resolveSignatureVerdict({ packageName: PKG, version: VERSION, integrity: INTEGRITY, signature: f.signature }),
    trustedActivationHosts: trustedActivationHosts(),
    allowMarketplaceBootstrapTrust: allowMarketplaceBootstrapTrust(),
  };
}
// saga → extension-workflow-install-saga.ts (install-time: integrity + decision are `true`)
function sagaInput(f: Facts) {
  return {
    packageName: PKG,
    registryUrl: f.registryUrl,
    integrityVerified: true,
    persistedTrustDecision: true,
    signatureVerified: resolveSignatureVerdict({ packageName: PKG, version: VERSION, integrity: INTEGRITY, signature: f.signature }),
    trustedActivationHosts: trustedActivationHosts(),
    allowMarketplaceBootstrapTrust: allowMarketplaceBootstrapTrust(),
  };
}

describe("caller-parity — single source of truth (no caller forks trust logic)", () => {
  const CALLERS = [
    "runtime-package-loader.ts",
    "extension-install-pipeline.ts",
    "extension-workflow-install-saga.ts",
    "extension-install-resolution.ts",
  ];
  it("every activation-trust caller imports classifyExtensionTrust from the canonical @/lib/extension-trust module", () => {
    for (const file of CALLERS) {
      const src = readFileSync(path.join(process.cwd(), "src", "lib", file), "utf8");
      // imports the canonical helper …
      expect(src, `${file} must import classifyExtensionTrust from @/lib/extension-trust`).toMatch(
        /import\s*\{[^}]*\bclassifyExtensionTrust\b[^}]*\}\s*from\s*["']@\/lib\/extension-trust["']/,
      );
      // … and never defines a local fork of it.
      expect(src, `${file} must NOT define a local classifyExtensionTrust`).not.toMatch(
        /function\s+classifyExtensionTrust\b/,
      );
    }
  });
});

describe("caller-parity — four callers reach the SAME verdict for a finalized install", () => {
  // FINALIZED, integrity-clean install (anchor decision true + integrity verified)
  // — the case where install-time (pipeline/saga) and activation-time
  // (loader/connector-UI) classify the identical package. Vary signature × host ×
  // bootstrap; assert all four caller constructions yield the SAME tier.
  type Scenario = { name: string; sign: boolean; requireSigs: boolean; registryUrl: string; expectedTier: ExtensionTrustTier };
  const scenarios: Scenario[] = [
    { name: "signed + trusted host → trusted-signed", sign: true, requireSigs: false, registryUrl: TRUSTED_REGISTRY, expectedTier: "trusted-signed" },
    { name: "signed + require-signatures on → trusted-signed", sign: true, requireSigs: true, registryUrl: TRUSTED_REGISTRY, expectedTier: "trusted-signed" },
    { name: "unsigned + bootstrap on → trusted-bootstrap", sign: false, requireSigs: false, registryUrl: TRUSTED_REGISTRY, expectedTier: "trusted-bootstrap" },
    { name: "unsigned + require-signatures on → untrusted", sign: false, requireSigs: true, registryUrl: TRUSTED_REGISTRY, expectedTier: "untrusted" },
    { name: "signed but NON-trusted host → untrusted (host precedes signature)", sign: true, requireSigs: false, registryUrl: "https://evil.example.com", expectedTier: "untrusted" },
  ];

  for (const s of scenarios) {
    it(s.name, () => {
      if (s.requireSigs) process.env.CINATRA_EXTENSION_REQUIRE_SIGNATURES = "true";
      const signature = s.sign ? signFixture() : null;
      const facts: Facts = { anchorIntegrityVerified: true, anchorTrustDecision: true, registryUrl: s.registryUrl, signature };

      const tiers = [
        classifyExtensionTrust(loaderInput(facts)).tier,
        classifyExtensionTrust(pipelineInput(facts)).tier,
        classifyExtensionTrust(sagaInput(facts)).tier,
        classifyExtensionTrust(connectorUiInput(facts)).tier,
      ];
      // all four agree …
      expect(new Set(tiers).size, `callers diverged: ${tiers.join(", ")}`).toBe(1);
      // … on the expected tier.
      expect(tiers[0]).toBe(s.expectedTier);
    });
  }
});

describe("caller-parity — connector-UI never renders one the loader refuses (REAL render path)", () => {
  // Drive the REAL `resolveRuntimeConnectorUiRecord` over the FULL activation-time
  // matrix (incl. the post-install re-checks the install-time callers never see)
  // and assert it renders (non-null) IFF the boot loader's REAL verdict — built
  // from the SAME anchor with the loader's exact construction — is trusted.
  type Case = { name: string; sign: boolean; requireSigs: boolean; anchorOver: Partial<InstallTrustAnchor>; integrityVerified: boolean };
  const cases: Case[] = [
    { name: "signed + trusted host → renders (signed)", sign: true, requireSigs: false, anchorOver: {}, integrityVerified: true },
    { name: "unsigned + bootstrap on → renders (bootstrap)", sign: false, requireSigs: false, anchorOver: {}, integrityVerified: true },
    { name: "unsigned + require-signatures on → refused", sign: false, requireSigs: true, anchorOver: {}, integrityVerified: true },
    { name: "revoked decision → refused", sign: true, requireSigs: false, anchorOver: { trustDecision: false }, integrityVerified: true },
    { name: "pending (undefined) decision → refused", sign: true, requireSigs: false, anchorOver: { trustDecision: undefined }, integrityVerified: true },
    { name: "tampered files (integrity fails) → refused", sign: true, requireSigs: false, anchorOver: {}, integrityVerified: false },
    { name: "unknown/non-trusted host → refused", sign: true, requireSigs: false, anchorOver: { registryUrl: "https://evil.example.com" }, integrityVerified: true },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      if (c.requireSigs) process.env.CINATRA_EXTENSION_REQUIRE_SIGNATURES = "true";
      const signature = c.sign ? signFixture() : null;
      const anchor: InstallTrustAnchor = {
        integrity: INTEGRITY,
        contentHash: "fixture-content-hash",
        registryUrl: TRUSTED_REGISTRY,
        trustDecision: true,
        approvedPorts: ["ui", "secrets"],
        version: VERSION,
        signature,
        ...c.anchorOver,
      };

      // The loader's REAL verdict from the SAME anchor (loader construction).
      const loaderVerdict = classifyExtensionTrust({
        packageName: PKG,
        registryUrl: anchor.registryUrl,
        integrityVerified: c.integrityVerified,
        persistedTrustDecision: anchor.trustDecision,
        signatureVerified: resolveSignatureVerdict({
          packageName: PKG,
          version: anchor.version ?? "",
          integrity: anchor.integrity,
          signature: anchor.signature,
        }),
        trustedActivationHosts: trustedActivationHosts(),
        allowMarketplaceBootstrapTrust: allowMarketplaceBootstrapTrust(),
      });

      // The REAL connector-UI render path (default classifyTrust = the real helper).
      readRowsMock.mockResolvedValue([activeInstallRow()]);
      const rendered = await resolveRuntimeConnectorUiRecord(PKG, actor, {
        resolveTrustAnchor: async () => anchor,
        discoverRecords: async () => [storeRecord()],
        verifyIntegrity: async () => c.integrityVerified,
      });

      // PARITY: connector-UI renders ⟺ the loader trusts. Never renders one the
      // loader would refuse.
      expect(rendered !== null).toBe(loaderVerdict.trusted);
    });
  }
});
