/**
 * THE WHOLE TYPED SCHEDULE ADJUST, ON A REAL POSTGRES (cinatra#2853, the second
 * fix leg) — plan (A) §2.2, "a typed change re-draws the bound card IN PLACE,
 * never a second card; the stale Confirm gone".
 *
 * THE DEFECT THIS TIER PINS. A person looking at a live 09:00 schedule card
 * types "make it 8 in the morning on weekdays". The send mints a single-use
 * grant against that card, and the assistant presses the card's own `adjust`
 * through it. Adjust cannot EDIT a proposal — a proposal ref IS the proposal, a
 * signed self-contained token with no row to change — so it RE-PROPOSES: a new
 * ref, and the old one still addressable. Nothing carried that new ref back to
 * the page, so the card in front of the person kept drawing 09:00 with its own
 * Confirm live while the 08:00 rows existed only behind a ref nobody held.
 *
 * WHY THIS TIER AND NOT THE UNIT ONE. Everything the defect is about is a
 * property of the real chain: that the send mints exactly ONE ledger row for the
 * message and that the press SPENDS it; that the adjust runs ONCE and mints a
 * proposal that inherits the original's consume identity; that the tool's answer
 * carries the replacement ref back through the SINK, as an announcement and not
 * as a second card; and that the superseded card's Confirm cannot arm anything
 * even if it is pressed. A stubbed store would agree with whatever the code said
 * about all four.
 *
 * The component tier next door (`packages/agents/src/__tests__/
 * schedule-card-typed-adjust-redraw.test.tsx`) proves the other half: that the
 * mounted card, told the replacement, re-draws IN PLACE on the adjusted rows
 * with one Confirm.
 *
 * DB-gated, like every other tier here: self-skips without a real
 * SUPABASE_DB_URL — except in its own lane, which refuses to skip, because a
 * suite whose only failure mode is "skipped" reports success by doing nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { randomUUID } from "node:crypto";

import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";

import { proposeTriggerSchedule } from "@cinatra-ai/agents/trigger-schedule-propose";
import { issueTurnLentActionGrant } from "@/lib/lifecycle/bound-card-binding";
import { resolveBoundTurnActor } from "@/lib/lifecycle/bound-turn-actor";
import {
  LENT_ACTION_NO_AUTHORITY,
  LENT_ACTION_PRIMITIVE,
  handleLentAction,
} from "@/lib/lifecycle/lent-action-mcp";
import {
  decideTriggerScheduleProposal,
  resolveTriggerScheduleProposalCard,
} from "@/lib/lifecycle/trigger-schedule-proposal-card";
import {
  LIFECYCLE_PRODUCER_SERVER_LABEL,
  recognizeLifecycleReplacementAnnouncement,
  recognizeLifecycleViewEnvelope,
} from "@/lib/assistant-runtime/lifecycle-view-envelope";
import { createAgUiSinkAdapter } from "@/lib/assistant-runtime/ag-ui-sink-adapter";
import {
  LIFECYCLE_CARD_REPLACEMENT_PART_KIND,
  isLifecycleCardReplacementDataPart,
  type AgUiEvent,
} from "@cinatra-ai/agent-ui-protocol";
import {
  agUiReduce,
  initialConversationState,
  renderableViewTypeOf,
} from "@cinatra-ai/chat/renderer/ag-ui-reducer";
import { createLifecycleCardSettleBus } from "@cinatra-ai/agents/lifecycle-card-runtime";
import { X2853_SCHEMA } from "./typed-schedule-adjust-redraw.setup";

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@");
const describeDb = HAS_DB ? describe : describe.skip;

const IN_DEDICATED_LANE = process.env.CINATRA_TYPED_SCHEDULE_ADJUST_REALDB === "1";

if (IN_DEDICATED_LANE && !HAS_DB) {
  throw new Error(
    "the typed-schedule-adjust tier needs a live Postgres: set SUPABASE_DB_URL to a scratch " +
      "connection string. Refusing to skip — a skipped proof of the defect proves nothing.",
  );
}

const TEST_SCHEMA = X2853_SCHEMA;
const q = (s: string) => s.replaceAll('"', '""');

const PERSON_ID = "usr-x2853";
const ORG_ID = "org-x2853";
const TEMPLATE_ID = "11111111-2853-4000-8000-000000000001";
const PACKAGE_NAME = "@cinatra-ai/x2853-agent";

/** THE PERSON'S OWN WORDS, verbatim from the capture that recorded the defect. */
const PERSON_SAID = "make it 8 in the morning on weekdays";

const WEEKDAYS = [1, 2, 3, 4, 5];
const TIMEZONE = "Europe/Berlin";

function recurringAt(hour: number) {
  return {
    kind: "recurring" as const,
    timezone: TIMEZONE,
    selection: {
      frequency: "weekly" as const,
      interval: 1,
      weekdays: [...WEEKDAYS],
      dayOfMonth: 1,
      monthlyMode: "date" as const,
      nthWeek: 1 as const,
      monthlyWeekday: 1,
      quarterAnchor: "start" as const,
      yearlyMonth: 1,
      hour,
      minute: 0,
    },
  };
}

let admin: Client;

/** The frame the transport puts a verified grant on — never a tool argument. */
async function pressWithGrant(
  grant: string,
  input: Record<string, unknown>,
): Promise<{ content: { type: "text"; text: string }[]; structuredContent: Record<string, unknown> }> {
  return mcpRequestContextStorage.run(
    { userId: PERSON_ID, orgId: ORG_ID, lentActionGrant: grant } as never,
    async () => handleLentAction(input),
  );
}

/** The send road's own grant mint — the claim, the actor, the binding, the row. */
async function sendBoundMessage(ref: string, messageId: string) {
  return issueTurnLentActionGrant({
    claim: { candidateRefs: [ref], focusedRef: ref },
    userId: PERSON_ID,
    orgId: ORG_ID,
    messageId,
    messageText: PERSON_SAID,
  });
}

async function grantRowsFor(messageId: string): Promise<number> {
  const rows = await admin.query(
    `SELECT count(*)::int AS n FROM "${q(TEST_SCHEMA)}"."lifecycle_lent_action_grants"
      WHERE user_id = $1 AND message_id = $2`,
    [PERSON_ID, messageId],
  );
  return rows.rows[0].n as number;
}

/** The ledger row as the spend leaves it: a wordless tombstone, never a delete. */
async function grantTombstoneFor(
  messageId: string,
): Promise<{ spent: boolean; keptWords: boolean } | null> {
  const rows = await admin.query(
    `SELECT spent_at, message_text FROM "${q(TEST_SCHEMA)}"."lifecycle_lent_action_grants"
      WHERE user_id = $1 AND message_id = $2`,
    [PERSON_ID, messageId],
  );
  if (rows.rows.length !== 1) return null;
  return {
    spent: rows.rows[0].spent_at !== null,
    keptWords: rows.rows[0].message_text !== null,
  };
}

async function runsForTemplate(): Promise<number> {
  const rows = await admin.query(
    `SELECT count(*)::int AS n FROM "${q(TEST_SCHEMA)}"."agent_runs" WHERE template_id = $1`,
    [TEMPLATE_ID],
  );
  return rows.rows[0].n as number;
}

/** Drive the SHIPPED sink over one tool call, and collect what it put on the wire. */
async function driveSink(result: string): Promise<{
  events: AgUiEvent[];
  durableDataParts: unknown[];
}> {
  const events: AgUiEvent[] = [];
  const toolCallId = `call-${randomUUID()}`;
  const sink = createAgUiSinkAdapter({
    runId: `run-${randomUUID()}`,
    threadId: `thr-${randomUUID()}`,
    publish: async (event: AgUiEvent) => {
      events.push(event);
    },
  });
  sink.start();
  sink.send("tool_call", {
    id: toolCallId,
    name: LENT_ACTION_PRIMITIVE,
    serverLabel: LIFECYCLE_PRODUCER_SERVER_LABEL,
  });
  sink.send("tool_result", {
    id: toolCallId,
    name: LENT_ACTION_PRIMITIVE,
    serverLabel: LIFECYCLE_PRODUCER_SERVER_LABEL,
    resultLabel: "decided",
    result,
  });
  sink.send("done", {});
  await sink.drain();
  const durable = sink.durableContent();
  return {
    events,
    durableDataParts: (durable as { dataParts?: unknown[] } | null)?.dataParts ?? [],
  };
}

describeDb("the typed schedule adjust, end to end on a real store", () => {
  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query(
      `INSERT INTO public."user" (id, username, name, email, "emailVerified")
       VALUES ($1, $2, $3, $4, false) ON CONFLICT (id) DO NOTHING`,
      [PERSON_ID, "x2853", "x2853", "x2853@example.test"],
    );
    await admin.query(
      `INSERT INTO public."organization" (id, slug, name, "createdAt")
       VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO NOTHING`,
      [ORG_ID, "x2853", "x2853"],
    );
    await admin.query(
      `INSERT INTO public."member" (id, "organizationId", "userId", "createdAt", role)
       VALUES ($1, $2, $3, now(), $4) ON CONFLICT (id) DO NOTHING`,
      ["mem-x2853", ORG_ID, PERSON_ID, "member"],
    );
    await admin.query(
      `INSERT INTO "${q(TEST_SCHEMA)}"."agent_templates"
         (id, name, package_name, source_nl, compiled_plan, input_schema, approval_policy, org_id, owner_level, owner_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (id) DO NOTHING`,
      [
        TEMPLATE_ID,
        "x2853 agent",
        PACKAGE_NAME,
        "sweep the cohort every weekday",
        JSON.stringify({ steps: [] }),
        JSON.stringify({ type: "object", properties: {} }),
        JSON.stringify({ mode: "manual" }),
        ORG_ID,
        "organization",
        ORG_ID,
        "active",
      ],
    );
  }, 120_000);

  afterAll(async () => {
    if (!admin) return;
    await admin.query(`DELETE FROM public."member" WHERE id = $1`, ["mem-x2853"]);
    await admin.query(`DELETE FROM public."user" WHERE id = $1`, [PERSON_ID]);
    await admin.query(`DELETE FROM public."organization" WHERE id = $1`, [ORG_ID]);
    await admin.end();
  }, 120_000);

  it("carries the REPLACEMENT ref back to the page — one grant, one spend, no second card", async () => {
    // 1. THE CARD THE PERSON IS LOOKING AT: a live proposal, Mon–Fri at 09:00.
    const proposed = await proposeTriggerSchedule({
      templateId: TEMPLATE_ID,
      userId: PERSON_ID,
      orgId: ORG_ID,
      schedule: recurringAt(9),
    });
    expect(proposed.ok, JSON.stringify(proposed)).toBe(true);
    if (!proposed.ok) return;
    const staleRef = proposed.token;

    const before = await resolveTriggerScheduleProposalCard({
      ref: staleRef,
      userId: PERSON_ID,
      orgId: ORG_ID,
    });
    expect(before.state.state).toBe("pending");
    expect(before.view?.phase).toBe("proposal");

    // 2. THE SEND. The person types their sentence with that card bound, and the
    //    server mints ONE single-use grant for the message — the real road, the
    //    real ledger row.
    const messageId = `msg-${randomUUID()}`;
    const bound = await sendBoundMessage(staleRef, messageId);
    expect(bound.grant, "the send minted no grant for the bound schedule card").toBeTruthy();
    expect(await grantRowsFor(messageId)).toBe(1);

    // 3. THE PRESS. The assistant presses the card's own `adjust` through that
    //    grant, and nothing else.
    const answer = await pressWithGrant(bound.grant as string, {
      ref: staleRef,
      control: "adjust",
      schedule: recurringAt(8),
    });
    expect(answer.structuredContent).toMatchObject({
      ok: true,
      outcome: { kind: "reproposed" },
    });
    const replacementRef = (
      answer.structuredContent.outcome as { ref: string }
    ).ref;
    expect(replacementRef).not.toBe(staleRef);

    // 4. THE ANSWER NAMES THE SUPERSEDING REF — the defect, closed. Read through
    //    the SHIPPED recognizer under the real (server, tool) tuple, so what is
    //    asserted is what the sink will actually see.
    const announced = recognizeLifecycleReplacementAnnouncement({
      serverLabel: LIFECYCLE_PRODUCER_SERVER_LABEL,
      toolName: LENT_ACTION_PRIMITIVE,
      result: answer.content[0].text,
    });
    expect(
      announced,
      "the adjust's answer carried no word about which ref replaced the card",
    ).not.toBeNull();
    expect(announced?.supersededRef).toBe(staleRef);
    expect(announced?.ref).toBe(replacementRef);
    expect(announced?.viewType).toBe("trigger_schedule_proposal");

    // 5. IT REACHES THE PAGE AS AN ANNOUNCEMENT, NOT AS A CARD. The real sink,
    //    driven over that tool result, puts exactly ONE data part on the wire and
    //    it draws nothing: no renderable view is minted, so no SECOND proposal
    //    card enters the transcript, and nothing is kept durable for it.
    const { events, durableDataParts } = await driveSink(answer.content[0].text);
    const dataParts = events.filter((e) => e.type === "DATA_PART");
    expect(dataParts).toHaveLength(1);
    const payload = (dataParts[0] as { data: unknown }).data;
    expect(isLifecycleCardReplacementDataPart(payload)).toBe(true);
    expect(payload).toMatchObject({
      kind: LIFECYCLE_CARD_REPLACEMENT_PART_KIND,
      supersededRef: staleRef,
      ref: replacementRef,
    });
    expect(
      recognizeLifecycleViewEnvelope({
        serverLabel: LIFECYCLE_PRODUCER_SERVER_LABEL,
        toolName: LENT_ACTION_PRIMITIVE,
        result: answer.content[0].text,
      }),
      "the adjust minted a card — the second card the plan forbids",
    ).toBeNull();
    expect(durableDataParts).toHaveLength(0);

    // 5b. THE RENDERER DROPS IT — proven on the sink's OWN bytes, not on a
    //     hand-written copy of them. "It draws nothing" is a claim about the
    //     REDUCER, so the reducer is what has to answer it: a payload the
    //     reducer classifies as a renderable view lands in `dataParts` and the
    //     interactive dispatch draws a card for it, which is exactly the second
    //     card this leg exists to remove. The classification rule is a non-empty
    //     string `viewType`, so the announcement must not carry one at all.
    expect(
      renderableViewTypeOf(payload),
      "the announcement is classified as a renderable view — the dispatch will draw a second card",
    ).toBeUndefined();
    const reduced = agUiReduce(initialConversationState(), dataParts[0] as AgUiEvent);
    expect(
      reduced.dataParts,
      "the announcement reached the turn's renderable data parts",
    ).toHaveLength(0);

    // 6. THE PAGE'S OWN CHANNEL. The announcement is the word the settle bus
    //    carries to the mounted card; the re-draw itself is the component tier.
    const bus = createLifecycleCardSettleBus();
    bus.announceReplacement(staleRef, replacementRef);
    expect(bus.replacementFor(staleRef)).toBe(replacementRef);

    // 7. THE ADJUSTED PROPOSAL IS THE ONE THE PERSON ASKED FOR, read back under
    //    their own access: Recurring, Mon–Fri, 08:00, their timezone, with a
    //    confirmable floor of its own.
    const after = await resolveTriggerScheduleProposalCard({
      ref: replacementRef,
      userId: PERSON_ID,
      orgId: ORG_ID,
    });
    expect(after.state.state).toBe("pending");
    expect(after.view?.phase).toBe("proposal");
    const rows = (after.view as { schedule?: unknown }).schedule as {
      kind: string;
      timezone: string;
      selection: { weekdays: number[]; hour: number; minute: number };
    };
    expect(rows.kind).toBe("recurring");
    expect(rows.timezone).toBe(TIMEZONE);
    expect(rows.selection.weekdays).toEqual(WEEKDAYS);
    expect(rows.selection.hour).toBe(8);
    expect(rows.selection.minute).toBe(0);
    expect((after.view as { canConfirm?: boolean }).canConfirm).toBe(true);

    // 8. ONE PRESS PER MESSAGE. The grant is spent; a replay of the same call
    //    presses nothing, so the adjust ran exactly ONCE.
    const replay = await pressWithGrant(bound.grant as string, {
      ref: staleRef,
      control: "adjust",
      schedule: recurringAt(7),
    });
    expect(replay.structuredContent).toMatchObject({
      message: LENT_ACTION_NO_AUTHORITY,
    });
    // The row STAYS, as a wordless tombstone — the spend hands back the person's
    // own words and leaves nothing to hand back twice. Still exactly one row for
    // the message, and it is spent.
    expect(await grantRowsFor(messageId)).toBe(1);
    expect(await grantTombstoneFor(messageId)).toEqual({ spent: true, keptWords: false });

    // 9. THE STALE CARD'S CONFIRM IS GONE, and it is gone in the strongest sense
    //    the store can state it: the replacement inherits the superseded
    //    proposal's consume identity, so the family is ONE row in the consume
    //    table. The person confirms the card in front of them; a press on the
    //    superseded ref afterwards — a stale tab, a replayed turn — arms nothing
    //    new and cannot produce a second run on the schedule they corrected away
    //    from.
    expect(await runsForTemplate()).toBe(0);
    // The person's OWN standing, resolved live from the store — the same actor
    // the press above resolved at gate 4, so the Confirm below runs under
    // exactly the credential the card's own button runs under.
    const actorCtx = await resolveBoundTurnActor({ userId: PERSON_ID, orgId: ORG_ID });
    expect(actorCtx, "the person has no live standing in their own org").not.toBeNull();
    const access = actorCtx
      ? { actor: actorCtx.actor, roles: actorCtx.roleHints }
      : undefined;
    const confirmed = await decideTriggerScheduleProposal({
      ref: replacementRef,
      op: "confirm",
      userId: PERSON_ID,
      orgId: ORG_ID,
      role: null,
      access,
    });
    expect(confirmed.kind, JSON.stringify(confirmed)).toBe("confirmed");
    expect(await runsForTemplate()).toBe(1);

    const stalePress = await decideTriggerScheduleProposal({
      ref: staleRef,
      op: "confirm",
      userId: PERSON_ID,
      orgId: ORG_ID,
      role: null,
      access,
    });
    // Whatever it answers — a refusal, or a confirm that lands on the run that
    // already exists — it may not arm a SECOND schedule. That is the property
    // the shared consume identity buys, and it is what makes the superseded
    // card's Confirm harmless even where a stale copy of it is still on screen.
    if (stalePress.kind === "confirmed") {
      expect(stalePress.runId).toBe((confirmed as { runId: string }).runId);
    }
    expect(await runsForTemplate(), "the superseded card armed a second run").toBe(1);

    const triggers = await admin.query(
      `SELECT count(*)::int AS n FROM "${q(TEST_SCHEMA)}"."agent_run_triggers" WHERE run_id = $1`,
      [(confirmed as { runId: string }).runId],
    );
    expect(triggers.rows[0].n).toBe(1);
  }, 300_000);

  it("a REFUSED adjust announces nothing — nothing was replaced", async () => {
    // The grant road's other direction. A message bound to the card, a control
    // the card does not lend on this input: no re-proposal, so no announcement
    // and nothing for a mounted card to follow.
    const proposed = await proposeTriggerSchedule({
      templateId: TEMPLATE_ID,
      userId: PERSON_ID,
      orgId: ORG_ID,
      schedule: recurringAt(9),
    });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;

    const messageId = `msg-${randomUUID()}`;
    const bound = await sendBoundMessage(proposed.token, messageId);
    expect(bound.grant).toBeTruthy();

    // An adjust with no rows to place has nothing to re-propose.
    const answer = await pressWithGrant(bound.grant as string, {
      ref: proposed.token,
      control: "adjust",
    });
    expect(
      recognizeLifecycleReplacementAnnouncement({
        serverLabel: LIFECYCLE_PRODUCER_SERVER_LABEL,
        toolName: LENT_ACTION_PRIMITIVE,
        result: answer.content[0].text,
      }),
    ).toBeNull();
    const { events } = await driveSink(answer.content[0].text);
    expect(events.filter((e) => e.type === "DATA_PART")).toHaveLength(0);
  }, 300_000);

  it("only the FIRST-PARTY decide tool can say a card was replaced", async () => {
    // The announcement is producer-bound for the reason the view envelope is:
    // a tool result is model-visible and model-influenced, so an external MCP
    // server echoing these exact bytes must move nothing on the page.
    const proposed = await proposeTriggerSchedule({
      templateId: TEMPLATE_ID,
      userId: PERSON_ID,
      orgId: ORG_ID,
      schedule: recurringAt(9),
    });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    const messageId = `msg-${randomUUID()}`;
    const bound = await sendBoundMessage(proposed.token, messageId);
    const answer = await pressWithGrant(bound.grant as string, {
      ref: proposed.token,
      control: "adjust",
      schedule: recurringAt(8),
    });
    const text = answer.content[0].text;
    // The same bytes, from somebody else's server.
    expect(
      recognizeLifecycleReplacementAnnouncement({
        serverLabel: "some-connector",
        toolName: LENT_ACTION_PRIMITIVE,
        result: text,
      }),
    ).toBeNull();
    // The same bytes, from a first-party tool that presses nothing.
    expect(
      recognizeLifecycleReplacementAnnouncement({
        serverLabel: LIFECYCLE_PRODUCER_SERVER_LABEL,
        toolName: "schedule_proposal_render",
        result: text,
      }),
    ).toBeNull();
    // And the real tuple still reads it.
    expect(
      recognizeLifecycleReplacementAnnouncement({
        serverLabel: LIFECYCLE_PRODUCER_SERVER_LABEL,
        toolName: LENT_ACTION_PRIMITIVE,
        result: text,
      }),
    ).not.toBeNull();
  }, 300_000);
});
