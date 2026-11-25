// cinatra#4150 W4 C1b: the publish-decision island's SUBJECT (which artifacts row, which frozen targets) and the
// run-made revision read (does every target belong to the run).
//
// Pinned here, each with its refusal (every refusal is `null` / `false`, and a read that throws is a refusal):
//   - the run access door is the card's own (readAgentRunById with the reader); a reader who may not read the run
//     reaches no decision;
//   - the decision is the run's NEWEST and the named one, of this run, not run_ended, and of the run's organization;
//   - the template declares an ARTIFACTS row over the named input on the decision's own node (own keys only);
//   - the targets are the decision's frozen value for that input, normalized like a gate's set: one malformed entry,
//     an empty list or 51 entries refuse;
//   - the revision read is keyed by organization AND creating run, and compares artifact and revision pair by pair.
// Red first: at C1's head the module under test does not exist (import fails).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const storeMock = vi.hoisted(() => ({ readAgentRunById: vi.fn(), readAgentTemplateById: vi.fn() }));
vi.mock("../store", () => storeMock);

const decisions = vi.hoisted(() => ({ readLatestDecisionForRun: vi.fn() }));
vi.mock("../publish-decision-store", () => decisions);

const dbState = vi.hoisted(() => ({ rows: [] as unknown[], where: [] as unknown[], throws: false }));
vi.mock("../db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async (clause: unknown) => {
          dbState.where.push(clause);
          if (dbState.throws) throw new Error("db down");
          return dbState.rows;
        },
      }),
    }),
  },
}));

// The module under test is loaded inside the tests (beforeEach), so before the fix this file loads and every test
// fails on the missing module.
import type * as SubjectModule from "../publish-decision-island-subject";
let readPublishDecisionIslandSubject: typeof SubjectModule.readPublishDecisionIslandSubject;
let readRevisionsMadeByRun: typeof SubjectModule.readRevisionsMadeByRun;
let readPublishDecisionIslandRows: typeof SubjectModule.readPublishDecisionIslandRows;

const WHO = {
  actor: { actorType: "human" as const, source: "ui" as const, userId: "user-a" },
  roleHints: { orgRole: "member" as const, actorOrganizationId: "org-1" },
};
const RUN = { id: "run-1", templateId: "tmpl-1", orgId: "org-1", status: "pending_approval" };
const TARGETS = [
  { artifactId: "art-1", representationRevisionId: "rev-1" },
  { artifactId: "art-2", representationRevisionId: "rev-2" },
];
function decision(over: Record<string, unknown> = {}) {
  return {
    id: "dec-1",
    runId: "run-1",
    orgId: "org-1",
    nodeId: "publish",
    status: "parked",
    surfacedValues: { reviewTargets: TARGETS, pageTitle: "About us" },
    ...over,
  };
}
const TEMPLATE = {
  id: "tmpl-1",
  publishRows: {
    publish: [
      { label: "Page", input: "pageTitle" },
      { kind: "artifacts", label: "Proposed page", input: "reviewTargets" },
    ],
  },
};
const ASK = { runId: "run-1", decisionId: "dec-1", input: "reviewTargets", who: WHO };

beforeEach(async () => {
  ({ readPublishDecisionIslandSubject, readRevisionsMadeByRun, readPublishDecisionIslandRows } = await import(
    "../publish-decision-island-subject"
  ));
  vi.resetAllMocks();
  storeMock.readAgentRunById.mockResolvedValue(RUN);
  storeMock.readAgentTemplateById.mockResolvedValue(TEMPLATE);
  decisions.readLatestDecisionForRun.mockResolvedValue(decision());
  dbState.rows = [];
  dbState.where = [];
  dbState.throws = false;
});

describe("readPublishDecisionIslandSubject", () => {
  it("proves the row through the card's access door and answers the frozen targets", async () => {
    expect(await readPublishDecisionIslandSubject(ASK)).toEqual({
      runId: "run-1",
      orgId: "org-1",
      decided: false,
      targets: TARGETS,
    });
    expect(storeMock.readAgentRunById).toHaveBeenCalledWith("run-1", WHO.actor, WHO.roleHints);
    expect(decisions.readLatestDecisionForRun).toHaveBeenCalledWith("run-1");
  });

  it("a settled decision is decided; run_ended draws nothing", async () => {
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status: "released" }));
    expect(await readPublishDecisionIslandSubject(ASK)).toMatchObject({ decided: true });
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status: "run_ended" }));
    expect(await readPublishDecisionIslandSubject(ASK)).toBeNull();
  });

  it("a parked decision is read only while its run is held, as the card draws it", async () => {
    storeMock.readAgentRunById.mockResolvedValue({ ...RUN, status: "running" });
    expect(await readPublishDecisionIslandSubject(ASK)).toMatchObject({ targets: TARGETS });
    for (const status of ["stopped", "queued", "pending_input", "completed", "failed"]) {
      storeMock.readAgentRunById.mockResolvedValue({ ...RUN, status });
      expect(await readPublishDecisionIslandSubject(ASK)).toBeNull();
    }
    // A settled decision stays decided whatever the run did after it.
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status: "released" }));
    storeMock.readAgentRunById.mockResolvedValue({ ...RUN, status: "completed" });
    expect(await readPublishDecisionIslandSubject(ASK)).toMatchObject({ decided: true });
  });

  it("a decision recorded with no organization is read under the run's organization", async () => {
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ orgId: null }));
    expect(await readPublishDecisionIslandSubject(ASK)).toMatchObject({ orgId: "org-1", targets: TARGETS });
  });

  it("a reader the run access door refuses reaches no decision", async () => {
    storeMock.readAgentRunById.mockResolvedValue(null);
    expect(await readPublishDecisionIslandSubject(ASK)).toBeNull();
    storeMock.readAgentRunById.mockRejectedValue(new Error("Forbidden"));
    expect(await readPublishDecisionIslandSubject(ASK)).toBeNull();
    expect(decisions.readLatestDecisionForRun).not.toHaveBeenCalled();
  });

  it.each([
    ["no decision", null],
    ["an older decision than the newest", decision({ id: "dec-0" })],
    ["another run's decision", decision({ runId: "run-2" })],
    ["a decision recorded for another organization", decision({ orgId: "org-2" })],
    ["a decision whose node declares no rows", decision({ nodeId: "other" })],
    ["a decision on a node named after an Object.prototype member", decision({ nodeId: "constructor" })],
    ["a decision that surfaced no value for the input", decision({ surfacedValues: { pageTitle: "About us" } })],
    ["a target list with one malformed entry", decision({ surfacedValues: { reviewTargets: [...TARGETS, { artifactId: "art-3" }] } })],
    ["an empty target list", decision({ surfacedValues: { reviewTargets: [] } })],
    ["a value that is not a list", decision({ surfacedValues: { reviewTargets: "art-1" } })],
    [
      "51 targets",
      decision({ surfacedValues: { reviewTargets: Array.from({ length: 51 }, (_, i) => ({ artifactId: `a${i}`, representationRevisionId: `r${i}` })) } }),
    ],
  ])("%s draws nothing", async (_name, row) => {
    decisions.readLatestDecisionForRun.mockResolvedValue(row);
    expect(await readPublishDecisionIslandSubject(ASK)).toBeNull();
  });

  it("an inherited surfaced value is not read", async () => {
    const surfacedValues = Object.assign(Object.create({ reviewTargets: TARGETS }), { pageTitle: "About us" });
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ surfacedValues }));
    expect(await readPublishDecisionIslandSubject(ASK)).toBeNull();
  });

  it("an input that names a text row, or no row, draws nothing; so does a missing template", async () => {
    expect(await readPublishDecisionIslandSubject({ ...ASK, input: "pageTitle" })).toBeNull();
    expect(await readPublishDecisionIslandSubject({ ...ASK, input: "other" })).toBeNull();
    storeMock.readAgentTemplateById.mockResolvedValue(null);
    expect(await readPublishDecisionIslandSubject(ASK)).toBeNull();
  });

  // cinatra#4738 on main's declared rows: the island reads the rows the decision kept at its park, as the card does;
  // only a decision with none recorded (null) reads the template's current rows.
  it("reads the decision's stored rows before the template's current ones", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue({ id: "tmpl-1", publishRows: { publish: [{ label: "Page", input: "pageTitle" }] } });
    decisions.readLatestDecisionForRun.mockResolvedValue(
      decision({ declaredRows: [{ kind: "artifacts", label: "Proposed page", input: "reviewTargets" }] }),
    );
    expect(await readPublishDecisionIslandSubject(ASK)).toMatchObject({ targets: TARGETS });
    storeMock.readAgentTemplateById.mockResolvedValue(TEMPLATE);
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ declaredRows: [{ label: "Page", input: "pageTitle" }] }));
    expect(await readPublishDecisionIslandSubject(ASK)).toBeNull();
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ declaredRows: null }));
    expect(await readPublishDecisionIslandSubject(ASK)).toMatchObject({ targets: TARGETS });
  });

  it("an empty or over-long id is refused before any read", async () => {
    for (const ask of [{ ...ASK, runId: "" }, { ...ASK, decisionId: "d".repeat(129) }, { ...ASK, input: "" }]) {
      expect(await readPublishDecisionIslandSubject(ask)).toBeNull();
    }
    expect(storeMock.readAgentRunById).not.toHaveBeenCalled();
  });

  it("a decision or template read that throws draws nothing", async () => {
    decisions.readLatestDecisionForRun.mockRejectedValue(new Error("db down"));
    expect(await readPublishDecisionIslandSubject(ASK)).toBeNull();
    decisions.readLatestDecisionForRun.mockResolvedValue(decision());
    storeMock.readAgentTemplateById.mockRejectedValue(new Error("db down"));
    expect(await readPublishDecisionIslandSubject(ASK)).toBeNull();
  });
});

describe("readRevisionsMadeByRun", () => {
  const ASK_REVS = { orgId: "org-1", runId: "run-1", targets: TARGETS };
  const made = (pairs: Array<[string, string]>) => pairs.map(([id, artifactId]) => ({ id, artifactId }));

  it("true only when every target's revision was made by the run for that artifact", async () => {
    dbState.rows = made([["rev-1", "art-1"], ["rev-2", "art-2"]]);
    expect(await readRevisionsMadeByRun(ASK_REVS)).toBe(true);
  });

  it("the read is keyed by the organization AND the creating run, over the targets' revision ids", async () => {
    dbState.rows = made([["rev-1", "art-1"], ["rev-2", "art-2"]]);
    await readRevisionsMadeByRun(ASK_REVS);
    const query = new PgDialect().sqlToQuery(dbState.where[0] as SQL);
    expect(query.sql).toContain('"org_id" = $1');
    expect(query.sql).toContain('"created_by_run_id" = $2');
    expect(query.sql).toMatch(/"id" in \(\$3, \$4\)/);
    expect(query.params).toEqual(["org-1", "run-1", "rev-1", "rev-2"]);
  });

  it("one target the run did not make refuses the set", async () => {
    dbState.rows = made([["rev-1", "art-1"]]);
    expect(await readRevisionsMadeByRun(ASK_REVS)).toBe(false);
  });

  it("a revision of the run named with another artifact is not the run's target", async () => {
    dbState.rows = made([["rev-1", "art-1"], ["rev-2", "art-9"]]);
    expect(await readRevisionsMadeByRun(ASK_REVS)).toBe(false);
  });

  it("no targets, an empty organization or run, an over-long revision id, and a read that throws are false", async () => {
    dbState.rows = made([["rev-1", "art-1"], ["rev-2", "art-2"]]);
    expect(await readRevisionsMadeByRun({ ...ASK_REVS, targets: [] })).toBe(false);
    expect(await readRevisionsMadeByRun({ ...ASK_REVS, orgId: "" })).toBe(false);
    expect(await readRevisionsMadeByRun({ ...ASK_REVS, runId: "" })).toBe(false);
    expect(
      await readRevisionsMadeByRun({ ...ASK_REVS, targets: [{ artifactId: "art-1", representationRevisionId: "r".repeat(257) }] }),
    ).toBe(false);
    dbState.throws = true;
    expect(await readRevisionsMadeByRun(ASK_REVS)).toBe(false);
  });
});

// cinatra#4738 round 2: the rows a sealed publish-row capability's serving path reads to find which row its subject key
// names, behind the same door and decision checks as the subject read.
describe("readPublishDecisionIslandRows", () => {
  it("answers the newest decision's id and the input of each of its artifacts rows, through the card's door", async () => {
    expect(await readPublishDecisionIslandRows({ runId: "run-1", who: WHO })).toEqual({
      decisionId: "dec-1",
      inputs: ["reviewTargets"],
    });
    expect(storeMock.readAgentRunById).toHaveBeenCalledWith("run-1", WHO.actor, WHO.roleHints);
  });

  it("refuses a reader the run refuses, a run_ended decision, another organization's decision, and a throw", async () => {
    storeMock.readAgentRunById.mockResolvedValueOnce(null);
    expect(await readPublishDecisionIslandRows({ runId: "run-1", who: WHO })).toBeNull();
    decisions.readLatestDecisionForRun.mockResolvedValueOnce(decision({ status: "run_ended" }));
    expect(await readPublishDecisionIslandRows({ runId: "run-1", who: WHO })).toBeNull();
    decisions.readLatestDecisionForRun.mockResolvedValueOnce(decision({ orgId: "org-2" }));
    expect(await readPublishDecisionIslandRows({ runId: "run-1", who: WHO })).toBeNull();
    decisions.readLatestDecisionForRun.mockRejectedValueOnce(new Error("db down"));
    expect(await readPublishDecisionIslandRows({ runId: "run-1", who: WHO })).toBeNull();
  });

  it("reads the rows the decision kept at its park before the template's current rows", async () => {
    decisions.readLatestDecisionForRun.mockResolvedValueOnce(
      decision({ declaredRows: [{ kind: "artifacts", label: "Kept", input: "keptTargets" }] }),
    );
    expect(await readPublishDecisionIslandRows({ runId: "run-1", who: WHO })).toEqual({
      decisionId: "dec-1",
      inputs: ["keptTargets"],
    });
  });
});
