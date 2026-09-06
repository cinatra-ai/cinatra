/**
 * WHAT A CREATED RUN PINS, AND WHAT IT MUST NOT (cinatra#1040 S7, #2960, #3035).
 *
 * `agent_runs` encodes a REQUIRED version pin as a PAIR: `version_id` AND
 * `package_version` both set. `resolvePinnedRunSnapshot` then serves that run
 * its exact `agent_template_versions` snapshot or refuses the run outright —
 * never the live template. Every producer other than the request-time road sets
 * AT MOST ONE of the two, and `createAgentRunPendingInput` sets `version_id`
 * only: an INERT latest-snapshot pin the worker has never honored.
 *
 * Stamping the template's package version onto that same row turns the inert
 * pin into a required one whose snapshot id was minted from a DIFFERENT table
 * than the one the resolver reads, so the run is refused before its first step.
 * These cases hold the two creation primitives to the encoding they own; the
 * package a run's tools are admitted under is resolved at the admission seam
 * instead (src/lib/extension-run-package).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const shared = vi.hoisted(() => ({
  kernelAnswers: {
    organization: { archivedAt: null as string | null, archiveEpoch: 0 } as
      | { archivedAt: string | null; archiveEpoch: number }
      | null,
    leaseHeld: false,
  },
  runRows: [] as Array<Record<string, unknown>>,
  // THE PACKAGE-BOUND TEMPLATE — the shape the refused runs actually had: a
  // published template carrying both halves of the binding.
  templateRows: [
    {
      id: "tmpl-1",
      orgId: "org-1",
      ownerLevel: "organization",
      ownerId: "org-1",
      creatorId: "user-installer",
      packageName: "@scope/pipeline-agent",
      packageVersion: "0.2.0",
    },
  ] as Array<Record<string, unknown>>,
  versionRows: [{ id: "ver-1", templateId: "tmpl-1" }] as Array<Record<string, unknown>>,
  insertedValues: [] as Array<Record<string, unknown>>,
  insertCalls: 0,
}));

function fakeRunRowDefaults(): Record<string, unknown> {
  return {
    id: "unset",
    templateId: "tmpl-1",
    versionId: null,
    runBy: null,
    status: "queued",
    inputParams: "{}",
    stepResults: null,
    startedAt: null,
    completedAt: null,
    error: null,
    title: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    sourceType: "agent_builder",
    sourceId: null,
    packageVersion: null,
    a2aTaskId: null,
    a2aContextId: null,
    parentRunId: null,
    agUiEnabled: true,
    lgThreadId: null,
    traceId: null,
    timeoutSeconds: null,
    streamedText: null,
    authPolicy: null,
    orgId: "org-1",
    projectId: null,
    idempotencyKey: null,
    oboCeiling: null,
    dependentInstallId: null,
    executionAttemptId: null,
    humanPresent: null,
  };
}

vi.mock("../db", async () => {
  const { wrapTxWithOrgWriteKernel } = await import("@cinatra-ai/org-write-kernel/testing");
  const { agentRuns, agentTemplates, agentVersions } = await import("../schema");

  function rowsFor(table: unknown): Array<Record<string, unknown>> {
    if (table === agentRuns) return shared.runRows;
    if (table === agentTemplates) return shared.templateRows;
    if (table === agentVersions) return shared.versionRows;
    return [];
  }

  function select() {
    return {
      from(table: unknown) {
        const rows = rowsFor(table);
        const terminal = Object.assign(Promise.resolve(rows), {
          limit: async () => rows,
          orderBy: () => ({ limit: async () => rows }),
        });
        return { where: () => terminal };
      },
    };
  }

  function insert() {
    return {
      values: (v: Record<string, unknown>) => {
        shared.insertCalls += 1;
        shared.insertedValues.push(v);
        const row = { ...fakeRunRowDefaults(), ...v };
        shared.runRows = [row];
        return Object.assign(Promise.resolve(undefined), { returning: async () => [row] });
      },
    };
  }

  const tx = wrapTxWithOrgWriteKernel(
    {
      update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
      insert,
      execute: async () => ({ rows: [] }),
    },
    shared.kernelAnswers,
  );
  return {
    db: {
      select,
      insert,
      transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
    agentBuilderPool: { end: vi.fn() },
  };
});

vi.mock("@/lib/auth-session", () => ({
  resolveOrgRoleForUser: async () => "member",
}));

vi.mock("@/lib/authz/build-actor-context-from-run", () => ({
  buildActorContextFromRun: async (run: { id: string; runBy: string | null; orgId: string }) => ({
    principalType: "HumanUser",
    principalId: run.runBy ?? "user-installer",
    organizationId: run.orgId,
    teamIds: [],
    projectIds: [],
    projectGrants: [],
    orgRole: "member",
    platformRole: "member",
    authSource: "worker",
    policyVersion: "v2",
  }),
}));

import { createAgentRun, createAgentRunPendingInput } from "../store";
import { resolvePinnedRunSnapshot } from "../execution";

const ORG = "org-1";
const SESSION = { orgId: ORG, can: () => true };

/** A written column that is absent, null or blank is not a pin. */
function pinOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  shared.runRows = [];
  shared.insertedValues = [];
  shared.insertCalls = 0;
  shared.kernelAnswers.organization = { archivedAt: null, archiveEpoch: 0 };
  shared.kernelAnswers.leaseHeld = false;
  shared.templateRows[0]!.packageVersion = "0.2.0";
});

describe("createAgentRunPendingInput — the parked row pins the SNAPSHOT only", () => {
  it("writes version_id and NO package version, for a package-bound template", async () => {
    await createAgentRunPendingInput({ templateId: "tmpl-1", runBy: "user-1", orgId: ORG }, SESSION);
    expect(shared.insertCalls).toBe(1);
    expect(shared.insertedValues[0]?.versionId).toBe("ver-1");
    expect(pinOf(shared.insertedValues[0]?.packageVersion)).toBeNull();
  });

  it("the row it writes is an INERT pin — the worker resolves it without refusing", async () => {
    // The pair is what makes a pin REQUIRED. version_id here was minted from
    // `agent_versions`; the required-pin path resolves an id against
    // `agent_template_versions`, so a forged pair refuses every run.
    await createAgentRunPendingInput({ templateId: "tmpl-1", runBy: "user-1", orgId: ORG }, SESSION);
    const written = shared.insertedValues[0]!;
    const byId = vi.fn(async () => null);
    const bySemver = vi.fn(async () => null);
    await expect(
      resolvePinnedRunSnapshot(
        {
          templateId: "tmpl-1",
          versionId: (written.versionId as string | null) ?? null,
          packageVersion: pinOf(written.packageVersion),
        },
        { readAgentTemplateVersionById: byId, readAgentTemplateVersionBySemver: bySemver },
      ),
    ).resolves.toBeNull();
    expect(byId).not.toHaveBeenCalled();
  });
});

describe("createAgentRun — the package version comes from the caller, or not at all", () => {
  it("writes no package version when the caller states none", async () => {
    await createAgentRun(
      { id: "run-new", templateId: "tmpl-1", inputParams: {}, orgId: ORG },
      SESSION,
    );
    expect(shared.insertCalls).toBe(1);
    expect(pinOf(shared.insertedValues[0]?.packageVersion)).toBeNull();
  });

  it("a caller that pins at request time keeps its own version", async () => {
    await createAgentRun(
      {
        id: "run-new",
        templateId: "tmpl-1",
        inputParams: {},
        orgId: ORG,
        packageVersion: "1.4.1",
      },
      SESSION,
    );
    expect(shared.insertedValues[0]?.packageVersion).toBe("1.4.1");
  });
});
