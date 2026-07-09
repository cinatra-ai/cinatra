// cinatra#1056 — run-enqueue connector preflight: requirement carry-through +
// the actor self-heal that keeps a populated connector_dependencies column from
// `no_actor`-breaking legitimate runs.
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

import {
  enqueueAgentRun,
  runConnectorPreflight,
  ConnectorNotConfiguredError,
} from "@/lib/agent-run-enqueue";

const ACTOR = { principalId: "u1", organizationId: "org1" } as never;

beforeEach(() => {
  vi.clearAllMocks();
  enqueueBackgroundJob.mockResolvedValue("job-1");
  requireConnectorAuthority.mockResolvedValue({ allowed: true });
});

describe("runConnectorPreflight — requirement carry-through (cinatra#1056)", () => {
  it("passes the projected edge's requirement (not a hardcoded 'required') to requireConnectorAuthority", async () => {
    await runConnectorPreflight(
      { "@cinatra-ai/apollo-connector": { range: "^1.0.0", requirement: "optional" } },
      ACTOR,
      "use",
    );
    expect(requireConnectorAuthority).toHaveBeenCalledWith(
      "@cinatra-ai/apollo-connector",
      ACTOR,
      { mode: "use", requirement: "optional" },
    );
  });

  it("normalizes a bare-string (legacy) value to requirement:'required'", async () => {
    await runConnectorPreflight({ "@cinatra-ai/wp": "^1.0.0" }, ACTOR, "use");
    expect(requireConnectorAuthority).toHaveBeenCalledWith(
      "@cinatra-ai/wp",
      ACTOR,
      { mode: "use", requirement: "required" },
    );
  });

  it("throws ConnectorNotConfiguredError (code + settingsHref) on a real policy deny — NOT a generic no_actor", async () => {
    requireConnectorAuthority.mockResolvedValue({ allowed: false, reason: "no_grant", skipped: false });
    await expect(
      runConnectorPreflight(
        { "@cinatra-ai/wordpress-mcp-connector": { range: "*", requirement: "required" } },
        ACTOR,
        "use",
      ),
    ).rejects.toMatchObject({
      code: "CONNECTOR_NOT_CONFIGURED",
      settingsHref: "/connectors/cinatra-ai/wordpress-mcp-connector/setup",
      reason: "no_grant",
    });
  });
});

describe("enqueueAgentRun — actor self-heal (cinatra#1056, codex D4)", () => {
  it("derives a run actor when a connector map is present but no actorContext was passed (MCP-path safety)", async () => {
    readAgentRunById.mockResolvedValue({ id: "run-1", runBy: "u1", orgId: "org1" });
    buildActorContextFromRun.mockResolvedValue(ACTOR);
    requireConnectorAuthority.mockResolvedValue({ allowed: true });

    await enqueueAgentRun(
      { runId: "run-1" },
      { connectorDependencies: { "@cinatra-ai/wp": { range: "*", requirement: "required" } } },
    );

    // Actor was built from the run and used for the preflight (NOT a no_actor path).
    expect(buildActorContextFromRun).toHaveBeenCalledWith({ id: "run-1", runBy: "u1", orgId: "org1" });
    expect(requireConnectorAuthority).toHaveBeenCalledWith("@cinatra-ai/wp", ACTOR, {
      mode: "use",
      requirement: "required",
    });
    expect(enforceConnectorPolicy).not.toHaveBeenCalled();
    // The self-healed actor is NOT threaded to the worker: enqueue options carry no actorContext.
    expect(enqueueBackgroundJob).toHaveBeenCalledTimes(1);
    const enqOpts = enqueueBackgroundJob.mock.calls[0][2] as Record<string, unknown>;
    expect(enqOpts).not.toHaveProperty("actorContext");
  });

  it("acceptance: a required connector unconfigured for the run actor blocks enqueue with CONNECTOR_NOT_CONFIGURED", async () => {
    readAgentRunById.mockResolvedValue({ id: "run-2", runBy: "u1", orgId: "org1" });
    buildActorContextFromRun.mockResolvedValue(ACTOR);
    requireConnectorAuthority.mockResolvedValue({ allowed: false, reason: "no_grant", skipped: false });

    await expect(
      enqueueAgentRun(
        { runId: "run-2" },
        { connectorDependencies: { "@cinatra-ai/wordpress-mcp-connector": { range: "*", requirement: "required" } } },
      ),
    ).rejects.toBeInstanceOf(ConnectorNotConfiguredError);
    // Blocked BEFORE enqueue.
    expect(enqueueBackgroundJob).not.toHaveBeenCalled();
  });

  it("D4: when the run actor cannot be built, the preflight is SKIPPED (never no_actor-false-denies) and the run still enqueues", async () => {
    readAgentRunById.mockResolvedValue({ id: "run-3", runBy: "u1", orgId: "org1" });
    buildActorContextFromRun.mockRejectedValue(new Error("grants store unreachable"));

    const res = await enqueueAgentRun(
      { runId: "run-3" },
      { connectorDependencies: { "@cinatra-ai/wp": { range: "*", requirement: "required" } } },
    );

    expect(res.status).toBe("queued");
    // No gate ran (neither the audited nor the no_actor synchronous branch).
    expect(requireConnectorAuthority).not.toHaveBeenCalled();
    expect(enforceConnectorPolicy).not.toHaveBeenCalled();
    // Run still enqueued; worker actorContext threading unchanged.
    expect(enqueueBackgroundJob).toHaveBeenCalledTimes(1);
    const enqOpts = enqueueBackgroundJob.mock.calls[0][2] as Record<string, unknown>;
    expect(enqOpts).not.toHaveProperty("actorContext");
  });

  it("does not touch the run/actor lookups when there is no connector dependency map (fast path)", async () => {
    await enqueueAgentRun({ runId: "run-4" }, { jobId: "run-4" });
    expect(readAgentRunById).not.toHaveBeenCalled();
    expect(buildActorContextFromRun).not.toHaveBeenCalled();
    expect(requireConnectorAuthority).not.toHaveBeenCalled();
    expect(enqueueBackgroundJob).toHaveBeenCalledTimes(1);
  });

  it("soft-preflight downgrades a deny to a warning (dev-preview path stays non-blocking)", async () => {
    buildActorContextFromRun.mockResolvedValue(ACTOR);
    readAgentRunById.mockResolvedValue({ id: "run-5", runBy: "u1", orgId: "org1" });
    requireConnectorAuthority.mockResolvedValue({ allowed: false, reason: "no_grant", skipped: false });
    const res = await enqueueAgentRun(
      { runId: "run-5" },
      { connectorDependencies: { "@cinatra-ai/wp": { range: "*", requirement: "required" } }, softPreflight: true },
    );
    expect(res.status).toBe("queued");
    expect(enqueueBackgroundJob).toHaveBeenCalledTimes(1);
  });
});
