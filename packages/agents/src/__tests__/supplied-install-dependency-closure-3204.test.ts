/**
 * AN UPLOADED PACKAGE'S PACK DEPENDENCIES COME FROM THE CONNECTED REGISTRY
 * (cinatra#3204 criterion 24, the maintainer's decision recorded on the issue).
 *
 * The decision, in its own words: "The upload road reads the package's declared
 * pack dependencies and installs the missing ones from the connected registry
 * through the store's own road before the uploaded package; when the registry
 * has none, the upload is refused with the missing names."
 *
 * What is measured here, on BOTH upload roads (the file and the repository):
 *
 *   - a declared required dependency that is not installed and that the
 *     registry carries is installed through the store's own dependency saga,
 *     at the operator's chosen anchor and as the operator, BEFORE the uploaded
 *     package reaches the dispatcher;
 *   - a declared required dependency the registry does not carry refuses the
 *     upload with the missing names, and nothing is written;
 *   - a dependency whose saga refuses ends the upload in the saga's own words,
 *     and the uploaded package is not installed;
 *   - a package that declares nothing, a dependency already installed at the
 *     scope, and a peer or an optional edge all take the road exactly as before.
 *
 * The module boundary is the one `supplied-install-registers-agent-template
 * .test.ts` beside this file installs, plus the store's saga module, which also
 * carries the registry read the saga itself uses. The manifest parser, the
 * auto-install predicate and the scope ladder are the real ones.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

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

// THE FIXTURE: an agent pack that declares its pack dependencies. Every name is
// an existing public package of the organisation.
const PACK = "@cinatra-ai/web-research-agent";
const PACK_VERSION = "1.2.0";
const SKILL_DEP = "@cinatra-ai/web-research-skill";
const ARTIFACT_DEP = "@cinatra-ai/markdown-artifact";
const PEER_DEP = "@cinatra-ai/slide-deck-artifact";
const AGENT_DEP = "@cinatra-ai/author-agent";

type DeclaredEdge = {
  packageName: string;
  kind: string;
  edgeType: "runtime" | "install-time" | "peer";
  requirement: "required" | "optional";
  versionConstraint: { kind: "semver-range"; range: string };
};

function edge(
  packageName: string,
  kind: string,
  range: string,
  overrides: Partial<Pick<DeclaredEdge, "edgeType" | "requirement">> = {},
): DeclaredEdge {
  return {
    packageName,
    kind,
    edgeType: overrides.edgeType ?? "runtime",
    requirement: overrides.requirement ?? "required",
    versionConstraint: { kind: "semver-range", range },
  };
}

/** The package's own manifest text, as the archive intake reads it. */
function manifestText(dependencies: DeclaredEdge[] | undefined): string {
  return JSON.stringify({
    name: PACK,
    version: PACK_VERSION,
    cinatra: {
      kind: "agent",
      ...(dependencies ? { dependencies } : {}),
    },
  });
}

const fixture = vi.hoisted(() => ({ packageJson: "" }));

function archivePrepared() {
  return {
    package: {
      kind: "agent",
      packageName: PACK,
      version: PACK_VERSION,
      contentDigest: "a".repeat(64),
      packageJson: fixture.packageJson,
      provenance: { type: "local", path: "x.tgz", contentDigest: "a".repeat(64) },
    },
    tarball: new Uint8Array([1]),
    provenance: { type: "local", path: "x.tgz", contentDigest: "a".repeat(64) },
    validatorRan: true,
  };
}

function repositoryPrepared() {
  return {
    kind: "agent",
    packageName: PACK,
    version: PACK_VERSION,
    provenance: { type: "github", contentDigest: "a".repeat(64) },
    validatorRan: true,
    packageJson: fixture.packageJson,
  };
}

const road = vi.hoisted(() => ({
  prepareSuppliedArchiveSnapshot: vi.fn(),
  candidateFromPreparedArchive: vi.fn(
    (prepared: { package: Record<string, unknown>; provenance: unknown; validatorRan: boolean }) => ({
      kind: prepared.package.kind,
      packageName: prepared.package.packageName,
      version: prepared.package.version,
      provenance: prepared.provenance,
      validatorRan: prepared.validatorRan,
    }),
  ),
  installSuppliedCandidate: vi.fn<(input: unknown) => Promise<undefined>>(async () => undefined),
  prepareSuppliedRepositoryArchiveSnapshot: vi.fn(),
  previewSuppliedRepositoryArchive: vi.fn(),
}));
vi.mock("@/lib/supplied-package-install", () => road);

const canonical = vi.hoisted(() => ({
  readInstalledExtensionByIdentity: vi.fn(async () => null as Record<string, unknown> | null),
  listInstalledExtensions: vi.fn(async () => [] as Record<string, unknown>[]),
}));
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionByIdentity: (...a: unknown[]) =>
    canonical.readInstalledExtensionByIdentity(...(a as [])),
  listInstalledExtensions: (...a: unknown[]) => canonical.listInstalledExtensions(...(a as [])),
}));

const access = vi.hoisted(() => ({
  setExtensionInstallAccess: vi.fn<(input: unknown) => Promise<undefined>>(async () => undefined),
}));
vi.mock("@cinatra-ai/extensions/install-access-contract", () => access);

const registry = vi.hoisted(() => ({
  extensionRegistry: { uninstall: vi.fn(async () => undefined) },
}));
vi.mock("@cinatra-ai/extensions", () => registry);

vi.mock("../materialize-agent-package", () => ({
  withInstallLock: (_pkg: string, fn: () => Promise<unknown>) => fn(),
}));

const store = vi.hoisted(() => ({
  readAgentTemplateByPackageName: vi.fn(async () => ({ id: "tpl-web-research" })),
  readInstalledAgentTemplates: vi.fn(async () => []),
}));
vi.mock("../store", () => store);

// THE HANDLER SET: the saga dispatches through the extension registry, so the
// handler set must be registered in the upload worker before any saga runs.
const boot = vi.hoisted(() => ({ loaded: false, seenBySaga: [] as boolean[] }));
vi.mock("@cinatra-ai/extensions/handler-bootstrap", () => {
  boot.loaded = true;
  return {};
});

// THE STORE'S OWN ROAD: the dependency saga and the registry read it uses.
const REGISTRY_CARRIES = vi.hoisted(() => new Map<string, string>());
const REGISTRY_KINDS = vi.hoisted(() => new Map<string, string>());
const batch = vi.hoisted(() => ({
  installExtensionWithDependencies: vi.fn<(input: unknown) => Promise<unknown>>(async () => {
    boot.seenBySaga.push(boot.loaded);
    return {
      rootPackage: "",
      rootVersion: "",
      installed: [],
      updated: [],
      installedSideBySide: [],
      alreadyInstalled: [],
      batchId: null,
    };
  }),
  fetchRegistryExtensionSummary: vi.fn(async (packageName: string, versionOrRange: string) => {
    const version = REGISTRY_CARRIES.get(packageName);
    if (!version) {
      throw new Error(
        `[extension-install-batch] no resolvable version for ${packageName}@${versionOrRange}`,
      );
    }
    const kind = REGISTRY_KINDS.get(packageName) ?? "skill";
    return { resolvedVersion: version, kind, manifest: { name: packageName, version } };
  }),
}));
vi.mock("@/lib/extension-install-batch", () => batch);

import {
  installSuppliedArchiveAction,
  installSuppliedRepositoryAction,
} from "../supplied-install-actions";

const ZIP = Buffer.from("zip").toString("base64");
const TARGET = { level: "workspace", id: "org-1" } as const;
const REPO_URL = "https://github.com/cinatra-ai/web-research-agent";
const PIN = { resolvedSha: "e".repeat(40), contentDigest: "a".repeat(64) };

const ROADS = [
  {
    name: "the FILE road",
    install: () => installSuppliedArchiveAction({ zipBase64: ZIP, accessTarget: TARGET }),
  },
  {
    name: "the REPOSITORY road",
    install: () =>
      installSuppliedRepositoryAction({ repoUrl: REPO_URL, ref: "main", pin: PIN, accessTarget: TARGET }),
  },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  REGISTRY_CARRIES.clear();
  REGISTRY_KINDS.clear();
  boot.seenBySaga.length = 0;
  fixture.packageJson = manifestText(undefined);
  road.prepareSuppliedArchiveSnapshot.mockImplementation(async () => archivePrepared() as never);
  road.prepareSuppliedRepositoryArchiveSnapshot.mockImplementation(
    async () => repositoryPrepared() as never,
  );
  canonical.readInstalledExtensionByIdentity.mockResolvedValue({
    id: "iext-1",
    kind: "agent",
    status: "active",
  } as never);
  canonical.listInstalledExtensions.mockResolvedValue([] as never);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  REGISTRY_CARRIES.clear();
  REGISTRY_KINDS.clear();
});

/** The row-ownership tuple the uploaded package's own install was handed. */
function uploadedInstallInput(): { rowOwnership: unknown; actor: unknown } {
  const call = road.installSuppliedCandidate.mock.calls[0] as unknown as [
    { rowOwnership: unknown; actor: unknown },
  ];
  return call[0];
}

describe.each(ROADS)("criterion 24 on $name", ({ install }) => {
  it("T1a installs a missing non-agent dependency the registry carries through the store's saga BEFORE the uploaded package", async () => {
    fixture.packageJson = manifestText([edge(SKILL_DEP, "skill", "^1.0.0")]);
    REGISTRY_CARRIES.set(SKILL_DEP, "1.2.0");

    const result = await install();

    expect(result.ok).toBe(true);
    expect(batch.installExtensionWithDependencies).toHaveBeenCalledTimes(1);
    expect(road.installSuppliedCandidate).toHaveBeenCalledTimes(1);
    const sagaInput = batch.installExtensionWithDependencies.mock.calls[0]![0] as {
      packageName: string;
      version?: string;
      actor: unknown;
      rowOwnership: unknown;
    };
    expect(sagaInput.packageName).toBe(SKILL_DEP);
    // The exact version the registry resolved, not the declared range.
    expect(sagaInput.version).toBe("1.2.0");
    // The operator's chosen anchor and the operator as the actor — the same
    // ones the uploaded package's own install is handed.
    const uploaded = uploadedInstallInput();
    expect(sagaInput.rowOwnership).toEqual(uploaded.rowOwnership);
    expect(sagaInput.actor).toEqual(uploaded.actor);
    // Dependencies first: the saga ran before the uploaded package's install.
    expect(batch.installExtensionWithDependencies.mock.invocationCallOrder[0]!).toBeLessThan(
      road.installSuppliedCandidate.mock.invocationCallOrder[0]!,
    );
  });

  it("T1b refuses the upload naming a dependency the registry does not carry, and writes nothing", async () => {
    fixture.packageJson = manifestText([edge(SKILL_DEP, "skill", "^1.0.0")]);

    const result = await install();

    expect(result.ok).toBe(false);
    const error = "error" in result ? String(result.error) : "";
    expect(error).toContain(SKILL_DEP);
    expect(error).toMatch(/registry/i);
    expect(error).toMatch(/nothing was installed/i);
    expect(batch.installExtensionWithDependencies).not.toHaveBeenCalled();
    expect(road.installSuppliedCandidate).not.toHaveBeenCalled();
    expect(access.setExtensionInstallAccess).not.toHaveBeenCalled();
  });

  it("T1c refuses ONCE naming every dependency the registry does not carry", async () => {
    fixture.packageJson = manifestText([
      edge(SKILL_DEP, "skill", "^1.0.0"),
      edge(ARTIFACT_DEP, "artifact", "^2.0.0"),
    ]);

    const result = await install();

    expect(result.ok).toBe(false);
    const error = "error" in result ? String(result.error) : "";
    expect(error).toContain(SKILL_DEP);
    expect(error).toContain(ARTIFACT_DEP);
    expect(batch.installExtensionWithDependencies).not.toHaveBeenCalled();
    expect(road.installSuppliedCandidate).not.toHaveBeenCalled();
  });

  it("T1d ends the upload in the saga's own words when a dependency's saga refuses", async () => {
    fixture.packageJson = manifestText([edge(ARTIFACT_DEP, "artifact", "^2.0.0")]);
    REGISTRY_CARRIES.set(ARTIFACT_DEP, "2.1.0");
    batch.installExtensionWithDependencies.mockRejectedValueOnce(
      new Error(`${ARTIFACT_DEP} could not be installed: the migration preflight refused it`),
    );

    const result = await install();

    expect(batch.installExtensionWithDependencies).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect("error" in result && result.error).toMatch(/the migration preflight refused it/);
    expect(road.installSuppliedCandidate).not.toHaveBeenCalled();
  });

  it("T1e registers the handler set in the upload worker before a dependency's saga dispatches", async () => {
    fixture.packageJson = manifestText([edge(SKILL_DEP, "skill", "^1.0.0")]);
    REGISTRY_CARRIES.set(SKILL_DEP, "1.2.0");

    const result = await install();

    expect(result.ok).toBe(true);
    expect(boot.seenBySaga).toEqual([true]);
  });

  it("T1f keeps an agent dependency of a workspace upload org-anchored at the operator's organization, as the planner does", async () => {
    fixture.packageJson = manifestText([edge(AGENT_DEP, "agent", "^1.0.0")]);
    REGISTRY_CARRIES.set(AGENT_DEP, "1.4.0");
    REGISTRY_KINDS.set(AGENT_DEP, "agent");

    const result = await install();

    expect(result.ok).toBe(true);
    expect(uploadedInstallInput().rowOwnership).toMatchObject({
      ownerLevel: "workspace",
      organizationId: null,
    });
    expect(batch.installExtensionWithDependencies).toHaveBeenCalledTimes(1);
    const sagaInput = batch.installExtensionWithDependencies.mock.calls[0]![0] as {
      packageName: string;
      rowOwnership: unknown;
    };
    expect(sagaInput.packageName).toBe(AGENT_DEP);
    expect(sagaInput.rowOwnership).toEqual({
      ownerLevel: "organization",
      ownerId: "org-1",
      organizationId: "org-1",
    });
  });

  it("T1g counts an agent dependency live in the operator's organization as installed for a workspace upload", async () => {
    fixture.packageJson = manifestText([edge(AGENT_DEP, "agent", "^1.0.0")]);
    REGISTRY_KINDS.set(AGENT_DEP, "agent");
    canonical.listInstalledExtensions.mockResolvedValue([
      { id: "iext-agent", packageName: AGENT_DEP, kind: "agent", status: "active", organizationId: "org-1" },
    ] as never);

    const result = await install();

    expect(result.ok).toBe(true);
    expect(batch.installExtensionWithDependencies).not.toHaveBeenCalled();
    expect(road.installSuppliedCandidate).toHaveBeenCalledTimes(1);
  });
});

describe.each(ROADS)("the road stays as it was on $name (green before and after)", ({ install }) => {
  it("installs a package that declares no dependencies exactly as before", async () => {
    fixture.packageJson = manifestText(undefined);

    const result = await install();

    expect(result.ok).toBe(true);
    expect(road.installSuppliedCandidate).toHaveBeenCalledTimes(1);
    expect(batch.installExtensionWithDependencies).not.toHaveBeenCalled();
  });

  it("installs no dependency that is already installed at the scope", async () => {
    fixture.packageJson = manifestText([edge(SKILL_DEP, "skill", "^1.0.0")]);
    REGISTRY_CARRIES.set(SKILL_DEP, "1.2.0");
    canonical.listInstalledExtensions.mockResolvedValue([
      { id: "iext-skill", packageName: SKILL_DEP, kind: "skill", status: "active", organizationId: null },
    ] as never);

    const result = await install();

    expect(result.ok).toBe(true);
    expect(road.installSuppliedCandidate).toHaveBeenCalledTimes(1);
    expect(batch.installExtensionWithDependencies).not.toHaveBeenCalled();
  });

  it("never installs a peer or an optional dependency", async () => {
    fixture.packageJson = manifestText([
      edge(PEER_DEP, "artifact", "^1.0.0", { edgeType: "peer" }),
      edge(ARTIFACT_DEP, "artifact", "^2.0.0", { requirement: "optional" }),
    ]);
    REGISTRY_CARRIES.set(PEER_DEP, "1.0.0");
    REGISTRY_CARRIES.set(ARTIFACT_DEP, "2.1.0");

    const result = await install();

    expect(result.ok).toBe(true);
    expect(road.installSuppliedCandidate).toHaveBeenCalledTimes(1);
    expect(batch.installExtensionWithDependencies).not.toHaveBeenCalled();
  });
});
