/**
 * A RUN CARRIES ITS TEMPLATE'S PACKAGE PIN (cinatra#2960, cinatra#3035).
 *
 * THE DEFECT, stated as cases. A template bound to a package at a version was
 * dispatched, and the row landed with an EMPTY `package_version`: every
 * dispatch road read `template.packageVersion` for the runnable gate and none
 * of them wrote it onto the run. The W7 admission seam then did exactly what it
 * promises — an unpinned run resolves to no calling package, so every packaged
 * tool the run's own package declares is refused — and a pipeline agent died at
 * its first packaged tool call with its own caller unresolved.
 *
 * Two tiers, because the fix has two halves:
 *
 *   1. THE RULE, as a DI unit: a caller's own pin wins (the agent-to-agent road
 *      pins at request time), the template's binding is the fallback, a blank
 *      is not a pin, and an unpackaged template still resolves to null — the
 *      admission seam's refusal is not being relaxed, it is being given the pin
 *      it was always entitled to.
 *   2. THE TWO CREATION PRIMITIVES, against the real store over a fake
 *      database (the `run-creation-guard` harness): what actually reaches the
 *      INSERT is asserted, for both `createAgentRun` and
 *      `createAgentRunPendingInput`. The creation fence makes those two the
 *      same set as "every producer", so proving them proves the chat primitive,
 *      the run page, the dev preview, the registry road and the peer adapter at
 *      once.
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
  // THE PACKAGE-BOUND TEMPLATE — the shape the failing runs actually had: a
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
  const { agentRuns, agentTemplates } = await import("../schema");

  function rowsFor(table: unknown): Array<Record<string, unknown>> {
    if (table === agentRuns) return shared.runRows;
    if (table === agentTemplates) return shared.templateRows;
    return []; // agentVersions → no version pin (benign here)
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

import { createAgentRun, createAgentRunPendingInput, resolveRunPackagePin } from "../store";

const ORG = "org-1";
const SESSION = { orgId: ORG, can: () => true };

beforeEach(() => {
  vi.clearAllMocks();
  shared.runRows = [];
  shared.insertedValues = [];
  shared.insertCalls = 0;
  shared.kernelAnswers.organization = { archivedAt: null, archiveEpoch: 0 };
  shared.kernelAnswers.leaseHeld = false;
  shared.templateRows[0]!.packageVersion = "0.2.0";
});

describe("resolveRunPackagePin — the rule", () => {
  it("takes the TEMPLATE's binding when the caller states no pin", async () => {
    const read = vi.fn(async () => "0.2.0");
    expect(
      await resolveRunPackagePin({ templateId: "tmpl-1" }, { readTemplatePackageVersion: read }),
    ).toBe("0.2.0");
    expect(read).toHaveBeenCalledWith("tmpl-1");
  });

  it("a caller's OWN pin wins, and the template is not read for it", async () => {
    const read = vi.fn(async () => "0.2.0");
    expect(
      await resolveRunPackagePin(
        { templateId: "tmpl-1", packageVersion: "1.4.1" },
        { readTemplatePackageVersion: read },
      ),
    ).toBe("1.4.1");
    expect(read).not.toHaveBeenCalled();
  });

  it("a BLANK caller pin is not a pin — the template's binding still answers", async () => {
    const read = vi.fn(async () => "0.2.0");
    expect(
      await resolveRunPackagePin(
        { templateId: "tmpl-1", packageVersion: "   " },
        { readTemplatePackageVersion: read },
      ),
    ).toBe("0.2.0");
  });

  it("an UNPACKAGED template still resolves to null — the admission seam's refusal stands", async () => {
    for (const bound of [null, "", "  "]) {
      expect(
        await resolveRunPackagePin(
          { templateId: "tmpl-1" },
          { readTemplatePackageVersion: async () => bound },
        ),
      ).toBeNull();
    }
  });
});

describe("createAgentRun — the row carries the pin", () => {
  it("writes the template's package version onto the run (the defect, as a case)", async () => {
    await createAgentRun(
      { id: "run-new", templateId: "tmpl-1", inputParams: {}, orgId: ORG },
      SESSION,
    );
    expect(shared.insertCalls).toBe(1);
    expect(shared.insertedValues[0]?.packageVersion).toBe("0.2.0");
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

  it("an unpackaged template still writes null", async () => {
    shared.templateRows[0]!.packageVersion = null;
    await createAgentRun(
      { id: "run-new", templateId: "tmpl-1", inputParams: {}, orgId: ORG },
      SESSION,
    );
    expect(shared.insertedValues[0]?.packageVersion).toBeNull();
  });
});

describe("createAgentRunPendingInput — the parked row carries the pin too", () => {
  it("writes the template's package version onto the pre-dispatch run", async () => {
    await createAgentRunPendingInput({ templateId: "tmpl-1", runBy: "user-1", orgId: ORG }, SESSION);
    expect(shared.insertCalls).toBe(1);
    expect(shared.insertedValues[0]?.packageVersion).toBe("0.2.0");
  });

  it("an unpackaged template still writes null", async () => {
    shared.templateRows[0]!.packageVersion = null;
    await createAgentRunPendingInput({ templateId: "tmpl-1", runBy: "user-1", orgId: ORG }, SESSION);
    expect(shared.insertedValues[0]?.packageVersion).toBeNull();
  });
});
