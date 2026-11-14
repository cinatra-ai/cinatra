// Per-connection use-gate contract tests (cinatra#952 W2). Mirrors the
// enforce-extension-access suite style: the REAL evaluator + REAL gate logic
// run over mocked stores (permissions-store / canonical-store) and a mocked
// audit sink, so every codex-converged binding requirement is pinned:
//   • explicit OWNER_DEFAULT fallback (the WORKSPACE module default must
//     NEVER engage for connections),
//   • non-human subject own-match (runAsUserId),
//   • the only-clamp ceiling over ALL grant material (visibility, co-owner /
//     installer person-grants, the platform_admin bypass),
//   • deny audited (durable + cooldown-aware) BEFORE the throw,
//   • no tokens in audit metadata.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActorContext } from "@/lib/authz";
import type { NangoConnectionIdentity } from "@cinatra-ai/extensions/connection-identity-store";

const readExtensionAccessPolicy = vi.fn();
const readExtensionCoOwners = vi.fn();
const readExtensionInstalledBy = vi.fn();
vi.mock("@cinatra-ai/extensions/permissions-store", () => ({
  readExtensionAccessPolicy: (...a: unknown[]) => readExtensionAccessPolicy(...a),
  readExtensionCoOwners: (...a: unknown[]) => readExtensionCoOwners(...a),
  readExtensionInstalledBy: (...a: unknown[]) => readExtensionInstalledBy(...a),
}));

const readInstalledExtensionsByPackageName = vi.fn();
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionsByPackageName: (...a: unknown[]) =>
    readInstalledExtensionsByPackageName(...a),
}));

const logAuditEvent = vi.fn(async (_input: Record<string, unknown>) => {});
const logDeniedAuditEventStrictWithCooldown = vi.fn(async (_input: Record<string, unknown>) => ({ id: "audit-1" }));
vi.mock("@/lib/authz/audit", () => ({
  logAuditEvent: (input: Record<string, unknown>) => logAuditEvent(input),
  logDeniedAuditEventStrictWithCooldown: (input: Record<string, unknown>) =>
    logDeniedAuditEventStrictWithCooldown(input),
}));

import {
  decideConnectionUse,
  enforceConnectionUse,
  connectionSubjectUserId,
  ConnectionUseDeniedError,
  EXTERNAL_MCP_CONNECTOR_PACKAGE_SENTINEL,
} from "@/lib/connection-use-gate";

const ORG = "org-1";
const OWNER = "user-owner";
const MEMBER = "user-member";

const identity: NangoConnectionIdentity = {
  id: "conn-uuid-1",
  organizationId: ORG,
  connectorPackageId: "@cinatra-ai/github-connector",
  connectorKey: "github",
  connectionId: "github-conn-1",
  ownerUserId: OWNER,
  createdAt: new Date(),
  deletedAt: null,
};

function human(userId: string, over: Partial<ActorContext> = {}): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: userId,
    organizationId: ORG,
    teamIds: [],
    projectIds: [],
    projectGrants: [],
    authSource: "ui",
    policyVersion: "v2",
    ...over,
  } as ActorContext;
}

function declaration(mode: "default" | "only", scope: string) {
  return {
    accessDeclaration: { formatVersion: 1, mode, scope, source: "declared" },
    organizationId: ORG,
  };
}

// Mirrors what `readExtensionAccessPolicy` returns after multi-scope W1: the
// stored policy is schema-parsed, so each visibility field is a non-empty
// token array (a stored scalar coerces to a one-element array on read).
const policy = (vis: string) => ({
  runListVisibility: [vis],
  runDataVisibility: [vis],
  runExecuteVisibility: [vis],
  allowRunSharing: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  readExtensionAccessPolicy.mockResolvedValue(null);
  readExtensionCoOwners.mockResolvedValue([]);
  readExtensionInstalledBy.mockResolvedValue(null);
  readInstalledExtensionsByPackageName.mockResolvedValue([declaration("default", "admin")]);
});

describe("subject resolution", () => {
  it("human principal is its own subject; worker resolves runAsUserId", () => {
    expect(connectionSubjectUserId(human(MEMBER))).toBe(MEMBER);
    expect(
      connectionSubjectUserId({
        principalType: "InternalWorker",
        principalId: "run:1",
        runAsUserId: OWNER,
        authSource: "worker",
        policyVersion: "v2",
      } as ActorContext),
    ).toBe(OWNER);
  });
});

describe("own short-circuit (round-2 finding 1)", () => {
  it("allows the owner's agent run via runAsUserId without any store read", async () => {
    const worker = {
      principalType: "InternalWorker",
      principalId: "run:42",
      organizationId: ORG,
      runAsUserId: OWNER,
      authSource: "agent",
      policyVersion: "v2",
    } as ActorContext;
    const d = await decideConnectionUse({
      identity,
      actor: worker,
      subjectUserId: connectionSubjectUserId(worker),
    });
    expect(d).toEqual({ allowed: true, asOwner: true });
    expect(readExtensionAccessPolicy).not.toHaveBeenCalled();
  });
});

describe("OWNER_DEFAULT fallback (the workspace default must never engage)", () => {
  it("denies a same-org member on a NO-policy-row connection (default mode)", async () => {
    const d = await decideConnectionUse({
      identity,
      actor: human(MEMBER),
      subjectUserId: MEMBER,
    });
    expect(d.allowed).toBe(false);
  });

  it("allows a same-org member once a workspace grant row exists", async () => {
    readExtensionAccessPolicy.mockResolvedValue(policy("workspace"));
    const d = await decideConnectionUse({
      identity,
      actor: human(MEMBER),
      subjectUserId: MEMBER,
    });
    expect(d.allowed).toBe(true);
  });

  it("denies cross-org even with a workspace grant (404-hidden at the gate)", async () => {
    readExtensionAccessPolicy.mockResolvedValue(policy("workspace"));
    const d = await decideConnectionUse({
      identity,
      actor: human(MEMBER, { organizationId: "org-2" }),
      subjectUserId: MEMBER,
    });
    expect(d).toMatchObject({ allowed: false, reason: "cross_org" });
  });
});

describe("only-clamp ceiling (round-2 finding 2 + convergence amendments)", () => {
  it("workspace grant on an only:team connector evaluates owner-only", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue([declaration("only", "team")]);
    readExtensionAccessPolicy.mockResolvedValue(policy("workspace"));
    const d = await decideConnectionUse({
      identity,
      actor: human(MEMBER),
      subjectUserId: MEMBER,
    });
    expect(d.allowed).toBe(false);
    expect((d as { clampApplied?: string[] }).clampApplied).toContain("visibility");
  });

  it("team grant within an only:team ceiling admits a team member", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue([declaration("only", "team")]);
    readExtensionAccessPolicy.mockResolvedValue(policy("team:team-9"));
    const d = await decideConnectionUse({
      identity,
      actor: human(MEMBER, { teamIds: ["team-9"] }),
      subjectUserId: MEMBER,
    });
    expect(d.allowed).toBe(true);
  });

  it("co-owner grantee is clamped out under only:user (amendment 2)", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue([declaration("only", "user")]);
    readExtensionCoOwners.mockResolvedValue([{ userId: MEMBER }]);
    const d = await decideConnectionUse({
      identity,
      actor: human(MEMBER),
      subjectUserId: MEMBER,
    });
    expect(d.allowed).toBe(false);
    expect((d as { clampApplied?: string[] }).clampApplied).toContain("coOwner");
  });

  it("co-owner grantee survives an only:workspace ceiling (same-org individual)", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue([declaration("only", "workspace")]);
    readExtensionCoOwners.mockResolvedValue([{ userId: MEMBER }]);
    const d = await decideConnectionUse({
      identity,
      actor: human(MEMBER),
      subjectUserId: MEMBER,
    });
    expect(d.allowed).toBe(true);
  });

  it("non-admin co-owner is clamped out under only:admin; org-admin passes", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue([declaration("only", "admin")]);
    readExtensionCoOwners.mockResolvedValue([{ userId: MEMBER }]);
    const denied = await decideConnectionUse({
      identity,
      actor: human(MEMBER),
      subjectUserId: MEMBER,
    });
    expect(denied.allowed).toBe(false);
    readExtensionAccessPolicy.mockResolvedValue(policy("admin"));
    const allowed = await decideConnectionUse({
      identity,
      actor: human(MEMBER, { orgRole: "org_admin" }),
      subjectUserId: MEMBER,
    });
    expect(allowed.allowed).toBe(true);
  });

  it("platform_admin bypass is neutralized under a non-admin only ceiling (amendment 3)", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue([declaration("only", "user")]);
    const d = await decideConnectionUse({
      identity,
      actor: human(MEMBER, { platformRole: "platform_admin" }),
      subjectUserId: MEMBER,
    });
    expect(d.allowed).toBe(false);
    expect((d as { clampApplied?: string[] }).clampApplied).toContain("platformAdminBypass");
  });

  it("platform_admin OWNER still allowed under only:user (own short-circuit first)", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue([declaration("only", "user")]);
    const d = await decideConnectionUse({
      identity,
      actor: human(OWNER, { platformRole: "platform_admin" }),
      subjectUserId: OWNER,
    });
    expect(d).toEqual({ allowed: true, asOwner: true });
  });

  it("platform_admin keeps kernel parity on default-mode connections", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue([declaration("default", "admin")]);
    const d = await decideConnectionUse({
      identity,
      actor: human(MEMBER, { platformRole: "platform_admin" }),
      subjectUserId: MEMBER,
    });
    expect(d.allowed).toBe(true);
  });

  it("fails closed for non-owner use when the package row cannot be resolved", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue([]);
    const d = await decideConnectionUse({
      identity,
      actor: human(MEMBER),
      subjectUserId: MEMBER,
    });
    expect(d.allowed).toBe(false);
  });

  it("external-MCP sentinel rows skip declaration resolution (default semantics)", async () => {
    readExtensionAccessPolicy.mockResolvedValue(policy("workspace"));
    const d = await decideConnectionUse({
      identity: {
        ...identity,
        connectorKey: "externalMcp",
        connectorPackageId: EXTERNAL_MCP_CONNECTOR_PACKAGE_SENTINEL,
      },
      actor: human(MEMBER),
      subjectUserId: MEMBER,
    });
    expect(d.allowed).toBe(true);
    expect(readInstalledExtensionsByPackageName).not.toHaveBeenCalled();
  });
});

describe("enforceConnectionUse — audit ordering + mapping", () => {
  it("ALLOW audits delegatedBy = owner for a granted non-owner", async () => {
    readExtensionAccessPolicy.mockResolvedValue(policy("workspace"));
    await enforceConnectionUse({
      identity,
      actor: human(MEMBER),
      subjectUserId: MEMBER,
      runId: "run-7",
      source: "test",
    });
    expect(logAuditEvent).toHaveBeenCalledTimes(1);
    const row = logAuditEvent.mock.calls[0][0] as Record<string, unknown>;
    expect(row).toMatchObject({
      decision: "allowed",
      delegatedBy: OWNER,
      resourceType: "connection",
      resourceId: identity.id,
      operation: "use",
      runId: "run-7",
    });
  });

  it("DENY writes the durable cooldown-aware audit row BEFORE the throw, never tokens", async () => {
    let auditedBeforeThrow = false;
    logDeniedAuditEventStrictWithCooldown.mockImplementation(async () => {
      auditedBeforeThrow = true;
      return { id: "a" };
    });
    await expect(
      enforceConnectionUse({
        identity,
        actor: human(MEMBER),
        subjectUserId: MEMBER,
      }),
    ).rejects.toBeInstanceOf(ConnectionUseDeniedError);
    expect(auditedBeforeThrow).toBe(true);
    const row = logDeniedAuditEventStrictWithCooldown.mock.calls[0][0] as {
      metadata?: Record<string, unknown>;
    };
    expect(JSON.stringify(row.metadata ?? {})).not.toMatch(/token|secret|credential/i);
  });

  it("maps cross-org to a 404-hidden error", async () => {
    readExtensionAccessPolicy.mockResolvedValue(policy("workspace"));
    await expect(
      enforceConnectionUse({
        identity,
        actor: human(MEMBER, { organizationId: "org-2" }),
        subjectUserId: MEMBER,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("maps a missing actor to 401", async () => {
    await expect(
      enforceConnectionUse({ identity, actor: null, subjectUserId: undefined }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });
});

// ---------------------------------------------------------------------------
// Multi-scope W2 — PER-TOKEN ceiling clamp. The `only` ceiling filters each
// field's tokens; an in-ceiling token survives even when a sibling token is
// dropped, and a field left empty falls back to ["owner"] (fail-closed).
// ---------------------------------------------------------------------------
const multiPolicy = (tokens: string[]) => ({
  runListVisibility: tokens,
  runDataVisibility: tokens,
  runExecuteVisibility: tokens,
  allowRunSharing: false,
});

describe("only-clamp ceiling — per-token clamp (multi-scope W2)", () => {
  it("keeps an in-ceiling token while dropping an out-of-ceiling sibling (only:team)", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue([declaration("only", "team")]);
    // workspace is outside the team ceiling and is dropped; team:team-9 survives.
    // The old scalar clamp read only the first token (workspace) → owner → deny;
    // the per-token clamp admits the team-9 member via the surviving token.
    readExtensionAccessPolicy.mockResolvedValue(multiPolicy(["workspace", "team:team-9"]));
    const d = await decideConnectionUse({
      identity,
      actor: human(MEMBER, { teamIds: ["team-9"] }),
      subjectUserId: MEMBER,
    });
    expect(d.allowed).toBe(true);
  });

  it("fails closed to owner-only when EVERY token is outside the ceiling (only:team)", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue([declaration("only", "team")]);
    // Both workspace and org:<id> are outside the team ceiling → clamped to
    // ["owner"] → a non-owner member is denied; the visibility clamp is flagged.
    readExtensionAccessPolicy.mockResolvedValue(multiPolicy(["workspace", `org:${ORG}`]));
    const d = await decideConnectionUse({
      identity,
      actor: human(MEMBER),
      subjectUserId: MEMBER,
    });
    expect(d.allowed).toBe(false);
    expect((d as { clampApplied?: string[] }).clampApplied).toContain("visibility");
  });

  it("a fully in-ceiling multi-token field is not clamped (no visibility flag)", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue([declaration("only", "workspace")]);
    // org:<id> and team:<id> are both within the workspace ceiling → nothing
    // dropped; a team member is admitted with no visibility clamp.
    readExtensionAccessPolicy.mockResolvedValue(multiPolicy([`org:${ORG}`, "team:team-9"]));
    const d = await decideConnectionUse({
      identity,
      actor: human(MEMBER, { teamIds: ["team-9"] }),
      subjectUserId: MEMBER,
    });
    expect(d.allowed).toBe(true);
  });
});

// Current run-start controls moved with their REAL owning gate. Upstream stores,
// identity/metadata/provider ports and audit sinks remain hermetic.
const listNangoConnectionsForScopeFilter = vi.fn();
const listNangoConnectionsByConnector = vi.fn();
vi.mock("@cinatra-ai/extensions/connection-identity-store", () => ({
  listNangoConnectionsForScopeFilter: (...a: unknown[]) => listNangoConnectionsForScopeFilter(...a),
  listNangoConnectionsByConnector: (...a: unknown[]) => listNangoConnectionsByConnector(...a),
}));
const configRead = vi.fn();
const metadataList = vi.fn();
const getNangoSystem = vi.fn();
const googlePresence = vi.fn();
const configurationProviders = vi.fn();
const externalRows = vi.fn();
const listSavedNangoConnections = vi.fn();
vi.mock("@/lib/extension-capabilities-registry", () => ({ resolveCapabilityProviders: (...a: unknown[]) => configurationProviders(...a) }));
vi.mock("@/lib/database-metadata", () => ({ readConnectorConfigurationForPreflight: (...a: unknown[]) => configRead(...a) }));
vi.mock("@/lib/external-mcp-registry", () => ({ listExternalMcpServersForPreflight: (...a: unknown[]) => externalRows(...a), externalMcpKeylessConnectionId: (id: string) => "external-mcp-keyless-" + id }));
vi.mock("@/lib/nango-system", () => ({
  getNangoSystem: (...a: unknown[]) => getNangoSystem(...a),
  listNangoConnectionAddressesForPreflight: (...a: unknown[]) => metadataList(...a),
  listSavedNangoConnections: (...a: unknown[]) => listSavedNangoConnections(...a),
  CINATRA_NANGO_PROVIDER_CONFIG_KEYS: { github: "cinatra-github" },
}));
import { hasRequiredConnectorConnectionForUse, ConnectionAvailabilityUnknownError, AmbiguousSharedConnectionError } from "@/lib/connection-use-gate";
import { resolveConnectionForUse, NoUsableConnectionError } from "@/lib/connection-credential-resolver";
const ME = "user-me", OTHER_A = "user-a", OTHER_B = "user-b";
function row(over: Partial<NangoConnectionIdentity>): NangoConnectionIdentity {
  return { id: `id-${over.connectionId ?? "fixture"}`, organizationId: ORG, connectorPackageId: "@cinatra-ai/github-connector", connectorKey: "github", connectionId: "c-1", ownerUserId: OTHER_A, createdAt: new Date(), deletedAt: null, ...over };
}
const actor = human(ME);

describe("current required preflight owning controls", () => {
  beforeEach(() => {
    readExtensionAccessPolicy.mockResolvedValue(policy("workspace"));
    readInstalledExtensionsByPackageName.mockResolvedValue([declaration("default", "admin")]);
    listSavedNangoConnections.mockReturnValue([{ connectionId: "c-own", providerConfigKey: "cinatra-github" }, { connectionId: "c-1", providerConfigKey: "cinatra-github" }, { connectionId: "c-2", providerConfigKey: "cinatra-github" }]);
  });
describe("production required-connection predicate", () => {
 beforeEach(() => configurationProviders.mockReturnValue([{
   packageName: "@cinatra-ai/google-oauth-connector", impl: { readPresence: googlePresence },
 }]));
 beforeEach(() => { listNangoConnectionsForScopeFilter.mockResolvedValue([]); configRead.mockResolvedValue({connections:{github:[{connectionId:"c-1",providerConfigKey:"cinatra-github"}]}}); getNangoSystem.mockReturnValue({providerConfigKeys:{github:"cinatra-github",googleCalendar:"cinatra-google-calendar",tailscale:"old",tailscaleOauth:"new"}}); metadataList.mockResolvedValue({state:"present",addresses:[{providerConfigKey:"cinatra-github",connectionId:"c-1"}]}); googlePresence.mockResolvedValue({state:"present"}); externalRows.mockResolvedValue([]); });
 it("refuses admin without any usable identity; admin is not a fabricated private grant", async () => { expect(await hasRequiredConnectorConnectionForUse({packageId:"@cinatra-ai/github-connector",actor:{...actor,platformRole:"platform_admin"}})).toBe(false); expect(metadataList).not.toHaveBeenCalled(); });
 it("accepts actual own address after readerUSE then performs exactly one final gate", async () => { listNangoConnectionsForScopeFilter.mockResolvedValue([row({ownerUserId:ME,connectionId:"c-1"})]); expect(await hasRequiredConnectorConnectionForUse({packageId:"@cinatra-ai/github-connector",actor})).toBe(true); expect(listNangoConnectionsForScopeFilter).toHaveBeenCalledBefore(metadataList); expect(logAuditEvent).toHaveBeenCalledTimes(1); expect(listSavedNangoConnections).not.toHaveBeenCalled(); });
 it("refuses a denied use ceiling without querying the provider", async () => { listNangoConnectionsForScopeFilter.mockResolvedValue([row({ownerUserId:OTHER_A})]); readInstalledExtensionsByPackageName.mockResolvedValue([declaration("only", "user")]); expect(await hasRequiredConnectorConnectionForUse({packageId:"@cinatra-ai/github-connector",actor})).toBe(false); expect(metadataList).not.toHaveBeenCalled(); });
 it("distinguishes UNKNOWN from confirmed missing and never exposes raw transport errors", async () => { listNangoConnectionsForScopeFilter.mockResolvedValue([row({ownerUserId:ME})]); metadataList.mockResolvedValue({state:"unknown",addresses:[]}); await expect(hasRequiredConnectorConnectionForUse({packageId:"@cinatra-ai/github-connector",actor})).rejects.toBeInstanceOf(ConnectionAvailabilityUnknownError); metadataList.mockRejectedValue(new Error("SECRET_SENTINEL")); await expect(hasRequiredConnectorConnectionForUse({packageId:"@cinatra-ai/github-connector",actor})).rejects.not.toThrow("SECRET_SENTINEL"); });
 it("requires a saved local address as well as its live provider tuple", async () => { listNangoConnectionsForScopeFilter.mockResolvedValue([row({ownerUserId:ME})]); configRead.mockResolvedValue(null); expect(await hasRequiredConnectorConnectionForUse({packageId:"@cinatra-ai/github-connector",actor})).toBe(false); expect(metadataList).not.toHaveBeenCalled(); });
 it("preserves a provider-only Google config without an account, but not Calendar", async () => { expect(await hasRequiredConnectorConnectionForUse({packageId:"@cinatra-ai/google-oauth-connector",actor})).toBe(true); expect(metadataList).not.toHaveBeenCalled(); expect(await hasRequiredConnectorConnectionForUse({packageId:"@cinatra-ai/google-calendar-connector",actor})).toBe(false); });
 it("follows consumesConnectionFrom and keeps one-to-many host aliases", async () => { listNangoConnectionsForScopeFilter.mockResolvedValue([row({connectorPackageId:"@cinatra-ai/google-calendar-connector",connectorKey:"googleCalendar",ownerUserId:ME})]); configRead.mockResolvedValue({connections:{googleCalendar:[{connectionId:"c-1",providerConfigKey:"cinatra-google-calendar"}]}}); metadataList.mockResolvedValue({state:"present",addresses:[{providerConfigKey:"cinatra-google-calendar",connectionId:"c-1"}]}); expect(await hasRequiredConnectorConnectionForUse({packageId:"@cinatra-ai/google-appointment-schedules-connector",actor})).toBe(true); });
 it("preserves actual keyless external MCP identity and row without a fake Nango address", async () => { listNangoConnectionsForScopeFilter.mockResolvedValue([row({connectorPackageId:"@cinatra-ai/host:external-mcp",connectorKey:"externalMcp",connectionId:"external-mcp-keyless-s",ownerUserId:ME})]); externalRows.mockResolvedValue([{id:"s",enabled:true,serverUrl:"https://rss.invalid/mcp",nangoConnectionId:null,scope:"user",userId:ME,orgId:ORG}]); expect(await hasRequiredConnectorConnectionForUse({packageId:"@cinatra-ai/host:external-mcp",actor})).toBe(true); expect(metadataList).not.toHaveBeenCalled(); });
 it("enforces shared ambiguity only after authorized actual addresses are discovered", async () => { listNangoConnectionsForScopeFilter.mockResolvedValue([row({ownerUserId:OTHER_A,connectionId:"c-1"}),row({ownerUserId:OTHER_B,connectionId:"c-2"})]); configRead.mockResolvedValue({connections:{github:[{connectionId:"c-1",providerConfigKey:"cinatra-github"},{connectionId:"c-2",providerConfigKey:"cinatra-github"}]}}); metadataList.mockResolvedValue({state:"present",addresses:[{providerConfigKey:"cinatra-github",connectionId:"c-1"},{providerConfigKey:"cinatra-github",connectionId:"c-2"}]}); await expect(hasRequiredConnectorConnectionForUse({packageId:"@cinatra-ai/github-connector",actor})).rejects.toBeInstanceOf(AmbiguousSharedConnectionError); expect(logAuditEvent).not.toHaveBeenCalled(); });
});


describe("required preflight preserves canonical shared ambiguity", () => {
  it("rejects two authorized shared identities even when provider lists only one",async()=>{
    const a=row({id:"shared-a",connectionId:"address-a",ownerUserId:OTHER_A});
    const b=row({id:"shared-b",connectionId:"address-b",ownerUserId:OTHER_B});
    listNangoConnectionsForScopeFilter.mockResolvedValue([a,b]);
    listNangoConnectionsByConnector.mockResolvedValue([a,b]);
    readExtensionAccessPolicy.mockResolvedValue(policy("workspace"));
    configRead.mockResolvedValue({connections:{github:[{connectionId:"address-a",providerConfigKey:"cinatra-github"},{connectionId:"address-b",providerConfigKey:"cinatra-github"}]}});
    getNangoSystem.mockReturnValue({providerConfigKeys:{github:"cinatra-github"}});
    metadataList.mockResolvedValue({state:"present",addresses:[{connectionId:"address-a",providerConfigKey:"cinatra-github"}]});
    await expect(resolveConnectionForUse({connectorKey:"github",actor})).rejects.toBeInstanceOf(AmbiguousSharedConnectionError);
    await expect(hasRequiredConnectorConnectionForUse({packageId:"@cinatra-ai/github-connector",actor})).rejects.toBeInstanceOf(AmbiguousSharedConnectionError);
    expect(metadataList).not.toHaveBeenCalled();expect(configRead).not.toHaveBeenCalled();
  });
});


describe("required preflight keeps own primary before presence",()=>{
  it("does not switch from absent own primary to another present own address",async()=>{
    const first=row({id:"own-first",connectionId:"primary-first",ownerUserId:ME});
    const second=row({id:"own-second",connectionId:"primary-second",ownerUserId:ME});
    listNangoConnectionsForScopeFilter.mockResolvedValue([second,first]);
    listNangoConnectionsByConnector.mockResolvedValue([second,first]);
    listSavedNangoConnections.mockReturnValue([{connectionId:"primary-first",providerConfigKey:"cinatra-github"},{connectionId:"primary-second",providerConfigKey:"cinatra-github"}]);
    configRead.mockResolvedValue({connections:{github:[{connectionId:"primary-first",providerConfigKey:"cinatra-github"},{connectionId:"primary-second",providerConfigKey:"cinatra-github"}]}});
    getNangoSystem.mockReturnValue({providerConfigKeys:{github:"cinatra-github"}});
    metadataList.mockResolvedValue({state:"present",addresses:[{connectionId:"primary-second",providerConfigKey:"cinatra-github"}]});
    expect((await resolveConnectionForUse({connectorKey:"github",actor})).connectionId).toBe("primary-first");
    expect(await hasRequiredConnectorConnectionForUse({packageId:"@cinatra-ai/github-connector",actor})).toBe(false);
  });
  it("does not borrow shared presence after an own address is absent",async()=>{
    const own=row({id:"own",connectionId:"own-absent",ownerUserId:ME});
    const shared=row({id:"shared",connectionId:"shared-present",ownerUserId:OTHER_A});
    listNangoConnectionsForScopeFilter.mockResolvedValue([own,shared]);
    configRead.mockResolvedValue({connections:{github:[{connectionId:"own-absent",providerConfigKey:"cinatra-github"},{connectionId:"shared-present",providerConfigKey:"cinatra-github"}]}});
    getNangoSystem.mockReturnValue({providerConfigKeys:{github:"cinatra-github"}});
    metadataList.mockResolvedValue({state:"present",addresses:[{connectionId:"shared-present",providerConfigKey:"cinatra-github"}]});
    expect(await hasRequiredConnectorConnectionForUse({packageId:"@cinatra-ai/github-connector",actor})).toBe(false);
  });
});

describe("configuration-only preflight resolves the activated owner", () => {
  const packageId = "@cinatra-ai/google-oauth-connector";
  const use = () => hasRequiredConnectorConnectionForUse({ packageId, actor });
  const registered = (impl: unknown = { readPresence: googlePresence }) =>
    configurationProviders.mockReturnValue([{ packageName: packageId, impl }]);

  beforeEach(() => {
    configurationProviders.mockReset();
    googlePresence.mockReset().mockResolvedValue({ state: "present" });
  });

  it("reports UNKNOWN when no configuration reader is registered", async () => {
    configurationProviders.mockReturnValue([]);
    googlePresence.mockResolvedValue({ state: "present" });
    await expect(hasRequiredConnectorConnectionForUse({
      packageId: "@cinatra-ai/google-oauth-connector", actor,
    })).rejects.toBeInstanceOf(ConnectionAvailabilityUnknownError);
    expect(googlePresence).not.toHaveBeenCalled();
    expect(logDeniedAuditEventStrictWithCooldown).not.toHaveBeenCalled();
  });

  it("uses only the descriptor's package owner and never another reader", async () => {
    const foreign = vi.fn().mockResolvedValue({ state: "present" });
    configurationProviders.mockReturnValue([{ packageName: "unrelated-connector", impl: { readPresence: foreign } }]);
    await expect(use()).rejects.toBeInstanceOf(ConnectionAvailabilityUnknownError);
    expect(foreign).not.toHaveBeenCalled();
    expect(logDeniedAuditEventStrictWithCooldown).not.toHaveBeenCalled();
  });

  it("accepts registered presence without reading an account or credentials", async () => {
    registered();
    expect(await use()).toBe(true);
    expect(configurationProviders).toHaveBeenCalledWith("connection-configuration-presence");
    expect(googlePresence).toHaveBeenCalledTimes(1);
    expect(configRead).not.toHaveBeenCalled();
    expect(metadataList).not.toHaveBeenCalled();
    expect(listNangoConnectionsForScopeFilter).not.toHaveBeenCalled();
    expect(logAuditEvent).not.toHaveBeenCalled();
    expect(logDeniedAuditEventStrictWithCooldown).not.toHaveBeenCalled();
  });

  it("audits a known absence, without treating an account as app configuration", async () => {
    registered();
    googlePresence.mockResolvedValue({ state: "absent" });
    expect(await use()).toBe(false);
    expect(logDeniedAuditEventStrictWithCooldown).toHaveBeenCalledTimes(1);
    expect(logDeniedAuditEventStrictWithCooldown).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: `connector:${packageId}`, metadata: expect.objectContaining({ reason: "no_candidate" }),
    }));
    expect(metadataList).not.toHaveBeenCalled();
    expect(listNangoConnectionsForScopeFilter).not.toHaveBeenCalled();
  });

  it.each([null, [], {}, { readPresence: true }])("refuses a malformed reader %j as UNKNOWN", async impl => {
    registered(impl);
    await expect(use()).rejects.toBeInstanceOf(ConnectionAvailabilityUnknownError);
    expect(logDeniedAuditEventStrictWithCooldown).not.toHaveBeenCalled();
  });

  it.each([null, [], {}, { state: "unknown" }, { state: "maybe" }, { state: true }, { state: "present", secret: "SECRET" }])(
    "refuses unavailable or malformed evidence %j as UNKNOWN", async result => {
      registered();
      googlePresence.mockResolvedValue(result);
      await expect(use()).rejects.toBeInstanceOf(ConnectionAvailabilityUnknownError);
      expect(logDeniedAuditEventStrictWithCooldown).not.toHaveBeenCalled();
    },
  );

  it("sanitizes reader errors, including authorization errors and result getters", async () => {
    registered();
    for (const error of [new Error("CLIENT_SECRET_SENTINEL"), new NoUsableConnectionError({ statusCode: 403, reason: "forbidden", message: "CLIENT_SECRET_SENTINEL" })]) {
      googlePresence.mockRejectedValue(error);
      await expect(use()).rejects.toMatchObject({ name: "ConnectionAvailabilityUnknownError", message: "Connection availability could not be confirmed. Try again later." });
    }
    googlePresence.mockResolvedValue({ get state() { throw new Error("CLIENT_SECRET_SENTINEL"); } });
    await expect(use()).rejects.toBeInstanceOf(ConnectionAvailabilityUnknownError);
    expect(logDeniedAuditEventStrictWithCooldown).not.toHaveBeenCalled();
  });

  it("re-resolves changed presence and removed owners rather than caching a verdict", async () => {
    registered();
    expect(await use()).toBe(true);
    googlePresence.mockResolvedValue({ state: "absent" });
    expect(await use()).toBe(false);
    configurationProviders.mockReturnValue([]);
    await expect(use()).rejects.toBeInstanceOf(ConnectionAvailabilityUnknownError);
    expect(configurationProviders).toHaveBeenCalledTimes(3);
    expect(googlePresence).toHaveBeenCalledTimes(2);
  });
  it("refuses ambiguous owner registrations rather than selecting one", async () => {
    configurationProviders.mockReturnValue([
      { packageName: packageId, impl: { readPresence: googlePresence } },
      { packageName: packageId, impl: { readPresence: googlePresence } },
    ]);
    await expect(use()).rejects.toBeInstanceOf(ConnectionAvailabilityUnknownError);
    expect(googlePresence).not.toHaveBeenCalled();
  });

  it.each(["present", "absent"])("refuses inherited state %s with an unrelated own key", async state => {
    registered();
    googlePresence.mockResolvedValue(Object.assign(Object.create({ state }), { unrelated: true }));
    await expect(use()).rejects.toBeInstanceOf(ConnectionAvailabilityUnknownError);
    expect(logDeniedAuditEventStrictWithCooldown).not.toHaveBeenCalled();
  });
});

});

describe("shared resolver and gate identities", () => {
  it("keeps exact class and predicate identities at the legacy import", async () => {
    const legacy = await import("@/lib/connection-credential-resolver");
    expect(legacy.AmbiguousSharedConnectionError).toBe(AmbiguousSharedConnectionError);
    expect(legacy.ConnectionAvailabilityUnknownError).toBe(ConnectionAvailabilityUnknownError);
    expect(legacy.hasRequiredConnectorConnectionForUse).toBe(hasRequiredConnectorConnectionForUse);
  });
});
