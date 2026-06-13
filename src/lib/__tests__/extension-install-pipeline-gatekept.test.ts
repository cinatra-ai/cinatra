// Gatekept-install coverage for makeDefaultInstallPipelineDeps.
//
// Flag OFF → resolveIntegrity + materialize fetch from the real registry; the
//            gatekept resolver is never called; provenance records the real
//            registry URL (exactly current behavior).
// Flag ON  → resolveIntegrity + the materialize fetchTarball source the config
//            from the broker grant; provenance records the FINAL
//            registry.cinatra.ai identity, NEVER the broker URL. SRI stays
//            authoritative (the same dist.integrity flows through).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const FINAL_REGISTRY = "https://registry.cinatra.ai";
const BROKER_URL = "https://marketplace.cinatra.ai/install/v1";

// --- Hoisted spies for every dynamically-imported dep of the factory. --------
const h = vi.hoisted(() => ({
  isGatekeptInstallEnabled: vi.fn(() => false),
  resolveGatekeptInstallConfig: vi.fn(),
  resolveExtensionDistIntegrity: vi.fn(),
  fetchExtensionTarballBytes: vi.fn(),
  loadVerdaccioConfigForServer: vi.fn(),
  materializePackageToStore: vi.fn(),
  sourceSwitchExtension: vi.fn(),
  readInstalledExtensionsByPackageName: vi.fn(),
  pickSingleActiveRow: vi.fn(),
  loadDeploymentRegistryConfig: vi.fn(),
}));

vi.mock("@/lib/gatekept-install", () => ({
  isGatekeptInstallEnabled: h.isGatekeptInstallEnabled,
  resolveGatekeptInstallConfig: h.resolveGatekeptInstallConfig,
}));
vi.mock("@cinatra-ai/registries", () => ({
  resolveExtensionDistIntegrity: h.resolveExtensionDistIntegrity,
  fetchExtensionTarballBytes: h.fetchExtensionTarballBytes,
}));
vi.mock("@/lib/verdaccio-config", () => ({
  loadVerdaccioConfigForServer: h.loadVerdaccioConfigForServer,
}));
vi.mock("@/lib/deployment-registry-config", () => ({
  // (a) the final registry identity is sourced from the credential-free
  // PUBLIC registry URL, NOT loadVerdaccioConfigForServer() (which needs server
  // creds). publicRegistryUrl carries NO token (the read token is a separate
  // field) — so a gatekept consumer-only install never needs server creds.
  loadDeploymentRegistryConfig: h.loadDeploymentRegistryConfig,
}));
vi.mock("@/lib/extension-package-store", () => ({
  materializePackageToStore: h.materializePackageToStore,
}));
vi.mock("@/lib/extension-host-port-grants", () => ({
  recordRequestedGrant: vi.fn(async () => {}),
  approveGrant: vi.fn(async () => {}),
  // The hot-UPDATE probe's exact-scope grant reader (makeDefaultInstallPipelineDeps
  // wires it). A fresh gatekept install has no prior grant → null.
  readGrantForScope: vi.fn(async () => null),
  // Design B durable-rollback grant restorer (wired by makeDefaultInstallPipelineDeps);
  // never invoked on a fresh gatekept install (no superseding update).
  restoreGrant: vi.fn(async () => {}),
}));
vi.mock("@/lib/extension-install-ops", () => ({
  beginInstallOp: vi.fn(async () => {}),
  advanceInstallOpPhase: vi.fn(async () => {}),
  // cinatra#158: the SUPERSESSION seam (the happy-path finalize routes through it).
  finalizeInstallOp: vi.fn(async () => {}),
  // The update-compensation path reads the prior (package, org) journal op; a fresh
  // gatekept install has none → null.
  readInstallOp: vi.fn(async () => null),
}));
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionsByPackageName: h.readInstalledExtensionsByPackageName,
  // #180 forward gate: an empty canonical snapshot → nothing to gate.
  listInstalledExtensions: vi.fn(async () => []),
}));
vi.mock("@cinatra-ai/extensions/lifecycle-primitive", () => ({
  sourceSwitchExtension: h.sourceSwitchExtension,
  // #180 edge persistence: the sanctioned canonical writer (no-op here — these
  // fixtures pin trust/provenance routing, not edge persistence).
  recordExtensionDependencies: vi.fn(async () => ({})),
}));
vi.mock("@cinatra-ai/extensions/manifest-dependencies", () => ({
  // The fixture storeDir is synthetic (no real package.json on disk) — the
  // dual-read seam reports a declared-empty edge set.
  readManifestDependencyEdgesFromStore: vi.fn(async () => ({ edges: [], source: "canonical" })),
}));
vi.mock("@/lib/extension-install-anchor", () => ({
  pickSingleActiveRow: h.pickSingleActiveRow,
}));
vi.mock("@/lib/extension-migration-host", () => ({
  applyExtensionMigrationsFromStore: vi.fn(async () => {}),
  // Validate-only preflight (#118): these fixtures declare no migrations.
  preflightExtensionMigrationsFromStore: vi.fn(async () => null),
}));

import {
  installExtensionFromRegistry,
  makeDefaultInstallPipelineDeps,
} from "@/lib/extension-install-pipeline";
import { generateExtensionSigningKeyPair, signExtension } from "@/lib/extension-signature";

const ORIGINAL_FLAG = process.env.CINATRA_GATEKEPT_INSTALL;
const ORIGINAL_KEYS = process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS;

beforeEach(() => {
  vi.clearAllMocks();
  h.isGatekeptInstallEnabled.mockReturnValue(false);
  h.loadVerdaccioConfigForServer.mockResolvedValue({
    registryUrl: FINAL_REGISTRY,
    packageScope: "@cinatra-ai",
    token: "deployment-read-token",
    uiUrl: null,
  });
  // Credential-free public registry URL (token lives in a SEPARATE field).
  h.loadDeploymentRegistryConfig.mockReturnValue({
    publicRegistryUrl: FINAL_REGISTRY,
    publicReadToken: "fixture-public-read",
    publicPublishToken: null,
    privateRegistryUrl: null,
    privateReadToken: null,
    privatePublishToken: null,
    privateDestinationConfigured: false,
    privateDestinationId: null,
    routingMode: "shared-acl",
  });
  h.resolveExtensionDistIntegrity.mockResolvedValue({
    integrity: "sha512-abc",
    registryUrl: FINAL_REGISTRY,
  });
  h.materializePackageToStore.mockResolvedValue({
    storeDir: "/store/foo/digest",
    digest: "digest",
    integrity: "sha512-abc",
    contentHash: "ch",
  });
  h.readInstalledExtensionsByPackageName.mockResolvedValue([
    { id: "row-1", status: "active", organizationId: null },
  ]);
  h.pickSingleActiveRow.mockReturnValue({ id: "row-1", status: "active", organizationId: null });
  h.sourceSwitchExtension.mockResolvedValue(undefined);
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.CINATRA_GATEKEPT_INSTALL;
  else process.env.CINATRA_GATEKEPT_INSTALL = ORIGINAL_FLAG;
  if (ORIGINAL_KEYS === undefined) delete process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS;
  else process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS = ORIGINAL_KEYS;
});

describe("makeDefaultInstallPipelineDeps — flag OFF (legacy, unchanged)", () => {
  it("resolveIntegrity reads the real registry config; the gatekept resolver is never called", async () => {
    const deps = await makeDefaultInstallPipelineDeps();
    const out = await deps.resolveIntegrity("@cinatra-ai/foo", "1.0.0");

    expect(h.resolveGatekeptInstallConfig).not.toHaveBeenCalled();
    expect(out.registryUrl).toBe(FINAL_REGISTRY);
    // resolveExtensionDistIntegrity was called with the REAL registry config.
    const cfg = h.resolveExtensionDistIntegrity.mock.calls[0]?.[1] as { registryUrl: string };
    expect(cfg.registryUrl).toBe(FINAL_REGISTRY);
  });

  it("materialize calls the store WITHOUT an injected broker fetchTarball", async () => {
    const deps = await makeDefaultInstallPipelineDeps();
    await deps.materialize({
      packageName: "@cinatra-ai/foo",
      version: "1.0.0",
      expectedIntegrity: "sha512-abc",
      registryUrl: FINAL_REGISTRY,
    });
    const matDeps = h.materializePackageToStore.mock.calls[0]?.[1] as { fetchTarball?: unknown };
    expect(matDeps?.fetchTarball).toBeUndefined();
    expect(h.resolveGatekeptInstallConfig).not.toHaveBeenCalled();
  });

  it("recordProvenance records the real registry URL", async () => {
    const deps = await makeDefaultInstallPipelineDeps();
    await deps.recordProvenance({
      packageName: "@cinatra-ai/foo",
      orgId: null,
      version: "1.0.0",
      registryUrl: FINAL_REGISTRY,
      integrity: "sha512-abc",
      contentHash: "ch",
    });
    const source = h.sourceSwitchExtension.mock.calls[0]?.[1] as { registryUrl: string };
    expect(source.registryUrl).toBe(FINAL_REGISTRY);
  });
});

describe("makeDefaultInstallPipelineDeps — flag ON (broker grant/proxy)", () => {
  beforeEach(() => {
    h.isGatekeptInstallEnabled.mockReturnValue(true);
    h.resolveGatekeptInstallConfig.mockResolvedValue({
      config: { registryUrl: BROKER_URL, packageScope: "@cinatra-ai", token: "opaque.grant", uiUrl: null },
    });
    // When gatekept, resolveExtensionDistIntegrity is called with the BROKER
    // config, so it returns the broker registryUrl.
    h.resolveExtensionDistIntegrity.mockResolvedValue({
      integrity: "sha512-abc",
      registryUrl: BROKER_URL,
    });
    h.fetchExtensionTarballBytes.mockResolvedValue({
      bytes: Buffer.from("tarball"),
      integrity: "sha512-abc",
    });
  });

  it("resolveIntegrity fetches the packument THROUGH the broker grant but RETURNS the FINAL registry identity (not the broker URL) so trust classification stays correct", async () => {
    const deps = await makeDefaultInstallPipelineDeps();
    const out = await deps.resolveIntegrity("@cinatra-ai/foo", "1.0.0");

    expect(h.resolveGatekeptInstallConfig).toHaveBeenCalledWith("@cinatra-ai/foo", "1.0.0");
    // (b) the returned registryUrl is the FINAL registry.cinatra.ai
    // identity, NOT the broker — installExtensionFromRegistry classifies trust
    // from this URL, so a trusted first-party package must NOT be demoted to
    // UNTRUSTED just because bytes were delivered via the broker.
    expect(out.registryUrl).toBe(FINAL_REGISTRY);
    expect(out.registryUrl).not.toBe(BROKER_URL);
    // The SRI read through the broker packument is preserved verbatim.
    expect(out.integrity).toBe("sha512-abc");
    // resolveExtensionDistIntegrity STILL received the BROKER config (token =
    // grant) — the broker is the byte source even though the identity is final.
    const cfg = h.resolveExtensionDistIntegrity.mock.calls[0]?.[1] as { registryUrl: string; token?: string };
    expect(cfg.registryUrl).toBe(BROKER_URL);
    expect(cfg.token).toBe("opaque.grant");
  });

  it("(a) the gatekept path NEVER calls loadVerdaccioConfigForServer (no server credentials required)", async () => {
    const deps = await makeDefaultInstallPipelineDeps();
    await deps.resolveIntegrity("@cinatra-ai/foo", "1.0.0");
    await deps.materialize({
      packageName: "@cinatra-ai/foo",
      version: "1.0.0",
      expectedIntegrity: "sha512-abc",
      registryUrl: BROKER_URL,
    });
    await deps.recordProvenance({
      packageName: "@cinatra-ai/foo",
      orgId: null,
      version: "1.0.0",
      registryUrl: BROKER_URL,
      integrity: "sha512-abc",
      contentHash: "ch",
    });
    // The factory must not load server registry credentials on the gatekept
    // path — neither eagerly at construction nor lazily in any dep.
    expect(h.loadVerdaccioConfigForServer).not.toHaveBeenCalled();
  });

  it("materialize injects a broker fetchTarball and persists the FINAL registry URL (not the broker URL) on the store", async () => {
    const deps = await makeDefaultInstallPipelineDeps();
    await deps.materialize({
      packageName: "@cinatra-ai/foo",
      version: "1.0.0",
      expectedIntegrity: "sha512-abc",
      registryUrl: BROKER_URL, // upper orchestration threads the broker URL here
    });

    const [matInput, matDeps] = h.materializePackageToStore.mock.calls[0] as [
      { registryUrl?: string; expectedIntegrity: string },
      { fetchTarball?: (i: { packageName: string; packageVersion?: string; expectedIntegrity?: string }) => Promise<unknown> },
    ];
    // The persisted registryUrl is the FINAL registry, NOT the broker.
    expect(matInput.registryUrl).toBe(FINAL_REGISTRY);
    // A broker fetchTarball was injected.
    expect(typeof matDeps.fetchTarball).toBe("function");

    // Exercising the injected fetch routes bytes through the broker config + the
    // SRI is still enforced (expectedIntegrity is forwarded to pacote).
    await matDeps.fetchTarball!({ packageName: "@cinatra-ai/foo", packageVersion: "1.0.0", expectedIntegrity: "sha512-abc" });
    const fetchCfg = h.fetchExtensionTarballBytes.mock.calls[0]?.[1] as { registryUrl: string; token?: string };
    expect(fetchCfg.registryUrl).toBe(BROKER_URL);
    expect(fetchCfg.token).toBe("opaque.grant");
    const fetchInput = h.fetchExtensionTarballBytes.mock.calls[0]?.[0] as { expectedIntegrity?: string };
    expect(fetchInput.expectedIntegrity).toBe("sha512-abc");
  });

  it("recordProvenance records the FINAL registry.cinatra.ai identity, NEVER the broker URL", async () => {
    const deps = await makeDefaultInstallPipelineDeps();
    await deps.recordProvenance({
      packageName: "@cinatra-ai/foo",
      orgId: null,
      version: "1.0.0",
      registryUrl: BROKER_URL, // even when handed the broker URL...
      integrity: "sha512-abc",
      contentHash: "ch",
    });
    const source = h.sourceSwitchExtension.mock.calls[0]?.[1] as { registryUrl: string; integrity: string };
    // ...provenance records the FINAL registry, not the broker.
    expect(source.registryUrl).toBe(FINAL_REGISTRY);
    expect(source.registryUrl).not.toBe(BROKER_URL);
    // SRI stays authoritative.
    expect(source.integrity).toBe("sha512-abc");
  });

  it("(b) end-to-end: a gatekept install of a SIGNED package stays TRUSTED (grant auto-approved) — trust classification sees registry.cinatra.ai, not the broker", async () => {
    // The full pipeline runs the REAL trust classifier (classifyExtensionTrust is
    // not mocked). Before the fix, resolveIntegrity returned the broker
    // URL, so the classifier saw marketplace.cinatra.ai → the host check failed →
    // UNTRUSTED → grant `pending`. After the fix it sees the FINAL
    // registry.cinatra.ai. Under the capability split, auto-grant requires a
    // `trusted-signed` package, so a SIGNED install is what proves the registryUrl
    // override fed registry.cinatra.ai into the (host + signature) gate → approved.
    const kp = generateExtensionSigningKeyPair();
    const signature = signExtension(
      { packageName: "@cinatra-ai/foo", version: "1.0.0", integrity: "sha512-abc" },
      kp.privateKeyPkcs8DerB64,
    );
    process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS = kp.publicKeyDerB64;
    h.resolveExtensionDistIntegrity.mockResolvedValue({
      integrity: "sha512-abc",
      registryUrl: FINAL_REGISTRY,
      signature,
    });
    const deps = await makeDefaultInstallPipelineDeps();
    const result = await installExtensionFromRegistry(
      { packageName: "@cinatra-ai/foo", version: "1.0.0", orgId: null },
      deps,
    );

    expect(result.grantStatus).toBe("approved");
    // SRI preserved end-to-end.
    expect(result.integrity).toBe("sha512-abc");
    // Provenance recorded the FINAL registry identity, never the broker.
    const source = h.sourceSwitchExtension.mock.calls[0]?.[1] as { registryUrl: string };
    expect(source.registryUrl).toBe(FINAL_REGISTRY);
    expect(source.registryUrl).not.toBe(BROKER_URL);
  });

  it("(b) end-to-end: a gatekept install of an UNSIGNED package stays grant-PENDING — no auto-grant without a verified signature (capability split), regardless of scope", async () => {
    h.resolveGatekeptInstallConfig.mockResolvedValue({
      config: { registryUrl: BROKER_URL, packageScope: "@third-party", token: "opaque.grant", uiUrl: null },
    });
    // No signing key configured → the package is at most `trusted-bootstrap` (it may
    // import, but its grant stays PENDING). The vendor-agnostic classifier never
    // reads scope; the auto-grant gate is the signature, not the package scope.
    const deps = await makeDefaultInstallPipelineDeps();
    const result = await installExtensionFromRegistry(
      { packageName: "@third-party/foo", version: "1.0.0", orgId: null },
      deps,
    );

    expect(result.grantStatus).toBe("pending");
  });
});
