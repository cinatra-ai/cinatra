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
const requireAuthSession = vi.fn();
const getActorContext = vi.fn();
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
  catalog(); status("installed");
  getActorContext.mockResolvedValue({ principalType: "HumanUser", principalId: USER, organizationId: ORG, orgRole: "member", teamIds: [], projectGrants: [] });
  verifySessionAuthority.mockResolvedValue({ kind: "session" });
  createAgentRunPendingInput.mockResolvedValue({ ...row });
  readAgentRunById.mockResolvedValue({ ...row });
  transitionRunStatus.mockResolvedValue(undefined);
  recordRunLifecycleMoment.mockResolvedValue(undefined);
  enqueueAgentRun.mockResolvedValue(undefined);
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
