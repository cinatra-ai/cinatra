import { identityClaimMockFrom } from "./helpers/identity-claim-mock";
// cinatra#1788 (epic #1785) — install-time TYPED-PRODUCTION preflight.
//
// Drives the REAL installAgentFromPackage with collaborators mocked, asserting
// the manifest `cinatra.produces` contract is enforced FAIL-CLOSED before any
// write: an agent whose produces entry does not resolve to a REQUIRED
// artifact-kind dependency (or to a claimed objectTypeId of one) has its
// install REFUSED with a precise error naming the missing claimant/claim; a
// conforming agent installs. The retired #1059 advisory (`missingProducedArtifacts`)
// and install-time dynamic-type minting are gone — the dynamic-types engine was
// torn down end-to-end (epic #1785 entry 95; #1793), so there is nothing left to
// mint through (the invariant is now STRUCTURAL). The real contract
// (resolveTypedProducesContract) runs via importOriginal; only the schema-parse
// stub is overridden so the compact fixture manifest reaches the preflight.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstalledExtension, ExtensionDependency } from "@cinatra-ai/extensions/canonical-types";
import { satisfiesVersionRange } from "../../../registries/src/version-compare";
import { storeDigestDirV2 } from "@/lib/extension-package-store-core";

const ART = "@cinatra-ai/blog-post-artifact";
const TYPE = "@cinatra-ai/blog-post-artifact:post";
const OTHER_TYPE = "@cinatra-ai/blog-post-artifact:comment";
const DEV_SHA = "a1b2c3d";
let DEV_ROOT = "";

// Configurable agent manifest slices (produces + required deps) and the
// registry manifests the preflight resolves for each required artifact dep.
let PRODUCES: Array<{ extension: string; objectTypeId?: string }> = [];
let DEPENDENCIES: unknown[] = [];
let ARTIFACT_MANIFESTS: Record<string, unknown> = {};
// The version a semver-range edge resolves to (null = no satisfying version).
let MAX_SATISFYING: string | null = "1.0.0";
let INSTALLED_ROWS: InstalledExtension[] = [];
let JOURNALS = new Map<string, { phase: string; digest: string }>();
let DATA_ROOT = "";
let ROOT_STORE_DIR: string | null = null;
let IMAGE_RECORDS: Record<string, { packageName: string; kind: string; version: string; sourceDir: string }> = {};
let IMAGE_DIGESTS = new Map<string, { kind: string; version: string; digest: string }>();
const registryRead = vi.fn(async (packageName: string) => ARTIFACT_MANIFESTS[packageName] ?? null);
const journalRead = vi.fn(async (name: string, org: string | null, version: string) =>
  JOURNALS.get(JSON.stringify([name, org, version])) ?? null);
vi.mock("@/lib/extension-install-ops", () => ({
  readInstallOpForVersion: (...args: [string, string | null, string]) => journalRead(...args),
}));
vi.mock("@/lib/extension-data-root", () => ({ resolveExtensionDataRoot: () => DATA_ROOT }));
vi.mock("@/lib/generated/extensions.server", () => ({ get STATIC_EXTENSION_MANIFEST() { return IMAGE_RECORDS; } }));
vi.mock("@/lib/bundled-digests", () => ({ readRecordedBundledDigests: () => IMAGE_DIGESTS }));
vi.mock("../../../extensions/src/lifecycle-primitive", () => ({
  sourceSwitchExtension: async (id: string, source: InstalledExtension["source"]) => {
    const row = INSTALLED_ROWS.find((row) => row.id === id)!;
    row.source = source;
    return row;
  },
}));
vi.mock("@cinatra-ai/extensions/dev-version", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../extensions/src/dev-version")>(),
  currentGitSha: () => DEV_SHA,
}));
// Only the external root-payload lookup is mocked. Artifact selection, the
// journal/digest trust selector and actual package.json reads remain real.
vi.mock("@/lib/extension-store-payload", () => ({
  resolveFinalizedStorePayload: async ({ expectedKind }: { expectedKind: string }) =>
    expectedKind === "agent" && ROOT_STORE_DIR
      ? { storeDir: ROOT_STORE_DIR, version: "1.0.0" } : null,
}));

const requiredArtifactEdge = (packageName: string): ExtensionDependency => ({
  packageName,
  kind: "artifact",
  edgeType: "install-time",
  requirement: "required",
  versionConstraint: { kind: "semver-range", range: "^1.0.0" },
});

/** An artifact-kind package manifest declaring `objectTypes` claims. */
const artifactManifest = (packageName: string, types: string[]) => ({
  name: packageName,
  version: "1.0.0",
  cinatra: {
    kind: "artifact",
    artifact: { objectTypes: types.map((type) => ({ type, claim: "dedicated" })) },
  },
});

vi.mock("@cinatra-ai/extensions/manifest-dependencies", () => ({
  parseManifestDependencyEdges: vi.fn(() => ({ edges: [], source: "canonical" })),
  resolveLiveCanonicalEdgeTargets: vi.fn(async () => []),
  writeDependencyEdgesToCanonicalRows: vi.fn(async () => ({ patchedRowIds: [] })),
  versionConstraintToRange: (vc: { kind: string; range?: string; version?: string; ref?: string }) =>
    vc.kind === "semver-range" ? vc.range! : vc.kind === "exact" ? vc.version! : vc.ref!,
}));

vi.mock("@cinatra-ai/extensions/required-in-prod", () => ({
  checkRequiredExtensionVersionPin: () => ({ ok: true }),
}));

vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  listInstalledExtensions: vi.fn(async () => []),
  readInstalledExtensionsByPackageName: async (name: string) => INSTALLED_ROWS.filter((row) => row.packageName === name),
  readInstalledExtensionById: async (id: string) => INSTALLED_ROWS.find((row) => row.id === id) ?? null,
}));

vi.mock("@cinatra-ai/registries", () => ({
  satisfiesVersionRange,
  readAgentPayloadFromExtractedPackage: async () => ({ title: "Blog draft writer" }),
  isSafePathSegment: (s: unknown): boolean =>
    typeof s === "string" && s !== "." && s !== ".." && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9-])?$/.test(s),
  assertSafePathSegment: (s: unknown, label = "path segment"): void => {
    const ok = typeof s === "string" && s !== "." && s !== ".." && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9-])?$/.test(s);
    if (!ok) throw new Error("unsafe " + label + ": " + JSON.stringify(s));
  },
  ensureConfig: (c: unknown) => c ?? { registryUrl: "https://registry.cinatra.ai", packageScope: "@cinatra-ai", token: "t", uiUrl: null },
  // The preflight resolves each required artifact dep's PINNED version, then its
  // PUBLISHED manifest. The fixture edges use a semver-range, so the preflight
  // calls resolveMaxSatisfyingVersion first.
  resolveMaxSatisfyingVersion: async () => MAX_SATISFYING,
  getPublishedExtensionSummary: async ({ packageName }: { packageName: string }) => ({
    kind: "artifact" as const,
    resolvedVersion: "1.0.0",
    manifest: await registryRead(packageName),
  }),
  extractAgentPackage: async () => ({
    packageName: "@cinatra-ai/blog-draft-writer-agent",
    packageVersion: "1.0.0",
    tempDir: "/tmp/extract-fixture",
    manifest: {
      name: "@cinatra-ai/blog-draft-writer-agent",
      version: "1.0.0",
      cinatra: {
        packageType: "agent-package",
        manifestVersion: "1",
        type: "orchestrator",
        produces: PRODUCES,
        dependencies: DEPENDENCIES,
      },
    },
    payload: {
      title: "Blog draft writer",
      description: "d",
      template: { name: "Blog draft writer", description: "d", sourceNl: "src" },
      version: { snapshot: { nodes: [] } },
    },
  }),
  cleanupExtractedAgentPackage: async (dir: string) => {
    if (dir.startsWith(join(tmpdir(), "cinatra-agent-store-payload-"))) await rm(dir, { recursive: true, force: true });
  },
  dependencyScopePrefixesFor: () => ["@cinatra-ai/"],
  installPackageWithDependencies: async () => {
    throw new Error("not used in this test");
  },
}));

// Keep the REAL typed-produces contract (resolveTypedProducesContract) so the
// preflight logic is under test; only stub the schema parse + type constants so
// the compact fixture manifest ("agent-package"/"1") reaches the preflight.
vi.mock("../verdaccio/package-contract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../verdaccio/package-contract")>();
  return {
    ...actual,
    parseAgentPackageManifestForInstall: (x: unknown) => x,
    CINATRA_AGENT_PACKAGE_TYPE: "agent-package",
    CINATRA_AGENT_MANIFEST_VERSION: "1",
  };
});
vi.mock("../verdaccio/cli-flags", () => ({ buildRegistryAuthArgs: () => [] }));

const createLocal = vi.fn(async (..._a: unknown[]) => ({ templateId: "tpl-fresh", versionId: "ver-fresh" }));
vi.mock("../import-export-actions", () => ({
  createLocalAgentTemplateVersion: (...a: unknown[]) => createLocal(...(a as [])),
}));

const readTemplate = vi.fn(async (): Promise<{ id: string; status: string } | null> => null);
const updateTemplate = vi.fn(async (..._a: unknown[]) => {});
vi.mock("../store", () => ({
  readAgentTemplateByPackageName: (...a: unknown[]) => readTemplate(...(a as [])),
  // cinatra#2616: the install/import paths now treat a null result as a
  // REFUSAL, so the stub must return the row it "updated".
  updateAgentTemplate: async (...a: unknown[]) =>
    (await updateTemplate(...(a as []))) ?? { id: (a as [string])[0] },
  updateAgentTemplatePackageVersion: vi.fn(async () => {}),
  createAgentVersion: vi.fn(async () => {}),
}));
vi.mock("../agent-template-identity", async () => identityClaimMockFrom((n: string) => (readTemplate as (p?: string) => unknown)(n) as never));

// buildAgentTemplateInstallSeed compiles the OAS; return a minimal compiled root
// (no `producesObjectTypes` — that field is retired).
vi.mock("../oas-compiler", () => ({
  compileOasAgentJson: async () => ({
    ok: true,
    value: {
      approvalPolicy: { steps: [] },
      inputSchema: { type: "object", properties: {} },
      outputSchema: null,
      prompt: null,
      packageName: "@cinatra-ai/blog-draft-writer-agent",
      packageVersion: "1.0.0",
      agentDependencies: {},
      type: "orchestrator",
      compiledPlan: [],
      hitlScreens: [],
      llmConfig: null,
      toolboxes: [],
      agentSpecVersion: "26.1.0",
      triggerMode: "full",
      gatedSteps: [],
      cinatraConfig: null,
    },
  }),
}));

// AC2: install-path dynamic-type minting is retired end-to-end — the
// dynamic-types engine (auto-registrar + dynamic_object_types) was torn down
// (epic cinatra#1785 entry 95; #1793), so install-from-package has no
// dynamic-type mutator to import or call. The invariant is now STRUCTURAL (there
// is nothing left to mint through), not a mock-observed not-called assertion.
vi.mock("@cinatra-ai/objects/registry", () => ({ objectTypeRegistry: { resolve: () => null } }));
vi.mock("../agent-runtime-mount", () => ({
  resolveAgentRuntimeMountDir: () => "/tmp/agents-fixture",
  resolveDevExtensionSourceRoot: () => "/tmp/agents-fixture",
}));
vi.mock("../materialize-agent-package", () => ({
  materializeAgentPackageToDisk: async () => ({ materialized: true, targetDir: "/tmp/agents-fixture/pkg", wasReinstall: false }),
  commitMaterialize: async () => {},
  rollbackMaterialize: async () => {},
  withInstallLock: async (_pkg: string, fn: () => Promise<unknown>) => fn(),
  withGlobalExtensionLifecycleLock: async (fn: () => Promise<unknown>) => fn(),
}));
vi.mock("../wayflow-reload-client", () => ({ triggerWayflowReload: async () => ({ ok: true }) }));

import { installAgentFromPackage } from "../install-from-package";

const install = (extra?: Record<string, unknown>) =>
  installAgentFromPackage({ packageName: "@cinatra-ai/blog-draft-writer-agent", orgId: "org-1", ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  readTemplate.mockResolvedValue(null);
  PRODUCES = [];
  DEPENDENCIES = [];
  ARTIFACT_MANIFESTS = {};
  MAX_SATISFYING = "1.0.0";
  INSTALLED_ROWS = []; JOURNALS = new Map(); ROOT_STORE_DIR = null;
  IMAGE_RECORDS = {}; IMAGE_DIGESTS = new Map();
  registryRead.mockImplementation(async (name) => ARTIFACT_MANIFESTS[name] ?? null);
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (DATA_ROOT) await rm(DATA_ROOT, { recursive: true, force: true });
  if (DEV_ROOT) await rm(DEV_ROOT, { recursive: true, force: true });
  DATA_ROOT = ""; DEV_ROOT = "";
});

describe("installAgentFromPackage — cinatra#1788 typed-production preflight", () => {
  it("conforming: produces objectTypeId claimed by a required artifact dep → installs, no dynamic type minted", async () => {
    PRODUCES = [{ extension: ART, objectTypeId: TYPE }];
    DEPENDENCIES = [requiredArtifactEdge(ART)];
    ARTIFACT_MANIFESTS = { [ART]: artifactManifest(ART, [TYPE]) };
    const res = await install();
    expect(res.templateId).toBeTruthy();
  });

  it("conforming coarse: produces without objectTypeId, extension is a required artifact dep → installs", async () => {
    PRODUCES = [{ extension: ART }];
    DEPENDENCIES = [requiredArtifactEdge(ART)];
    ARTIFACT_MANIFESTS = { [ART]: artifactManifest(ART, []) };
    const res = await install();
    expect(res.templateId).toBeTruthy();
  });

  it("BLOCKS: produces objectTypeId NOT claimed by the required artifact dep → refused, names the claim", async () => {
    PRODUCES = [{ extension: ART, objectTypeId: TYPE }];
    DEPENDENCIES = [requiredArtifactEdge(ART)];
    ARTIFACT_MANIFESTS = { [ART]: artifactManifest(ART, [OTHER_TYPE]) };
    await expect(install()).rejects.toThrow(/typed-production contract failed/);
    await expect(install()).rejects.toThrow(TYPE);
    expect(createLocal).not.toHaveBeenCalled();
  });

  it("BLOCKS: produces names an extension that is NOT a required artifact dependency → refused", async () => {
    PRODUCES = [{ extension: ART, objectTypeId: TYPE }];
    DEPENDENCIES = []; // no required artifact-kind dependency edge
    await expect(install()).rejects.toThrow(/not a REQUIRED artifact-kind dependency/);
    expect(createLocal).not.toHaveBeenCalled();
  });

  it("BLOCKS: an OPTIONAL artifact dependency does not satisfy a typed produces entry", async () => {
    PRODUCES = [{ extension: ART, objectTypeId: TYPE }];
    DEPENDENCIES = [{ ...requiredArtifactEdge(ART), requirement: "optional" }];
    ARTIFACT_MANIFESTS = { [ART]: artifactManifest(ART, [TYPE]) };
    await expect(install()).rejects.toThrow(/not a REQUIRED artifact-kind dependency/);
  });

  it("BLOCKS: an unsatisfiable version range fails closed even if the manifest would claim the type (F2)", async () => {
    PRODUCES = [{ extension: ART, objectTypeId: TYPE }];
    DEPENDENCIES = [requiredArtifactEdge(ART)]; // semver-range edge
    ARTIFACT_MANIFESTS = { [ART]: artifactManifest(ART, [TYPE]) };
    MAX_SATISFYING = null; // no published version satisfies the range → fail closed
    await expect(install()).rejects.toThrow(/typed-production contract failed/);
    expect(createLocal).not.toHaveBeenCalled();
  });

  it("no produces → no-op, installs", async () => {
    PRODUCES = [];
    const res = await install();
    expect(res.templateId).toBeTruthy();
  });

  it("UPSERT branch: enforces the contract identically (refuses a violating re-install before any write)", async () => {
    readTemplate.mockResolvedValue({ id: "tpl-existing", status: "active" });
    PRODUCES = [{ extension: ART, objectTypeId: TYPE }];
    DEPENDENCIES = [requiredArtifactEdge(ART)];
    ARTIFACT_MANIFESTS = { [ART]: artifactManifest(ART, [OTHER_TYPE]) };
    await expect(install()).rejects.toThrow(/typed-production contract failed/);
    expect(updateTemplate).not.toHaveBeenCalled();
  });
});


const ROOT_PACKAGE = "@cinatra-ai/blog-draft-writer-agent";
const ROOT_DIGEST = "a".repeat(64);
const ART_DIGEST = "b".repeat(64);
const suppliedClaimContext = {
  rootAnchor: { ownerLevel: "organization" as const, ownerId: "org-1", organizationId: "org-1" },
  provenance: { type: "local" as const, path: "uploaded.tgz", contentDigest: ROOT_DIGEST },
};
function installedRow(id: string, packageName: string, kind: "agent" | "artifact", org: string | null, digest: string): InstalledExtension {
  return {
    id, packageName, kind, organizationId: org, ownerLevel: org ? "organization" : "platform",
    ownerId: org ?? "__platform__", status: "active", version: "0.0.0", isDefault: true,
    requiredInProd: false, manifestHash: digest, createdAt: new Date(0), updatedAt: new Date(0), dependencies: [], dependencyEdges: [],
    source: { type: "local", path: "uploaded.tgz", resolvedCommitOrTreeHash: "test-tree", contentDigest: digest,
      contentHash: digest, integrity: "sha512-genuine-test-tarball", activeDigest: digest },
  };
}
async function writePayload(row: InstalledExtension, manifest: unknown, digest: string) {
  const dir = storeDigestDirV2(DATA_ROOT, row.kind, row.packageName, digest);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify(manifest));
  JOURNALS.set(JSON.stringify([row.packageName, row.organizationId, row.isDefault === false ? row.version : "0.0.0"]), { phase: "finalized", digest });
  return dir;
}
async function uploadedFixture() {
  DATA_ROOT = await mkdtemp(join(tmpdir(), "cinatra-4002-native-"));
  PRODUCES = [{ extension: ART, objectTypeId: TYPE }]; DEPENDENCIES = [requiredArtifactEdge(ART)];
  const root = installedRow("agent-row", ROOT_PACKAGE, "agent", "org-1", ROOT_DIGEST);
  root.dependencies = DEPENDENCIES as InstalledExtension["dependencies"];
  root.dependencyEdges = [{ ...requiredArtifactEdge(ART), resolvedInstallId: "artifact-row", resolutionReason: "scoped:org" }];
  const artifact = installedRow("artifact-row", ART, "artifact", "org-1", ART_DIGEST);
  INSTALLED_ROWS = [root, artifact];
  ROOT_STORE_DIR = await writePayload(root, { name: ROOT_PACKAGE, version: "1.0.0", cinatra: {
    kind: "agent", packageType: "agent-package", manifestVersion: "1", type: "orchestrator", produces: PRODUCES, dependencies: DEPENDENCIES,
  } }, ROOT_DIGEST);
  await writePayload(artifact, artifactManifest(ART, [TYPE]), ART_DIGEST);
  registryRead.mockImplementation(async () => { throw new Error("registry is unreachable for this upload"); });
  return { root, artifact };
}
const upload = () => install({ packageVersion: "1.0.0", anchorOrgId: "org-1", requireStorePayload: true, suppliedClaimContext });
async function platformFallback() {
  const row = installedRow("platform-artifact", ART, "artifact", null, "c".repeat(64));
  INSTALLED_ROWS.push(row); await writePayload(row, artifactManifest(ART, [TYPE]), "c".repeat(64)); return row;
}

describe("cinatra#4002 — uploaded typed production reads the installed required edge", () => {
  it("real uploaded blog draft writer installs with a finalized artifact and unreachable registry", async () => {
    await uploadedFixture(); expect((await upload()).templateId).toBeTruthy(); expect(registryRead).not.toHaveBeenCalled();
  });
  it("allows the declared dependency's locked platform row when no own-org row exists", async () => {
    const { root, artifact } = await uploadedFixture(); INSTALLED_ROWS = [root];
    const platform = await platformFallback(); platform.status = "locked";
    root.dependencyEdges = []; expect((await upload()).templateId).toBeTruthy(); expect(registryRead).not.toHaveBeenCalled();
    expect(journalRead).toHaveBeenCalledWith(ART, null, "0.0.0"); expect(artifact.organizationId).toBe("org-1");
  });
  it("honors a persisted non-default version instead of a claiming default", async () => {
    const { artifact } = await uploadedFixture(); artifact.isDefault = false; artifact.version = "1.0.0";
    await writePayload(artifact, artifactManifest(ART, [OTHER_TYPE]), ART_DIGEST);
    await platformFallback(); await expect(upload()).rejects.toThrow(/typed-production contract failed/);
    expect(journalRead).toHaveBeenCalledWith(ART, "org-1", "1.0.0"); expect(createLocal).not.toHaveBeenCalled();
  });
  it.each(["foreign-org", "archived", "wrong-kind", "stale-version", "unfinalized", "digest-mismatch", "wrong-name", "missing-selected"])("refuses persisted %s without fallback", async (failure) => {
    const { artifact } = await uploadedFixture(); await platformFallback();
    if (failure === "foreign-org") artifact.organizationId = "foreign-org";
    if (failure === "archived") artifact.status = "archived";
    if (failure === "wrong-kind") artifact.kind = "agent";
    if (failure === "raw-kind") await writeFile(join(sourceDir, "package.json"), JSON.stringify({ ...artifactManifest(ART, [TYPE]), cinatra: { kind: "agent" } }));
    if (failure === "image-kind") IMAGE_RECORDS[ART].kind = "agent";
    if (failure === "image-name") IMAGE_RECORDS[ART].packageName = "@other/artifact";
    if (failure === "heal-owner") artifact.ownerId = "foreign-org";
    if (failure === "stale-version") await writePayload(artifact, { ...artifactManifest(ART, [TYPE]), version: "2.0.0" }, ART_DIGEST);
    if (failure === "unfinalized") JOURNALS.get(JSON.stringify([ART, "org-1", "0.0.0"]))!.phase = "materialized";
    if (failure === "digest-mismatch") JOURNALS.get(JSON.stringify([ART, "org-1", "0.0.0"]))!.digest = "d".repeat(64);
    if (failure === "wrong-name") await writePayload(artifact, artifactManifest("@other/name", [TYPE]), ART_DIGEST);
    if (failure === "missing-selected") INSTALLED_ROWS = INSTALLED_ROWS.filter((row) => row !== artifact);
    await expect(upload()).rejects.toThrow(/typed-production contract failed/); expect(createLocal).not.toHaveBeenCalled(); expect(registryRead).not.toHaveBeenCalled();
  });
  it.each(["unfinalized", "wrong-claim"])("does not fall back from an own-org %s row", async (failure) => {
    const { root, artifact } = await uploadedFixture(); root.dependencyEdges = []; await platformFallback();
    if (failure === "unfinalized") JOURNALS.delete(JSON.stringify([ART, "org-1", "0.0.0"]));
    else await writePayload(artifact, artifactManifest(ART, [OTHER_TYPE]), ART_DIGEST);
    await expect(upload()).rejects.toThrow(/typed-production contract failed/); expect(createLocal).not.toHaveBeenCalled();
  });
  it("no installed row refuses even when a claiming image/registry manifest exists", async () => {
    const { root } = await uploadedFixture(); INSTALLED_ROWS = [root]; root.dependencyEdges = [];
    ARTIFACT_MANIFESTS[ART] = artifactManifest(ART, [TYPE]); await expect(upload()).rejects.toThrow(/typed-production contract failed/);
  });
  it("canonical 0.0.0 does not conceal a supplied payload outside the required range", async () => {
    const { root, artifact } = await uploadedFixture(); root.dependencyEdges = [];
    await writePayload(artifact, { ...artifactManifest(ART, [TYPE]), version: "0.0.0" }, ART_DIGEST);
    await expect(upload()).rejects.toThrow(/typed-production contract failed/);
  });
  it("a matching image-owned bundled platform artifact needs no fabricated journal", async () => {
    const { root } = await uploadedFixture(); const row = installedRow("image-artifact", ART, "artifact", null, ART_DIGEST);
    row.source = { type: "bundled", packageName: ART, version: "1.0.0", digest: ART_DIGEST }; row.version = "1.0.0"; row.status = "locked";
    INSTALLED_ROWS = [root, row]; root.dependencyEdges = [{ ...requiredArtifactEdge(ART), resolvedInstallId: row.id, resolutionReason: "scoped:platform" }];
    const sourceDir = join(DATA_ROOT, "image-owned"); await mkdir(sourceDir);
    await writeFile(join(sourceDir, "package.json"), JSON.stringify(artifactManifest(ART, [TYPE])));
    IMAGE_RECORDS[ART] = { packageName: ART, kind: "artifact", version: "1.0.0", sourceDir };
    IMAGE_DIGESTS.set(ART, { version: "1.0.0", kind: "artifact", digest: ART_DIGEST });
    expect((await upload()).templateId).toBeTruthy(); expect(journalRead).not.toHaveBeenCalledWith(ART, null, expect.anything());
  });
  it("a dev image row with no recorded digest uses the same generated version identity", async () => {
    const { root } = await uploadedFixture(); const row = installedRow("dev-image", ART, "artifact", null, ART_DIGEST);
    row.source = { type: "bundled", packageName: ART, version: "1.0.0" }; row.version = "1.0.0"; row.status = "locked";
    INSTALLED_ROWS = [root, row]; root.dependencyEdges = [];
    const sourceDir = join(DATA_ROOT, "dev-image-owned"); await mkdir(sourceDir);
    await writeFile(join(sourceDir, "package.json"), JSON.stringify(artifactManifest(ART, [TYPE])));
    IMAGE_RECORDS[ART] = { packageName: ART, kind: "artifact", version: "1.0.0", sourceDir };
    expect((await upload()).templateId).toBeTruthy(); expect(registryRead).not.toHaveBeenCalled();
  });
  it("the original workspace anchor cannot borrow the translated native organization's claims", async () => {
    const { root } = await uploadedFixture(); root.organizationId = null; root.ownerLevel = "workspace"; root.ownerId = "__platform__"; root.dependencyEdges = [];
    await writePayload(root, { name: ROOT_PACKAGE, version: "1.0.0", cinatra: {
      kind: "agent", packageType: "agent-package", manifestVersion: "1", type: "orchestrator", produces: PRODUCES, dependencies: DEPENDENCIES,
    } }, ROOT_DIGEST);
    const platform = await platformFallback(); await writePayload(platform, artifactManifest(ART, [OTHER_TYPE]), "c".repeat(64));
    await expect(install({ packageVersion: "1.0.0", anchorOrgId: null, ownerLevel: "organization", ownerId: "org-1", requireStorePayload: true,
      suppliedClaimContext: { ...suppliedClaimContext, rootAnchor: { ownerLevel: "workspace", ownerId: "__platform__", organizationId: null } },
    })).rejects.toThrow(/typed-production contract failed/);
    expect(createLocal).not.toHaveBeenCalled(); expect(registryRead).not.toHaveBeenCalled();
  });
  it.each(["image-version", "image-kind", "image-digest", "missing-image", "source-dir-override"])("bundled %s fails closed against authoritative image metadata", async (failure) => {
    const { root } = await uploadedFixture(); const row = installedRow("image-artifact", ART, "artifact", null, ART_DIGEST);
    row.source = { type: "bundled", packageName: ART, version: "1.0.0", digest: ART_DIGEST }; row.version = "1.0.0";
    INSTALLED_ROWS = [root, row]; root.dependencyEdges = [{ ...requiredArtifactEdge(ART), resolvedInstallId: row.id, resolutionReason: "scoped:platform" }];
    const sourceDir = join(DATA_ROOT, "image-owned"); await mkdir(sourceDir);
    await writeFile(join(sourceDir, "package.json"), JSON.stringify(artifactManifest(ART, failure === "source-dir-override" ? [OTHER_TYPE] : [TYPE])));
    IMAGE_RECORDS[ART] = { packageName: ART, kind: "artifact", version: "1.0.0", sourceDir };
    IMAGE_DIGESTS.set(ART, { version: "1.0.0", kind: "artifact", digest: ART_DIGEST });
    if (failure === "image-version") IMAGE_RECORDS[ART].version = "2.0.0";
    if (failure === "image-kind") IMAGE_RECORDS[ART].kind = "agent";
    if (failure === "image-digest") IMAGE_DIGESTS.get(ART)!.digest = "c".repeat(64);
    if (failure === "missing-image") delete IMAGE_RECORDS[ART];
    if (failure === "source-dir-override") Object.assign(row.source, { sourceDir: ROOT_STORE_DIR });
    await expect(upload()).rejects.toThrow(/typed-production contract failed/); expect(createLocal).not.toHaveBeenCalled();
  });
  it("does not reuse a prior root edge when finalized root declarations changed", async () => {
    const { root } = await uploadedFixture();
    root.dependencies = [{ ...requiredArtifactEdge(ART), versionConstraint: { kind: "exact", version: "2.0.0" } }];
    root.dependencyEdges = [{ ...root.dependencies[0], resolvedInstallId: "artifact-row", resolutionReason: "scoped:org" }];
    // The current payload requires ^1.0.0; the old edge's pin is not its authority.
    expect((await upload()).templateId).toBeTruthy(); expect(registryRead).not.toHaveBeenCalled();
  });
  it.each(["foreign-owner", "root-archived", "root-unfinalized", "root-provenance", "root-version", "root-declarations", "ambiguous-root"])("root %s cannot lend persisted edge authority", async (failure) => {
    const { root } = await uploadedFixture();
    if (failure === "foreign-owner") root.ownerId = "other-owner";
    if (failure === "root-archived") root.status = "archived";
    if (failure === "root-unfinalized") JOURNALS.delete(JSON.stringify([ROOT_PACKAGE, "org-1", "0.0.0"]));
    if (failure === "root-provenance") Object.assign(root.source, { contentDigest: "e".repeat(64) });
    if (failure === "ambiguous-root") INSTALLED_ROWS.push({ ...root, id: "second-root" });
    if (failure === "root-version" || failure === "root-declarations") {
      const manifest = { name: ROOT_PACKAGE, version: failure === "root-version" ? "2.0.0" : "1.0.0", cinatra: {
        kind: "agent", packageType: "agent-package", manifestVersion: "1", type: "orchestrator", produces: PRODUCES,
        dependencies: failure === "root-declarations" ? [] : DEPENDENCIES,
      } };
      // A disagreement with the finalized bytes used by the installer is
      // simulated at the canonical read port, not by changing extracted input.
      Object.assign(root.source, { activeDigest: "e".repeat(64) });
      await writePayload(root, manifest, "e".repeat(64));
    }
    await expect(upload()).rejects.toThrow(/typed-production contract failed/);
    expect(createLocal).not.toHaveBeenCalled(); expect(registryRead).not.toHaveBeenCalled();
  });
  it("a fresh unresolved edge picks a satisfying installed sibling within the own-org scope", async () => {
    const { root, artifact } = await uploadedFixture(); root.dependencyEdges = [];
    artifact.source = { type: "verdaccio", packageName: ART, version: "2.0.0", registryUrl: "https://registry.example.invalid", integrity: "sha512-native", contentHash: ART_DIGEST, activeDigest: ART_DIGEST };
    artifact.version = "2.0.0";
    await writePayload(artifact, { ...artifactManifest(ART, [TYPE]), version: "2.0.0" }, ART_DIGEST);
    const sibling = installedRow("satisfying-sibling", ART, "artifact", "org-1", "c".repeat(64));
    sibling.isDefault = false; sibling.version = "1.0.0"; INSTALLED_ROWS.push(sibling);
    await writePayload(sibling, artifactManifest(ART, [TYPE]), "c".repeat(64));
    expect((await upload()).templateId).toBeTruthy(); expect(journalRead).toHaveBeenCalledWith(ART, "org-1", "1.0.0");
  });
  it("an uploaded optional edge still cannot authorize a typed claim", async () => {
    const { root } = await uploadedFixture(); DEPENDENCIES = [{ ...requiredArtifactEdge(ART), requirement: "optional" }];
    ROOT_STORE_DIR = await writePayload(root, { name: ROOT_PACKAGE, version: "1.0.0", cinatra: {
      kind: "agent", packageType: "agent-package", manifestVersion: "1", type: "orchestrator", produces: PRODUCES, dependencies: DEPENDENCIES,
    } }, ROOT_DIGEST);
    await expect(upload()).rejects.toThrow(/not a REQUIRED artifact-kind dependency/); expect(createLocal).not.toHaveBeenCalled();
  });
  it("registry installs keep registry planned-closure claims despite installed claiming bytes", async () => {
    await uploadedFixture(); ROOT_STORE_DIR = null;
    registryRead.mockImplementation(async () => artifactManifest(ART, [OTHER_TYPE]));
    await expect(install()).rejects.toThrow(/typed-production contract failed/); expect(registryRead).toHaveBeenCalled(); expect(createLocal).not.toHaveBeenCalled();
  });
});

// #3759 App458: the real installed lookup reads raw development-local claims.
async function devLocalFixture(record: "heal" | "git" = "heal") {
  const { root, artifact } = await uploadedFixture();
  DEV_ROOT = await realpath(await mkdtemp(join(tmpdir(), "cinatra-dev-local-claim-")));
  vi.spyOn(process, "cwd").mockReturnValue(DEV_ROOT);
  vi.stubEnv("CINATRA_RUNTIME_MODE", "development");
  const relative = "extensions/cinatra-ai/blog-post-artifact";
  const sourceDir = join(DEV_ROOT, relative);
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "package.json"), JSON.stringify(artifactManifest(ART, [TYPE])));
  // Exact defaultInstallRow heal shape: explicit version, platform, no digest.
  artifact.organizationId = null; artifact.ownerLevel = "platform"; artifact.ownerId = null;
  artifact.version = "1.0.0"; artifact.manifestHash = null;
  artifact.source = { type: "local", path: sourceDir, resolvedCommitOrTreeHash: "in-tree@1.0.0" };
  IMAGE_RECORDS[ART] = { packageName: ART, kind: "artifact", version: "1.0.0", sourceDir: relative };
  root.dependencyEdges = [{ ...requiredArtifactEdge(ART), resolvedInstallId: artifact.id, resolutionReason: "scoped:platform" }];
  JOURNALS.delete(JSON.stringify([ART, "org-1", "0.0.0"]));
  if (record === "git") {
    // Execute the maintained recorder; mock only its canonical write/Git read.
    const { recordDevExtensionVersion } = await import("@cinatra-ai/extensions/dev-version");
    expect((await recordDevExtensionVersion(ART, sourceDir, { sha: DEV_SHA })).ok).toBe(true);
    expect(artifact.version).toBe("1.0.0");
    expect(artifact.source).toEqual({ type: "local", path: sourceDir, resolvedCommitOrTreeHash: DEV_SHA });
  }
  return { root, artifact, sourceDir };
}

describe("#3759 trusted development-local installed claims", () => {
  it.each(["heal", "git"] as const)("reads a legitimate %s record's raw claims without digest or registry", async (record) => {
    await devLocalFixture(record);
    expect((await upload()).templateId).toBeTruthy();
    expect(registryRead).not.toHaveBeenCalled();
    expect(journalRead).not.toHaveBeenCalledWith(ART, null, expect.anything());
  });
  it.each(["production", "test", ""])("refuses a nondigest local record outside development (%s)", async (mode) => {
    await devLocalFixture(); vi.stubEnv("CINATRA_RUNTIME_MODE", mode);
    await expect(upload()).rejects.toThrow(/typed-production contract failed/);
    expect(createLocal).not.toHaveBeenCalled(); expect(registryRead).not.toHaveBeenCalled();
  });
  it.each(["wrong-name", "wrong-kind", "raw-kind", "image-kind", "image-name", "heal-owner", "manifest-version", "row-version", "image-version", "foreign-org", "heal-own-org", "wrong-hash", "unknown-git", "stale-git", "wrong-row-path", "traversal-path", "wrong-image-path", "missing-image", "unfinalized-upload", "custom-local", "wrong-claim", "package-json-symlink", "package-dir-symlink"])("refuses %s without registry or other-row fallback", async (failure) => {
    const { artifact, sourceDir } = await devLocalFixture();
    if (failure === "wrong-name") await writeFile(join(sourceDir, "package.json"), JSON.stringify(artifactManifest("@other/artifact", [TYPE])));
    if (failure === "wrong-kind") artifact.kind = "agent";
    if (failure === "raw-kind") await writeFile(join(sourceDir, "package.json"), JSON.stringify({ ...artifactManifest(ART, [TYPE]), cinatra: { kind: "agent" } }));
    if (failure === "image-kind") IMAGE_RECORDS[ART].kind = "agent";
    if (failure === "image-name") IMAGE_RECORDS[ART].packageName = "@other/artifact";
    if (failure === "heal-owner") artifact.ownerId = "foreign-org";
    if (failure === "manifest-version") await writeFile(join(sourceDir, "package.json"), JSON.stringify({ ...artifactManifest(ART, [TYPE]), version: "2.0.0" }));
    if (failure === "row-version") artifact.version = "2.0.0";
    if (failure === "image-version") IMAGE_RECORDS[ART].version = "2.0.0";
    if (failure === "foreign-org") artifact.organizationId = "foreign-org";
    if (failure === "heal-own-org") { artifact.organizationId = "org-1"; artifact.ownerLevel = "organization"; artifact.ownerId = "org-1"; }
    if (failure === "wrong-hash") Object.assign(artifact.source, { resolvedCommitOrTreeHash: "in-tree@2.0.0" });
    if (failure === "unknown-git") Object.assign(artifact.source, { resolvedCommitOrTreeHash: "unknown" });
    if (failure === "stale-git") Object.assign(artifact.source, { resolvedCommitOrTreeHash: "deadbee" });
    if (failure === "wrong-row-path") Object.assign(artifact.source, { path: ROOT_STORE_DIR });
    if (failure === "traversal-path") Object.assign(artifact.source, { path: sourceDir + "/../blog-post-artifact" });
    if (failure === "wrong-image-path") IMAGE_RECORDS[ART].sourceDir = ".";
    if (failure === "missing-image") delete IMAGE_RECORDS[ART];
    if (failure === "unfinalized-upload") Object.assign(artifact.source, { contentDigest: ART_DIGEST, integrity: "sha512-upload" });
    if (failure === "custom-local") Object.assign(artifact.source, { resolvedCommitOrTreeHash: "custom-source" });
    if (failure === "wrong-claim") await writeFile(join(sourceDir, "package.json"), JSON.stringify(artifactManifest(ART, [OTHER_TYPE])));
    if (failure === "package-json-symlink") {
      const target = join(DEV_ROOT, "injected-package.json");
      await writeFile(target, JSON.stringify(artifactManifest(ART, [TYPE])));
      await rm(join(sourceDir, "package.json")); await symlink(target, join(sourceDir, "package.json"));
    }
    if (failure === "package-dir-symlink") {
      const target = join(DEV_ROOT, "injected-package"); await mkdir(target);
      await writeFile(join(target, "package.json"), JSON.stringify(artifactManifest(ART, [TYPE])));
      await rm(sourceDir, { recursive: true }); await symlink(target, sourceDir);
    }
    await expect(upload()).rejects.toThrow(/typed-production contract failed/);
    expect(createLocal).not.toHaveBeenCalled(); expect(registryRead).not.toHaveBeenCalled();
  });
  it.each(["development", "production"])("preserves finalized digest trust in %s", async (mode) => {
    await uploadedFixture(); vi.stubEnv("CINATRA_RUNTIME_MODE", mode);
    expect((await upload()).templateId).toBeTruthy();
    expect(journalRead).toHaveBeenCalledWith(ART, "org-1", "0.0.0"); expect(registryRead).not.toHaveBeenCalled();
  });
});
