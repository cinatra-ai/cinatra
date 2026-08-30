// @vitest-environment jsdom
//
// THE SETTLED SKILLS STEP DRAWS ITS READING (cinatra#3047, review point C) —
// against the REAL store, from the run's own recorded decision rows.
//
// WHY THIS TIER EXISTS, and why the component suite beside it could not catch
// what this catches. `skills-step-editable-until-run-starts.test.tsx` hands the
// card a settled state it wrote itself, so it proves the VIEW and nothing about
// the road that view is fed from. The defect this file was written for lives on
// that road: a run whose skills were decided drew NOTHING on the run page —
// zero `[data-run-recommendation-chip-row]`, zero `[data-skills-step-checkbox]`
// — while the rail beside it read the very same park row as settled. So this
// tier drives the whole road on a real database: real DDL, a real run, a real
// park, the run's real decision evidence, the REAL resolver, and the REAL card
// mounted under the run page's own host. What it asserts is the DOM.
//
// Run:
//   cd packages/agents && CINATRA_TEST_DB_URL=<a scratch DSN> \
//     npx vitest run --config vitest.integration.config.ts \
//     src/__tests__/settled-skills-step.integration.test.ts
import React from "react";
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { cleanup, render, waitFor } from "@testing-library/react";
import * as railMod from "../recommendation-rail-entry";

const TEST_SCHEMA = "cinatra_test_settled_skills_step_3047";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
// The tier self-skips without a live database. The placeholder the base
// config injects names the `unused` database — see `vitest.integration.config.ts`.
const HAS_DB = DB_URL !== "" && !DB_URL.endsWith("/unused");
const q = (s: string) => s.replaceAll('"', '""');

const USER_ID = "user-3047-settled";
const ORG_ID = "org-3047-settled";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("../server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
}));

// Same reason as the component suite beside this tier: the mounted card reaches
// the run page host, whose module graph statically lists every optional
// extension package via the generated registries below. This tier stands up a
// real database and a real resolver, not a real installed extension fleet, so
// (as run-page-recommendation-one-place.test.tsx already does for the same
// mount) those two generated modules are stood in for here too.
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

// THE ONE SEAM THIS TIER SUBSTITUTES, and it substitutes only the SESSION.
// `getRunRecommendationHoldStateAction` is a `"use server"` wrapper whose whole
// body is "resolve the cookie session into an actor, then ask the core". There
// is no cookie jar in a test process, so the actor is supplied here and the
// call goes on to the REAL `resolveRecommendationHoldStateForActor` against the
// REAL database. Nothing else on the road is stood in for.
let resolveForTestActor: ((runId: string) => Promise<unknown>) | null = null;
/** Runs whose CLIENT read does not land — the condition the empty column was
 *  photographed under. The page's own server-side reading is the only source
 *  left, which is exactly what the last case below measures. */
const deadClientReads = new Set<string>();
vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: async (input: { runId: string }) => {
    if (deadClientReads.has(input.runId)) throw new Error("the read did not complete");
    if (!resolveForTestActor) throw new Error("resolver not wired");
    return resolveForTestActor(input.runId);
  },
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: false })),
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

  resolveForTestActor = (runId: string) =>
    core.resolveRecommendationHoldStateForActor({
      runId,
      who: {
        actor: { actorType: "human", source: "ui", userId: USER_ID },
        roleHints: { actorOrganizationId: ORG_ID },
      },
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

/** A real run row, owned by the reader below, in the status the caller names. */
async function insertRun(status: string): Promise<string> {
  const runId = `run-${randomUUID()}`;
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  await c.query(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_runs"
       (id, template_id, run_by, status, input_params, org_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [runId, `tpl-${randomUUID()}`, USER_ID, status, "{}", ORG_ID],
  );
  await c.end();
  return runId;
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
 * ONE DECIDED RUN: the reader kept one skill and cleared another, and the hold
 * released — the exact shape the run page draws its settled step from.
 */
async function decidedRun(status: string): Promise<string> {
  const runId = await insertRun(status);
  await parkRecommendation(runId);
  selectionStore.writeRunSelectedSkillRevisions({
    runId,
    selections: [
      { skillId: "skill-kept", skillRevisionId: "skill-kept@1", selectionSource: "recommended_confirmed" },
    ],
  });
  selectionStore.writeRunRejectedRecommendations({
    runId,
    rejected: [
      { skillId: "skill-cleared", skillRevisionId: "skill-cleared@1", recommendationSource: "user_skipped", recommendedRank: 2 },
    ],
  });
  await hold.releaseRecommendationParkForRun(runId);
  return runId;
}

function mountRunPageStep(runId: string, initialState: unknown = null) {
  const card = React.createElement(cardMod.RecommendationHoldCard, {
    runId,
    agentPackageName: "",
    wireRef: null,
    // WHAT THE RUN PAGE HANDS OVER. `SetupScreen` resolves this settled reading
    // server-side, through the very call the case below makes, and passes it
    // into this same prop.
    initialState,
  } as never);
  return render(
    React.createElement(runtimeMod.LifecycleCardSurfaceProvider, {
      host: "run_card",
      children: card,
    }),
  );
}

const boxes = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLElement>("[data-skills-step-checkbox]"));

describe.skipIf(!HAS_DB)("cinatra#3047 point C — the SETTLED Skills step, on a real store", () => {
  it("the resolver answers the decision rows for a decided run (the data road)", async () => {
    const runId = await decidedRun("pending_input");
    const state = (await resolveForTestActor!(runId)) as {
      state: string;
      decided?: Array<{ skillId: string; mark: string }>;
    };
    expect(state.state).toBe("confirmed");
    expect((state.decided ?? []).map((d) => [d.skillId, d.mark])).toEqual([
      ["skill-cleared", "skipped"],
      ["skill-kept", "confirmed"],
    ]);
  }, 120_000);

  it("a RUNNING run's settled step draws one box per decision row, disabled, with no Continue", async () => {
    const runId = await decidedRun("running");
    const { container } = mountRunPageStep(runId);
    await waitFor(() => {
      expect(container.querySelector("[data-run-recommendation-chip-row]")).not.toBeNull();
    }, { timeout: 20_000 });
    const drawn = boxes(container);
    expect(drawn).toHaveLength(2);
    expect(drawn.map((b) => b.getAttribute("data-skill-id"))).toEqual([
      "skill-cleared",
      "skill-kept",
    ]);
    expect(drawn.map((b) => b.getAttribute("aria-checked"))).toEqual(["false", "true"]);
    for (const b of drawn) expect(b.getAttribute("data-disabled")).not.toBeNull();
    expect(container.querySelector("[data-skills-step-continue]")).toBeNull();
  }, 120_000);

  it("a COMPLETED run reads the same after a fresh mount", async () => {
    const runId = await decidedRun("completed");
    const first = mountRunPageStep(runId);
    await waitFor(() => {
      expect(boxes(first.container)).toHaveLength(2);
    }, { timeout: 20_000 });
    cleanup();
    // A FRESH PAGE LOAD is a fresh mount with no state carried over — the second
    // reading comes from the store alone.
    const second = mountRunPageStep(runId);
    await waitFor(() => {
      expect(boxes(second.container)).toHaveLength(2);
    }, { timeout: 20_000 });
    expect(second.container.querySelector("[data-skills-step-continue]")).toBeNull();
  }, 120_000);

  it("a released hold with NO decision at all closes the step instead of opening an empty column", async () => {
    // THE MEASURED CASE (cinatra#3047, convergence): a hold that released with no
    // selection and no skip on file. The resolver answers `none` and the card
    // draws no DOM for it, so the park status alone — `released` — would have
    // opened this step over a blank column. The page holds the reading now, and
    // the reading closes the row.
    const runId = await insertRun("running");
    await parkRecommendation(runId);
    await hold.releaseRecommendationParkForRun(runId);
    const state = (await resolveForTestActor!(runId)) as { state: string };
    expect(state.state).toBe("none");
    const { container } = mountRunPageStep(runId, state);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(container.querySelector("[data-run-recommendation-chip-row]")).toBeNull();
    // …so the rail must not open it. The status-only reading opened it.
    expect(
      railMod.recommendationRailStepOpens({
        entry: "settled",
        parkStatus: "released",
        decided: true,
      }),
    ).toBe(true);
    expect(
      railMod.recommendationRailStepOpens({
        entry: "settled",
        parkStatus: "released",
        decided: true,
        settledReadingIsEmpty: state.state === "none",
      }),
    ).toBe(false);
  }, 120_000);

  it("a settled run whose decision names ONE cleared skill draws that one box", async () => {
    // A released park with one skip on file: one CLEARED box and nothing to
    // press. The truly empty decision is the case above.
    const runId = await insertRun("running");
    await parkRecommendation(runId);
    selectionStore.writeRunRejectedRecommendations({
      runId,
      rejected: [
        { skillId: "skill-none", skillRevisionId: "skill-none@1", recommendationSource: "user_skipped", recommendedRank: 1 },
      ],
    });
    await hold.releaseRecommendationParkForRun(runId);
    // The skip evidence names the one skill the hold asked about, so the reading
    // is one CLEARED box — the empty-column case is the run whose decision named
    // no skill at all, which the surface states in words.
    const { container } = mountRunPageStep(runId);
    await waitFor(() => {
      expect(container.querySelector("[data-run-recommendation-chip-row]")).not.toBeNull();
    }, { timeout: 20_000 });
    const list = container.querySelector("[data-skills-step-list]");
    expect(list).not.toBeNull();
    expect(list!.textContent?.trim().length).toBeGreaterThan(0);
    expect(container.querySelector("[data-skills-step-continue]")).toBeNull();
  }, 120_000);

  it("the PRODUCTION SHAPE — a real template and a hold that claimed its offer — still draws", async () => {
    const templateId = `tpl-${randomUUID()}`;
    const c = new Client({ connectionString: DB_URL });
    await c.connect();
    await c.query(
      `INSERT INTO "${q(TEST_SCHEMA)}"."agent_templates"
         (id, org_id, name, source_nl, compiled_plan, input_schema, approval_policy, package_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [templateId, ORG_ID, "Blog draft writer", "write a blog draft", "[]", "{}", "{}", "@cinatra-ai/blog-draft-writer-agent"],
    );
    const runId = `run-${randomUUID()}`;
    await c.query(
      `INSERT INTO "${q(TEST_SCHEMA)}"."agent_runs"
         (id, template_id, run_by, status, input_params, org_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [runId, templateId, USER_ID, "running", "{}", ORG_ID],
    );
    await c.end();

    const parked = await parkRecommendation(runId);
    const park = await hold.readRecommendationParkForRun(runId);
    expect(park?.status).toBe("parked");
    expect(parked.parked).toBe(true);
    // THE OFFER THE FIRST DRAW CLAIMED — four skills, as the re-shoot's run had.
    await selectionStore.writeRunRecommendationOfferedSet({
      runId,
      holdId: park!.id,
      offered: [
        { skillId: "skill-kept", skillRevisionId: "skill-kept@1", recommended: true, rank: 1 },
        { skillId: "skill-cleared", skillRevisionId: "skill-cleared@1", recommended: true, rank: 2 },
        { skillId: "skill-three", skillRevisionId: "skill-three@1", recommended: true, rank: 3 },
        { skillId: "skill-four", skillRevisionId: "skill-four@1", recommended: false, rank: 4 },
      ],
    });
    selectionStore.writeRunSelectedSkillRevisions({
      runId,
      selections: [
        { skillId: "skill-kept", skillRevisionId: "skill-kept@1", selectionSource: "recommended_confirmed" },
      ],
    });
    selectionStore.writeRunRejectedRecommendations({
      runId,
      rejected: [
        { skillId: "skill-cleared", skillRevisionId: "skill-cleared@1", recommendationSource: "user_skipped", recommendedRank: 2 },
      ],
    });
    await hold.releaseRecommendationParkForRun(runId);

    const state = (await resolveForTestActor!(runId)) as { state: string };
    expect(state.state).toBe("confirmed");

    const { container } = mountRunPageStep(runId);
    await waitFor(() => {
      expect(container.querySelector("[data-run-recommendation-chip-row]")).not.toBeNull();
    }, { timeout: 20_000 });
    expect(boxes(container).length).toBeGreaterThan(0);
    expect(container.querySelector("[data-skills-step-continue]")).toBeNull();
  }, 180_000);

  it("THE PAGE'S OWN READING draws the settled step when the client read never lands", async () => {
    const runId = await decidedRun("running");
    // The run page's server-side resolve — the same call `SetupScreen` makes for
    // a settled entry, against this real store.
    const pageReading = await resolveForTestActor!(runId);
    expect((pageReading as { state: string }).state).toBe("confirmed");

    // …and the client round trip does not land, at all.
    deadClientReads.add(runId);
    const { container } = mountRunPageStep(runId, pageReading);

    // FIRST PAINT, with no client answer to wait for.
    expect(container.querySelector("[data-run-recommendation-chip-row]")).not.toBeNull();
    const drawn = boxes(container);
    expect(drawn).toHaveLength(2);
    expect(drawn.map((b) => b.getAttribute("data-skill-id"))).toEqual([
      "skill-cleared",
      "skill-kept",
    ]);
    expect(drawn.map((b) => b.getAttribute("aria-checked"))).toEqual(["false", "true"]);
    for (const b of drawn) expect(b.hasAttribute("disabled")).toBe(true);
    expect(container.querySelector("[data-skills-step-continue]")).toBeNull();

    // It is still drawn after the failed read has spent its budget — the column
    // never comes up empty.
    await new Promise((r) => setTimeout(r, 1_000));
    expect(boxes(container)).toHaveLength(2);
  }, 180_000);
});
