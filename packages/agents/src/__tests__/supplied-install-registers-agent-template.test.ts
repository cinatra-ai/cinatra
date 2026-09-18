/**
 * THE IMPORT SCREEN REGISTERS AN AGENT PACK'S AGENT TEMPLATE (cinatra#3534).
 *
 * The defect this file pins: a pack installed through the Upload Extension
 * screen installed as a package and was never an agent. The dispatcher ran, the
 * canonical row went live, and nothing on the road ever registered the agent
 * TEMPLATE — so the pack's Run wizard answered 404 and the run screen's search
 * found no agent, while the very same pack loaded by the development fleet sync
 * was runnable.
 *
 * What is measured here is the step between the dispatcher and the access
 * write, for the agent kind alone:
 *
 *   - a pack whose template row is ABSENT after the install is registered
 *     through the fleet sync's own entry point, exactly once, over the pack the
 *     dispatcher FINALIZED in the extension package store — on the file road
 *     and on the repository road alike;
 *   - a pack that declares no compilable agent is REFUSED in the words of
 *     whatever refused it, and a row this install created is rolled back;
 *   - a pack whose template row is already PRESENT is untouched: no
 *     registration call is made and the access write proceeds as it always did.
 *
 * The module boundary is the one `supplied-install-actions.test.ts` beside this
 * file already installs, plus the two modules the cut reaches: the loader and
 * the finalized-payload reader.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";

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

// THE AGENT PACK FIXTURE. A pack of the vendor this pull request's own fix leg
// re-keyed its fixture identity to, declaring a compilable agent document and
// its own manifest.
const PACK = "@acme-agents/list-organizer-agent";
const PACK_VERSION = "0.2.0";
const STORE_DIR = "/var/lib/cinatra/extensions/agent/list-organizer-agent/".concat("b".repeat(64));
/** The canonical layout the fleet sync's loader reads. */
const OAS_PATH = join(STORE_DIR, "cinatra", "oas.json");

function agentPackPrepared() {
  return {
    package: {
      kind: "agent",
      packageName: PACK,
      version: PACK_VERSION,
      contentDigest: "a".repeat(64),
      provenance: { type: "local", path: "x.tgz", contentDigest: "a".repeat(64) },
    },
    tarball: new Uint8Array([1]),
    provenance: { type: "local", path: "x.tgz", contentDigest: "a".repeat(64) },
    validatorRan: true,
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
  installSuppliedCandidate: vi.fn(async () => undefined),
  prepareSuppliedRepositoryArchiveSnapshot: vi.fn(),
  previewSuppliedRepositoryArchive: vi.fn(),
}));
vi.mock("@/lib/supplied-package-install", () => road);

const canonical = vi.hoisted(() => ({
  readInstalledExtensionByIdentity: vi.fn(async () => null as Record<string, unknown> | null),
}));
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionByIdentity: (...a: unknown[]) =>
    canonical.readInstalledExtensionByIdentity(...(a as [])),
}));

const access = vi.hoisted(() => ({
  setExtensionInstallAccess: vi.fn<
    (input: {
      kind: string;
      resourceId: string;
      policy?: unknown;
      installedByUserId: string | null;
    }) => Promise<void>
  >(),
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
  readAgentTemplateByPackageName: vi.fn(async () => null as { id: string } | null),
  readInstalledAgentTemplates: vi.fn(async () => [
    {
      id: "tpl-curator",
      packageName: "@acme-agents/list-organizer-agent",
      hitlRequired: true,
      hitlScreens: ["review"],
      gatedSteps: null,
      agentDependencies: null,
      sourceType: "internal",
    },
  ]),
}));
vi.mock("../store", () => store);

// THE FLEET SYNC'S OWN ENTRY POINT — the registration this road was missing.
const loader = vi.hoisted(() => ({
  ensureAgentPackageFromGitFile: vi.fn<
    (opts: {
      oasSourcePath: string;
    }) => Promise<{ templateId: string; upserted: boolean; skipped: boolean }>
  >(),
}));
vi.mock("../ensure-agent-package", () => loader);

// The dispatcher's FINALIZED payload for the pack, as the agent kind's own
// installer already reads it.
const payload = vi.hoisted(() => ({
  resolveFinalizedStorePayload: vi.fn<
    (input: { packageName: string; expectedKind: string; orgId?: string | null }) => Promise<{
      storeDir: string;
      digest: string;
      version: string | null;
      registryUrl: string | null;
    } | null>
  >(),
}));
vi.mock("@/lib/extension-store-payload", () => payload);

import {
  installSuppliedArchiveAction,
  installSuppliedRepositoryAction,
} from "../supplied-install-actions";

const ZIP = Buffer.from("zip").toString("base64");
const TARGET = { level: "workspace", id: "org-1" } as const;
const REPO_URL = "https://github.com/acme-agents/list-organizer-agent";
const PIN = { resolvedSha: "e".repeat(40), contentDigest: "a".repeat(64) };

beforeEach(() => {
  vi.clearAllMocks();
  road.prepareSuppliedArchiveSnapshot.mockResolvedValue(agentPackPrepared() as never);
  road.prepareSuppliedRepositoryArchiveSnapshot.mockResolvedValue({
    kind: "agent",
    packageName: PACK,
    version: PACK_VERSION,
    provenance: { type: "github", contentDigest: "a".repeat(64) },
    validatorRan: true,
  } as never);
  road.installSuppliedCandidate.mockResolvedValue(undefined as never);
  canonical.readInstalledExtensionByIdentity.mockResolvedValue({
    id: "iext-1",
    kind: "agent",
    status: "active",
  } as never);
  access.setExtensionInstallAccess.mockResolvedValue(undefined as never);
  authz.assertCanInstallAtTarget.mockResolvedValue(undefined as never);
  payload.resolveFinalizedStorePayload.mockResolvedValue({
    storeDir: STORE_DIR,
    digest: "b".repeat(64),
    version: PACK_VERSION,
    registryUrl: null,
  } as never);
  loader.ensureAgentPackageFromGitFile.mockResolvedValue({
    templateId: "tpl-curator",
    upserted: true,
    skipped: false,
  } as never);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

/** The row is absent when the road first looks, and present once registered. */
function templateAppearsAfterRegistration() {
  store.readAgentTemplateByPackageName
    .mockResolvedValueOnce(null as never)
    .mockResolvedValue({ id: "tpl-curator" } as never);
}

describe("an agent pack whose template row is missing is registered (cinatra#3534)", () => {
  it("registers the template through the fleet sync's own loader on the FILE road", async () => {
    templateAppearsAfterRegistration();

    const result = await installSuppliedArchiveAction({ zipBase64: ZIP, accessTarget: TARGET });

    // The dispatcher ran — the defect was never that the package failed to
    // install, it was that installing it registered no agent.
    expect(road.installSuppliedCandidate).toHaveBeenCalledTimes(1);
    // The registration is the fleet sync's own call, made EXACTLY once, over the
    // agent document of the payload the dispatcher finalized.
    expect(loader.ensureAgentPackageFromGitFile).toHaveBeenCalledTimes(1);
    expect(loader.ensureAgentPackageFromGitFile.mock.calls[0]![0].oasSourcePath).toBe(
      OAS_PATH,
    );
    expect(payload.resolveFinalizedStorePayload).toHaveBeenCalledTimes(1);
    const payloadInput = payload.resolveFinalizedStorePayload.mock.calls[0]![0];
    expect(payloadInput.packageName).toBe(PACK);
    expect(payloadInput.expectedKind).toBe("agent");
    // …and the access write then proceeds against the REGISTERED row.
    expect(access.setExtensionInstallAccess).toHaveBeenCalledTimes(1);
    const written = access.setExtensionInstallAccess.mock.calls[0]![0];
    expect(written.kind).toBe("agent_template");
    expect(written.resourceId).toBe("tpl-curator");
    expect(result.ok).toBe(true);
    expect(registry.extensionRegistry.uninstall).not.toHaveBeenCalled();
  });

  it("registers the template on the REPOSITORY road too", async () => {
    templateAppearsAfterRegistration();

    const result = await installSuppliedRepositoryAction({
      repoUrl: REPO_URL,
      ref: "main",
      pin: PIN,
      accessTarget: TARGET,
    });

    expect(road.installSuppliedCandidate).toHaveBeenCalledTimes(1);
    expect(loader.ensureAgentPackageFromGitFile).toHaveBeenCalledTimes(1);
    expect(loader.ensureAgentPackageFromGitFile.mock.calls[0]![0].oasSourcePath).toBe(
      OAS_PATH,
    );
    expect(access.setExtensionInstallAccess).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });
});

describe("a pack that declares no compilable agent is refused with a reason", () => {
  it("answers in the refusing words and rolls a FRESH install back exactly once", async () => {
    store.readAgentTemplateByPackageName.mockResolvedValue(null as never);
    canonical.readInstalledExtensionByIdentity
      // the pre-install snapshot: nothing was live before this install
      .mockResolvedValueOnce(null as never)
      // the rollback's own read
      .mockResolvedValueOnce({ id: "iext-1", kind: "agent", status: "active" } as never)
      // after the rollback
      .mockResolvedValueOnce(null as never);
    loader.ensureAgentPackageFromGitFile.mockRejectedValueOnce(
      new Error("no compilable agent document under this package"),
    );

    const result = await installSuppliedRepositoryAction({
      repoUrl: REPO_URL,
      ref: "main",
      pin: PIN,
      accessTarget: TARGET,
    });

    expect(result.ok).toBe(false);
    // The refusal travels in the words of whatever refused it.
    expect("error" in result && result.error).toMatch(/no compilable agent document/);
    // Nothing is left installed, and the rollback ran once and only once.
    expect(registry.extensionRegistry.uninstall).toHaveBeenCalledTimes(1);
    // The access write never runs against a template that was never registered.
    expect(access.setExtensionInstallAccess).not.toHaveBeenCalled();
  });
});

describe("the road a template row already answers for is untouched", () => {
  it("makes no registration call when the template row is present", async () => {
    store.readAgentTemplateByPackageName.mockResolvedValue({ id: "tpl-existing" } as never);

    const result = await installSuppliedArchiveAction({ zipBase64: ZIP, accessTarget: TARGET });

    expect(road.installSuppliedCandidate).toHaveBeenCalledTimes(1);
    expect(loader.ensureAgentPackageFromGitFile).not.toHaveBeenCalled();
    expect(payload.resolveFinalizedStorePayload).not.toHaveBeenCalled();
    expect(access.setExtensionInstallAccess).toHaveBeenCalledTimes(1);
    const written = access.setExtensionInstallAccess.mock.calls[0]![0];
    expect(written.kind).toBe("agent_template");
    expect(written.resourceId).toBe("tpl-existing");
    expect(result.ok).toBe(true);
    expect(registry.extensionRegistry.uninstall).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// THE CONVERGENCE ROUND'S OWN CASES (cinatra#3534). Each pins one finding the
// read-only review raised against the branch above.
// ---------------------------------------------------------------------------

describe("the loader's refusals and failures are compensated and readable", () => {
  it("treats a SKIPPED loader result as a refusal instead of letting it read as an access failure", async () => {
    store.readAgentTemplateByPackageName.mockResolvedValue(null as never);
    canonical.readInstalledExtensionByIdentity
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce({ id: "iext-1", kind: "agent", status: "active" } as never)
      .mockResolvedValueOnce(null as never);
    // The loader's own skip contract: it REFUSES without throwing.
    loader.ensureAgentPackageFromGitFile.mockResolvedValueOnce({
      templateId: "",
      upserted: false,
      skipped: true,
    } as never);

    const result = await installSuppliedArchiveAction({ zipBase64: ZIP, accessTarget: TARGET });

    expect(result.ok).toBe(false);
    // The operator is told what is actually wrong — not that a scope failed.
    expect("error" in result && result.error).toMatch(/declares no agent/);
    expect("error" in result && result.error).not.toMatch(/access scope/i);
    expect(registry.extensionRegistry.uninstall).toHaveBeenCalledTimes(1);
    expect(access.setExtensionInstallAccess).not.toHaveBeenCalled();
  });

  it("compensates a template READ that fails after the package is already installed", async () => {
    store.readAgentTemplateByPackageName.mockRejectedValue(
      new Error("the agent template store is unreachable") as never,
    );
    canonical.readInstalledExtensionByIdentity
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce({ id: "iext-1", kind: "agent", status: "active" } as never)
      .mockResolvedValueOnce(null as never);

    const result = await installSuppliedArchiveAction({ zipBase64: ZIP, accessTarget: TARGET });

    // It does not escape as an uncompensated failure: the fresh install is
    // rolled back and the road answers.
    expect(result.ok).toBe(false);
    expect("error" in result && result.error).toMatch(/unreachable/);
    expect(registry.extensionRegistry.uninstall).toHaveBeenCalledTimes(1);
    expect(access.setExtensionInstallAccess).not.toHaveBeenCalled();
  });

  it("keeps a server path out of the answer and claims nothing about a version it did not restore", async () => {
    store.readAgentTemplateByPackageName.mockResolvedValue(null as never);
    // A row was already live before this install, so nothing is rolled back.
    canonical.readInstalledExtensionByIdentity.mockResolvedValue({
      id: "iext-1",
      kind: "agent",
      status: "active",
    } as never);
    loader.ensureAgentPackageFromGitFile.mockRejectedValueOnce(
      new Error(
        `ENOENT: no such file or directory, open '${OAS_PATH}'`,
      ) as never,
    );

    const result = await installSuppliedArchiveAction({ zipBase64: ZIP, accessTarget: TARGET });

    expect(result.ok).toBe(false);
    const answer = "error" in result ? String(result.error) : "";
    // The server's filesystem path stays in the server log.
    expect(answer).not.toContain(STORE_DIR);
    expect(answer).not.toContain("/var/lib");
    // The dispatcher has already replaced the bytes, so the answer never says
    // the previously installed version is unchanged.
    expect(answer).not.toMatch(/already installed is unchanged/);
    expect(answer).toMatch(/nothing was uninstalled/);
    // The road's existing rule: a row that was live before is never rolled back.
    expect(registry.extensionRegistry.uninstall).not.toHaveBeenCalled();
  });
});
