/**
 * WHAT THE SCREEN PROMISES AFTER AN INSTALL, AND WHAT IT PROMISES BEFORE ONE
 * (cinatra#3204 criteria 9-10 and 21 — the two screen-side defects the second
 * proof round measured on the real product).
 *
 *   - THE AGENT OBSERVABLE. `/agents` is the RUN picker: it carries the
 *     installed templates with a human-in-the-loop signal of their own, their
 *     sub-agents, and external A2A agents. An agent without such a signal is
 *     absent from it — on this road and on the store road alike. Pointing every
 *     agent install there promised a listing that could not carry the package,
 *     and the round measured exactly that: the toast named the agents list and
 *     the listing's own search reported no match.
 *
 *   - THE GITHUB PRECONDITION. The connector client's status is an INSTANCE
 *     answer (its contract takes no scope at all), so a second admin session in
 *     another organization read the first organization's connection as its own
 *     and neither precondition state of criteria 9-10 could occur for it. The
 *     precondition is the organization's question, so it is read per
 *     organization.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const session = vi.hoisted(() => ({
  user: { id: "u1" } as { id: string } | null,
  session: { activeOrganizationId: "org-1" } as { activeOrganizationId: string | null } | null,
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
  prepareSuppliedRepositorySnapshot: vi.fn(),
}));
vi.mock("@/lib/supplied-package-install", () => road);

vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionByIdentity: vi.fn(async () => ({
    id: "iext-1",
    kind: "agent",
    status: "active",
  })),
}));

vi.mock("@cinatra-ai/extensions/install-access-contract", () => ({
  setExtensionInstallAccess: vi.fn(async () => undefined),
}));

vi.mock("@cinatra-ai/extensions", () => ({
  extensionRegistry: { uninstall: vi.fn(async () => undefined) },
}));

vi.mock("../materialize-agent-package", () => ({
  withInstallLock: (_pkg: string, fn: () => Promise<unknown>) => fn(),
}));

// The agents LISTING's own reader. The real `selectHitlRunVisibleTemplates` is
// deliberately NOT mocked: the point of the fix is that the screen reads the
// listing's own rule rather than a second copy of it.
type Template = {
  id: string;
  packageName: string | null;
  hitlRequired: boolean;
  hitlScreens: string[] | null;
  gatedSteps: unknown[] | null;
  agentDependencies: Record<string, string> | null;
  sourceType: string;
};
const templates = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("../store", () => ({
  readAgentTemplateByPackageName: vi.fn(async () => ({ id: "tpl-1" })),
  readInstalledAgentTemplates: vi.fn(async () => templates.rows),
}));

const identity = vi.hoisted(() => ({
  listNangoConnectionsByConnector: vi.fn(async () => [] as unknown[]),
}));
vi.mock("@cinatra-ai/extensions/connection-identity-store", () => identity);

const connector = vi.hoisted(() => ({
  resolveGitHubConnectionClient: vi.fn(
    () => ({ getStatus: async () => ({ status: "connected", settingsConfigured: true }) }) as unknown,
  ),
}));
vi.mock("@/lib/connector-client-providers", () => connector);

vi.mock("@/lib/anthropic-skill-config-service", () => ({
  snapshotSkillPackageIds: () => new Set<string>(),
  resolveInstalledClosure: () => [],
  recordSkillInstallConsent: () => ({ grant: false, reason: "not-asked", outcome: "" }),
  buildInstallConsentPrompt: () => ({
    headline: "h",
    advisory: "a",
    closureLines: [],
    closureDigest: "d",
    consentApplies: false,
  }),
}));

import {
  installSuppliedArchiveAction,
  readGitHubUploadPreconditionAction,
} from "../supplied-install-actions";

const ZIP = Buffer.from("zip").toString("base64");
const AGENT_PACKAGE = "@acme/upload-walk-agent";

const template = (over: Partial<Template>): Template => ({
  id: "tpl-1",
  packageName: AGENT_PACKAGE,
  hitlRequired: false,
  hitlScreens: [],
  gatedSteps: null,
  agentDependencies: null,
  sourceType: "internal",
  ...over,
});

function installAgent() {
  road.prepareSuppliedArchiveSnapshot.mockResolvedValueOnce({
    package: {
      kind: "agent",
      packageName: AGENT_PACKAGE,
      version: "1.0.0",
      contentDigest: "a".repeat(64),
      provenance: { type: "local", path: "x.tgz", contentDigest: "a".repeat(64) },
    },
    tarball: new Uint8Array([1]),
    provenance: { type: "local", path: "x.tgz", contentDigest: "a".repeat(64) },
    validatorRan: true,
  } as never);
  return installSuppliedArchiveAction({
    zipBase64: ZIP,
    accessTarget: { level: "workspace", id: "org-1" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  templates.rows = [];
  session.user = { id: "u1" };
  session.session = { activeOrganizationId: "org-1" };
  identity.listNangoConnectionsByConnector.mockResolvedValue([] as never);
  connector.resolveGitHubConnectionClient.mockReturnValue({
    getStatus: async () => ({ status: "connected", settingsConfigured: true }),
  } as never);
});

// ---------------------------------------------------------------------------
// Criterion 21 — the agent kind's observable
// ---------------------------------------------------------------------------
describe("the agent install points at a listing that actually carries it", () => {
  it("an agent the run picker carries keeps the agents list", async () => {
    templates.rows = [template({ hitlScreens: ["review"] })];
    const result = await installAgent();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.observable.href).toBe("/agents");
  });

  it("an agent WITHOUT a human-in-the-loop signal is not promised the agents list", async () => {
    templates.rows = [template({})];
    const result = await installAgent();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.observable.href).toBe("/configuration/extensions");
      expect(result.observable.label.length).toBeGreaterThan(0);
    }
  });

  it("a sub-agent of a gated flow keeps the agents list, exactly as the listing decides", async () => {
    templates.rows = [
      template({
        id: "tpl-parent",
        packageName: "@acme/parent-agent",
        hitlRequired: true,
        agentDependencies: { [AGENT_PACKAGE]: "1.0.0" },
      }),
      template({}),
    ];
    const result = await installAgent();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.observable.href).toBe("/agents");
  });

  it("a listing read that fails names the installed-extensions listing, never a false promise", async () => {
    const { readInstalledAgentTemplates } = await import("../store");
    vi.mocked(readInstalledAgentTemplates).mockRejectedValueOnce(new Error("store down") as never);
    const result = await installAgent();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.observable.href).toBe("/configuration/extensions");
  });
});

// ---------------------------------------------------------------------------
// Criteria 9-10 — the GitHub tab's precondition, per organization
// ---------------------------------------------------------------------------
describe("the GitHub tab states the precondition of THIS organization", () => {
  const rowFor = (organizationId: string | null, ownerUserId = "u1") => ({
    id: "nc-1",
    organizationId,
    ownerUserId,
    connectorKey: "github",
    connectionId: "conn-1",
  });

  it("the organization that holds the connection sees the resolved road", async () => {
    identity.listNangoConnectionsByConnector.mockResolvedValue([rowFor("org-1")] as never);
    await expect(readGitHubUploadPreconditionAction()).resolves.toEqual({ state: "ready" });
  });

  it("a second organization with no connection of its own sees the precondition", async () => {
    session.session = { activeOrganizationId: "org-2" };
    // The identity read is org-scoped; the instance still answers "connected".
    identity.listNangoConnectionsByConnector.mockResolvedValue([] as never);
    const result = await readGitHubUploadPreconditionAction();
    expect(result.state).toBe("no-connection");
    if (result.state === "no-connection") {
      expect(result.message).toMatch(/organization/i);
      expect(result.fixHref).toBe("/configuration/connectors");
      expect(result.fixLabel.length).toBeGreaterThan(0);
    }
    expect(identity.listNangoConnectionsByConnector).toHaveBeenCalledWith("org-2", "github");
  });

  it("another organization's row never counts as this organization's connection", async () => {
    session.session = { activeOrganizationId: "org-2" };
    identity.listNangoConnectionsByConnector.mockResolvedValue([rowFor("org-1")] as never);
    const result = await readGitHubUploadPreconditionAction();
    expect(result.state).toBe("no-connection");
  });

  it("a legacy row with no organization counts for its OWN admin only", async () => {
    session.session = { activeOrganizationId: "org-2" };
    identity.listNangoConnectionsByConnector.mockResolvedValue([rowFor(null, "u1")] as never);
    await expect(readGitHubUploadPreconditionAction()).resolves.toEqual({ state: "ready" });

    identity.listNangoConnectionsByConnector.mockResolvedValue([rowFor(null, "someone-else")] as never);
    const foreign = await readGitHubUploadPreconditionAction();
    expect(foreign.state).toBe("no-connection");
  });

  it("no owning connector is still its own state, named separately", async () => {
    connector.resolveGitHubConnectionClient.mockReturnValue(null as never);
    const result = await readGitHubUploadPreconditionAction();
    expect(result.state).toBe("no-connector");
    if (result.state === "no-connector") {
      expect(result.fixHref).toBe("/configuration/marketplace");
    }
  });

  it("an instance with no connection at all still reports no connection", async () => {
    connector.resolveGitHubConnectionClient.mockReturnValue({
      getStatus: async () => ({ status: "not_connected", settingsConfigured: false }),
    } as never);
    const result = await readGitHubUploadPreconditionAction();
    expect(result.state).toBe("no-connection");
    expect(identity.listNangoConnectionsByConnector).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Criterion 21 — the skill kind's observable
//
// The third proof round measured the same class of false promise on the SKILL
// kind: the install finished, the toast named the skills catalog, the screen
// arrived at it — and the package was not on the surface, because the catalog's
// table pages and the fresh row sat past the first page. Criterion 21 names the
// skill's observable exactly: "the skill queryable in the catalog BY PACKAGE
// NAME". So the destination is that query, which is also the very link the
// catalog itself renders next to every row.
// ---------------------------------------------------------------------------
const SKILL_PACKAGE = "@acme/upload-walk-skill";

function installSkill() {
  road.prepareSuppliedArchiveSnapshot.mockResolvedValueOnce({
    package: {
      kind: "skill",
      packageName: SKILL_PACKAGE,
      version: "1.0.0",
      contentDigest: "b".repeat(64),
      provenance: { type: "local", path: "x.tgz", contentDigest: "b".repeat(64) },
    },
    tarball: new Uint8Array([1]),
    provenance: { type: "local", path: "x.tgz", contentDigest: "b".repeat(64) },
    validatorRan: true,
  } as never);
  return installSuppliedArchiveAction({
    zipBase64: ZIP,
    accessTarget: { level: "workspace", id: "org-1" },
  });
}

describe("the skill install points at the catalog queried by package name", () => {
  it("names the catalog query, not the unfiltered catalog", async () => {
    const result = await installSkill();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.observable.href).toBe(
        `/skills?q=${encodeURIComponent(SKILL_PACKAGE)}`,
      );
      expect(result.observable.label.length).toBeGreaterThan(0);
    }
  });

  it("escapes a package name so the scope separator cannot break the query", async () => {
    const result = await installSkill();
    expect(result.ok).toBe(true);
    // "@acme/x" must arrive as one query value, never as a second path segment.
    if (result.ok) expect(result.observable.href).not.toContain("/skills?q=@acme/");
  });

  it("leaves the other kinds' observables exactly as they were", async () => {
    road.prepareSuppliedArchiveSnapshot.mockResolvedValueOnce({
      package: {
        kind: "artifact",
        packageName: "@acme/upload-walk-artifact",
        version: "1.0.0",
        contentDigest: "c".repeat(64),
        provenance: { type: "local", path: "x.tgz", contentDigest: "c".repeat(64) },
      },
      tarball: new Uint8Array([1]),
      provenance: { type: "local", path: "x.tgz", contentDigest: "c".repeat(64) },
      validatorRan: true,
    } as never);
    const result = await installSuppliedArchiveAction({
      zipBase64: ZIP,
      accessTarget: { level: "workspace", id: "org-1" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.observable.href).toBe("/configuration/extensions");
  });
});

// ---------------------------------------------------------------------------
// Criterion 21 — the connector kind's observable
//
// The fifth proof round measured the last false promise of the same class on
// the CONNECTOR kind: the install finished, the road handed the admin on, and
// the page it handed them to answered 404. The reason is that the connector
// kind's observable named `/configuration/connectors`, an address this product
// does not serve — a connector's own configuration surface is its dispatch
// route `/connectors/<vendor>/<slug>/setup`, which is exactly where a
// runtime-installed connector with no build-time catalog descriptor resolves.
// ---------------------------------------------------------------------------
const CONNECTOR_PACKAGE = "@acme/upload-walk-ok-connector";

function installConnector(packageName = CONNECTOR_PACKAGE) {
  road.prepareSuppliedArchiveSnapshot.mockResolvedValueOnce({
    package: {
      kind: "connector",
      packageName,
      version: "1.0.0",
      contentDigest: "d".repeat(64),
      provenance: { type: "local", path: "x.tgz", contentDigest: "d".repeat(64) },
    },
    tarball: new Uint8Array([1]),
    provenance: { type: "local", path: "x.tgz", contentDigest: "d".repeat(64) },
    validatorRan: true,
  } as never);
  return installSuppliedArchiveAction({
    zipBase64: ZIP,
    accessTarget: { level: "workspace", id: "org-1" },
  });
}

describe("the connector install points at a page this product serves", () => {
  it("names the connector's own configuration surface, never /configuration/connectors", async () => {
    const result = await installConnector();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.observable.href).toBe(
        "/connectors/acme/upload-walk-ok-connector/setup",
      );
      expect(result.observable.href).not.toBe("/configuration/connectors");
      expect(result.observable.label.length).toBeGreaterThan(0);
    }
  });

  it("falls back to a listing that exists when the name is not a scoped package", async () => {
    const result = await installConnector("upload-walk-bare-connector");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.observable.href).toBe("/connectors");
  });
});
