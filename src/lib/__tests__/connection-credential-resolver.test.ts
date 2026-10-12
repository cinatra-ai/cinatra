// Grant-following resolver contract tests (cinatra#952 W2): own-first
// resolution, the OWNER-RULING ambiguity HARD-FAIL (never pick; no
// pinning/selection), only:"user" never listing shared, null-org narrowing,
// pre-fetch sentinel DENY audits, blob-record hard-fail, and the
// no-cross-request-caching contract.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActorContext } from "@/lib/authz";
import type { NangoConnectionIdentity } from "@cinatra-ai/extensions/connection-identity-store";

const listNangoConnectionsForScopeFilter = vi.fn();
const listNangoConnectionsByConnector = vi.fn();
vi.mock("@cinatra-ai/extensions/connection-identity-store", () => ({
  listNangoConnectionsForScopeFilter: (...a: unknown[]) => listNangoConnectionsForScopeFilter(...a),
  listNangoConnectionsByConnector: (...a: unknown[]) => listNangoConnectionsByConnector(...a),
}));

const decideConnectionUse = vi.fn();
const enforceConnectionUse = vi.fn(async (..._a: unknown[]) => ({ allowed: true }));
const resolveConnectionAccessDeclaration = vi.fn(
  async (
    _identity: Record<string, unknown>,
  ): Promise<{ kind: string; declaration: Record<string, unknown> | null }> => ({
    kind: "declaration",
    declaration: null,
  }),
);
vi.mock("@/lib/connection-use-gate", () => ({
  decideConnectionUse: (...a: unknown[]) => decideConnectionUse(...a),
  enforceConnectionUse: (...a: unknown[]) => enforceConnectionUse(...a),
  resolveConnectionAccessDeclaration: (identity: Record<string, unknown>) =>
    resolveConnectionAccessDeclaration(identity),
  connectionSubjectUserId: (actor: ActorContext) =>
    actor.principalType === "HumanUser" ? actor.principalId : actor.runAsUserId,
}));

const configRead = vi.fn();
const metadataList = vi.fn();
const getNangoSystem = vi.fn();
const googlePresence = vi.fn();
const configurationProviders = vi.fn();
vi.mock("@/lib/extension-capabilities-registry", () => ({
  resolveCapabilityProviders: (...args: unknown[]) => configurationProviders(...args),
}));
const externalRows = vi.fn();
vi.mock("@/lib/database-metadata", () => ({readConnectorConfigurationForPreflight: (...a: unknown[]) => configRead(...a)}));
vi.mock("@cinatra-ai/google-oauth-connection", () => ({readGoogleOAuthConfigurationPresenceForPreflight: (...a: unknown[]) => googlePresence(...a)}));
vi.mock("@/lib/external-mcp-registry", () => ({listExternalMcpServersForPreflight: (...a: unknown[]) => externalRows(...a),externalMcpKeylessConnectionId: (id: string) => "external-mcp-keyless-"+id}));
const listSavedNangoConnections = vi.fn();
const logDeniedAuditEventStrictWithCooldown = vi.fn(async (_input: Record<string, unknown>) => ({ id: "a" }));
vi.mock("@/lib/nango-system", () => ({
  getNangoSystem: (...a: unknown[]) => getNangoSystem(...a),
  listNangoConnectionAddressesForPreflight: (...a: unknown[]) => metadataList(...a),
  listSavedNangoConnections: (...a: unknown[]) => listSavedNangoConnections(...a),
  CINATRA_NANGO_PROVIDER_CONFIG_KEYS: { github: "cinatra-github" },
}));
vi.mock("@/lib/authz/audit", () => ({
  logDeniedAuditEventStrictWithCooldown: (input: Record<string, unknown>) =>
    logDeniedAuditEventStrictWithCooldown(input),
}));

import {
  resolveConnectionForUse,
  hasRequiredConnectorConnectionForUse,
  ConnectionAvailabilityUnknownError,
  AmbiguousSharedConnectionError,
  NoUsableConnectionError,
  ConnectionRecordMissingError,
} from "@/lib/connection-credential-resolver";

const ORG = "org-1";
const ME = "user-me";
const OTHER_A = "user-a";
const OTHER_B = "user-b";

function row(over: Partial<NangoConnectionIdentity>): NangoConnectionIdentity {
  return {
    id: `id-${over.connectionId ?? Math.random()}`,
    organizationId: ORG,
    connectorPackageId: "@cinatra-ai/github-connector",
    connectorKey: "github",
    connectionId: "c-1",
    ownerUserId: OTHER_A,
    createdAt: new Date(),
    deletedAt: null,
    ...over,
  };
}

const actor: ActorContext = {
  principalType: "HumanUser",
  principalId: ME,
  organizationId: ORG,
  teamIds: [],
  projectIds: [],
  projectGrants: [],
  authSource: "ui",
  policyVersion: "v2",
} as ActorContext;

beforeEach(() => {
  vi.clearAllMocks();
  decideConnectionUse.mockResolvedValue({ allowed: true });
  enforceConnectionUse.mockResolvedValue({ allowed: true });
  resolveConnectionAccessDeclaration.mockResolvedValue({ kind: "declaration", declaration: null });
  listSavedNangoConnections.mockReturnValue([
    { connectionId: "c-own", providerConfigKey: "cinatra-github" },
    { connectionId: "c-1", providerConfigKey: "cinatra-github" },
    { connectionId: "c-2", providerConfigKey: "cinatra-github" },
  ]);
});

describe("own-first resolution", () => {
  it("resolves the actor's own connection through the audited gate (delegated=false)", async () => {
    listNangoConnectionsByConnector.mockResolvedValue([
      row({ connectionId: "c-own", ownerUserId: ME }),
      row({ connectionId: "c-1", ownerUserId: OTHER_A }),
    ]);
    const resolved = await resolveConnectionForUse({ connectorKey: "github", actor });
    expect(resolved.connectionId).toBe("c-own");
    expect(resolved.delegated).toBe(false);
    expect(enforceConnectionUse).toHaveBeenCalledTimes(1);
    // Own choice bypasses candidate selection entirely — even with another
    // user's row present there is no ambiguity.
    expect(decideConnectionUse).not.toHaveBeenCalled();
  });

  it("a null-org row resolves for its OWNER (own-match)", async () => {
    listNangoConnectionsByConnector.mockResolvedValue([
      row({ connectionId: "c-own", ownerUserId: ME, organizationId: null }),
    ]);
    const resolved = await resolveConnectionForUse({ connectorKey: "github", actor });
    expect(resolved.connectionId).toBe("c-own");
  });
});

describe("shared resolution + the ambiguity HARD-FAIL (owner ruling)", () => {
  it("exactly one authorized shared candidate resolves through the SAME audited gate (delegated=true)", async () => {
    listNangoConnectionsByConnector.mockResolvedValue([
      row({ connectionId: "c-1", ownerUserId: OTHER_A }),
      row({ connectionId: "c-2", ownerUserId: OTHER_B }),
    ]);
    decideConnectionUse
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ allowed: false, reason: "not_visible" });
    const resolved = await resolveConnectionForUse({ connectorKey: "github", actor });
    expect(resolved.connectionId).toBe("c-1");
    expect(resolved.delegated).toBe(true);
    expect(enforceConnectionUse).toHaveBeenCalledTimes(1);
  });

  it(">1 authorized shared candidates = typed hard error + sentinel DENY audit; NEVER picks", async () => {
    listNangoConnectionsByConnector.mockResolvedValue([
      row({ connectionId: "c-1", ownerUserId: OTHER_A }),
      row({ connectionId: "c-2", ownerUserId: OTHER_B }),
    ]);
    await expect(
      resolveConnectionForUse({ connectorKey: "github", actor }),
    ).rejects.toBeInstanceOf(AmbiguousSharedConnectionError);
    expect(enforceConnectionUse).not.toHaveBeenCalled(); // never picked one
    expect(logDeniedAuditEventStrictWithCooldown).toHaveBeenCalledTimes(1);
    const deny = logDeniedAuditEventStrictWithCooldown.mock.calls[0][0] as {
      resourceId: string;
      metadata: Record<string, unknown>;
    };
    expect(deny.resourceId).toBe("connector:github");
    expect(deny.metadata).toMatchObject({
      reason: "ambiguous_shared_candidates",
      candidateCount: 2,
    });
  });

  it("zero candidates = NoUsableConnectionError + pre-fetch sentinel DENY", async () => {
    listNangoConnectionsByConnector.mockResolvedValue([]);
    await expect(
      resolveConnectionForUse({ connectorKey: "github", actor }),
    ).rejects.toBeInstanceOf(NoUsableConnectionError);
    const deny = logDeniedAuditEventStrictWithCooldown.mock.calls[0][0] as {
      metadata: Record<string, unknown>;
    };
    expect(deny.metadata).toMatchObject({ reason: "no_candidate" });
  });

  it("null-org rows are NEVER shared candidates (round-2 finding 6)", async () => {
    listNangoConnectionsByConnector.mockResolvedValue([
      row({ connectionId: "c-1", ownerUserId: OTHER_A, organizationId: null }),
    ]);
    await expect(
      resolveConnectionForUse({ connectorKey: "github", actor }),
    ).rejects.toBeInstanceOf(NoUsableConnectionError);
    expect(decideConnectionUse).not.toHaveBeenCalled();
  });

  it("only:'user' never lists shared — actionable connect-your-own error", async () => {
    listNangoConnectionsByConnector.mockResolvedValue([
      row({ connectionId: "c-1", ownerUserId: OTHER_A }),
    ]);
    resolveConnectionAccessDeclaration.mockResolvedValue({
      kind: "declaration",
      declaration: { formatVersion: 1, mode: "only", scope: "user", source: "declared" },
    });
    await expect(resolveConnectionForUse({ connectorKey: "github", actor })).rejects.toThrow(
      /connect your own/i,
    );
    expect(decideConnectionUse).not.toHaveBeenCalled();
  });
});

describe("blob address + caching contract", () => {
  it("a live identity row with NO blob record hard-fails (never a silent skip)", async () => {
    listNangoConnectionsByConnector.mockResolvedValue([
      row({ connectionId: "c-ghost", ownerUserId: ME }),
    ]);
    await expect(
      resolveConnectionForUse({ connectorKey: "github", actor }),
    ).rejects.toBeInstanceOf(ConnectionRecordMissingError);
  });

  it("caches nothing across resolutions (revocation-next-use)", async () => {
    listNangoConnectionsByConnector.mockResolvedValue([
      row({ connectionId: "c-own", ownerUserId: ME }),
    ]);
    await resolveConnectionForUse({ connectorKey: "github", actor });
    await resolveConnectionForUse({ connectorKey: "github", actor });
    expect(listNangoConnectionsByConnector).toHaveBeenCalledTimes(2);
    expect(enforceConnectionUse).toHaveBeenCalledTimes(2);
  });
});

describe("production required-connection predicate", () => {
 beforeEach(() => configurationProviders.mockReturnValue([{
   packageName: "@cinatra-ai/google-oauth-connector", impl: { readPresence: googlePresence },
 }]));
 beforeEach(() => { listNangoConnectionsForScopeFilter.mockResolvedValue([]); configRead.mockResolvedValue({connections:{github:[{connectionId:"c-1",providerConfigKey:"cinatra-github"}]}}); getNangoSystem.mockReturnValue({providerConfigKeys:{github:"cinatra-github",googleCalendar:"cinatra-google-calendar",tailscale:"old",tailscaleOauth:"new"}}); metadataList.mockResolvedValue({state:"present",addresses:[{providerConfigKey:"cinatra-github",connectionId:"c-1"}]}); googlePresence.mockResolvedValue({state:"present"}); externalRows.mockResolvedValue([]); });
 it("refuses admin without any usable identity; admin is not a fabricated private grant", async () => { expect(await hasRequiredConnectorConnectionForUse({packageId:"@cinatra-ai/github-connector",actor:{...actor,platformRole:"platform_admin"}})).toBe(false); expect(metadataList).not.toHaveBeenCalled(); });
 it("accepts actual own address after readerUSE then performs exactly one final gate", async () => { listNangoConnectionsForScopeFilter.mockResolvedValue([row({ownerUserId:ME,connectionId:"c-1"})]); expect(await hasRequiredConnectorConnectionForUse({packageId:"@cinatra-ai/github-connector",actor})).toBe(true); expect(decideConnectionUse).toHaveBeenCalledBefore(metadataList); expect(enforceConnectionUse).toHaveBeenCalledTimes(1); expect(listSavedNangoConnections).not.toHaveBeenCalled(); });
 it("refuses a denied use ceiling without querying the provider", async () => { listNangoConnectionsForScopeFilter.mockResolvedValue([row({ownerUserId:OTHER_A})]); decideConnectionUse.mockResolvedValue({allowed:false}); expect(await hasRequiredConnectorConnectionForUse({packageId:"@cinatra-ai/github-connector",actor})).toBe(false); expect(metadataList).not.toHaveBeenCalled(); });
 it("distinguishes UNKNOWN from confirmed missing and never exposes raw transport errors", async () => { listNangoConnectionsForScopeFilter.mockResolvedValue([row({ownerUserId:ME})]); metadataList.mockResolvedValue({state:"unknown",addresses:[]}); await expect(hasRequiredConnectorConnectionForUse({packageId:"@cinatra-ai/github-connector",actor})).rejects.toBeInstanceOf(ConnectionAvailabilityUnknownError); metadataList.mockRejectedValue(new Error("SECRET_SENTINEL")); await expect(hasRequiredConnectorConnectionForUse({packageId:"@cinatra-ai/github-connector",actor})).rejects.not.toThrow("SECRET_SENTINEL"); });
 it("requires a saved local address as well as its live provider tuple", async () => { listNangoConnectionsForScopeFilter.mockResolvedValue([row({ownerUserId:ME})]); configRead.mockResolvedValue(null); expect(await hasRequiredConnectorConnectionForUse({packageId:"@cinatra-ai/github-connector",actor})).toBe(false); expect(metadataList).not.toHaveBeenCalled(); });
 it("preserves a provider-only Google config without an account, but not Calendar", async () => { expect(await hasRequiredConnectorConnectionForUse({packageId:"@cinatra-ai/google-oauth-connector",actor})).toBe(true); expect(metadataList).not.toHaveBeenCalled(); expect(await hasRequiredConnectorConnectionForUse({packageId:"@cinatra-ai/google-calendar-connector",actor})).toBe(false); });
 it("follows consumesConnectionFrom and keeps one-to-many host aliases", async () => { listNangoConnectionsForScopeFilter.mockResolvedValue([row({connectorPackageId:"@cinatra-ai/google-calendar-connector",connectorKey:"googleCalendar",ownerUserId:ME})]); configRead.mockResolvedValue({connections:{googleCalendar:[{connectionId:"c-1",providerConfigKey:"cinatra-google-calendar"}]}}); metadataList.mockResolvedValue({state:"present",addresses:[{providerConfigKey:"cinatra-google-calendar",connectionId:"c-1"}]}); expect(await hasRequiredConnectorConnectionForUse({packageId:"@cinatra-ai/google-appointment-schedules-connector",actor})).toBe(true); });
 it("preserves actual keyless external MCP identity and row without a fake Nango address", async () => { listNangoConnectionsForScopeFilter.mockResolvedValue([row({connectorPackageId:"@cinatra-ai/host:external-mcp",connectorKey:"externalMcp",connectionId:"external-mcp-keyless-s",ownerUserId:ME})]); externalRows.mockResolvedValue([{id:"s",enabled:true,serverUrl:"https://rss.invalid/mcp",nangoConnectionId:null,scope:"user",userId:ME,orgId:ORG}]); expect(await hasRequiredConnectorConnectionForUse({packageId:"@cinatra-ai/host:external-mcp",actor})).toBe(true); expect(metadataList).not.toHaveBeenCalled(); });
 it("enforces shared ambiguity only after authorized actual addresses are discovered", async () => { listNangoConnectionsForScopeFilter.mockResolvedValue([row({ownerUserId:OTHER_A,connectionId:"c-1"}),row({ownerUserId:OTHER_B,connectionId:"c-2"})]); configRead.mockResolvedValue({connections:{github:[{connectionId:"c-1",providerConfigKey:"cinatra-github"},{connectionId:"c-2",providerConfigKey:"cinatra-github"}]}}); metadataList.mockResolvedValue({state:"present",addresses:[{providerConfigKey:"cinatra-github",connectionId:"c-1"},{providerConfigKey:"cinatra-github",connectionId:"c-2"}]}); await expect(hasRequiredConnectorConnectionForUse({packageId:"@cinatra-ai/github-connector",actor})).rejects.toBeInstanceOf(AmbiguousSharedConnectionError); expect(enforceConnectionUse).not.toHaveBeenCalled(); });
});


describe("required preflight preserves canonical shared ambiguity", () => {
  it("rejects two authorized shared identities even when provider lists only one",async()=>{
    const a=row({id:"shared-a",connectionId:"address-a",ownerUserId:OTHER_A});
    const b=row({id:"shared-b",connectionId:"address-b",ownerUserId:OTHER_B});
    listNangoConnectionsForScopeFilter.mockResolvedValue([a,b]);
    listNangoConnectionsByConnector.mockResolvedValue([a,b]);
    decideConnectionUse.mockResolvedValue({allowed:true});
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
    expect(enforceConnectionUse).not.toHaveBeenCalled();
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
});
