import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";
import { sriForBytes } from "@/lib/extension-package-store-core";
import { materializePackageToStore } from "@/lib/extension-package-store";
import { installExtensionFromRegistry, type InstallPipelineDeps } from "@/lib/extension-install-pipeline";
import { resolveInstallAnchor } from "@/lib/extension-install-anchor";
import { loadRuntimePackageExtensions } from "@/lib/runtime-package-loader";
import { resolveCapabilityProviders, __resetCapabilityRegistry } from "@/lib/extension-capabilities-registry";
// The canonical serverEntry builder — THE SAME artifact the release pipeline
// executes (design §4.1: the e2e must consume the real
// builder, never an in-test reimplementation that could drift on externals /
// manifest rewrite / pruning / format / target).
import { buildServerEntryPack } from "../../../scripts/extensions/build-server-entry.mjs";

// FIRST-PARTY connector E2E (cinatra#161 issue ask #4, design §3.4(4)): build
// the REAL `extensions/cinatra-ai/nango-connector` with the canonical builder,
// pack the EXACT post-build dir, then drive the FULL real install pipeline —
// `installExtensionFromRegistry` → real materializer (bundled-deps gate +
// host-peer gate + built-artifacts-only gate all run over the REAL bundle) →
// real install anchor → `loadRuntimePackageExtensions` → status `registered`.
// This replaces synthetic-fixture-only coverage with a REAL connector through
// the REAL marketplace install path (same locally-packed-bytes seam as
// extension-install-e2e.test.ts — no live registry) and pins the builder's
// output contract so the release pipeline cannot drift from what the store
// accepts.
//
// nango's `register(ctx)` is PROBE-SAFE and lazy (see its header comment):
// it binds injected stores + registers the `nango-system` capability surface;
// every host service resolves lazily at CALL time — safe to activate in-test.

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, "../../..");
const CONNECTOR_DIR = path.join(REPO_ROOT, "extensions/cinatra-ai/nango-connector");

const PKG = "@cinatra-ai/nango-connector";
const REGISTRY = "https://registry.cinatra.ai"; // a trusted activation host (publicRegistryUrl)

type InstallState = {
  source?: { type: string; registryUrl: string; integrity: string; contentHash: string };
  grant?: { status: string; approvedPorts: string[]; orgId: string | null };
  journalPhase?: string;
};

let workDir: string;
let version: string;
let tarballBytes: Buffer;
let integrity: string;

beforeAll(async () => {
  // The connector tree is materialized from its companion repo (the
  // clone-back lock). A missing dir means the workspace is not synced — fail
  // LOUD (never skip-vacuous): run `node scripts/ci/sync-dev-extensions.mjs
  // --pinned` first (CI jobs do, via .github/actions/clone-extensions).
  const connectorStat = await stat(path.join(CONNECTOR_DIR, "package.json")).catch(() => null);
  if (!connectorStat?.isFile()) {
    throw new Error(
      `first-party e2e: ${CONNECTOR_DIR} is not materialized — run ` +
        "`node scripts/ci/sync-dev-extensions.mjs --pinned` (the clone-back sync) before this suite.",
    );
  }
  const sourceManifest = JSON.parse(await readFile(path.join(CONNECTOR_DIR, "package.json"), "utf8"));
  version = sourceManifest.version;

  workDir = await mkdtemp(path.join(tmpdir(), "cinatra-fp-e2e-"));

  // 1. BUILD with the canonical builder into the staging layout npm tarballs
  //    use (top-level `package/` dir), then pack the EXACT post-build dir.
  const staging = path.join(workDir, "staging");
  const packDir = path.join(staging, "package");
  const result = await buildServerEntryPack({ packageDir: CONNECTOR_DIR, outDir: packDir });

  // Pin the builder's OUTPUT CONTRACT (what the release pipeline publishes).
  expect(result.mode).toBe("bundled");
  expect(result.entryRel).toBe("./src/register.ts");
  const packed = JSON.parse(await readFile(path.join(packDir, "package.json"), "utf8"));
  expect(packed.cinatra.serverEntry).toBe("./register.mjs");
  expect(packed.dependencies).toBeUndefined(); // inlined → pruned (bundled-deps gate)
  expect(packed.files).toContain("register.mjs");
  expect(packed.exports).toEqual(sourceManifest.exports); // source entries kept
  expect((await stat(path.join(packDir, "register.mjs"))).isFile()).toBe(true);

  const out = path.join(workDir, "nango-connector.tgz");
  await tar.c({ gzip: true, cwd: staging, file: out }, ["package"]);
  tarballBytes = await readFile(out);
  integrity = sriForBytes(tarballBytes, "sha512");
}, 120_000);

afterAll(async () => {
  __resetCapabilityRegistry(); // the REAL register() wrote into the shared host registry
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
});

function makePipelineDeps(state: InstallState): InstallPipelineDeps {
  return {
    resolveIntegrity: async () => ({ integrity, registryUrl: REGISTRY }),
    materialize: async (i) => {
      const m = await materializePackageToStore(
        {
          packageName: i.packageName,
          version: i.version,
          expectedIntegrity: i.expectedIntegrity,
          registryUrl: i.registryUrl,
          storeRoot: i.storeRoot,
        },
        { fetchTarball: async () => ({ bytes: tarballBytes, integrity }), now: () => "2026-06-12T00:00:00.000Z" },
      );
      return { storeDir: m.storeDir, digest: m.digest, integrity: m.integrity, contentHash: m.contentHash };
    },
    readRequestedPorts: async (storeDir) => {
      const raw = await readFile(path.join(storeDir, "package.json"), "utf8");
      const ports = (JSON.parse(raw) as { cinatra?: { requestedHostPorts?: unknown } }).cinatra?.requestedHostPorts;
      return Array.isArray(ports) ? (ports as string[]) : [];
    },
    recordProvenance: async (p) => {
      state.source = { type: "verdaccio", registryUrl: p.registryUrl, integrity: p.integrity, contentHash: p.contentHash };
    },
    recordRequestedGrant: async (g) => {
      state.grant = { status: "pending", approvedPorts: [], orgId: g.orgId };
    },
    approveGrant: async (g) => {
      state.grant = { status: "approved", approvedPorts: g.approvedPorts, orgId: g.orgId };
    },
    beginInstallOp: async () => {
      state.journalPhase = "materialized";
    },
    advanceInstallOpPhase: async ({ phase }) => {
      state.journalPhase = phase;
    },
  };
}

function makeAnchorResolver(state: InstallState, orgId: string | null) {
  return (packageName: string) =>
    resolveInstallAnchor(packageName, {
      orgId,
      readActiveInstall: async () => (state.source ? { status: "active", source: state.source } : null),
      readGrant: async () => state.grant ?? null,
      readInstallOp: async () => (state.journalPhase ? { phase: state.journalPhase } : null),
    });
}

describe("first-party install E2E — canonical builder → pack → real pipeline → activate (cinatra#161)", () => {
  it("installs the BUILT nango-connector through the real pipeline and activates it `registered`", async () => {
    const storeRoot = path.join(workDir, "data", "extensions", "packages");
    const state: InstallState = {};
    const orgId: string | null = null;

    // 2. INSTALL through the real pipeline. The REAL materializer runs every
    //    install gate over the REAL bundle: bundled-deps (dependencies pruned
    //    by the builder), host-peer value-imports (the bundle keeps SDK
    //    imports type-only/erased), and the built-artifacts-only serverEntry
    //    gate (top-level register.mjs).
    const result = await installExtensionFromRegistry(
      { packageName: PKG, version, orgId, storeRoot },
      makePipelineDeps(state),
    );
    expect(result.requestedPorts).toEqual(["capabilities"]);
    expect(result.grantStatus).toBe("pending"); // unsigned bootstrap → ports stay pending
    expect(state.journalPhase).toBe("finalized");

    // 3. ADMIN APPROVAL (the separate grant flow): nango's register() calls
    //    ctx.capabilities.registerProvider, and the `capabilities` port is
    //    grant-gated — approve the requested port exactly as the admin
    //    review surface records it.
    state.grant = { status: "approved", approvedPorts: ["capabilities"], orgId };

    // 4. ACTIVATE through the real loader, real anchor, real grant-aware ctx.
    const anchor = await makeAnchorResolver(state, orgId)(PKG);
    expect(anchor?.trustDecision).toBe(true);
    expect(anchor?.approvedPorts).toEqual(["capabilities"]);

    const activations = await loadRuntimePackageExtensions(storeRoot, {
      resolveInstallAnchor: makeAnchorResolver(state, orgId),
    });
    const nango = activations.find((a) => a.packageName === PKG);
    expect(nango?.status).toBe("registered");
    expect(activations.filter((a) => a.status === "failed")).toEqual([]);

    // 5. REAL-SURFACE PROOF: the bundle's register() actually populated the
    //    host capability registry with the full nango-system surface.
    const providers = resolveCapabilityProviders("nango-system");
    expect(providers.some((p) => p.packageName === PKG)).toBe(true);
    const impl = providers.find((p) => p.packageName === PKG)?.impl as Record<string, unknown>;
    expect(typeof impl.isNangoConfigured).toBe("function");
    expect(typeof impl.handleNangoWebhookRequest).toBe("function");
    expect(typeof impl.saveNangoConnectionAction).toBe("function");
  }, 60_000);
});
