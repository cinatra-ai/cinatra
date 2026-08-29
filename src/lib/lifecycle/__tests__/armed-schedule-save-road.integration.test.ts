// THE ARMED-SCHEDULE CHANGE ROAD, AGAINST A REAL POSTGRES (cinatra#2934, the
// armed-schedule change road) — the tier the graded re-shoot's first defect can
// actually be settled on.
//
// WHAT THE PICTURES MEASURED, and what only a database can answer for it. The
// road was intermittent on real runs: a described change reached the form's
// rows on the first ask of one run and on none of six asks of another, and a
// plain "save that" was refused outright. Two of the three causes are read
// off code (the turn's missing context, the refusal's wrong sentence) and are
// pinned in the unit suite beside this one. THE THIRD IS A STORE QUESTION: is
// what the person placed in one turn still findable, as the same rows, by the
// turn that asks for it to be saved — through JSON in a text column, two
// separate requests, and a trigger row that moves under it? An in-memory
// stand-in would agree with whatever this code claimed.
//
// So the world under the handler is REAL where it matters: the fill is written
// by the fill road's own recorder, read back by the save arm's own reader, the
// trigger row is written and read by the trigger store, and the "not yet saved"
// bound is the real `updated_at` the real upsert stamps. What is substituted is
// the world AROUND it — the resolver's rows, the run's access and the person's
// standing — exactly as the unit suites substitute them.
//
// SELF-SKIPS without `SUPABASE_DB_URL`, and THROWS instead of skipping inside
// its own lane (`CINATRA_SCREEN_FILL_REALDB`), for the same reason the sibling
// tier does: a suite whose only failure mode is "skipped" reports success by
// doing nothing.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-w5c-armed-save-road";

const DSN = process.env.SUPABASE_DB_URL ?? "";
const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra_x2934";
const IN_LANE = process.env.CINATRA_SCREEN_FILL_REALDB === "1";

if (IN_LANE && !DSN) {
  throw new Error(
    "the armed-save tier needs a real database: set SUPABASE_DB_URL to a scratch Postgres DSN",
  );
}

const frame: { store: Record<string, unknown> | undefined } = { store: undefined };
vi.mock("@cinatra-ai/mcp-server", () => ({
  mcpRequestContextStorage: { getStore: () => frame.store },
}));

// The single-use ledger. Its own store is proven elsewhere; here it is the one
// property this road depends on — one press per message.
let grantSpent = false;
vi.mock("../lent-action-grant-store", () => ({
  lentActionGrantIsSpendable: async () => !grantSpent,
  consumeLentActionGrant: async () => {
    if (grantSpent) return { outcome: "refused" };
    grantSpent = true;
    return { outcome: "consumed", messageText: "save that" };
  },
  recordLentActionGrant: async () => true,
  sweepExpiredLentActionGrants: async () => undefined,
}));

// The RUN's own right to answer. Mocked WITHOUT `importOriginal`, deliberately:
// the real module reaches the session layer at import, and this tier's database
// is a scratch schema with no auth tables in it. The right itself is proven by
// the unit suites; what this tier is about is the store underneath.
vi.mock("../run-window-turn", () => ({
  canActorRespondToRun: async () => true,
}));

vi.mock("@cinatra-ai/agents/review-task-actions", () => ({
  approveReviewTaskInternal: vi.fn(),
}));
vi.mock(
  "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/actions",
  () => ({ submitReviewDecisionAction: vi.fn() }),
);
vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({
  enforceReviewRunAccess: vi.fn(),
  readGatePinnedTargets: vi.fn(),
}));
vi.mock("@cinatra-ai/agents/store", () => ({
  readLatestDurableHitlGateArtifact: vi.fn(),
}));
// The PERSON'S OWN CREDENTIAL. Injected into every call below as a `deps`
// argument, so what is mocked here is only the module's IMPORT: the real one
// reaches the session layer, which opens the product's auth tables — and this
// tier's schema is a scratch one holding the two tables the road actually
// writes to.
vi.mock("../bound-turn-actor", () => ({ resolveBoundTurnActor: vi.fn() }));

import {
  createOrUpdateRunTrigger,
  readRunTriggerByRunId,
} from "@cinatra-ai/agents/trigger-store";
import { armedScheduleFormValues } from "@cinatra-ai/agents/trigger-recurrence";
import { encodeScheduleRunRef } from "../lifecycle-card-ref";
import { mintLentActionGrant } from "../lent-action-grant";
import {
  ARMED_SCHEDULE_FORM_X_RENDERER,
  armedScheduleFormSchema,
} from "../schedule-form-screen";
import { recordBoundScreenFill } from "../bound-screen-fill";
import { LENT_ACTION_NOTHING_PLACED_TO_SAVE, handleLentAction } from "../lent-action-mcp";
import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";

const maybe = DSN ? describe : describe.skip;

const PERSON = { userId: "usr_realstore_1", orgId: "org_realstore_1" };
const RUN = "w5c-armed-save-road";
const REF = encodeScheduleRunRef({ runId: RUN })!;

const ACTOR: ReviewActorContext = {
  actor: { actorType: "human", source: "agent", userId: PERSON.userId, orgId: PERSON.orgId },
  orgId: PERSON.orgId,
  roleHints: { platformRole: "member", orgRole: "member", actorOrganizationId: PERSON.orgId },
} as unknown as ReviewActorContext;

/** The card the window is bound to: a one-off armed for a future instant. */
function armedResolution(runAt: string) {
  const schedule = { kind: "scheduled" as const, runAt, timezone: "Europe/Berlin" };
  return {
    kind: "armed_schedule_form" as const,
    runId: RUN,
    xRenderer: ARMED_SCHEDULE_FORM_X_RENDERER,
    canSave: true,
    refusal: null,
    schedule,
    form: { schema: armedScheduleFormSchema(), values: armedScheduleFormValues(schedule) },
  };
}

let pool: Pool;
const T = (t: string) => `"${SCHEMA}"."${t}"`;

const BOOTSTRAP = [
  `CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`,
  `CREATE TABLE IF NOT EXISTS ${T("agent_run_messages")} (
      id text PRIMARY KEY,
      run_id text NOT NULL,
      sequence integer NOT NULL,
      role text NOT NULL,
      message_type text NOT NULL DEFAULT 'text',
      tool_call_id text,
      tool_name text,
      content text NOT NULL DEFAULT '',
      content_json text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS agent_run_messages_run_id_sequence_unique
     ON ${T("agent_run_messages")} (run_id, sequence)`,
  `CREATE TABLE IF NOT EXISTS ${T("agent_run_triggers")} (
      run_id text PRIMARY KEY,
      trigger_type text NOT NULL DEFAULT 'immediate',
      scheduled_at timestamptz,
      cron_expression text,
      timezone text NOT NULL DEFAULT 'UTC',
      enabled boolean NOT NULL DEFAULT true,
      released_at timestamptz,
      last_fired_at timestamptz,
      stopped_at timestamptz,
      job_scheduler_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
   )`,
];

/** The person sends a message with the armed form bound. */
function sendAs(messageId: string) {
  grantSpent = false;
  const minted = mintLentActionGrant({
    userId: PERSON.userId,
    orgId: PERSON.orgId,
    messageId,
    cardRef: REF,
    control: "save",
  });
  if (!minted) throw new Error("mint failed");
  frame.store = {
    userId: PERSON.userId,
    orgId: PERSON.orgId,
    lentActionGrant: minted.grant,
  };
}

/** The card's own save, as the trigger store really performs it. */
function decideAgainstTheStore() {
  return vi.fn(async (input: Record<string, unknown>) => {
    const s = input.schedule as { kind: string; runAt: string; timezone: string };
    await createOrUpdateRunTrigger({
      runId: RUN,
      triggerType: "scheduled",
      scheduledAt: new Date(`${s.runAt}:00.000Z`),
      timezone: s.timezone,
      enabled: true,
    });
    return { kind: "saved", runId: RUN } as never;
  });
}

maybe("the armed-schedule change road, on a real database", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: DSN, max: 4 });
    for (const q of BOOTSTRAP) await pool.query(q);
  }, 60_000);

  afterAll(async () => {
    if (!pool) return;
    await pool
      .query(`DELETE FROM ${T("agent_run_messages")} WHERE run_id = $1`, [RUN])
      .catch(() => undefined);
    await pool
      .query(`DELETE FROM ${T("agent_run_triggers")} WHERE run_id = $1`, [RUN])
      .catch(() => undefined);
    await pool.end();
  });

  beforeEach(async () => {
    frame.store = undefined;
    grantSpent = false;
    await pool.query(`DELETE FROM ${T("agent_run_messages")} WHERE run_id = $1`, [RUN]);
    await pool.query(`DELETE FROM ${T("agent_run_triggers")} WHERE run_id = $1`, [RUN]);
    await createOrUpdateRunTrigger({
      runId: RUN,
      triggerType: "scheduled",
      scheduledAt: new Date("2026-09-01T09:00:00.000Z"),
      timezone: "Europe/Berlin",
      enabled: true,
    });
  });

  it("a described change placed in one turn is saved by a plain ask in the next", async () => {
    const resolve = vi.fn(async () => armedResolution("2026-09-01T09:00") as never);
    // TURN 1 — the change is placed in the form. Nothing is saved: the row
    // stands exactly where it was armed.
    const placed = await recordBoundScreenFill({
      ref: REF,
      values: { scheduledAt: "2026-09-02T10:30" },
      actorCtx: ACTOR,
      messageId: "turn_1",
      deps: { resolve: resolve as never, surface: "armed-trigger" },
    });
    expect(placed.kind).toBe("filled");
    expect((await readRunTriggerByRunId(RUN))!.scheduledAt!.toISOString()).toBe(
      "2026-09-01T09:00:00.000Z",
    );

    // TURN 2 — "Save that.", with nothing described in it at all.
    sendAs("turn_2");
    const decide = decideAgainstTheStore();
    const res = await handleLentAction(
      { ref: REF },
      { resolve: resolve as never, resolveActor: (async () => ACTOR) as never, decideSchedule: decide as never },
    );
    expect((res.structuredContent as { ok: boolean }).ok).toBe(true);
    // AND THE ROW MOVED, read back off the database rather than off the answer.
    expect((await readRunTriggerByRunId(RUN))!.scheduledAt!.toISOString()).toBe(
      "2026-09-02T10:30:00.000Z",
    );
  });

  it("eight identical asks in a row all land — every fill, every save", async () => {
    for (let i = 0; i < 8; i += 1) {
      const day = String(2 + i).padStart(2, "0");
      const armedAt = i === 0 ? "2026-09-01T09:00" : `2026-09-${String(1 + i).padStart(2, "0")}T10:30`;
      const resolve = vi.fn(async () => armedResolution(armedAt) as never);
      const placed = await recordBoundScreenFill({
        ref: REF,
        values: { scheduledAt: `2026-09-${day}T10:30` },
        actorCtx: ACTOR,
        messageId: `fill_${i}`,
        deps: { resolve: resolve as never, surface: "armed-trigger" },
      });
      expect(placed.kind, `fill ${i}`).toBe("filled");

      sendAs(`save_${i}`);
      const decide = decideAgainstTheStore();
      const res = await handleLentAction(
        { ref: REF },
        { resolve: resolve as never, resolveActor: (async () => ACTOR) as never, decideSchedule: decide as never },
      );
      expect((res.structuredContent as { ok: boolean }).ok, `ask ${i}`).toBe(true);
      expect(decide, `ask ${i}`).toHaveBeenCalledTimes(1);
      expect(
        (await readRunTriggerByRunId(RUN))!.scheduledAt!.toISOString(),
        `row after ask ${i}`,
      ).toBe(`2026-09-${day}T10:30:00.000Z`);
    }
  });

  it("a placement already saved is not re-applied by a later bare ask", async () => {
    const resolve = vi.fn(async () => armedResolution("2026-09-01T09:00") as never);
    await recordBoundScreenFill({
      ref: REF,
      values: { scheduledAt: "2026-09-02T10:30" },
      actorCtx: ACTOR,
      messageId: "turn_1",
      deps: { resolve: resolve as never, surface: "armed-trigger" },
    });
    sendAs("turn_2");
    await handleLentAction(
      { ref: REF },
      { resolve: resolve as never, resolveActor: (async () => ACTOR) as never, decideSchedule: decideAgainstTheStore() as never },
    );
    // THE SAVE LANDED. A second bare ask, with nothing newly placed, has
    // nothing to save — and says so in those words rather than in the card's
    // authorization sentence.
    sendAs("turn_3");
    const decide = decideAgainstTheStore();
    const res = await handleLentAction(
      { ref: REF },
      { resolve: resolve as never, resolveActor: (async () => ACTOR) as never, decideSchedule: decide as never },
    );
    expect(decide).not.toHaveBeenCalled();
    expect((res.structuredContent as { message: string }).message).toBe(
      LENT_ACTION_NOTHING_PLACED_TO_SAVE,
    );
  });

  it("another person's placement never travels under this person's ask", async () => {
    const resolve = vi.fn(async () => armedResolution("2026-09-01T09:00") as never);
    const otherActor = {
      ...ACTOR,
      actor: { ...(ACTOR as unknown as { actor: object }).actor, userId: "usr_realstore_2" },
    } as unknown as ReviewActorContext;
    await recordBoundScreenFill({
      ref: REF,
      values: { scheduledAt: "2026-09-09T23:00" },
      actorCtx: otherActor,
      messageId: "their_turn",
      deps: { resolve: resolve as never, surface: "armed-trigger" },
    });
    sendAs("my_turn");
    const decide = decideAgainstTheStore();
    const res = await handleLentAction(
      { ref: REF },
      { resolve: resolve as never, resolveActor: (async () => ACTOR) as never, decideSchedule: decide as never },
    );
    expect(decide).not.toHaveBeenCalled();
    expect((res.structuredContent as { message: string }).message).toBe(
      LENT_ACTION_NOTHING_PLACED_TO_SAVE,
    );
    expect((await readRunTriggerByRunId(RUN))!.scheduledAt!.toISOString()).toBe(
      "2026-09-01T09:00:00.000Z",
    );
  });
});
