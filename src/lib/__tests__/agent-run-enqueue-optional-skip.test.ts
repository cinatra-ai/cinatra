// cinatra#1058 — optional-dependency RUN semantics at the connector run-start
// preflight. A REQUIRED connector dep denied at enqueue fails the run closed
// (unchanged, #1056); an OPTIONAL connector dep denied is skip-step-audit: the
// preflight does NOT throw, the run still enqueues, and one audited run-visible
// "skipped step" annotation is recorded per skipped dep.
import { describe, expect, it, vi, beforeEach } from "vitest";

const enqueueBackgroundJob = vi.fn(async (..._a: unknown[]) => "job-1");
vi.mock("@/lib/background-jobs", () => ({
  BACKGROUND_JOB_NAMES: { AGENT_BUILDER_EXECUTION: "AGENT_BUILDER_EXECUTION" },
  enqueueBackgroundJob: (...a: unknown[]) => enqueueBackgroundJob(...(a as [])),
}));

const requireConnectorAuthority = vi.fn();
vi.mock("@/lib/connector-authority", () => ({
  requireConnectorAuthority: (...a: unknown[]) => requireConnectorAuthority(...(a as [])),
}));

const enforceConnectorPolicy = vi.fn();
vi.mock("@/lib/connector-policy", () => ({
  enforceConnectorPolicy: (...a: unknown[]) => enforceConnectorPolicy(...(a as [])),
}));

const readAgentRunById = vi.fn();
vi.mock("@cinatra-ai/agents/store", () => ({
  readAgentRunById: (...a: unknown[]) => readAgentRunById(...(a as [])),
}));

const buildActorContextFromRun = vi.fn();
vi.mock("@/lib/authz/build-actor-context-from-run", () => ({
  buildActorContextFromRun: (...a: unknown[]) => buildActorContextFromRun(...(a as [])),
}));

const logAuditEvent = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("@/lib/authz/audit", () => ({
  logAuditEvent: (...a: unknown[]) => logAuditEvent(...(a as [])),
}));

import {
  enqueueAgentRun,
  runConnectorPreflight,
  recordOptionalConnectorSkips,
  ConnectorNotConfiguredError,
} from "@/lib/agent-run-enqueue";

const ACTOR = { principalId: "u1", organizationId: "org1" } as never;

// Decision helpers mirroring requireConnectorAuthority's contract.
const allow = () => ({ allowed: true });
const denyRequired = (reason: string) => ({ allowed: false, reason, skipped: false });
const denyOptional = (reason: string) => ({ allowed: false, reason, skipped: true });

beforeEach(() => {
  vi.clearAllMocks();
  enqueueBackgroundJob.mockResolvedValue("job-1");
  requireConnectorAuthority.mockResolvedValue(allow());
});

describe("runConnectorPreflight — optional skip-step-audit (cinatra#1058)", () => {
  it("does NOT throw on an OPTIONAL deny; returns the skipped dep with its reason", async () => {
    requireConnectorAuthority.mockResolvedValue(denyOptional("no_grant"));
    const res = await runConnectorPreflight(
      { "@cinatra-ai/apollo-connector": { range: "^1.0.0", requirement: "optional" } },
      ACTOR,
      "use",
    );
    expect(res.skippedOptional).toEqual([
      { packageId: "@cinatra-ai/apollo-connector", reason: "no_grant" },
    ]);
  });

  it("still throws ConnectorNotConfiguredError on a REQUIRED deny", async () => {
    requireConnectorAuthority.mockResolvedValue(denyRequired("no_grant"));
    await expect(
      runConnectorPreflight(
        { "@cinatra-ai/wordpress-mcp-connector": { range: "*", requirement: "required" } },
        ACTOR,
        "use",
      ),
    ).rejects.toBeInstanceOf(ConnectorNotConfiguredError);
  });

  it("mixed map: a REQUIRED deny throws even when an OPTIONAL dep would skip", async () => {
    requireConnectorAuthority.mockImplementation(async (pkg: string) =>
      pkg.includes("apollo") ? denyOptional("no_grant") : denyRequired("no_grant"),
    );
    await expect(
      runConnectorPreflight(
        {
          "@cinatra-ai/apollo-connector": { range: "*", requirement: "optional" },
          "@cinatra-ai/wp": { range: "*", requirement: "required" },
        },
        ACTOR,
        "use",
      ),
    ).rejects.toBeInstanceOf(ConnectorNotConfiguredError);
  });

  it("all-optional map: every deny is collected, none throw", async () => {
    requireConnectorAuthority.mockResolvedValue(denyOptional("no_connection"));
    const res = await runConnectorPreflight(
      {
        "@cinatra-ai/apollo-connector": { range: "*", requirement: "optional" },
        "@cinatra-ai/hunter-connector": { range: "*", requirement: "optional" },
      },
      ACTOR,
      "use",
    );
    expect(res.skippedOptional.map((s) => s.packageId).sort()).toEqual([
      "@cinatra-ai/apollo-connector",
      "@cinatra-ai/hunter-connector",
    ]);
  });

  it("actor-less branch: an OPTIONAL deny skips (never fail-closes on no_actor)", async () => {
    enforceConnectorPolicy.mockReturnValue({ allowed: false, reason: "no_actor" });
    const res = await runConnectorPreflight(
      { "@cinatra-ai/apollo-connector": { range: "*", requirement: "optional" } },
      undefined,
      "use",
    );
    expect(res.skippedOptional).toEqual([
      { packageId: "@cinatra-ai/apollo-connector", reason: "no_actor" },
    ]);
    // The audited helper was never reached (no actor) — but the run isn't failed.
    expect(requireConnectorAuthority).not.toHaveBeenCalled();
  });
});

describe("recordOptionalConnectorSkips — audited, run-visible annotation (cinatra#1058)", () => {
  it("emits one audit_events row per skipped dep, tagged with runId + behavior:skip-step-audit", async () => {
    await recordOptionalConnectorSkips("run-9", ACTOR, [
      { packageId: "@cinatra-ai/apollo-connector", reason: "no_grant" },
    ]);
    expect(logAuditEvent).toHaveBeenCalledTimes(1);
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org1",
        actorPrincipalId: "u1",
        resourceType: "connector_instance",
        resourceId: "@cinatra-ai/apollo-connector",
        operation: "use",
        decision: "allowed",
        runId: "run-9",
        metadata: expect.objectContaining({
          packageId: "@cinatra-ai/apollo-connector",
          requirement: "optional",
          skipped: true,
          behavior: "skip-step-audit",
          reason: "no_grant",
        }),
      }),
    );
  });

  it("swallows an audit-write failure (a skip annotation must never fail an enqueuable run)", async () => {
    logAuditEvent.mockRejectedValueOnce(new Error("audit store down"));
    await expect(
      recordOptionalConnectorSkips("run-9", ACTOR, [
        { packageId: "@cinatra-ai/apollo-connector", reason: "no_grant" },
      ]),
    ).resolves.toBeUndefined();
  });
});

describe("enqueueAgentRun — acceptance (cinatra#1058)", () => {
  it("A1/A2: an OPTIONAL connector unavailable → run STILL enqueues and the skip is audited", async () => {
    readAgentRunById.mockResolvedValue({ id: "run-1", runBy: "u1", orgId: "org1" });
    buildActorContextFromRun.mockResolvedValue(ACTOR);
    requireConnectorAuthority.mockResolvedValue(denyOptional("no_grant"));

    const res = await enqueueAgentRun(
      { runId: "run-1" },
      { connectorDependencies: { "@cinatra-ai/apollo-connector": { range: "*", requirement: "optional" } } },
    );

    expect(res.status).toBe("queued");
    expect(enqueueBackgroundJob).toHaveBeenCalledTimes(1);
    // The skip is recorded as an audited, run-visible annotation.
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        resourceId: "@cinatra-ai/apollo-connector",
        metadata: expect.objectContaining({ behavior: "skip-step-audit" }),
      }),
    );
  });

  it("A3: a REQUIRED connector unconfigured → blocked at enqueue (not mid-run), no annotation", async () => {
    readAgentRunById.mockResolvedValue({ id: "run-2", runBy: "u1", orgId: "org1" });
    buildActorContextFromRun.mockResolvedValue(ACTOR);
    requireConnectorAuthority.mockResolvedValue(denyRequired("no_grant"));

    await expect(
      enqueueAgentRun(
        { runId: "run-2" },
        { connectorDependencies: { "@cinatra-ai/wordpress-mcp-connector": { range: "*", requirement: "required" } } },
      ),
    ).rejects.toBeInstanceOf(ConnectorNotConfiguredError);
    expect(enqueueBackgroundJob).not.toHaveBeenCalled();
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it("an all-allowed map enqueues with no skip annotation", async () => {
    readAgentRunById.mockResolvedValue({ id: "run-3", runBy: "u1", orgId: "org1" });
    buildActorContextFromRun.mockResolvedValue(ACTOR);
    requireConnectorAuthority.mockResolvedValue(allow());

    const res = await enqueueAgentRun(
      { runId: "run-3" },
      { connectorDependencies: { "@cinatra-ai/apollo-connector": { range: "*", requirement: "optional" } } },
    );
    expect(res.status).toBe("queued");
    expect(logAuditEvent).not.toHaveBeenCalled();
  });
});
