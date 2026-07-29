import "server-only";

// ---------------------------------------------------------------------------
// InstallPipelineDeps CONSTRUCTION — the DI-wiring vertical slice of the
// extension install pipeline. Extracted VERBATIM from
// `extension-install-pipeline.ts` (file-size ratchet; the pipeline file is a
// tracked architecture bottleneck) so the orchestration (`installExtensionFromRegistry`)
// and its type surface stay in the pipeline module while ALL dependency
// construction lives here:
//   - `makeDefaultInstallPipelineDeps` — the production seam writer (real
//     materializer + canonical store + grant/journal stores; gatekept-install
//     broker routing);
//   - `makeTestInstallPipelineDeps` — the fully-wired INERT deps for unit tests.
// The pipeline module RE-EXPORTS both, so every caller's import path
// (`@/lib/extension-install-pipeline`) is byte-for-byte unchanged. Pure code
// motion: no behaviour change, no signature drift.
//
// The type-only `InstallPipelineDeps` import below is erased at build time, so
// there is NO runtime import cycle (pipeline → deps is the only value edge).
// ---------------------------------------------------------------------------

import { makeOwnershipGrantInstallDeps } from "@/lib/extension-capability-ownership-grants";
import { readConnectorAccessDeclarationFromStore } from "@/lib/connector-access-config-host";
import { readAssistantInstallSignalsFromStore } from "@/lib/assistant-declaration-host";
import { readSkillPackagingSignalsFromStore } from "@/lib/skill-packaging-install-gate";
import type { InstallPipelineDeps } from "@/lib/extension-install-pipeline";

/**
 * Wire the production install-pipeline defaults (the seam writer):
 *  - `resolveIntegrity` → `resolveExtensionDistIntegrity` (sha512 SRI root +
 *    additive sha256), authed via `loadVerdaccioConfigForServer()` on the legacy
 *    (flag-OFF) path, or via the broker grant on the gatekept (flag-ON) path —
 *    the latter requires NO server credentials and returns the FINAL registry
 *    identity (not the broker URL) for trust classification;
 *  - `materialize` → `materializePackageToStore` (the SRI-checked materializer);
 *  - `readRequestedPorts` → the manifest's `cinatra.requestedHostPorts`;
 *  - `readDeclaredCompat` → the manifest's `cinatra.sdkAbiRange` (the
 *    HOST-COMPAT GATE's basis);
 *  - `recordProvenance` → `sourceSwitchExtension` (the ONLY sanctioned provenance
 *    writer; persists the REAL integrity + content hash + the new attestedSha256);
 *  - `recordRequestedGrant` / `approveGrant` → the host-port grant store;
 *  - the install-op journal hooks → the install-ops journal store.
 *
 * The LIVE production caller is `runHostExtensionInstallAndActivate` in
 * `src/lib/extension-runtime-activate.ts`: the
 * `extensions_install` dispatch hook resolves the canonical verdaccio row, then
 * calls `makeDefaultInstallPipelineDeps()` + `installExtensionFromRegistry(...)`
 * to drive the REAL-integrity pipeline against the real registry. This factory
 * also exists so the DI defaults are wired + unit-testable.
 */
export async function makeDefaultInstallPipelineDeps(): Promise<InstallPipelineDeps> {
  const { resolveExtensionDistIntegrity } = await import("@cinatra-ai/registries");
  const { materializePackageToStore } = await import("@/lib/extension-package-store");
  const [{ readRequestedHostPortsFromStore }, { makeHostPortGrantInstallDeps }] = await Promise.all([import("@/lib/extension-host-port-grants"), import("@/lib/extension-host-port-grant-install-deps")]);
  const { beginInstallOp, advanceInstallOpPhase, finalizeInstallOp, readInstallOp } = await import("@/lib/extension-install-ops");
  const { makeCanonicalRowInstallDeps } = await import("@/lib/extension-install-canonical-row-deps");
  const { isGatekeptInstallEnabled, resolveGatekeptInstallConfig } = await import("@/lib/gatekept-install");

  // Gatekept install: when ON, resolveIntegrity + materialize fetch
  // through the marketplace broker read-proxy (grant as token, broker base as
  // registry). pacote still re-verifies the sha512 SRI over the downloaded
  // bytes on EVERY path. Provenance + trust classification, however, see the
  // FINAL `registry.cinatra.ai` identity (NOT the broker URL) — the broker is
  // only a delivery mechanism.
  //
  // The final registry identity is the deployment's PUBLIC registry URL — a
  // public, credential-free URL (`loadDeploymentRegistryConfig().publicRegistryUrl`;
  // the read credential lives in the separate `publicReadToken` field, never in
  // this URL). Resolving it this way means a gatekept (consumer-only) install
  // NEVER needs server registry credentials. `loadVerdaccioConfigForServer()`
  // (which DOES require server creds) is only loaded LAZILY inside the legacy
  // flag-OFF branches below — so the flag-OFF path is byte-for-byte unchanged
  // and the flag-ON path stays credential-free.
  const { getPublicRegistryIdentityUrl } = await import("@/lib/deployment-registry-config");
  const finalRegistryUrl = getPublicRegistryIdentityUrl();

  // Lazy server-cred loader for the legacy (flag-OFF) direct-read path ONLY.
  // Never invoked when gatekept install is ON.
  const loadServerRegistryConfig = async () => {
    const { loadVerdaccioConfigForServer } = await import("@/lib/verdaccio-config");
    return loadVerdaccioConfigForServer();
  };

  return {
    resolveIntegrity: async (packageName, version) => {
      if (isGatekeptInstallEnabled()) {
        // Broker-pointed config: registryUrl = broker base, token = opaque grant.
        // We fetch the packument THROUGH the broker to read dist.integrity, but
        // the returned `registryUrl` MUST be the FINAL registry identity — the
        // upper orchestration classifies trust from this URL (a trusted
        // first-party package would otherwise be mis-classified UNTRUSTED
        // because broker base != registry.cinatra.ai). SRI is unchanged: the
        // sha512 dist.integrity read through the broker is the same digest the
        // registry serves, and pacote re-verifies it over the bytes.
        const { config } = await resolveGatekeptInstallConfig(packageName, version);
        const resolved = await resolveExtensionDistIntegrity({ packageName, packageVersion: version }, config);
        return { ...resolved, registryUrl: finalRegistryUrl };
      }
      const config = await loadServerRegistryConfig();
      return resolveExtensionDistIntegrity({ packageName, packageVersion: version }, config);
    },
    materialize: async (i) => {
      // Gatekept install: fetch the tarball bytes through the broker
      // read-proxy (grant as token, broker base as registry). pacote enforces
      // the sha512 SRI over the downloaded bytes; materializePackageToStore
      // ALSO re-verifies the SRI before writing — integrity is never weakened by
      // routing through the broker. The `registryUrl` PERSISTED on the store
      // sidecar is overridden to the FINAL registry (the broker is delivery, not
      // origin — same rule recordProvenance enforces). When OFF, the default
      // fetch path (real registry) runs unchanged.
      let fetchTarball: import("@/lib/extension-package-store").FetchTarball | undefined;
      let persistRegistryUrl = i.registryUrl;
      if (isGatekeptInstallEnabled()) {
        const { config } = await resolveGatekeptInstallConfig(i.packageName, i.version);
        const { fetchExtensionTarballBytes } = await import("@cinatra-ai/registries");
        fetchTarball = (input) =>
          fetchExtensionTarballBytes(
            {
              packageName: input.packageName,
              packageVersion: input.packageVersion,
              expectedIntegrity: input.expectedIntegrity,
            },
            config,
          );
        persistRegistryUrl = finalRegistryUrl;
      }
      const mat = await materializePackageToStore(
        {
          packageName: i.packageName,
          version: i.version,
          expectedIntegrity: i.expectedIntegrity,
          registryUrl: persistRegistryUrl,
          storeRoot: i.storeRoot,
          expectedKind: i.expectedKind,
          // cinatra#181: the parsed plan + verified closureHash thread into the materializer
          // (step 4.7); per-node fetches ride the SAME injected fetchTarball seam.
          plan: i.plan ?? null,
          expectedClosureHash: i.expectedClosureHash ?? null,
        },
        fetchTarball ? { fetchTarball } : {},
      );
      return { storeDir: mat.storeDir, digest: mat.digest, integrity: mat.integrity, contentHash: mat.contentHash };
    },
    readRequestedPorts: (storeDir) => readRequestedHostPortsFromStore(storeDir),
    // HOST-COMPAT GATE basis: the materialized manifest's `cinatra.sdkAbiRange`
    // (verified bytes — same basis as readRequestedPorts above).
    readDeclaredCompat: async (storeDir) => {
      const { readDeclaredHostCompatFromStore } = await import("@/lib/extension-host-compat");
      return readDeclaredHostCompatFromStore(storeDir);
    },
    // DEPENDENCY EDGES (#180): dual-read over the materialized manifest
    // (canonical `cinatra.dependencies` wins; legacy `cinatra.agentDependencies`
    // projected; conflict/malformed = fail-loud throw).
    readDependencyEdges: async (storeDir) => {
      const { readManifestDependencyEdgesFromStore } = await import(
        "@cinatra-ai/extensions/manifest-dependencies"
      );
      const { edges } = await readManifestDependencyEdgesFromStore(storeDir);
      return edges;
    },
    // ACCESS DECLARATION (cinatra#951): the host reader — fail-closed resolve
    // of cinatra/config.json through the single SDK validator.
    readAccessDeclaration: (storeDir) => readConnectorAccessDeclarationFromStore(storeDir),
    // ASSISTANT PRE-FINALIZE GATE (cinatra#1874 W1): the host reader — fail-closed
    // resolve of the agent-kind cinatra/config.json assistant block + the XOR
    // executor signal, through the shared SDK parser.
    readAssistantInstallSignals: (storeDir) => readAssistantInstallSignalsFromStore(storeDir),
    // cinatra#2089 (S2): the packaging/structure verdict at the pre-journal
    // seam — one bundle per skill extension, singular `-skill`, Anthropic-clean
    // SKILL.md, and no embedded skill in a non-skill extension.
    readSkillPackagingSignals: (storeDir) => readSkillPackagingSignalsFromStore(storeDir),
    // FORWARD INSTALL GATE (#180 item 5): edgeType-aware closure check over the
    // canonical snapshot, scoped to the install's org.
    assertForwardInstallClosure: async (p) => {
      const { listInstalledExtensions } = await import("@cinatra-ai/extensions/canonical-store");
      const { assertForwardInstallClosureForPackage } = await import(
        "@cinatra-ai/extensions/dependency-closure"
      );
      const allRows = await listInstalledExtensions({});
      assertForwardInstallClosureForPackage(p.packageName, allRows, {
        organizationId: p.orgId,
      });
    },
    // CANONICAL-ROW deps (extracted vertical slice — file-size ratchet):
    // recordProvenance (outcome-seam source write + `current` mirror, #792),
    // readActiveDigest (finalize cross-check basis, #792), readCurrentSource /
    // readCurrentDependencies (rollback captures), persistDependencyEdges
    // (finalize-seam edge write, #180). Gatekept install: provenance records
    // the FINAL registry identity, NEVER the broker URL (the loader classifies
    // trust on the recorded registry URL).
    ...makeCanonicalRowInstallDeps({
      provenanceRegistryUrl: (requestUrl) => (isGatekeptInstallEnabled() ? finalRegistryUrl : requestUrl),
    }),
    applyMigrations: async (i) => {
      const { applyExtensionMigrationsFromStore } = await import("@/lib/extension-migration-host");
      await applyExtensionMigrationsFromStore({
        storeDir: i.storeDir,
        packageName: i.packageName,
        packageVersion: i.version,
      });
    },
    preflightMigrations: async (i) => {
      const { preflightExtensionMigrationsFromStore } = await import("@/lib/extension-migration-host");
      const pre = await preflightExtensionMigrationsFromStore({
        storeDir: i.storeDir,
        packageName: i.packageName,
      });
      return pre !== null;
    },
    // Host-port grant lifecycle (record/approve/read-scope/restore) — extracted
    // to `extension-host-port-grants.ts` (pipeline is a file-size bottleneck).
    ...makeHostPortGrantInstallDeps(),
    // Capability-ownership grant lifecycle (widget-auth token-key ownership),
    // mirroring the host-port wiring. (capability-ownership grant S0)
    ...makeOwnershipGrantInstallDeps(),
    beginInstallOp: (b) => beginInstallOp(b).then(() => undefined),
    advanceInstallOpPhase: (a) => advanceInstallOpPhase(a).then(() => undefined),
    // cinatra#158: the SUPERSESSION seam — atomic demote-OLD + promote-NEW.
    finalizeInstallOp: (id) => finalizeInstallOp(id).then(() => undefined),
    readInstallOp: (pkg, oid) => readInstallOp(pkg, oid),
    // The HOT-UPDATE pre-finalize probe default: supersession detection + the
    // inert import/register probe (cinatra#793 metadata-only rule inside).
    verifyActivatableBeforeFinalize: async (i) => {
      const { probeUpdateActivatableBeforeFinalize } = await import("@/lib/extension-runtime-activate");
      return probeUpdateActivatableBeforeFinalize(i);
    },
    gcStoreDir: async (storeDir) => {
      const { rm } = await import("node:fs/promises");
      await rm(storeDir, { recursive: true, force: true });
      await rm(`${storeDir}.tgz`, { force: true }).catch(() => undefined);
    },
    activateInProcess: async (i) => {
      const { activateInstalledPackageInProcess, summarizeActivation } = await import("@/lib/extension-runtime-activate");
      const results = await activateInstalledPackageInProcess(i.packageName, i.orgId, {
        currentStoreDir: i.storeDir,
        ...(i.storeRoot ? { storeRoot: i.storeRoot } : {}),
      });
      // Shared verdict: the loader emits ONE result per phase (register, then
      // bootstrap), so success requires a registration AND no failure — a fresh
      // install whose bootstrap throws must report activated:false, not true. Reuse
      // summarizeActivation so this rule never drifts from the hot-update path.
      // (Non-fatal: a fresh install has no prior version to roll back to.)
      const { activated, reason } = summarizeActivation(results, i.packageName);
      return reason === undefined ? { activated } : { activated, reason };
    },
    // The atomic hot-update activator with durable-rollback-first.
    activateUpdateWithRollback: async (i) => {
      const { hotUpdateWithDurableRollback } = await import("@/lib/extension-runtime-activate");
      return hotUpdateWithDurableRollback(i.packageName, i.orgId, i.storeDir,
        { restoreDurableAnchor: i.restoreDurableAnchor },
        { ...(i.storeRoot ? { storeRoot: i.storeRoot } : {}), priorDigest: i.priorDigest ?? null });
    },
    // cinatra#158 (d): the structured operational-event sink. No central event bus
    // backs the install path, so the default is the stable structured console
    // emitter (the same surface the hot-update rollbackComplete signal uses). Ops
    // alerting keys on `event: "install_durable_restore_failed"`.
    emitOperationalEvent: (event) => {
      // eslint-disable-next-line no-console
      console.error(`[operational-event] ${JSON.stringify(event)}`);
    },
  };
}

/**
 * Fully-wired INERT `InstallPipelineDeps` for unit tests (cinatra#158 (c)). Every
 * one of the now-REQUIRED deps gets a safe no-op/in-memory default; spread
 * `overrides` to swap in the specific behaviors a test exercises. This keeps test
 * call sites terse now that the deps are no longer individually optional. The
 * inert defaults intentionally disable the saga/gate machinery (no journal, no
 * activation, no compensation) — exactly the "omit it" behavior tests relied on
 * when these fields were optional, but now type-safe and explicit.
 */
export function makeTestInstallPipelineDeps(
  overrides: Partial<InstallPipelineDeps> = {},
): InstallPipelineDeps {
  const noop = async (): Promise<void> => undefined;
  const base: InstallPipelineDeps = {
    resolveIntegrity: async () => ({ integrity: "sha512-test", registryUrl: "https://registry.test" }),
    materialize: async (i) => ({
      storeDir: `/tmp/test-store/${i.packageName}/${i.version}`,
      digest: "testdigest",
      integrity: i.expectedIntegrity,
      contentHash: "testcontenthash",
    }),
    readRequestedPorts: async () => [],
    readDeclaredCompat: async () => ({ sdkAbiRange: null }),
    recordProvenance: noop,
    recordRequestedGrant: noop,
    approveGrant: noop,
    readGrantForScope: async () => null,
    restoreGrant: noop,
    applyMigrations: noop,
    preflightMigrations: async () => false,
    beginInstallOp: noop,
    advanceInstallOpPhase: noop,
    finalizeInstallOp: noop,
    readInstallOp: async () => null,
    readCurrentSource: async () => null,
    readCurrentDependencies: async () => null,
    activateInProcess: async () => ({ activated: false, reason: "no-activator" }),
    activateUpdateWithRollback: async () => ({ activated: false, reason: "no-activator" }),
    verifyActivatableBeforeFinalize: async () => ({ supersedes: false }),
    gcStoreDir: noop,
    readDependencyEdges: async () => [],
    persistDependencyEdges: noop,
    readAccessDeclaration: async () => null,
    persistAccessDeclaration: noop,
    readCurrentAccessDeclaration: async () => null,
    assertForwardInstallClosure: noop,
    emitOperationalEvent: () => undefined,
  };
  return { ...base, ...overrides };
}
