import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
import { sriForBytes } from "@/lib/extension-package-store-core";
import { materializePackageToStore } from "@/lib/extension-package-store";
import { installExtensionFromRegistry,
  makeTestInstallPipelineDeps, type InstallPipelineDeps } from "@/lib/extension-install-pipeline";
import { resolveInstallAnchor } from "@/lib/extension-install-anchor";
import { loadRuntimePackageExtensions } from "@/lib/runtime-package-loader";

// DEV install E2E. Closes the "/data dormant in dev" gap: drives the FULL
// install pipeline over a LOCALLY-PACKED connector tarball (no live registry, no
// publish) through the REAL materializer into a `/data`-shaped store, records the
// finalized trusted install row + approved grant, then resolves the REAL install
// anchor over that SAME recorded state and lets the REAL RuntimePackageLoader
// (the dev/prod dual-loader's `/data` half) activate it. Proves: pack → resolve →
// materialize → record → grant → finalize → anchor → activate-from-/data.
//
// The persistence layer is in-memory (one State the pipeline WRITES and the
// anchor READS), so the proof is autonomous + CI-gated — no DB, no registry, no
// container. The true prod-container / live-marketplace-version proof is the
// owner/infra tail (deferred).

const PKG = "@cinatra-ai/install-e2e-fixture"; // any vendor — scope confers ZERO trust
const VERSION = "1.0.0";
const REGISTRY = "https://registry.cinatra.ai"; // a trusted activation host (publicRegistryUrl)
const REGISTER_MJS = `export function register(ctx) { ctx.logger.info("install-e2e fixture registered"); }\n`;

type InstallState = {
  source?: { type: string; registryUrl: string; integrity: string; contentHash: string };
  grant?: { status: string; approvedPorts: string[]; orgId: string | null };
  journalPhase?: string;
};

let workDir: string;
let tarballBytes: Buffer;
let integrity: string;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "cinatra-install-e2e-"));
  const src = path.join(workDir, "src", "package");
  await mkdir(src, { recursive: true });
  await writeFile(
    path.join(src, "package.json"),
    JSON.stringify({
      name: PKG,
      version: VERSION,
      cinatra: { kind: "connector", serverEntry: "./register.mjs", requestedHostPorts: ["settings"], sdkAbiRange: "^2" },
    }),
  );
  await writeFile(path.join(src, "register.mjs"), REGISTER_MJS);
  const out = path.join(workDir, "fixture.tgz");
  await tar.c({ gzip: true, cwd: path.join(workDir, "src"), file: out }, ["package"]);
  tarballBytes = await readFile(out);
  integrity = sriForBytes(tarballBytes, "sha512");
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
});

// The unsigned bootstrap path is opt-IN now. These dev E2E
// tests install UNSIGNED packages as the vehicle, so they opt in explicitly.
let prevAllowUnsignedE2e: string | undefined;
beforeEach(() => {
  prevAllowUnsignedE2e = process.env.CINATRA_EXTENSION_ALLOW_UNSIGNED_BOOTSTRAP;
  process.env.CINATRA_EXTENSION_ALLOW_UNSIGNED_BOOTSTRAP = "true";
});
afterEach(() => {
  if (prevAllowUnsignedE2e === undefined) delete process.env.CINATRA_EXTENSION_ALLOW_UNSIGNED_BOOTSTRAP;
  else process.env.CINATRA_EXTENSION_ALLOW_UNSIGNED_BOOTSTRAP = prevAllowUnsignedE2e;
});

function makePipelineDeps(state: InstallState): InstallPipelineDeps {
  return {
    ...makeTestInstallPipelineDeps(),
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
        { fetchTarball: async () => ({ bytes: tarballBytes, integrity }), now: () => "2026-06-04T00:00:00.000Z" },
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
    // cinatra#158: the happy-path finalize is the supersession seam; reflect it in
    // the fake journal phase so the post-commit anchor read resolves `finalized`.
    finalizeInstallOp: async () => {
      state.journalPhase = "finalized";
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

describe("dev install E2E — local pack → /data → anchor → activate", () => {
  it("installs an UNSIGNED bootstrap connector: grant stays PENDING (capability split) yet the loader still imports it with ZERO ports", async () => {
    const storeRoot = path.join(workDir, "data-ok", "extensions", "packages");
    const state: InstallState = {};
    const orgId: string | null = null;

    // 1. INSTALL through the real pipeline (real materializer + recorded state).
    //    No signing keys are configured + REQUIRE_SIGNATURES is unset, so the
    //    package classifies as `trusted-bootstrap` — the capability split
    //    keeps its requested host-port grant PENDING (no auto-approve), but it
    //    remains import-trusted.
    const result = await installExtensionFromRegistry({ packageName: PKG, version: VERSION, orgId, storeRoot }, makePipelineDeps(state));
    expect(result.grantStatus).toBe("pending"); // bootstrap → ports stay pending
    expect(result.requestedPorts).toEqual(["settings"]);
    expect(state.grant?.status).toBe("pending"); // grant store never auto-approved
    expect(state.journalPhase).toBe("finalized"); // the activatability transition
    expect(state.source?.integrity).toBe(integrity);

    // 2. ACTIVATE through the real dev loader, resolving the REAL anchor from the
    //    SAME recorded state (no injected trustDecision — the live loop). The
    //    HIGH-finding regression: a pending grant must NOT make the anchor's
    //    persisted trust decision false — the bootstrap package still imports.
    const anchor = await makeAnchorResolver(state, orgId)(PKG);
    expect(anchor?.trustDecision).toBe(true); // decoupled from the pending port grant
    expect(anchor?.approvedPorts).toEqual([]); // but it carries ZERO approved ports
    const activations = await loadRuntimePackageExtensions(storeRoot, { resolveInstallAnchor: makeAnchorResolver(state, orgId) });
    // The loader runs register + bootstrap passes; the register pass must succeed.
    expect(activations.some((a) => a.packageName === PKG && a.status === "registered")).toBe(true);
    // No failures (the bootstrap pass is a clean "skipped" — the fixture has none).
    expect(activations.filter((a) => a.status === "failed")).toEqual([]);
  });

  it("FAILS CLOSED — a materialized package whose install never finalized is NOT activated", async () => {
    const storeRoot = path.join(workDir, "data-unfinalized", "extensions", "packages");
    const state: InstallState = {};
    const orgId: string | null = null;

    // Materialize + record source/grant but leave the journal NON-finalized.
    const deps = makePipelineDeps(state);
    const mat = await deps.materialize({ packageName: PKG, version: VERSION, expectedIntegrity: integrity, registryUrl: REGISTRY, storeRoot });
    await deps.recordProvenance({ packageName: PKG, orgId, version: VERSION, registryUrl: REGISTRY, integrity: mat.integrity, contentHash: mat.contentHash });
    await deps.approveGrant({ packageName: PKG, orgId, approvedPorts: ["settings"], requestedPorts: ["settings"], approvedBy: "test" });
    state.journalPhase = "granted"; // NOT finalized → the primary trust gate refuses

    const activations = await loadRuntimePackageExtensions(storeRoot, { resolveInstallAnchor: makeAnchorResolver(state, orgId) });
    expect(activations).toHaveLength(0); // fails closed — present in /data but not trusted
  });
});

// ---------------------------------------------------------------------------
// #180 PR-1: a DEPFUL fixture through the REAL pipeline + REAL dual-read +
// REAL edgeType-aware forward gate — edges persisted (incl. the `kind` field),
// fresh install refused while the blocking dep is absent, finalized once the
// dep is present.
// ---------------------------------------------------------------------------

describe("dev install E2E — dependency edges + forward gate (#180)", () => {
  const DEP_PKG = "@cinatra-ai/install-e2e-dep";
  const ROOT_PKG = "@cinatra-ai/install-e2e-depful-fixture";
  const ROOT_EDGES = [
    {
      packageName: DEP_PKG,
      kind: "connector",
      edgeType: "runtime",
      versionConstraint: { kind: "semver-range", range: "*" },
      requirement: "required",
    },
    {
      packageName: "@cinatra-ai/install-e2e-peer",
      kind: "connector",
      edgeType: "peer",
      versionConstraint: { kind: "semver-range", range: "*" },
      requirement: "optional",
    },
  ];

  async function packDepfulFixture(): Promise<{ bytes: Buffer; sri: string }> {
    const src = path.join(workDir, "src-depful", "package");
    await mkdir(src, { recursive: true });
    await writeFile(
      path.join(src, "package.json"),
      JSON.stringify({
        name: ROOT_PKG,
        version: VERSION,
        cinatra: {
          kind: "connector",
          serverEntry: "./register.mjs",
          requestedHostPorts: [],
          sdkAbiRange: "^2",
          dependencies: ROOT_EDGES,
          // The legacy vocabulary RESTATES a subset — the dual-read must
          // accept this (canonical wins) and the canonical edges persist.
          agentDependencies: { [DEP_PKG]: "*" },
        },
      }),
    );
    await writeFile(path.join(src, "register.mjs"), REGISTER_MJS);
    const out = path.join(workDir, "depful.tgz");
    await tar.c({ gzip: true, cwd: path.join(workDir, "src-depful"), file: out }, ["package"]);
    const bytes = await readFile(out);
    return { bytes, sri: sriForBytes(bytes, "sha512") };
  }

  function canonicalRow(packageName: string, dependencies: unknown[], orgId: string | null) {
    return {
      id: `iext_${packageName.split("/")[1]}`,
      packageName,
      ownerLevel: "platform" as const,
      ownerId: null,
      organizationId: orgId,
      kind: "connector" as const,
      status: "active" as const,
      source: { type: "local" as const, path: `/x/${packageName}`, resolvedCommitOrTreeHash: "h" },
      requiredInProd: false,
      dependencies: dependencies as never,
      manifestHash: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  it("REFUSES the fresh install while the blocking dep is absent; FINALIZES + persists edges (incl. kind) once present", async () => {
    const { bytes, sri } = await packDepfulFixture();
    const { readManifestDependencyEdgesFromStore } = await import(
      "@cinatra-ai/extensions/manifest-dependencies"
    );
    const { assertForwardInstallClosureForPackage } = await import(
      "@cinatra-ai/extensions/dependency-closure"
    );

    const orgId: string | null = null;
    let depInstalled = false;
    const state: InstallState & { dependencies?: unknown[] } = {};
    const storeRoot = path.join(workDir, "data-depful", "extensions", "packages");

    const deps: InstallPipelineDeps = {
      ...makeTestInstallPipelineDeps(),
      ...makePipelineDeps(state),
      resolveIntegrity: async () => ({ integrity: sri, registryUrl: REGISTRY }),
      materialize: async (i) => {
        const m = await materializePackageToStore(
          {
            packageName: i.packageName,
            version: i.version,
            expectedIntegrity: i.expectedIntegrity,
            registryUrl: i.registryUrl,
            storeRoot: i.storeRoot,
          },
          { fetchTarball: async () => ({ bytes, integrity: sri }), now: () => "2026-06-12T00:00:00.000Z" },
        );
        return { storeDir: m.storeDir, digest: m.digest, integrity: m.integrity, contentHash: m.contentHash };
      },
      // The REAL dual-read helper over the REAL materialized bytes.
      readDependencyEdges: async (storeDir) => (await readManifestDependencyEdgesFromStore(storeDir)).edges,
      persistDependencyEdges: async (i) => {
        state.dependencies = i.dependencies;
      },
      // The REAL edgeType-aware forward gate over a canonical snapshot that
      // mirrors what the persist seam just wrote.
      assertForwardInstallClosure: async (p) => {
        const rows = [canonicalRow(p.packageName, state.dependencies ?? [], p.orgId)];
        if (depInstalled) rows.push(canonicalRow(DEP_PKG, [], p.orgId));
        assertForwardInstallClosureForPackage(p.packageName, rows as never, { organizationId: p.orgId });
      },
    };

    // (a) dep ABSENT → the fresh install is refused LOUD, never finalized. The
    // missing PEER edge does NOT participate in the refusal (edgeType-aware).
    await expect(
      installExtensionFromRegistry({ packageName: ROOT_PKG, version: VERSION, orgId, storeRoot }, deps),
    ).rejects.toThrow(new RegExp(`requires ${DEP_PKG.replace("/", "\\/")} \\(missing\\)`));
    expect(state.journalPhase).not.toBe("finalized");

    // (b) dep PRESENT → finalizes; the persisted edges are the manifest's
    // canonical declaration VERBATIM — kind field included, peer edge included.
    depInstalled = true;
    const result = await installExtensionFromRegistry(
      { packageName: ROOT_PKG, version: VERSION, orgId, storeRoot },
      deps,
    );
    expect(result.installed).toBe(true);
    expect(state.journalPhase).toBe("finalized");
    expect(state.dependencies).toEqual(ROOT_EDGES);
    expect((state.dependencies as Array<{ kind?: string }>)[0]?.kind).toBe("connector");
  });
});
