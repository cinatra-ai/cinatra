/** #3961: real run action, install gate and lifecycle coordinator; mocks record registry, authority, persistence and queue ports. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionDependency } from "@cinatra-ai/sdk-extensions";
import type { AgentCatalogRecord, AgentCatalogView, ReadEffectiveInstallStatus } from "../runtime-install-gate";

const USER = "user-3961";
const ORG = "org-3961";
const RUN_ID = "run-3961";

const { StubRunTransitionError, TEMPLATE } = vi.hoisted(() => ({
  StubRunTransitionError: class RunTransitionError extends Error {
    readonly code: string;
    constructor(code: string) {
      super(code);
      this.name = "RunTransitionError";
      this.code = code;
    }
  },
  TEMPLATE: {
    id: "tmpl-3961",
    name: "Blog Draft Writer",
    packageName: "@cinatra/blog-draft-writer-agent",
    lifecycleConfig: null,
  },
}));

const readAgentRunById = vi.fn();
const transitionRunStatus = vi.fn();
const createAgentRunPendingInput = vi.fn();
const createAgentRun = vi.fn();
const enqueueAgentRun = vi.fn();
const runConnectorPreflight = vi.fn();
const requireAuthSession = vi.fn();
const getActorContext = vi.fn();
const resolveActorGrantsForUserInOrg = vi.fn();
const verifySessionAuthority = vi.fn();
const recordRunLifecycleMoment = vi.fn();

vi.mock("../store", () => ({
  RunTransitionError: StubRunTransitionError,
  readAgentRunById: (...a: unknown[]) => readAgentRunById(...a),
  readAgentTemplateBySlug: vi.fn(async () => ({ ...TEMPLATE })),
  readAgentTemplateById: vi.fn(async () => null),
  transitionRunStatus: (...a: unknown[]) => transitionRunStatus(...a),
  clearAgentRunFailureMetadata: vi.fn(async () => undefined),
  createAgentRunPendingInput: (...a: unknown[]) => createAgentRunPendingInput(...a),
  createAgentRun: (...a: unknown[]) => createAgentRun(...a),
  recordRunLifecycleMoment: (...a: unknown[]) => recordRunLifecycleMoment(...a),
  slugifyAgentTemplateName: (n: string) => n,
  readAllHitlPromptsForRun: vi.fn(async () => []),
}));
vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: (...a: unknown[]) => requireAuthSession(...a),
  getActorContext: (...a: unknown[]) => getActorContext(...a),
  resolveActorGrantsForUserInOrg: (...a: unknown[]) => resolveActorGrantsForUserInOrg(...a),
}));
vi.mock("@/lib/org-write/authority", () => ({
  verifySessionAuthority: (...a: unknown[]) => verifySessionAuthority(...a),
}));
vi.mock("@/lib/org-write/run-creation-authority", () => ({
  resolveRunCreationAuthority: vi.fn(async () => ({ kind: "system" })),
}));
vi.mock("../auth-policy", () => ({ resolveTemplateVisibilityActor: vi.fn(async () => null) }));
const registry = vi.hoisted(() => ({ readStatus: vi.fn<ReadEffectiveInstallStatus>(), catalog: {} as AgentCatalogView }));
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({ readEffectiveStatusByPackageNames: registry.readStatus }));
vi.mock("@/lib/generated/extensions.server", () => ({ get STATIC_EXTENSION_MANIFEST() { return registry.catalog; } }));
vi.mock("../recommendation-hold", () => ({
  maybeHoldRunForRecommendation: vi.fn(async () => ({ held: false })),
  readRecommendationParkForRun: vi.fn(async () => null),
}));
vi.mock("@/lib/agent-run-enqueue", () => ({
  runConnectorPreflight: (...a: unknown[]) => runConnectorPreflight(...a),
  enqueueAgentRun: (...a: unknown[]) => enqueueAgentRun(...a),
  enqueueDepsForTemplate: vi.fn(() => ({})),
}));
vi.mock("../trigger-store", () => ({
  readRunTriggerByRunId: vi.fn(async () => null),
  createOrUpdateRunTrigger: vi.fn(async () => undefined),
  deleteRunTriggerByRunId: vi.fn(async () => undefined),
}));
vi.mock("../trigger-schedule", () => ({
  scheduleTrigger: vi.fn(async () => ({ jobSchedulerId: null })),
  cancelTriggerSchedule: vi.fn(async () => undefined),
}));
vi.mock("../trigger-gate", () => ({ markTriggerReleased: vi.fn(async () => undefined) }));
vi.mock("@/lib/pm-integration-providers", () => ({
  syncRunTriggerPmTask: vi.fn(async () => undefined),
  deleteRunTriggerPmTask: vi.fn(async () => undefined),
}));
vi.mock("@/lib/agent-run-readiness", () => ({
  assertAgentRunReadyByPackage: vi.fn(async () => null),
}));
vi.mock("@/lib/org-archive/dispatch-precheck", () => ({
  readOrgArchivedAtForDispatch: vi.fn(async () => false),
}));
vi.mock("../agent-run-serde", () => ({
  assertAgentRunDispatchAuthorized: vi.fn(async () => undefined),
  assertAgentRunScopeAuthorized: vi.fn(async () => undefined),
}));

import { createAndTriggerRunWithContext } from "../run-actions";
import type { AgentTemplateRecord } from "../store";

const PKG = TEMPLATE.packageName;
const DEP = "@cinatra-ai/context-selection-skill";
const template = { ...TEMPLATE, packageVersion: "0.1.2" } as unknown as AgentTemplateRecord;
const row = { id: RUN_ID, templateId: TEMPLATE.id, orgId: ORG, runBy: USER, status: "pending_input", inputParams: {}, lifecycleMoment: null };
function record(name: string, dependencies: ExtensionDependency[] = [], displayName: string | null = null): AgentCatalogRecord {
  return { packageName: name, kind: name === PKG ? "agent" : "skill", version: "0.1.2", resolution: "guardedOptional", displayName, dependencies };
}
function catalog(required = true) {
  registry.catalog = {
    [PKG]: record(PKG, [{ packageName: DEP, kind: "skill", edgeType: "runtime", requirement: required ? "required" : "optional", versionConstraint: { kind: "semver-range", range: "^0.1.0" } }]),
    [DEP]: record(DEP, [], "Context Selection"),
  };
}
function status(agent: "installed" | "not_installed" | "archived", dependency: "installed" | "not_installed" = "installed") {
  const statuses = new Map<string, "active" | "archived">();
  if (agent !== "not_installed") statuses.set(PKG, agent === "installed" ? "active" : "archived");
  if (dependency === "installed") statuses.set(DEP, "active");
  registry.readStatus.mockResolvedValue(statuses);
}
function noWrites() {
  expect(verifySessionAuthority).not.toHaveBeenCalled();
  expect(createAgentRunPendingInput).not.toHaveBeenCalled();
  expect(createAgentRun).not.toHaveBeenCalled();
  expect(transitionRunStatus).not.toHaveBeenCalled();
  expect(recordRunLifecycleMoment).not.toHaveBeenCalled();
  expect(enqueueAgentRun).not.toHaveBeenCalled();
}
beforeEach(() => {
  vi.clearAllMocks();
  requireAuthSession.mockResolvedValue({user:{id:USER,role:"user"},session:{activeOrganizationId:ORG}});
  resolveActorGrantsForUserInOrg.mockResolvedValue({orgRole:"member",teamIds:[],teamRoles:{},projectGrants:[]});
  catalog(); status("installed");
  getActorContext.mockResolvedValue({ principalType: "HumanUser", principalId: USER, organizationId: ORG, orgRole: "member", teamIds: [], projectGrants: [] });
  verifySessionAuthority.mockResolvedValue({ kind: "session" });
  createAgentRunPendingInput.mockResolvedValue({ ...row });
  readAgentRunById.mockResolvedValue({ ...row });
  transitionRunStatus.mockResolvedValue(undefined);
  recordRunLifecycleMoment.mockResolvedValue(undefined);
  enqueueAgentRun.mockResolvedValue(undefined);
  runConnectorPreflight.mockResolvedValue({skippedOptional:[]});
});

describe("real install refusal creates no run (cinatra#3961)", () => {
  it("missing required dependency returns its display name, identity and install instruction before any writes", async () => {
    status("installed", "not_installed");
    expect(await createAndTriggerRunWithContext(USER, ORG, template)).toEqual({ ok: false, error: `Agent cannot run: ${PKG} requires Context Selection (${DEP}), which is not installed. Install the missing extension from the marketplace first.`, installRefusal: { kind: "missing-required-dependency", missing: [{ packageName: DEP, displayName: "Context Selection", kind: "skill", reason: "not-installed" }] } });
    expect(registry.readStatus).toHaveBeenCalledExactlyOnceWith([PKG, DEP]);
    noWrites();
  });
  it("keeps every missing identity in deterministic package order and still creates nothing", async () => {
    const earlier = "@a-vendor/required-skill";
    registry.catalog = {
      [PKG]: record(PKG, [
        { packageName: DEP, kind: "skill", edgeType: "runtime", requirement: "required", versionConstraint: { kind: "semver-range", range: "^0.1.0" } },
        { packageName: earlier, kind: "skill", edgeType: "runtime", requirement: "required", versionConstraint: { kind: "semver-range", range: "^0.1.0" } },
      ]),
      [DEP]: record(DEP, [], "Context Selection"),
      [earlier]: record(earlier),
    };
    registry.readStatus.mockResolvedValue(new Map([[PKG, "active"], [DEP, "archived"]]));
    const result = await createAndTriggerRunWithContext(USER, ORG, template);
    expect(result).toMatchObject({ ok: false, installRefusal: { kind: "missing-required-dependency", missing: [
      { packageName: earlier, displayName: null, kind: "skill", reason: "not-installed" },
      { packageName: DEP, displayName: "Context Selection", kind: "skill", reason: "archived" },
    ] } });
    noWrites();
  });
  it.each(["not_installed", "archived"] as const)("%s agent refuses before writes", async (agentStatus) => {
    status(agentStatus);
    const result = await createAndTriggerRunWithContext(USER, ORG, template);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("installRefusal");
    expect(result).toMatchObject({ error: agentStatus === "archived" ? `Agent is not installed (disabled or uninstalled): ${PKG}` : `Agent is not installed: ${PKG} — it ships with Cinatra but is opt-in. Install it from the marketplace before running it.` });
    noWrites();
  });
  it("installed runnable agent reaches real coordinator store, transition and exactly one queue job", async () => {
    expect(await createAndTriggerRunWithContext(USER, ORG, template)).toEqual({ ok: true, runId: RUN_ID });
    expect(createAgentRunPendingInput).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ templateId: TEMPLATE.id, runBy: USER, orgId: ORG, launchProducer: "run_page_create_and_trigger", humanPresent: true }), { kind: "session" });
    expect(transitionRunStatus).toHaveBeenCalledExactlyOnceWith(RUN_ID, "pending_input", "queued", undefined, { kind: "session" });
    expect(enqueueAgentRun).toHaveBeenCalledExactlyOnceWith({ runId: RUN_ID }, { jobId: RUN_ID });
  });
  it("optional missing dependency does not prevent a runnable agent", async () => {
    catalog(false); status("installed", "not_installed");
    expect(await createAndTriggerRunWithContext(USER, ORG, template)).toEqual({ ok: true, runId: RUN_ID });
    expect(enqueueAgentRun).toHaveBeenCalledTimes(1);
  });
  it("legacy package-less template preserves launch without a registry status read", async () => {
    expect(await createAndTriggerRunWithContext(USER, ORG, { ...template, packageName: null })).toEqual({ ok: true, runId: RUN_ID });
    expect(registry.readStatus).not.toHaveBeenCalled();
    expect(createAgentRunPendingInput).toHaveBeenCalledTimes(1);
    expect(enqueueAgentRun).toHaveBeenCalledTimes(1);
  });
  it("membership authority refusal creates no run or queue job", async () => {
    const denied = new Error("membership revoked"); verifySessionAuthority.mockRejectedValueOnce(denied);
    await expect(createAndTriggerRunWithContext(USER, ORG, template)).rejects.toBe(denied);
    expect(createAgentRunPendingInput).not.toHaveBeenCalled();
  expect(createAgentRun).not.toHaveBeenCalled();
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });
  it("recognized enqueue preflight retains the existing actionable return and compensation", async () => {
    const preflight = Object.assign(new Error("Configure the connector first"), { code: "CONNECTOR_NOT_CONFIGURED", settingsHref: "/settings/connectors" });
    enqueueAgentRun.mockRejectedValueOnce(preflight);
    expect(await createAndTriggerRunWithContext(USER, ORG, template)).toEqual({ ok: false, error: preflight.message, code: preflight.code, settingsHref: preflight.settingsHref });
    expect(createAgentRunPendingInput).toHaveBeenCalledTimes(1);
    expect(transitionRunStatus).toHaveBeenNthCalledWith(2, RUN_ID, "queued", "pending_input", undefined, { kind: "session" });
  });
  it("unrecognized enqueue failure is still thrown after compensation, not fabricated as an install refusal", async () => {
    const failed = new Error("queue unavailable"); enqueueAgentRun.mockRejectedValueOnce(failed);
    await expect(createAndTriggerRunWithContext(USER, ORG, template)).rejects.toBe(failed);
    expect(transitionRunStatus).toHaveBeenNthCalledWith(2, RUN_ID, "queued", "pending_input", undefined, { kind: "session" });
  });
});


describe("required connector start refusal (cinatra#4041)", () => {
  // The reader's setup reading belongs to the page, never to this core: the
  // refusal names the declared connector and nothing about the reader.
  const packageId = "@cinatra-ai/apollo-connector";
  const settingsHref = "/connectors/cinatra-ai/apollo-connector/setup";
  function arrange(requirement: "required" | "optional" = "required") {
    registry.catalog = { ...registry.catalog, [packageId]: { packageName: packageId, kind: "connector", version: "1.0.0", resolution: "guardedOptional", displayName: "Apollo", dependencies: [] } } as AgentCatalogView;
    enqueueAgentRun.mockRejectedValueOnce(Object.assign(new Error("PRIVATE_BACKEND_DIAGNOSTIC"), { code: "CONNECTOR_NOT_CONFIGURED", packageId, settingsHref }));
    return { ...template, connectorDependencies: { [packageId]: { range: "^1.0.0", requirement } } };
  }
  it("retains the declared identity and trusted name, and logs the refused connector", async () => {
    const current = arrange();
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await createAndTriggerRunWithContext(USER, ORG, current);
      expect(result).toMatchObject({ ok: false, code: "CONNECTOR_NOT_CONFIGURED", connectorConfigurationRefusal: { packageId, displayName: "Apollo" } });
      expect(result).toHaveProperty("connectorConfigurationRefusal", { packageId, displayName: "Apollo" });
      expect(log).toHaveBeenCalledWith("[agents] run start refused: required connector is not configured", expect.objectContaining({ connectorPackage: packageId, connectorName: "Apollo", agentPackage: PKG }));
      expect(log).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE_BACKEND_DIAGNOSTIC");
      expect(createAgentRunPendingInput).toHaveBeenCalledTimes(1);
      expect(enqueueAgentRun).toHaveBeenCalledTimes(1);
      expect(transitionRunStatus).toHaveBeenNthCalledWith(2, RUN_ID, "queued", "pending_input", undefined, { kind: "session" });
    } finally { log.mockRestore(); }
  });
  it("uses the declared package identity when no public display name exists", async () => {
    const current = arrange();
    registry.catalog = { ...registry.catalog, [packageId]: { ...registry.catalog![packageId], displayName: "  " } };
    expect(await createAndTriggerRunWithContext(USER, ORG, current)).toHaveProperty("connectorConfigurationRefusal", { packageId, displayName: packageId });
  });
  it("does not borrow a non-connector record's name", async () => {
    const current = arrange(); registry.catalog = { ...registry.catalog, [packageId]: { ...registry.catalog![packageId], kind: "skill", displayName: "Unrelated secret" } };
    expect(await createAndTriggerRunWithContext(USER, ORG, current)).toHaveProperty("connectorConfigurationRefusal", { packageId, displayName: packageId });
  });
  it("preserves the preflight's legacy string declaration as a required edge", async () => {
    const current = arrange();
    expect(await createAndTriggerRunWithContext(USER, ORG, { ...current, connectorDependencies: { [packageId]: "^1.0.0" } })).toHaveProperty("connectorConfigurationRefusal", { packageId, displayName: "Apollo" });
  });
  it("never turns an LLM failure into a named connector or connector log", async () => {
    enqueueAgentRun.mockRejectedValueOnce(Object.assign(new Error("Configure LLM"), { code: "LLM_PROVIDER_NOT_CONFIGURED", packageId, settingsHref: "/configuration/llm" }));
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await createAndTriggerRunWithContext(USER, ORG, template)).toEqual({ ok: false, error: "Configure LLM", code: "LLM_PROVIDER_NOT_CONFIGURED", settingsHref: "/configuration/llm" });
      expect(log).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
  it("does not promote an optional edge into a required-connector refusal", async () => {
    expect(await createAndTriggerRunWithContext(USER, ORG, arrange("optional"))).not.toHaveProperty("connectorConfigurationRefusal");
  });
  it("does not trust an undeclared thrown connector", async () => {
    arrange();
    expect(await createAndTriggerRunWithContext(USER, ORG, template)).not.toHaveProperty("connectorConfigurationRefusal");
  });
});

describe("required connection checked before run creation", () => {
 it("draws/logs the named connector and creates no run when authority allowed but usable connection missing", async () => { const connector="@cinatra-ai/apollo-connector"; const e=Object.assign(new Error("connection missing"),{code:"CONNECTOR_NOT_CONFIGURED",packageId:connector,settingsHref:"/connectors/cinatra-ai/apollo-connector/setup"}); runConnectorPreflight.mockRejectedValue(e); const configuredCatalog: Record<string, AgentCatalogRecord> = {
    ...(registry.catalog ?? {}),
    [connector]: { ...record(connector, [], "Apollo"), kind: "connector" },
  };
  registry.catalog = configuredCatalog; const warn=vi.spyOn(console,"warn").mockImplementation(()=>{}); try { const result=await createAndTriggerRunWithContext(USER,ORG,{...template,connectorDependencies:{[connector]:"*"}}); expect(result).toMatchObject({ok:false,connectorConfigurationRefusal:{packageId:connector,displayName:"Apollo"}}); expect(createAgentRunPendingInput).not.toHaveBeenCalled(); expect(createAgentRun).not.toHaveBeenCalled(); expect(enqueueAgentRun).not.toHaveBeenCalled(); expect(warn).toHaveBeenCalledWith("[agents] run start refused: required connector is not configured",expect.objectContaining({connectorName:"Apollo",connectorPackage:connector})); } finally {warn.mockRestore();} });
 it("passes the real launching human before writes and preserves valid start", async () => { const t={...template,connectorDependencies:{"@cinatra-ai/apollo-connector":"*"}}; expect(await createAndTriggerRunWithContext(USER,ORG,t)).toMatchObject({ok:true}); expect(runConnectorPreflight).toHaveBeenCalledWith(t.connectorDependencies,expect.objectContaining({principalType:"HumanUser",principalId:USER,organizationId:ORG}),"use"); expect(runConnectorPreflight).toHaveBeenCalledBefore(createAgentRunPendingInput); });
});

it("optional-only start remains valid without inventing a new availability actor",async()=>{getActorContext.mockResolvedValue(null);const deps={"@cinatra-ai/apollo-connector":{range:"*",requirement:"optional" as const}};expect(await createAndTriggerRunWithContext(USER,ORG,{...template,connectorDependencies:deps})).toMatchObject({ok:true});expect(runConnectorPreflight).not.toHaveBeenCalled();});


describe("verified scoped launch connector actor (cinatra#3693)", () => {
  const launchOrg = "launch-org-B";
  const requiredTemplate = {...template,connectorDependencies:{"@cinatra-ai/apollo-connector":"*"}};
  function absentRunEffects() {
    expect(createAgentRunPendingInput).not.toHaveBeenCalled();
    expect(createAgentRun).not.toHaveBeenCalled();
    expect(transitionRunStatus).not.toHaveBeenCalled();
    expect(recordRunLifecycleMoment).not.toHaveBeenCalled();
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  }
  it("starts a configured required connector in verified orgB while active orgA", async () => {
    getActorContext.mockResolvedValue({principalType:"HumanUser",principalId:USER,organizationId:ORG,orgRole:"org_admin",teamIds:["team-A"],teamRoles:{"team-A":"team_admin"},projectGrants:[{projectId:"project-A",role:"owner"}]});
    resolveActorGrantsForUserInOrg.mockResolvedValue({orgRole:"member",teamIds:["team-B"],teamRoles:{"team-B":"member"},projectGrants:[{projectId:"project-B",role:"read"}]});
    expect(await createAndTriggerRunWithContext(USER,launchOrg,requiredTemplate)).toMatchObject({ok:true});
    expect(verifySessionAuthority).toHaveBeenCalledWith(USER,launchOrg);
    expect(resolveActorGrantsForUserInOrg).toHaveBeenCalledWith(USER,launchOrg);
    expect(runConnectorPreflight).toHaveBeenCalledWith(requiredTemplate.connectorDependencies,expect.objectContaining({principalType:"HumanUser",principalId:USER,organizationId:launchOrg,platformRole:"member",orgRole:"member",teamIds:["team-B"],teamRoles:{"team-B":"member"},projectIds:["project-B"]}),"use");
    expect(runConnectorPreflight).toHaveBeenCalledBefore(createAgentRunPendingInput);
  });
  it("refuses missing target membership without borrowing active-org admin", async () => {
    getActorContext.mockResolvedValue({principalType:"HumanUser",principalId:USER,organizationId:ORG,orgRole:"org_admin"});
    resolveActorGrantsForUserInOrg.mockResolvedValue({teamIds:[],projectGrants:[]});
    await expect(createAndTriggerRunWithContext(USER,launchOrg,requiredTemplate)).rejects.toThrow("Run-start actor could not be confirmed.");
    expect(runConnectorPreflight).not.toHaveBeenCalled();absentRunEffects();
  });
  it("refuses a request human different from the verified launch user", async () => {
    requireAuthSession.mockResolvedValue({user:{id:"another-human",role:"admin"},session:{activeOrganizationId:ORG}});
    await expect(createAndTriggerRunWithContext(USER,ORG,requiredTemplate)).rejects.toThrow("Run-start actor could not be confirmed.");
    expect(resolveActorGrantsForUserInOrg).not.toHaveBeenCalled();expect(runConnectorPreflight).not.toHaveBeenCalled();absentRunEffects();
  });
  it("refuses a missing request session before connection queries or creation", async () => {
    requireAuthSession.mockResolvedValue(null);
    await expect(createAndTriggerRunWithContext(USER,ORG,requiredTemplate)).rejects.toThrow("Run-start actor could not be confirmed.");
    expect(resolveActorGrantsForUserInOrg).not.toHaveBeenCalled();expect(runConnectorPreflight).not.toHaveBeenCalled();absentRunEffects();
  });
  it("refuses unresolved target grants without a fallback org", async () => {
    resolveActorGrantsForUserInOrg.mockRejectedValue(new Error("target grants unavailable"));
    await expect(createAndTriggerRunWithContext(USER,ORG,requiredTemplate)).rejects.toThrow("Run-start actor could not be confirmed.");
    expect(runConnectorPreflight).not.toHaveBeenCalled();absentRunEffects();
  });
  it("keeps target connection USE refusal before every run side effect", async () => {
    runConnectorPreflight.mockRejectedValue(Object.assign(new Error("connection unavailable for reader"),{code:"CONNECTOR_NOT_CONFIGURED",packageId:"@cinatra-ai/apollo-connector",settingsHref:"/connectors/cinatra-ai/apollo-connector/setup"}));
    const warn=vi.spyOn(console,"warn").mockImplementation(()=>{});
    try {
      expect(await createAndTriggerRunWithContext(USER,launchOrg,requiredTemplate)).toMatchObject({ok:false,connectorConfigurationRefusal:{packageId:"@cinatra-ai/apollo-connector"}});
      expect(runConnectorPreflight).toHaveBeenCalledWith(requiredTemplate.connectorDependencies,expect.objectContaining({organizationId:launchOrg,orgRole:"member"}),"use");absentRunEffects();
    } finally {warn.mockRestore();}
  });
});
