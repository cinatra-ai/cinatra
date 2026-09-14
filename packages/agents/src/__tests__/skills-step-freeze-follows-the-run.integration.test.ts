// @vitest-environment jsdom
//
// THE FREEZE FOLLOWS THE RUN, NOT A FLAG (cinatra#3062, fix leg 3) — against the
// REAL store, the REAL resolver and the REAL card, across a REAL reload.
//
// WHAT WAS MEASURED, AND WHY NO COMPONENT-TIER ARM COULD HAVE CAUGHT IT. On a
// live boot, with a real run dispatched from the shipped composer: the reader
// set the boxes through the card's own checkboxes, pressed the card's own
// Continue, and came back with a real page reload. In the SAME instant the run
// row read `pending_approval` with `started_at` NULL — the run had not started —
// while the card read `data-skills-step-editable` false, drew zero Continue
// controls, disabled every box, and refused a real change attempt. The card
// region went from 736 by 79 pixels to 736 by 26: the floor was gone from the
// pixels, not drawn disabled.
//
// The ratified drawing, section V, gives that reader one reading and it is not
// that one: "Continue does not close the row. For as long as the run has not
// started, a reader who comes back to the Skills step is shown the same pills
// with the boxes still able to take a change and Continue still beneath them,
// and may change the selection." The other reading it draws is for AFTER:
// "Once the run has started the same pills are drawn with the state their boxes
// were left in, read-only, and with no Continue."
//
// The component suites beside this file hand the card a settled state they wrote
// themselves, so they prove the VIEW and nothing about the road it is fed from.
// The defect lives on that road: the resolver answered "this run has started"
// from the STATUS STRING alone, and `pending_approval` is the status the skills
// hold's own park puts a not-yet-executed run into. So this tier drives the whole
// road on a real database — real DDL, a real run row with a real `started_at`
// column, a real park, the run's real decision evidence, the REAL resolver and
// the REAL card mounted under a declared host — and the reload is a real fresh
// mount that re-resolves from the row, exactly as a page load does.
//
// Run:
//   cd packages/agents && CINATRA_TEST_DB_URL=<a scratch DSN> \
//     npx vitest run --config vitest.integration.config.ts \
//     src/__tests__/skills-step-freeze-follows-the-run.integration.test.ts
import React from "react";
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const TEST_SCHEMA = "cinatra_test_freeze_follows_the_run_3062";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
// The tier self-skips without a live database, as its sibling does. The
// placeholder the base config injects names the `unused` database.
const HAS_DB = DB_URL !== "" && !DB_URL.endsWith("/unused");
const q = (s: string) => s.replaceAll('"', '""');

const USER_ID = "user-3062-freeze";
const ORG_ID = "org-3062-freeze";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("../server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
}));

// Module-graph stand-ins only, for the same reason the sibling tier names: the
// mounted card reaches a host whose module graph statically lists every optional
// extension package. This tier stands up a real database and a real resolver,
// not a real installed extension fleet.
vi.mock("@/lib/generated/extensions.server", () => ({
  STATIC_EXTENSION_MANIFEST: {},
  STATIC_EXTENSION_RECORDS: [],
  GENERATED_EXTENSION_SERVER_ENTRIES: {},
  GENERATED_CONNECTOR_ENTRY_MODULES: {},
  GENERATED_CONNECTOR_MCP_MODULES: {},
  GENERATED_CONNECTOR_PRIMITIVE_HANDLERS: {},
  GENERATED_EXTERNAL_MCP_TOOLBOXES: {},
  GENERATED_WIDGET_STREAM_AGENTS: {},
  GENERATED_CHAT_WIDGET_MODULES: {},
  GENERATED_CHAT_WIDGET_MANIFEST_MODULES: {},
  GENERATED_DEV_SETUP_MODULES: {},
}));
vi.mock("@/lib/generated/field-renderer-components", () => ({
  GENERATED_FIELD_RENDERER_COMPONENTS: {},
}));

const PACKAGE_NAME = "@cinatra-ai/blog-draft-writer-agent";
/**
 * THE ONE READ THIS TIER STANDS IN FOR, and it is not the seam under test.
 *
 * `getAssignedSkillIdsForAgent` resolves which skills an agent is entitled to,
 * and the shipped catalog behind it is `syncInstalledSkillsToDatabase()` — a
 * SYNC FROM DISK of an installed skill fleet, not a table a fixture can seed.
 * A test process has no installed fleet, so the entitlement set comes back
 * empty and the settled reading has no offer to draw. Every other read on this
 * road stays real: the run row and its `started_at`, the park, the offered set,
 * the decision evidence, the resolver, the card and the reload.
 */
vi.mock("@/lib/agents-store", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getAssignedSkillIdsForAgent: async () => ["skill-kept", "skill-cleared"],
  };
});

// THE TWO SEAMS SUBSTITUTED, AND NEITHER IS A BEHAVIOUR OF THIS ROAD. Both
// server entries are `"use server"` wrappers whose whole body is "resolve the
// cookie session into an actor, then ask the core"; there is no cookie jar in a
// test process, so the actor is supplied here and BOTH calls go on to the real
// core against the real database. The read is the reload seam; the write is the
// card's own Continue.
let resolveForTestActor: ((runId: string) => Promise<unknown>) | null = null;
let confirmForTestActor:
  | ((input: { runId: string; confirmedSkillIds: string[]; holdRef?: string }) => Promise<unknown>)
  | null = null;
vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: async (input: { runId: string }) => {
    if (!resolveForTestActor) throw new Error("resolver not wired");
    return resolveForTestActor(input.runId);
  },
  confirmRunRecommendationAction: async (input: {
    runId: string;
    confirmedSkillIds: string[];
    holdRef?: string;
  }) => {
    if (!confirmForTestActor) throw new Error("decision path not wired");
    return confirmForTestActor(input);
  },
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: false })),
}));

let parkStore: typeof import("../lifecycle-continuation-park-store");
let hold: typeof import("../recommendation-hold");
let core: typeof import("../run-recommendation-core");
let selectionStore: typeof import("@/lib/run-selected-skill-revisions");
let dbMod: typeof import("../db");
let cardMod: typeof import("../run-recommendation-chip-row");
let runtimeMod: typeof import("../lifecycle-card-runtime");
let policyMod: typeof import("@/lib/lifecycle/lifecycle-policy");
let continuationMod: typeof import("@/lib/lifecycle/lifecycle-continuation");
let statusMod: typeof import("../run-status");
let transitionMod: typeof import("../run-transition");

const WHO = {
  actor: { actorType: "human" as const, source: "ui" as const, userId: USER_ID },
  roleHints: { actorOrganizationId: ORG_ID },
};

beforeAll(async () => {
  if (!HAS_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;

  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
  await admin.query(`CREATE SCHEMA "${q(TEST_SCHEMA)}"`);
  const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
  for (const qy of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
    const head = qy.text.trim().slice(0, 6).toUpperCase();
    if (
      head !== "CREATE" &&
      head !== "ALTER " &&
      head !== "DROP T" &&
      head !== "DROP S" &&
      head !== "DO $$ "
    ) {
      continue;
    }
    if (qy.text.includes("user_slug_move_trg")) continue;
    try {
      await admin.query(qy.text, (qy as { values?: unknown[] }).values as never[]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("does not exist") && !msg.includes("already exists")) throw err;
    }
  }
  await admin.end();
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;

  parkStore = await import("../lifecycle-continuation-park-store");
  hold = await import("../recommendation-hold");
  core = await import("../run-recommendation-core");
  selectionStore = await import("@/lib/run-selected-skill-revisions");
  dbMod = await import("../db");
  cardMod = await import("../run-recommendation-chip-row");
  runtimeMod = await import("../lifecycle-card-runtime");
  policyMod = await import("@/lib/lifecycle/lifecycle-policy");
  continuationMod = await import("@/lib/lifecycle/lifecycle-continuation");
  statusMod = await import("../run-status");
  transitionMod = await import("../run-transition");

  resolveForTestActor = (runId: string) =>
    core.resolveRecommendationHoldStateForActor({ runId, who: WHO }) as Promise<unknown>;
  confirmForTestActor = (input) =>
    core.confirmRecommendationForActor({
      runId: input.runId,
      confirmedSkillIds: input.confirmedSkillIds,
      who: WHO,
      ...(input.holdRef ? { holdRef: input.holdRef } : {}),
      // The broker entry's own selection write — the same actor-parameterized
      // implementation the session action delegates to.
      writeSelection: (write) =>
        core.writeRunSkillSelectionForActor({
          runId: write.runId,
          confirmedSkillIds: write.confirmedSkillIds,
          who: WHO,
          ...(write.holdId !== undefined ? { holdId: write.holdId } : {}),
        }),
    }) as Promise<unknown>;
}, 120_000);

afterAll(async () => {
  if (!HAS_DB) return;
  await dbMod?.agentBuilderPool?.end().catch(() => {});
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
});

afterEach(() => {
  cleanup();
});

/**
 * A real run row in the status the caller names, with the `started_at` stamp
 * either absent or written — THE ONE FACT this whole file is about — under a
 * real template whose package the entitlement road can resolve.
 */
/** ONE template for the package — `package_name` is unique across templates. */
let templateId: string | null = null;
async function ensureTemplate(): Promise<string> {
  if (templateId) return templateId;
  const id = `tpl-${randomUUID()}`;
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  await c.query(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_templates"
       (id, org_id, name, source_nl, compiled_plan, input_schema, approval_policy, package_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, ORG_ID, "Blog draft writer", "write a blog draft", "[]", "{}", "{}", PACKAGE_NAME],
  );
  await c.end();
  templateId = id;
  return id;
}

async function insertRun(status: string, startedAt: Date | null): Promise<string> {
  const runId = `run-${randomUUID()}`;
  const templateId = await ensureTemplate();
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  await c.query(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_runs"
       (id, template_id, run_by, status, input_params, org_id, started_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [runId, templateId, USER_ID, status, "{}", ORG_ID, startedAt],
  );
  await c.end();
  return runId;
}

/** The dispatch CAS, as the row sees it: the status moves AND the stamp lands. */
async function stampTheStart(runId: string): Promise<void> {
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  await c.query(
    `UPDATE "${q(TEST_SCHEMA)}"."agent_runs" SET status = 'running', started_at = now() WHERE id = $1`,
    [runId],
  );
  await c.end();
}

async function readRunRow(runId: string): Promise<{ status: string; started_at: Date | null }> {
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  const { rows } = await c.query(
    `SELECT status, started_at FROM "${q(TEST_SCHEMA)}"."agent_runs" WHERE id = $1`,
    [runId],
  );
  await c.end();
  return rows[0];
}

/** Park the run at the recommendation interception, exactly as the hold does. */
async function parkRecommendation(runId: string) {
  const decision = policyMod.evaluatePolicy({
    checkpoint: "recommendation",
    artifactType: "*",
    destinationClass: "none",
    originKind: "agent_produced",
    humanPresent: true,
    orgRule: { bound: "silent" },
  });
  const outcome = continuationMod.evaluateThenPark(decision, {
    checkpoint: "recommendation",
    destinationClass: "none",
  });
  return parkStore.maybeParkCheckpoint(outcome, {
    runId,
    eventId: hold.recommendationHoldEventId(runId),
  });
}

/**
 * THE MEASURED SHAPE. A run parked at the skills hold, an offer the first draw
 * claimed, the reader's decision on file, and the park released — and the run
 * still sitting at `pending_approval` with NO start stamp, which is exactly what
 * the live boot read back in both themes.
 */
async function decidedButNotStarted(status = "pending_approval"): Promise<string> {
  const runId = await insertRun(status, null);
  await parkRecommendation(runId);
  const park = await hold.readRecommendationParkForRun(runId);
  await selectionStore.writeRunRecommendationOfferedSet({
    runId,
    holdId: park!.id,
    offered: [
      { skillId: "skill-kept", skillRevisionId: "skill-kept@1", recommended: true, rank: 1 },
      { skillId: "skill-cleared", skillRevisionId: "skill-cleared@1", recommended: true, rank: 2 },
    ],
  });
  selectionStore.writeRunSelectedSkillRevisions({
    runId,
    selections: [
      {
        skillId: "skill-kept",
        skillRevisionId: "skill-kept@1",
        selectionSource: "recommended_confirmed",
      },
    ],
  });
  selectionStore.writeRunRejectedRecommendations({
    runId,
    rejected: [
      {
        skillId: "skill-cleared",
        skillRevisionId: "skill-cleared@1",
        recommendationSource: "user_skipped",
        recommendedRank: 2,
      },
    ],
  });
  await hold.releaseRecommendationParkForRun(runId);
  return runId;
}

/** A PAGE LOAD: a fresh mount with nothing carried over, which re-resolves. */
function reload(runId: string, host: "chat_thread" | "run_card") {
  const card = React.createElement(cardMod.RecommendationHoldCard, {
    runId,
    agentPackageName: "",
    wireRef: null,
    initialState: null,
  } as never);
  return render(
    React.createElement(runtimeMod.LifecycleCardSurfaceProvider, { host, children: card }),
  );
}

const boxes = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLElement>("[data-skills-step-checkbox]"));
const step = (c: HTMLElement) => c.querySelector<HTMLElement>("[data-skills-step-editable]");
const continues = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLElement>("[data-skills-step-continue]"));

async function drawn(container: HTMLElement) {
  await waitFor(
    () => {
      expect(container.querySelector("[data-run-recommendation-chip-row]")).not.toBeNull();
    },
    { timeout: 20_000 },
  );
}

describe("the boundary, asked of the ROW", () => {
  it("reads a run parked at the hold with NO start stamp as NOT started", async () => {
    if (!HAS_DB) return;
    // `pending_approval` is reached from `queued` (the setup interrupt this hold
    // parks on, nothing executed) AND from `running` (an interrupt mid-flight).
    // The status cannot tell them apart; the stamp can.
    expect([...statusMod.START_AMBIGUOUS_RUN_STATUSES]).toEqual(["pending_approval"]);
    expect(statusMod.LEGAL_TRANSITIONS.has("queued->pending_approval")).toBe(true);
    expect(statusMod.LEGAL_TRANSITIONS.has("running->pending_approval")).toBe(true);
    expect(
      statusMod.recommendationRunHasStartedForRow({ status: "pending_approval", startedAt: null }),
    ).toBe(false);
    expect(
      statusMod.recommendationRunHasStartedForRow({
        status: "pending_approval",
        startedAt: new Date(),
      }),
    ).toBe(true);
    // The stamp is the fact, whatever the status says beside it…
    expect(
      statusMod.recommendationRunHasStartedForRow({ status: "pending_input", startedAt: new Date() }),
    ).toBe(true);
    // …and every unambiguous status keeps the answer it already had.
    expect(statusMod.recommendationRunHasStartedForRow({ status: "queued", startedAt: null })).toBe(
      true,
    );
    expect(
      statusMod.recommendationRunHasStartedForRow({ status: "pending_input", startedAt: null }),
    ).toBe(false);
    expect(statusMod.recommendationRunHasStartedForRow(null)).toBe(false);
  });
});

describe.skipIf(!HAS_DB)("cinatra#3062 fix leg 3 — the freeze follows the run, not a flag", () => {
  it("the resolver reads the measured row — parked, decided, no start stamp — as NOT started", async () => {
    const runId = await decidedButNotStarted();
    const row = await readRunRow(runId);
    expect(row.status).toBe("pending_approval");
    expect(row.started_at).toBeNull();
    const state = (await resolveForTestActor!(runId)) as { state: string; runStarted?: boolean };
    expect(state.state).toBe("confirmed");
    expect(state.runStarted).toBe(false);
  }, 120_000);

  for (const host of ["chat_thread", "run_card"] as const) {
    it(`${host}: a reader who comes back BEFORE the run starts gets the boxes and the Continue back`, async () => {
      // §V: "For as long as the run has not started, a reader who comes back to
      // the Skills step is shown the same pills with the boxes still able to
      // take a change and Continue still beneath them, and may change the
      // selection."
      const runId = await decidedButNotStarted();
      const { container } = reload(runId, host);
      await drawn(container);
      expect(step(container)?.getAttribute("data-skills-step-editable")).toBe("true");
      expect(continues(container)).toHaveLength(1);
      expect(continues(container)[0].hasAttribute("disabled")).toBe(false);
      const drawnBoxes = boxes(container);
      expect(drawnBoxes.length).toBeGreaterThan(0);
      for (const b of drawnBoxes) expect(b.hasAttribute("disabled")).toBe(false);
      // The row is still the run's own answer: what the decision recorded.
      expect(drawnBoxes.map((b) => b.getAttribute("aria-checked")).sort()).toEqual([
        "false",
        "true",
      ]);
    }, 120_000);

    it(`${host}: once the run HAS started the same pills are read-only, with no Continue`, async () => {
      // §V: "Once the run has started the same pills are drawn with the state
      // their boxes were left in, read-only, and with no Continue."
      const runId = await decidedButNotStarted();
      await stampTheStart(runId);
      const row = await readRunRow(runId);
      expect(row.started_at).not.toBeNull();
      const { container } = reload(runId, host);
      await drawn(container);
      expect(step(container)?.getAttribute("data-skills-step-editable")).toBe("false");
      expect(continues(container)).toHaveLength(0);
      const drawnBoxes = boxes(container);
      expect(drawnBoxes.length).toBeGreaterThan(0);
      for (const b of drawnBoxes) expect(b.hasAttribute("disabled")).toBe(true);
    }, 120_000);
  }

  it("THE CHANGE THE DRAWING PROMISES ACTUALLY LANDS — the store's own guard reads the stamp too", async () => {
    // §V does not stop at the reading: the returning reader "may change the
    // selection". The screen offering a live box is worth nothing if the write
    // behind it refuses, and the pre-start selection write carried the SAME
    // status-only boundary — so a run parked at `pending_approval` by this very
    // hold had its re-decision refused while the card invited it.
    const runId = await decidedButNotStarted();
    const applied = selectionStore.replaceRunSelectedSkillRevisionsBeforeStart({
      runId,
      scopeSkillIds: ["skill-kept", "skill-cleared"],
      selections: [
        {
          skillId: "skill-cleared",
          skillRevisionId: "skill-cleared@1",
          selectionSource: "recommended_confirmed",
        },
      ],
    });
    expect(applied).toBe(true);
    expect(
      selectionStore.readRunSelectedSkillRevisions(runId).map((r) => r.skillId).sort(),
    ).toEqual(["skill-cleared"]);

    // …and once the run HAS started the same write is refused, which is the
    // guard doing its job — the reading above goes read-only at the same moment.
    await stampTheStart(runId);
    const afterStart = selectionStore.replaceRunSelectedSkillRevisionsBeforeStart({
      runId,
      scopeSkillIds: ["skill-kept", "skill-cleared"],
      selections: [
        {
          skillId: "skill-kept",
          skillRevisionId: "skill-kept@1",
          selectionSource: "recommended_confirmed",
        },
      ],
    });
    expect(afterStart).toBe(false);
    expect(
      selectionStore.readRunSelectedSkillRevisions(runId).map((r) => r.skillId).sort(),
    ).toEqual(["skill-cleared"]);
  }, 120_000);

  it("THE MEASURED SEQUENCE: press the card's own Continue, then reload — the row is still editable, and the RUN is what closes it", async () => {
    const runId = await decidedButNotStarted();

    // 1. The returning reader's own reading, with a live Continue to press.
    const first = reload(runId, "chat_thread");
    await drawn(first.container);
    expect(continues(first.container)).toHaveLength(1);

    // 2. THE PRESS — the card's own control, through the real decision path.
    fireEvent.click(continues(first.container)[0]);
    await waitFor(
      async () => {
        const park = await hold.readRecommendationParkForRun(runId);
        expect(park?.status).not.toBe("parked");
      },
      { timeout: 20_000 },
    );
    // The press did not start the run: the row is where it was.
    const afterPress = await readRunRow(runId);
    expect(afterPress.started_at).toBeNull();

    // 3. THE RELOAD — a fresh mount, nothing carried over, re-resolved from the
    //    row. This is the instant the live boot measured as frozen.
    cleanup();
    const second = reload(runId, "chat_thread");
    await drawn(second.container);
    // THE AUTHORITY IS WHAT RE-OPENS THE WINDOW (fix leg 4). A conversation
    // redraws the row it already showed this reader the moment it remounts, so
    // the row is on screen before any read lands — and that replayed reading
    // withholds the one fact it cannot still vouch for, "the run has not
    // started". §V's editable reading is therefore the one the RESOLVER gives,
    // one read later, from the run row itself; waiting for it here is waiting
    // for exactly the answer this file is about.
    await waitFor(
      () => {
        expect(step(second.container)?.getAttribute("data-skills-step-editable")).toBe("true");
      },
      { timeout: 20_000 },
    );
    expect(continues(second.container)).toHaveLength(1);
    for (const b of boxes(second.container)) expect(b.hasAttribute("disabled")).toBe(false);

    // 4. The run starts, and the SAME reload closes the row — because the run
    //    closed it, not because a flag survived.
    cleanup();
    await stampTheStart(runId);
    const third = reload(runId, "chat_thread");
    await drawn(third.container);
    expect(step(third.container)?.getAttribute("data-skills-step-editable")).toBe("false");
    expect(continues(third.container)).toHaveLength(0);
  }, 180_000);
});


/**
 * THE REAL DISPATCH CAS, not a hand-written UPDATE (cinatra#3062, convergence).
 *
 * `stampTheStart` above stands in for the dispatch with its own SQL, which is
 * fine for asking the CARD a question but proves nothing about the row a real
 * dispatch leaves behind. This drives the production statement itself —
 * `updateAgentRunStatusConditional`, the deepest layer of `transitionRunStatus`
 * and the only place a run's status may legally flip — on the real database, so
 * the stamp the reading is derived from is the stamp the dispatch actually
 * writes. The guarded transaction the production entry wraps this in is an org
 * lock and permit around the SAME statement; the statement is the seam here.
 */
async function casTransition(
  runId: string,
  from: string,
  to: string,
  attemptId?: string,
): Promise<boolean> {
  return (dbMod.db as unknown as {
    transaction: (fn: (tx: unknown) => Promise<boolean>) => Promise<boolean>;
  }).transaction(async (tx) =>
    transitionMod.updateAgentRunStatusConditional(
      runId,
      from,
      to,
      attemptId ? { attemptId } : undefined,
      ORG_ID,
      tx as never,
    ),
  );
}

/** Parked, offered, decided — the same fixture, at whatever status the run holds. */
async function decideOn(runId: string): Promise<void> {
  await parkRecommendation(runId);
  const park = await hold.readRecommendationParkForRun(runId);
  await selectionStore.writeRunRecommendationOfferedSet({
    runId,
    holdId: park!.id,
    offered: [
      { skillId: "skill-kept", skillRevisionId: "skill-kept@1", recommended: true, rank: 1 },
      { skillId: "skill-cleared", skillRevisionId: "skill-cleared@1", recommended: true, rank: 2 },
    ],
  });
  selectionStore.writeRunSelectedSkillRevisions({
    runId,
    selections: [
      {
        skillId: "skill-kept",
        skillRevisionId: "skill-kept@1",
        selectionSource: "recommended_confirmed",
      },
    ],
  });
  selectionStore.writeRunRejectedRecommendations({
    runId,
    rejected: [
      {
        skillId: "skill-cleared",
        skillRevisionId: "skill-cleared@1",
        recommendationSource: "user_skipped",
        recommendedRank: 2,
      },
    ],
  });
  await hold.releaseRecommendationParkForRun(runId);
}

describe.skipIf(!HAS_DB)(
  "cinatra#3062 convergence — the stamp the reading rests on is the one the DISPATCH writes",
  () => {
    it("the production dispatch CAS stamps started_at", async () => {
      // The whole reading rests on the claim that `started_at` is written by the
      // `queued->running` dispatch. Ask the statement, not a fixture.
      const runId = await insertRun("queued", null);
      expect((await readRunRow(runId)).started_at).toBeNull();

      expect(await casTransition(runId, "queued", "running", randomUUID())).toBe(true);

      const running = await readRunRow(runId);
      expect(running.status).toBe("running");
      expect(running.started_at).not.toBeNull();
      expect(
        statusMod.recommendationRunHasStartedForRow({
          status: running.status,
          startedAt: running.started_at,
        }),
      ).toBe(true);
    }, 120_000);

    it("a re-dispatch keeps the run's FIRST start", async () => {
      const runId = await insertRun("queued", null);
      await casTransition(runId, "queued", "running", randomUUID());
      const first = (await readRunRow(runId)).started_at;
      expect(first).not.toBeNull();
      // running -> pending_input -> queued -> running, the retry road.
      await casTransition(runId, "running", "pending_input");
      await casTransition(runId, "pending_input", "queued");
      await casTransition(runId, "queued", "running", randomUUID());
      expect((await readRunRow(runId)).started_at).toEqual(first);
    }, 120_000);

    for (const host of ["chat_thread", "run_card"] as const) {
      it(`${host}: a run interrupted MID-FLIGHT into pending_approval stays FROZEN`, async () => {
        // The other producer of `pending_approval`: an interrupt raised while the
        // run was executing. Its status is byte-identical to the hold's own park,
        // so if the stamp is missing the card hands a started run a live Continue
        // and the store lets its ledger be rewritten. §V: "Once the run has
        // started the same pills are drawn with the state their boxes were left
        // in, read-only, and with no Continue."
        const runId = await insertRun("queued", null);
        await decideOn(runId);
        expect(await casTransition(runId, "queued", "running", randomUUID())).toBe(true);
        expect(await casTransition(runId, "running", "pending_approval")).toBe(true);

        const row = await readRunRow(runId);
        expect(row.status).toBe("pending_approval");
        expect(row.started_at).not.toBeNull();

        const state = (await resolveForTestActor!(runId)) as { runStarted?: boolean };
        expect(state.runStarted).toBe(true);

        const { container } = reload(runId, host);
        await drawn(container);
        expect(step(container)?.getAttribute("data-skills-step-editable")).toBe("false");
        expect(continues(container)).toHaveLength(0);
        for (const b of boxes(container)) expect(b.hasAttribute("disabled")).toBe(true);
      }, 180_000);
    }

    it("a run interrupted MID-FLIGHT into pending_approval keeps its ledger SHUT", async () => {
      const runId = await insertRun("queued", null);
      await decideOn(runId);
      await casTransition(runId, "queued", "running", randomUUID());
      await casTransition(runId, "running", "pending_approval");

      const applied = selectionStore.replaceRunSelectedSkillRevisionsBeforeStart({
        runId,
        scopeSkillIds: ["skill-kept", "skill-cleared"],
        selections: [
          {
            skillId: "skill-cleared",
            skillRevisionId: "skill-cleared@1",
            selectionSource: "recommended_confirmed",
          },
        ],
      });
      expect(applied).toBe(false);
      expect(
        selectionStore.readRunSelectedSkillRevisions(runId).map((r) => r.skillId).sort(),
      ).toEqual(["skill-kept"]);
    }, 120_000);
  },
);
