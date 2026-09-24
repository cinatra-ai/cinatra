/**
 * THE PERSON'S PICK BECOMES THE RESERVATION ROW (cinatra#3035, epic #3023 W11).
 *
 * The acceptance in the issue's own words: a person runs the pipeline end to end
 * "with the relation row present, a second run refused the same idea". On a real
 * run the pick arrived intact and matched the offered list, yet the reservation
 * table stayed empty: the row the runner built named the organisation column the
 * host injects itself and carried no scope, so the extension-data tool refused it
 * and the run went on with an empty idea.
 *
 * This file takes the PINNED pack's own reserve call — read out of the installed
 * declaration on disk, never re-typed — fills it with the pick and the offered
 * list exactly as that run carried them, and dispatches it through the REAL
 * stored-ideas road, the REAL runner and the REAL extension-data tool, over a
 * pooled client that only records what it is asked. Nothing of the gate's
 * decisions is mocked: what reaches the database here is what reaches it on a run.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IDEA_TAKEN_REASON } from "@/lib/stored-ideas-gate";

const lookup = vi.fn();
const getAgentPackage = vi.fn();
const logAuditEvent = vi.fn();

type Recorded = { text: string; values: unknown[] };
/** Every statement the extension-data tool sent, in order, with its parameters. */
let recorded: Recorded[] = [];
/** What the recording client answers the INSERT with: a row, or this error. */
let insertError: (Error & { code?: string }) | null = null;

const recordingClient = {
  async query(text: string, values: unknown[] = []) {
    recorded.push({ text, values });
    if (/^INSERT\b/.test(text)) {
      if (insertError) throw insertError;
      return { rows: [{}], rowCount: 1 };
    }
    // BEGIN, SET LOCAL ROLE, COMMIT and ROLLBACK answer nothing.
    return { rows: [], rowCount: 0 };
  },
  release() {},
};

vi.mock("@/lib/db/pooled", () => ({
  getPooledDb: () => ({
    query: (...a: unknown[]) => lookup(...a),
    connect: async () => recordingClient,
  }),
}));
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://unused",
  postgresSchema: "cinatra",
}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));
vi.mock("@cinatra-ai/registries", () => ({
  getAgentPackage: (...a: unknown[]) => getAgentPackage(...a),
}));
vi.mock("@/lib/verdaccio-config", () => ({ loadVerdaccioConfigForReads: async () => ({}) }));
vi.mock("@cinatra-ai/agents/installed-oas-path", () => ({
  probeInstalledOasPathForRead: (packageName: string) => ({
    path: packageName === PACKAGE_NAME ? OAS_PATH : null,
  }),
}));
vi.mock("@/lib/authz/audit", () => ({
  logAuditEvent: (...a: unknown[]) => logAuditEvent(...a),
}));

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const PACKAGE_NAME = "@cinatra-ai/blog-pipeline-agent";
/** The pinned checkout the dev-extensions lock materializes for this package. */
const PACK_ROOT = join(REPO_ROOT, "extensions", "cinatra-ai", "blog-pipeline-agent");
const OAS_PATH = join(PACK_ROOT, "cinatra", "oas.json");
/** The version whose call this file pins. */
const PINNED_VERSION = "0.2.4";
/** The declaration node that takes the person's pick for the run. */
const RESERVE_NODE_ID = "reserve_idea";

type Json = Record<string, unknown>;

function readJson(file: string): Json {
  return JSON.parse(readFileSync(file, "utf8")) as Json;
}

/** The keys a declaration carries its NODES under — the same two the host's own
 *  admission walks. A payload lookalike declares nothing. */
const DECLARATION_NODE_CONTAINERS = ["nodes", "$referenced_components"] as const;

function findDeclaredNodes(doc: unknown, id: string): Json[] {
  const found: Json[] = [];
  const seen = new Set<unknown>();
  const walkContainer = (container: unknown, depth: number): void => {
    if (depth > 40 || container === null || typeof container !== "object") return;
    if (seen.has(container)) return;
    seen.add(container);
    const entries = Array.isArray(container) ? container : Object.values(container as Json);
    for (const entry of entries) {
      if (Array.isArray(entry)) {
        walkContainer(entry, depth + 1);
        continue;
      }
      if (entry === null || typeof entry !== "object" || seen.has(entry)) continue;
      seen.add(entry);
      const node = entry as Json;
      if (node.id === id) found.push(node);
      for (const key of DECLARATION_NODE_CONTAINERS) {
        walkContainer(node[key], depth + 1);
      }
    }
  };
  for (const key of DECLARATION_NODE_CONTAINERS) {
    walkContainer((doc as Json)[key], 0);
  }
  return found;
}

/** The run the pick was lost on, and its organisation, as the run's own rows read. */
const RUN_ID = "1ec2c856-1156-4640-b9a7-c92b9df1473c";
const ORG_ID = "12d1e1fd-b976-4b30-8b7c-c7de77085caa";
const RUN = {
  id: RUN_ID,
  orgId: ORG_ID,
  runBy: null,
  templateId: "tmpl-1",
  packageVersion: PINNED_VERSION,
};

/** The five ideas the gate offered on that run, in their offered order. */
const OFFERED_IDEAS: ReadonlyArray<{
  artifactId: string;
  representationRevisionId: string;
  title: string;
  text: string;
}> = [
  {
    artifactId: "249296ae-a9f1-40ca-a7a3-4535e9e60980",
    representationRevisionId: "acb36b53-32e1-4197-bef1-1657186f16e6",
    title: "Common Failure Modes in Human-Reviewed AI Agent Workflows",
    text: "Title: Common Failure Modes in Human-Reviewed AI Agent Workflows\n\nA troubleshooting guide for teams whose AI agents still feel slow, risky, or unreliable despite human oversight. It identifies design issues that make review less effective.\n\nOutline:\nWhy adding a human does not automatically reduce risk\nFailure mode one: reviewers rubber-stamp low-context outputs\nFailure mode two: every task gets routed through the same queue\nFailure mode three: feedback never changes agent behavior\nFailure mode four: exceptions lack clear ownership\nRedesign review around decisions, not generic approval",
  },
  {
    artifactId: "780bd86d-8d37-4f00-8b1d-d634644a8733",
    representationRevisionId: "9c7cb643-cc22-4ee5-a8a6-619aa162b0a4",
    title: "How to Train Reviewers for Better AI Agent Supervision",
    text: "Title: How to Train Reviewers for Better AI Agent Supervision\n\nA playbook for making human reviewers more consistent, faster, and more useful to the system. The post covers rubrics, calibration, and feedback loops that improve outcomes.\n\nOutline:\nWhy reviewer inconsistency limits agent reliability\nCreate rubrics for approve, edit, reject, and escalate decisions\nRun calibration sessions on real edge cases\nTurn reviewer edits into reusable guidance\nAudit reviewer drift as workflows and policies change",
  },
  {
    artifactId: "27e779c4-4a3d-4c9f-b17d-b060fa15fee2",
    representationRevisionId: "1b48f030-6b64-44a7-a822-78482def1670",
    title: "The Operational Metrics That Matter for Human-in-the-Loop Agents",
    text: "Title: The Operational Metrics That Matter for Human-in-the-Loop Agents\n\nA breakdown of the metrics teams should track when AI agents run with human oversight. It covers quality, speed, reviewer load, and where automation is actually paying off.\n\nOutline:\nWhy accuracy alone is not enough to manage agent performance\nTrack approval rate, edit rate, and escalation rate\nMeasure reviewer time as a core operating cost\nSeparate agent failures from workflow failures\nUse metric trends to decide where to automate next",
  },
  {
    artifactId: "46c855fa-6146-46fa-af6e-0e64ffbc240b",
    representationRevisionId: "d556b4ce-5f22-4658-b088-c16e5762cd23",
    title: "When Should an AI Agent Ask for Human Help?",
    text: "Title: When Should an AI Agent Ask for Human Help?\n\nA framework for deciding which agent actions should be automatic, which should be reviewed, and which should be escalated. The goal is safer automation without constant interruption.\n\nOutline:\nThe hidden cost of asking humans too often\nMap tasks by confidence, impact, and reversibility\nUse thresholds that change as the agent proves itself\nEscalate ambiguity before the agent commits to action\nReview the escalation log to find automation opportunities",
  },
  {
    artifactId: "c13a193a-5519-4e02-8f83-8e3b9a371911",
    representationRevisionId: "f7f6bb45-081e-4c6b-9403-094d9ac902c3",
    title: "Designing Human Review That Improves AI Agent Output",
    text: "Title: Designing Human Review That Improves AI Agent Output\n\nA practical guide to placing human review where it catches real risk without slowing every task. The post explains how to turn review from a bottleneck into a learning loop.\n\nOutline:\nWhy human review belongs in the workflow design, not after it\nChoose review points based on risk and reversibility\nGive reviewers clear decision options, not vague approval buttons\nCapture reviewer feedback as structured improvement data\nMeasure quality gains alongside cycle time impact",
  },
];

/** The offered list as the runtime's `tojson` filter writes it: sorted keys,
 *  `", "` and `": "` between them. */
function offeredAsTheRuntimeWritesIt(): string {
  const keys = ["artifactId", "representationRevisionId", "text", "title"] as const;
  return `[${OFFERED_IDEAS.map(
    (idea) => `{${keys.map((k) => `${JSON.stringify(k)}: ${JSON.stringify(idea[k])}`).join(", ")}}`,
  ).join(", ")}]`;
}

const PICKED = OFFERED_IDEAS[0];
/** The pick exactly as the idea renderer commits it. */
const PICK = JSON.stringify({
  artifactId: PICKED.artifactId,
  representationRevisionId: PICKED.representationRevisionId,
});

/** The pinned reserve node's own call, with its pick and offered list filled. */
function reserveCall(pick: string): { tool: string; input: Json } {
  const nodes = findDeclaredNodes(readJson(OAS_PATH), RESERVE_NODE_ID);
  expect(nodes.length, `${RESERVE_NODE_ID} is declared exactly once at ${PINNED_VERSION}`).toBe(1);
  const data = nodes[0].data as Json;
  const envelope = data.input as Json;
  const inner = envelope.input as Json;
  expect(inner.op).toBe("reserve");
  return {
    tool: data.tool as string,
    input: { ...envelope, input: { ...inner, pick, offered: offeredAsTheRuntimeWritesIt() } },
  };
}

async function dispatch(pick: string) {
  const call = reserveCall(pick);
  const { dispatchExtensionScopedTool } = await import("@/lib/extension-scoped-tools");
  return dispatchExtensionScopedTool({ tool: call.tool, input: call.input, run: RUN });
}

const inserts = () => recorded.filter((r) => /^INSERT\b/.test(r.text));

/** The pinned declaration of the relation the reservation is written to. */
function declaredRelation(): {
  organizationColumn: string;
  columns: Array<{ name: string; notNull?: boolean }>;
} {
  const cinatra = readJson(join(PACK_ROOT, "package.json")).cinatra as Json;
  const tables = cinatra.declaredTables as Array<Json>;
  expect(tables).toHaveLength(1);
  return tables[0] as unknown as ReturnType<typeof declaredRelation>;
}

/** The column list an INSERT names, unquoted, in order. */
function insertColumns(text: string): string[] {
  const match = /^INSERT INTO [^(]+\(([^)]*)\) VALUES/.exec(text);
  expect(match, text).not.toBeNull();
  return (match?.[1] ?? "").split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
}

describe("the person's pick becomes the reservation row the pipeline's table accepts", () => {
  beforeEach(() => {
    recorded = [];
    insertError = null;
    lookup.mockReset();
    getAgentPackage.mockReset();
    logAuditEvent.mockReset();
    lookup.mockResolvedValue({
      rows: [{ package_name: PACKAGE_NAME, package_version: PINNED_VERSION }],
    });
    getAgentPackage.mockResolvedValue({ manifest: readJson(join(PACK_ROOT, "package.json")) });
    logAuditEvent.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterAll(() => {
    for (const mocked of [
      "@/lib/db/pooled",
      "@/lib/postgres-config",
      "@/lib/postgres-schema-init",
      "@cinatra-ai/registries",
      "@/lib/verdaccio-config",
      "@cinatra-ai/agents/installed-oas-path",
      "@/lib/authz/audit",
    ]) {
      vi.doUnmock(mocked);
    }
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("G3 pins the version the readings below are about", () => {
    expect(readJson(join(PACK_ROOT, "package.json")).version).toBe(PINNED_VERSION);
  });

  it("T1 answers the pick with the picked idea's artifact, revision, title and text", async () => {
    const outcome = await dispatch(PICK);
    expect(outcome).toEqual({
      ok: true,
      result: {
        ok: true,
        ideaArtifactId: "249296ae-a9f1-40ca-a7a3-4535e9e60980",
        ideaRevisionId: "acb36b53-32e1-4197-bef1-1657186f16e6",
        ideaTitle: "Common Failure Modes in Human-Reviewed AI Agent Workflows",
        idea: PICKED.text,
      },
    });
  });

  it("T2 writes one row under the extension's own role that names every notNull column once", async () => {
    await dispatch(PICK);

    const written = inserts();
    const events = logAuditEvent.mock.calls.map(([event]) => event as Json);
    const deniedReasons = events
      .filter((event) => event.decision === "denied")
      .map((event) => (event.metadata as Json | undefined)?.reason);
    // One reading of both halves, so a refusal names its own reason.
    expect({ inserts: written.length, denied: deniedReasons }).toEqual({ inserts: 1, denied: [] });
    const at = recorded.indexOf(written[0]);
    expect(recorded[at - 1]?.text).toMatch(/^SET LOCAL ROLE /);
    expect(recorded[at - 2]?.text).toBe("BEGIN");

    const relation = declaredRelation();
    const notNull = relation.columns.filter((c) => c.notNull === true).map((c) => c.name);
    expect(notNull.length).toBeGreaterThan(0);
    const columns = insertColumns(written[0].text);
    for (const column of notNull) {
      expect([column, columns.filter((c) => c === column).length]).toEqual([column, 1]);
    }
    const value = (column: string) => written[0].values[columns.indexOf(column)];
    expect(value(relation.organizationColumn)).toBe(ORG_ID);
    expect(value("scope_kind")).toBe("organization");
    expect(value("scope_id")).toBe(ORG_ID);
    expect(value("run_id")).toBe(RUN_ID);
    expect(value("idea_artifact_id")).toBe(PICKED.artifactId);
    expect(value("idea_revision_id")).toBe(PICKED.representationRevisionId);

    expect(events).toContainEqual(
      expect.objectContaining({ operation: "extension_data.insert", decision: "allowed" }),
    );
  });

  it("T3 tells a second run the idea was just taken when the table's one-live-row rule refuses it", async () => {
    insertError = Object.assign(
      new Error('duplicate key value violates unique constraint "idea_drafts_one_live"'),
      { code: "23505" },
    );
    const outcome = await dispatch(PICK);
    expect(outcome).toEqual({ ok: true, result: { ok: false, reason: IDEA_TAKEN_REASON } });
  });

  it("G1 refuses a pick on a revision the list did not offer, and writes nothing", async () => {
    const outcome = await dispatch(
      JSON.stringify({
        artifactId: PICKED.artifactId,
        representationRevisionId: "00000000-0000-4000-8000-000000000000",
      }),
    );
    expect(outcome).toMatchObject({ ok: true, result: { ok: false } });
    expect(String((outcome as { result: { reason: string } }).result.reason)).toContain(
      `is not one of the ${OFFERED_IDEAS.length} ideas the gate offered`,
    );
    expect(inserts()).toHaveLength(0);
  });

  it("G2 refuses the empty pick the gate emits when nothing is picked, and writes nothing", async () => {
    const outcome = await dispatch("");
    expect(outcome).toMatchObject({ ok: true, result: { ok: false } });
    expect(String((outcome as { result: { reason: string } }).result.reason)).toContain(
      "No blog idea was chosen at the idea gate.",
    );
    expect(inserts()).toHaveLength(0);
  });
});
