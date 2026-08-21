/**
 * cinatra#2837 — THE LINEAGE-LATEST RATCHET, against real Postgres.
 *
 * The seam suites model the conditional upsert with a `Map` and drive the
 * service's response to each of its three outcomes. What a `Map` cannot have is
 * the thing the whole bound rests on: ONE STATEMENT in which the check and the
 * write are the same act, under a real primary key, with two connections racing
 * into it. That is what this file is for.
 *
 *   CLAIM              — a free slot is taken, and the row names the token.
 *   REFUSE WHILE LIVE  — a slot holding an un-expired replacement is never
 *                        overwritten by a stranger; the loser reads the winner.
 *   ROLL               — the slot MAY be overwritten by the caller exchanging
 *                        the very token it names. This is the drawn form's
 *                        Adjust, and it is why the reader editing rows on a
 *                        live card does not have to wait for a TTL.
 *   ROLL AFTER EXPIRY  — once the replacement has genuinely expired, anybody
 *                        may claim it, and the window rolls by ONE TTL.
 *   CONCURRENCY        — two adjusts racing on one lineage leave exactly ONE
 *                        live token in the slot, and the loser is refused
 *                        rather than handed an uncounted mint.
 *
 * The last one is driven through the REAL service (`adjustLiveScheduleProposal`)
 * with real tokens and the real store, because "the loser gets the documented
 * refusal" is a claim about the service's answer and not about the row.
 * `../trigger-schedule` is mocked to keep BullMQ out of a database test; the
 * adjust path never reaches it.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   CINATRA_TEST_DB_URL=postgres://…  pnpm --filter @cinatra-ai/agents test:integration
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

// BullMQ has no place in a database test, and the adjust path never reaches
// the scheduler: it mints a token and writes one ratchet row.
vi.mock("../trigger-schedule", () => ({ scheduleTrigger: vi.fn() }));

const TEST_SCHEMA = "cinatra_test_schedule_lineage_2837";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB =
  DB_URL !== "" && !DB_URL.includes("unused:unused@localhost:5432/unused");
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-2837-lineage";
const USER = "user-2837-reader";

let proposalStore: typeof import("../trigger-schedule-proposal-store");
let service: typeof import("../trigger-schedule-proposal-service");
let tokens: typeof import("@/lib/trigger-schedule-proposal-token");
let dbMod: typeof import("../db");
let client: Client;

const WEEKDAYS_9AM = {
  kind: "recurring" as const,
  timezone: "Europe/Berlin",
  selection: {
    frequency: "weekly",
    interval: 1,
    weekdays: [1, 2, 3, 4, 5],
    dayOfMonth: 1,
    monthlyMode: "date",
    nthWeek: 1,
    monthlyWeekday: 0,
    quarterAnchor: "start",
    yearlyMonth: 1,
    hour: 9,
    minute: 0,
  },
};
const WEEKDAYS_8AM = {
  ...WEEKDAYS_9AM,
  selection: { ...WEEKDAYS_9AM.selection, hour: 8 },
};

/** A template the reader is genuinely inside the org scope of. */
async function seedTemplate(): Promise<string> {
  const templateId = randomUUID();
  await client.query(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_templates"
       (id, org_id, owner_level, owner_id, name, package_name, package_version, description, source_nl, compiled_plan, input_schema, approval_policy, status, type, hitl_required, execution_provider, created_at, updated_at)
     VALUES ($1, $2, 'organization', $2, $3, $4, '1.0.0', '', '', '[]'::jsonb, '{}'::jsonb, '"none"', 'ready', 'leaf', false, 'default', now(), now())`,
    [templateId, ORG, `tpl-${templateId.slice(0, 8)}`, `@cinatra-ai/tpl-${templateId.slice(0, 8)}`],
  );
  return templateId;
}

/** The consume identity a token addresses — the ratchet's key. */
function consumeKeyOf(token: string): string {
  const reading = tokens.readTriggerScheduleProposalToken({
    token,
    expectedUserId: USER,
    expectedOrgId: ORG,
  });
  if (!reading) throw new Error("expected a readable token");
  return tokens.proposalConsumeKey(reading.proposal.nonce);
}

/** The row the ratchet is holding, read straight out of Postgres. */
async function slotRow(
  consumeKey: string,
): Promise<{ latest_token: string; expires_at: Date } | null> {
  const rows = await client.query(
    `SELECT latest_token, expires_at FROM "${q(TEST_SCHEMA)}"."trigger_schedule_proposal_lineage" WHERE consume_key = $1`,
    [consumeKey],
  );
  return rows.rows[0] ?? null;
}

async function slotCount(consumeKey: string): Promise<number> {
  const rows = await client.query(
    `SELECT count(*)::int AS n FROM "${q(TEST_SCHEMA)}"."trigger_schedule_proposal_lineage" WHERE consume_key = $1`,
    [consumeKey],
  );
  return rows.rows[0].n as number;
}

function claimInput(over: {
  consumeKey: string;
  token: string;
  expiresAt: Date;
  templateId: string;
  supersedes?: string;
}) {
  return { orgId: ORG, reproposedBy: USER, ...over };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
  process.env.BETTER_AUTH_SECRET ??= "test-secret-for-2837-lineage-integration";

  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
  await admin.query(`CREATE SCHEMA "${q(TEST_SCHEMA)}"`);
  const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
  for (const qy of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
    const head = qy.text.trim().slice(0, 6).toUpperCase();
    if (head !== "CREATE" && head !== "ALTER " && head !== "DROP T" && head !== "DROP S") continue;
    if (qy.text.includes("user_slug_move_trg")) continue;
    try {
      await admin.query(qy.text, (qy as { values?: unknown[] }).values as never[]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("does not exist") && !msg.includes("already exists")) throw err;
    }
  }
  await admin.end();
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized =
    true;

  proposalStore = await import("../trigger-schedule-proposal-store");
  service = await import("../trigger-schedule-proposal-service");
  tokens = await import("@/lib/trigger-schedule-proposal-token");
  dbMod = await import("../db");
  client = new Client({ connectionString: DB_URL });
  await client.connect();
}, 90_000);

afterAll(async () => {
  if (!HAS_DB) return;
  await client?.end().catch(() => {});
  await dbMod?.agentBuilderPool?.end().catch(() => {});
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean })
    .__cinatraPostgresSchemaInitialized;
});

describe.skipIf(!HAS_DB)("the lineage slot — the conditional upsert itself", () => {
  it("CLAIM: a free slot is taken, and one row names the token", async () => {
    const templateId = await seedTemplate();
    const consumeKey = `ck-${randomUUID()}`;
    const claimed = await proposalStore.claimLineageReproposal(
      claimInput({
        consumeKey,
        token: "replacement-a",
        expiresAt: new Date(Date.now() + 60_000),
        templateId,
      }),
    );
    expect(claimed.outcome).toBe("claimed");
    expect(await slotCount(consumeKey)).toBe(1);
    expect((await slotRow(consumeKey))?.latest_token).toBe("replacement-a");
  });

  it("REFUSE WHILE LIVE: a stranger never overwrites an un-expired slot", async () => {
    const templateId = await seedTemplate();
    const consumeKey = `ck-${randomUUID()}`;
    await proposalStore.claimLineageReproposal(
      claimInput({
        consumeKey,
        token: "replacement-a",
        expiresAt: new Date(Date.now() + 60_000),
        templateId,
      }),
    );
    const second = await proposalStore.claimLineageReproposal(
      claimInput({
        consumeKey,
        token: "replacement-b",
        expiresAt: new Date(Date.now() + 60_000),
        templateId,
      }),
    );
    expect(second.outcome).toBe("yielded");
    // The row is untouched, and it still names the FIRST token.
    expect((await slotRow(consumeKey))?.latest_token).toBe("replacement-a");
    if (second.outcome === "yielded") {
      expect(second.record.token).toBe("replacement-a");
    }
  });

  it("ROLL: the caller exchanging the slot's OWN token overwrites it", async () => {
    // The drawn form's Adjust. The reader holds the token the slot names and is
    // replacing it, so the ratchet keeps counting one live token rather than
    // making an ordinary edit wait out a TTL.
    const templateId = await seedTemplate();
    const consumeKey = `ck-${randomUUID()}`;
    await proposalStore.claimLineageReproposal(
      claimInput({
        consumeKey,
        token: "replacement-a",
        expiresAt: new Date(Date.now() + 60_000),
        templateId,
      }),
    );
    const rolled = await proposalStore.claimLineageReproposal(
      claimInput({
        consumeKey,
        token: "replacement-b",
        expiresAt: new Date(Date.now() + 90_000),
        templateId,
        supersedes: "replacement-a",
      }),
    );
    expect(rolled.outcome).toBe("claimed");
    expect(await slotCount(consumeKey)).toBe(1);
    expect((await slotRow(consumeKey))?.latest_token).toBe("replacement-b");
  });

  it("ROLL IS EXACT: naming a token the slot does NOT hold still yields", async () => {
    // The widening must be one disjunct and no more. A stale ref cannot roll a
    // slot that has already moved on, or the bound would be gone.
    const templateId = await seedTemplate();
    const consumeKey = `ck-${randomUUID()}`;
    await proposalStore.claimLineageReproposal(
      claimInput({
        consumeKey,
        token: "replacement-current",
        expiresAt: new Date(Date.now() + 60_000),
        templateId,
      }),
    );
    const stale = await proposalStore.claimLineageReproposal(
      claimInput({
        consumeKey,
        token: "replacement-from-a-stale-tab",
        expiresAt: new Date(Date.now() + 60_000),
        templateId,
        supersedes: "a-token-this-slot-never-held",
      }),
    );
    expect(stale.outcome).toBe("yielded");
    expect((await slotRow(consumeKey))?.latest_token).toBe("replacement-current");
  });

  it("ROLL AFTER EXPIRY: an expired slot is claimable by anybody", async () => {
    const templateId = await seedTemplate();
    const consumeKey = `ck-${randomUUID()}`;
    await proposalStore.claimLineageReproposal(
      claimInput({
        consumeKey,
        token: "replacement-a",
        // Already closed — `now()` in the statement decides, not the caller.
        expiresAt: new Date(Date.now() - 1_000),
        templateId,
      }),
    );
    const renewed = await proposalStore.claimLineageReproposal(
      claimInput({
        consumeKey,
        token: "replacement-b",
        expiresAt: new Date(Date.now() + 60_000),
        templateId,
      }),
    );
    expect(renewed.outcome).toBe("claimed");
    expect(await slotCount(consumeKey)).toBe(1);
    expect((await slotRow(consumeKey))?.latest_token).toBe("replacement-b");
  });

  it("CONCURRENCY: ten claims racing into one free slot leave ONE winner", async () => {
    const templateId = await seedTemplate();
    const consumeKey = `ck-${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        proposalStore.claimLineageReproposal(
          claimInput({
            consumeKey,
            token: `replacement-${i}`,
            expiresAt: new Date(Date.now() + 60_000),
            templateId,
          }),
        ),
      ),
    );
    const claimed = results.filter((r) => r.outcome === "claimed");
    expect(claimed).toHaveLength(1);
    // Every loser was told what the lineage is actually holding, and it is the
    // one row that exists.
    expect(await slotCount(consumeKey)).toBe(1);
    const row = await slotRow(consumeKey);
    for (const loser of results.filter((r) => r.outcome !== "claimed")) {
      if (loser.outcome === "yielded") {
        expect(loser.record.token).toBe(row?.latest_token);
      }
    }
    expect(row?.latest_token).toBe(
      claimed[0]!.outcome === "claimed" ? claimed[0]!.record.token : null,
    );
  });
});

describe.skipIf(!HAS_DB)("ADJUST on a LIVE card goes through that slot", () => {
  async function mintLive(templateId: string, schedule = WEEKDAYS_9AM) {
    const minted = tokens.mintTriggerScheduleProposalToken({
      templateId,
      userId: USER,
      orgId: ORG,
      schedule: schedule as never,
    });
    expect(minted).not.toBeNull();
    return minted!;
  }

  const READER = { userId: USER, orgId: ORG };

  it("claims the slot for the replacement it mints", async () => {
    const templateId = await seedTemplate();
    const original = await mintLive(templateId);
    const adjusted = await service.adjustLiveScheduleProposal(READER, {
      ref: original.token,
      schedule: WEEKDAYS_8AM as never,
    });
    if (!adjusted.ok) throw new Error(`expected a fresh proposal: ${adjusted.error}`);
    const consumeKey = consumeKeyOf(original.token);
    // Same lineage, and the row in Postgres names what the reader is holding.
    expect(consumeKeyOf(adjusted.token)).toBe(consumeKey);
    expect(await slotCount(consumeKey)).toBe(1);
    expect((await slotRow(consumeKey))?.latest_token).toBe(adjusted.token);
  });

  it("rolls the slot when the reader adjusts the card the slot names", async () => {
    const templateId = await seedTemplate();
    const original = await mintLive(templateId);
    const first = await service.adjustLiveScheduleProposal(READER, {
      ref: original.token,
      schedule: WEEKDAYS_8AM as never,
    });
    if (!first.ok) throw new Error("expected a fresh proposal");
    const second = await service.adjustLiveScheduleProposal(READER, {
      ref: first.token,
      schedule: WEEKDAYS_9AM as never,
    });
    if (!second.ok) throw new Error("expected the slot to roll");
    const consumeKey = consumeKeyOf(original.token);
    expect(await slotCount(consumeKey)).toBe(1);
    expect((await slotRow(consumeKey))?.latest_token).toBe(second.token);
  });

  it("refuses a stale card whose slot a live successor holds", async () => {
    const templateId = await seedTemplate();
    const original = await mintLive(templateId);
    const current = await service.adjustLiveScheduleProposal(READER, {
      ref: original.token,
      schedule: WEEKDAYS_8AM as never,
    });
    if (!current.ok) throw new Error("expected a fresh proposal");

    const stale = await service.adjustLiveScheduleProposal(READER, {
      ref: original.token,
      schedule: WEEKDAYS_9AM as never,
    });
    expect(stale.ok).toBe(false);
    expect((stale as { error: string }).error).toBe(
      service.PROPOSAL_REFUSALS.superseded,
    );
    const consumeKey = consumeKeyOf(original.token);
    expect((await slotRow(consumeKey))?.latest_token).toBe(current.token);
  });

  it("CONCURRENT DOUBLE-ADJUST: exactly one live token, and the loser is refused", async () => {
    // THE CASE THIS FILE EXISTS FOR. Two presses on the same live card, racing
    // into the same lineage. Before the mint went through the slot, both would
    // have succeeded and the ratchet would have counted neither.
    const templateId = await seedTemplate();
    const original = await mintLive(templateId);
    const [a, b] = await Promise.all([
      service.adjustLiveScheduleProposal(READER, {
        ref: original.token,
        schedule: WEEKDAYS_8AM as never,
      }),
      service.adjustLiveScheduleProposal(READER, {
        ref: original.token,
        schedule: WEEKDAYS_9AM as never,
      }),
    ]);
    const winners = [a, b].filter((r) => r.ok);
    const losers = [a, b].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    // THE DOCUMENTED REFUSAL — not the winner's token, which answers rows this
    // reader did not ask for.
    expect((losers[0] as { error: string }).error).toBe(
      service.PROPOSAL_REFUSALS.superseded,
    );
    expect(losers[0]).not.toHaveProperty("token");

    const consumeKey = consumeKeyOf(original.token);
    expect(await slotCount(consumeKey)).toBe(1);
    const winner = winners[0] as { token: string };
    expect((await slotRow(consumeKey))?.latest_token).toBe(winner.token);
    // The winner's token is live, is this reader's, and is in the same lineage.
    const held = tokens.readTriggerScheduleProposalToken({
      token: winner.token,
      expectedUserId: USER,
      expectedOrgId: ORG,
    });
    expect(held?.status).toBe("live");
    expect(consumeKeyOf(winner.token)).toBe(consumeKey);
  });

  it("the two forms COMPOSE: the expired path is never handed the superseded token", async () => {
    // The bug the roll closes, end to end and against the real row. A live
    // Adjust moves the slot; later, an EXPIRED member of the same lineage
    // presses Adjust from the transcript. Before the roll, the slot still named
    // the card the reader had corrected away from and that is what came back.
    const templateId = await seedTemplate();
    const original = await mintLive(templateId);
    const consumeKey = consumeKeyOf(original.token);
    const adjusted = await service.adjustLiveScheduleProposal(READER, {
      ref: original.token,
      schedule: WEEKDAYS_8AM as never,
    });
    if (!adjusted.ok) throw new Error("expected a fresh proposal");
    expect((await slotRow(consumeKey))?.latest_token).toBe(adjusted.token);

    // An expired card in the SAME lineage — the reading the transcript keeps.
    // It shares the nonce, so it shares the consume key and the slot.
    const nonce = tokens.readTriggerScheduleProposalToken({
      token: original.token,
      expectedUserId: USER,
      expectedOrgId: ORG,
    })!.proposal.nonce;
    const expired = tokens.mintTriggerScheduleProposalToken(
      { templateId, userId: USER, orgId: ORG, schedule: WEEKDAYS_9AM as never },
      {
        nonce,
        nowSeconds: Math.floor(Date.now() / 1000) - tokens.PROPOSAL_TTL_SECONDS - 60,
      },
    );
    expect(expired).not.toBeNull();
    expect(consumeKeyOf(expired!.token)).toBe(consumeKey);

    // THE ASSERTION THIS TEST EXISTS FOR. The expired card's Adjust is handed
    // exactly what the lineage is holding — the replacement the live Adjust
    // rolled the slot onto — and never the card the reader corrected away
    // from. Before the roll, the slot still named the original mint and THAT
    // is what came back.
    const held = await service.reproposeExpiredScheduleProposal(READER, expired!.token);
    if (!held.ok) throw new Error(`expected the live replacement back: ${held.error}`);
    expect(held.token).toBe(adjusted.token);
    expect(held.token).not.toBe(original.token);
    expect(held.token).not.toBe(expired!.token);
    // Still ONE slot, still naming one token, and nothing new was minted: the
    // press was idempotent while the replacement lives.
    expect(await slotCount(consumeKey)).toBe(1);
    expect((await slotRow(consumeKey))?.latest_token).toBe(adjusted.token);
  });
});
