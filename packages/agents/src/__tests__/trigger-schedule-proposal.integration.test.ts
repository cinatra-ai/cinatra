/**
 * cinatra#2569 (epic #2564 S5) — the schedule proposal's DURABLE half, against
 * real Postgres.
 *
 * Everything proven here is a property of the DATABASE, which is precisely why
 * it cannot be proven at the seam tier:
 *
 *   ONE TRANSACTION — Confirm commits the consume edge, the run, and the
 *     schedule-install intent TOGETHER. All three or none: a mid-transaction
 *     failure leaves no run behind.
 *   SINGLE USE     — a second Confirm carrying the same proposal loses the
 *     consume insert and ROLLS BACK the run it was creating. There is exactly
 *     one run, and the loser answers with it.
 *   CONCURRENCY    — two Confirms racing on the same proposal produce one run,
 *     and the row count proves it (the winner is whichever commits; both
 *     callers agree on which).
 *   ARM BEFORE EXPOSE — the drain stamps `armed_at` BEFORE the schedule is
 *     installed, and a `done` intent with no `armed_at` never exists. That
 *     ordering is what stops a schedule falling due mid-drain from firing on a
 *     not-armed run, where the `armed → queued` CAS logs and skips and the
 *     one-shot fire is lost forever.
 *   RECONCILIATION — a crash between the transaction and the install leaves a
 *     claimable intent; the next pass finishes it, and every step is
 *     re-runnable.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   CINATRA_DB_INTEGRATION_TESTS=1 \
 *   SUPABASE_DB_URL=postgres://postgres:postgres@127.0.0.1:5634/postgres \
 *     pnpm --filter @cinatra-ai/agents test trigger-schedule-proposal
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

const TEST_SCHEMA = "cinatra_test_schedule_proposal_2569";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB =
  DB_URL !== "" && !DB_URL.includes("unused:unused@localhost:5432/unused");
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-2569-schedule-proposal";
const USER = "user-2569-confirmer";

let proposalStore: typeof import("../trigger-schedule-proposal-store");
let store: typeof import("../store");
let dbMod: typeof import("../db");
let client: Client;
let authority: unknown;

/**
 * A fresh template the confirming human is genuinely inside the scope of.
 *
 * `owner_level`/`owner_id` are not decoration here: the #2485 C run-scope guard
 * (`assertAgentRunScopeAuthorized`) fail-closes on a template whose scope it
 * cannot read, so an ORGANIZATION-anchored template owned by this suite's org
 * is what makes the confirming member an in-scope dispatcher.
 */
async function seedTemplate(): Promise<string> {
  const templateId = randomUUID();
  await client.query(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_templates"
       (id, org_id, owner_level, owner_id, name, package_name, package_version, description, source_nl, compiled_plan, input_schema, approval_policy, status, type, hitl_required, execution_provider, created_at, updated_at)
     VALUES ($1, $2, 'organization', $2, $3, $4, '1.0.0', '', '', '[]'::jsonb, '{}'::jsonb, 'none', 'ready', 'leaf', false, 'default', now(), now())`,
    [templateId, ORG, `tpl-${templateId.slice(0, 8)}`, `@cinatra-ai/tpl-${templateId.slice(0, 8)}`],
  );
  return templateId;
}

const IMMEDIATE_INSTALL = {
  triggerType: "recurring" as const,
  scheduledAt: null,
  cronExpression: "0 9 * * 1,2,3,4,5",
  timezone: "Europe/Berlin",
};

/**
 * The REAL Confirm transaction shape: create the run with the consume edge and
 * the install intent written inside `withinCreateTx`.
 *
 * Deliberately calls the same `createAgentRunPendingInput` + `spendProposalWithinTx`
 * pair the service does, rather than the service itself — the service also
 * verifies a token, resolves a template's runnability and drives an inline
 * drain, none of which is what this suite is proving. What IS the service's is
 * the ORDER (consume first) and the atomicity, and both live here.
 */
async function confirmOnce(input: {
  consumeKey: string;
  templateId: string;
  install?: typeof IMMEDIATE_INSTALL;
}): Promise<{ ok: true; runId: string } | { ok: false; conflict: boolean }> {
  try {
    const created = await store.createAgentRunPendingInput(
      {
        templateId: input.templateId,
        runBy: USER,
        inputParams: {},
        orgId: ORG,
        humanPresent: true,
        withinCreateTx: async (tx, run) =>
          proposalStore.spendProposalWithinTx(tx, {
            consumeKey: input.consumeKey,
            runId: run.id,
            orgId: run.orgId,
            templateId: input.templateId,
            consumedBy: USER,
            install: input.install ?? IMMEDIATE_INSTALL,
          }),
      },
      authority as never,
    );
    return { ok: true, runId: created.id };
  } catch (err) {
    return {
      ok: false,
      conflict: err instanceof proposalStore.ProposalAlreadyConsumedError,
    };
  }
}

async function countRuns(templateId: string): Promise<number> {
  const rows = await client.query(
    `SELECT count(*)::int AS n FROM "${q(TEST_SCHEMA)}"."agent_runs" WHERE template_id = $1`,
    [templateId],
  );
  return rows.rows[0].n as number;
}

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
  store = await import("../store");
  dbMod = await import("../db");
  client = new Client({ connectionString: DB_URL });
  await client.connect();
  // The guarded create reads the org's lifecycle from public."organization",
  // and the #2485 C run-scope gate resolves the run owner's LIVE membership.
  await client.query(
    `INSERT INTO public."organization" (id, name, slug, "createdAt") VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO NOTHING`,
    [ORG, ORG, ORG],
  );
  await client.query(
    `INSERT INTO public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, $1, $2, false, now(), now()) ON CONFLICT (id) DO NOTHING`,
    [USER, `${USER}@2569.test`],
  );
  // Better Auth's OWN role vocabulary ('owner' | 'admin' | 'member'), not the
  // kernel's — `resolveOrgRoleForUser` maps it, and an out-of-vocabulary value
  // resolves to "not a member" and fail-closes the guarded write.
  await client.query(
    `INSERT INTO public."member" (id, "organizationId", "userId", role, "createdAt")
     VALUES ($1, $2, $3, 'owner', now()) ON CONFLICT (id) DO NOTHING`,
    [`m-2569-${USER}`, ORG, USER],
  );

  const { verifySessionAuthority } = await import("@/lib/org-write/authority");
  authority = await verifySessionAuthority(USER, ORG);
}, 90_000);

afterAll(async () => {
  if (!HAS_DB) return;
  let cleanupError: unknown;
  try {
    await client?.query(`DELETE FROM public."member" WHERE "userId" = $1`, [USER]);
    await client?.query(`DELETE FROM public."user" WHERE id = $1`, [USER]);
    await client?.query(`DELETE FROM public."organization" WHERE id = $1`, [ORG]);
  } catch (err) {
    cleanupError = err;
  }
  await client?.end().catch(() => {});
  await dbMod?.agentBuilderPool?.end().catch(() => {});
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean })
    .__cinatraPostgresSchemaInitialized;
  if (cleanupError) throw cleanupError;
});

describe.skipIf(!HAS_DB)("cinatra#2569 — schedule proposal confirm (real store)", () => {
  it("ONE TRANSACTION: Confirm commits the consume edge, the run and the install intent together", async () => {
    const templateId = await seedTemplate();
    const consumeKey = `ck-${randomUUID()}`;

    const result = await confirmOnce({ consumeKey, templateId });
    expect(result.ok).toBe(true);
    const runId = (result as { runId: string }).runId;

    // The run is PRE-DISPATCH: created, not queued, not running.
    const run = await store.readAgentRunById(runId);
    expect(run?.status).toBe("pending_input");

    const consume = await proposalStore.readProposalConsume(consumeKey);
    expect(consume).not.toBeNull();
    expect(consume!.runId).toBe(runId);
    expect(consume!.templateId).toBe(templateId);
    expect(consume!.consumedBy).toBe(USER);

    const intent = await proposalStore.readInstallIntent(runId);
    expect(intent).not.toBeNull();
    expect(intent!.status).toBe("pending");
    expect(intent!.triggerType).toBe("recurring");
    expect(intent!.cronExpression).toBe("0 9 * * 1,2,3,4,5");
    expect(intent!.timezone).toBe("Europe/Berlin");
    // Not yet armed — the drain has not run.
    expect(intent!.armedAt).toBeNull();
  });

  it("ATOMICITY: a companion write that throws rolls the RUN back — no orphan run survives", async () => {
    const templateId = await seedTemplate();
    const before = await countRuns(templateId);

    await expect(
      store.createAgentRunPendingInput(
        {
          templateId,
          runBy: USER,
          inputParams: {},
          orgId: ORG,
          humanPresent: true,
          withinCreateTx: async () => {
            throw new Error("companion write failed");
          },
        },
        authority as never,
      ),
    ).rejects.toThrow("companion write failed");

    expect(await countRuns(templateId)).toBe(before);
  });

  it("SINGLE USE: a second Confirm on the same proposal creates NO second run and answers with the original", async () => {
    const templateId = await seedTemplate();
    const consumeKey = `ck-${randomUUID()}`;

    const first = await confirmOnce({ consumeKey, templateId });
    expect(first.ok).toBe(true);
    const originalRunId = (first as { runId: string }).runId;
    expect(await countRuns(templateId)).toBe(1);

    const second = await confirmOnce({ consumeKey, templateId });
    expect(second.ok).toBe(false);
    expect((second as { conflict: boolean }).conflict).toBe(true);

    // The losing transaction took its run down with it.
    expect(await countRuns(templateId)).toBe(1);

    // …and the loser can name the winner.
    const consume = await proposalStore.readProposalConsume(consumeKey);
    expect(consume!.runId).toBe(originalRunId);
  });

  it("REPLAY: confirming an OLD proposal after a newer one was confirmed still yields only its own single run", async () => {
    // Adjust re-proposes rather than mutating, so a superseded token is still a
    // VALID proposal with its OWN consume identity. Confirming it late must
    // create exactly the one run it describes — never a second run for the
    // adjusted proposal, and never nothing at all.
    const templateId = await seedTemplate();
    const oldKey = `ck-${randomUUID()}`;
    const newKey = `ck-${randomUUID()}`;

    const adjusted = await confirmOnce({ consumeKey: newKey, templateId });
    expect(adjusted.ok).toBe(true);
    const stale = await confirmOnce({ consumeKey: oldKey, templateId });
    expect(stale.ok).toBe(true);

    expect(await countRuns(templateId)).toBe(2);
    expect((await proposalStore.readProposalConsume(oldKey))!.runId).not.toBe(
      (await proposalStore.readProposalConsume(newKey))!.runId,
    );

    // Re-confirming EITHER is still a no-op.
    expect((await confirmOnce({ consumeKey: oldKey, templateId })).ok).toBe(false);
    expect((await confirmOnce({ consumeKey: newKey, templateId })).ok).toBe(false);
    expect(await countRuns(templateId)).toBe(2);
  });

  it("CONCURRENCY: two Confirms racing on one proposal produce exactly one run", async () => {
    const templateId = await seedTemplate();
    const consumeKey = `ck-${randomUUID()}`;

    const [a, b] = await Promise.all([
      confirmOnce({ consumeKey, templateId }),
      confirmOnce({ consumeKey, templateId }),
    ]);

    // Exactly one winner. (Either may win; both must agree on which.)
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(await countRuns(templateId)).toBe(1);

    const consume = await proposalStore.readProposalConsume(consumeKey);
    const winner = a.ok ? (a as { runId: string }).runId : (b as { runId: string }).runId;
    expect(consume!.runId).toBe(winner);
  });

  it("DRAIN CLAIM: an intent is claimed exactly once while its lease is live", async () => {
    const templateId = await seedTemplate();
    const consumeKey = `ck-${randomUUID()}`;
    const created = await confirmOnce({ consumeKey, templateId });
    const runId = (created as { runId: string }).runId;

    const first = await proposalStore.claimPendingInstallIntents({ runId, limit: 5 });
    expect(first).toHaveLength(1);
    expect(first[0].status).toBe("installing");
    expect(first[0].leaseToken).toBeTruthy();
    expect(first[0].attempts).toBe(1);

    // A second pass while the lease is live claims nothing.
    expect(await proposalStore.claimPendingInstallIntents({ runId, limit: 5 })).toHaveLength(0);
  });

  it("ARM BEFORE EXPOSE: `armed_at` is stamped before the install is marked done, and a done intent always carries it", async () => {
    const templateId = await seedTemplate();
    const consumeKey = `ck-${randomUUID()}`;
    const created = await confirmOnce({ consumeKey, templateId });
    const runId = (created as { runId: string }).runId;

    const [claimed] = await proposalStore.claimPendingInstallIntents({ runId, limit: 1 });
    const lease = claimed.leaseToken!;

    // Step 2 of the pinned order.
    expect(await proposalStore.markInstallIntentArmed(runId, lease)).toBe(true);
    const armed = await proposalStore.readInstallIntent(runId);
    expect(armed!.armedAt).not.toBeNull();
    // Still not done — the schedule has not been exposed yet. This is the whole
    // window the ordering protects: a fire landing HERE finds an armed run.
    expect(armed!.status).toBe("installing");

    // Step 4.
    expect(await proposalStore.markInstallIntentDone(runId, lease)).toBe(true);
    const done = await proposalStore.readInstallIntent(runId);
    expect(done!.status).toBe("done");
    expect(done!.armedAt).not.toBeNull();

    // The invariant, stated as a query: no intent is ever done-without-armed.
    const inverted = await client.query(
      `SELECT count(*)::int AS n FROM "${q(TEST_SCHEMA)}"."trigger_schedule_install_outbox"
        WHERE status = 'done' AND armed_at IS NULL`,
    );
    expect(inverted.rows[0].n).toBe(0);
  });

  it("ARM IS IDEMPOTENT: a re-driven drain does not re-stamp `armed_at`", async () => {
    const templateId = await seedTemplate();
    const consumeKey = `ck-${randomUUID()}`;
    const created = await confirmOnce({ consumeKey, templateId });
    const runId = (created as { runId: string }).runId;

    const [claimed] = await proposalStore.claimPendingInstallIntents({ runId, limit: 1 });
    const lease = claimed.leaseToken!;
    expect(await proposalStore.markInstallIntentArmed(runId, lease)).toBe(true);
    const firstStamp = (await proposalStore.readInstallIntent(runId))!.armedAt;

    // At-least-once delivery: the same step runs again.
    expect(await proposalStore.markInstallIntentArmed(runId, lease)).toBe(false);
    expect((await proposalStore.readInstallIntent(runId))!.armedAt).toEqual(firstStamp);
  });

  it("LEASE FENCE: a stale worker cannot mark another worker's in-flight install done", async () => {
    const templateId = await seedTemplate();
    const consumeKey = `ck-${randomUUID()}`;
    const created = await confirmOnce({ consumeKey, templateId });
    const runId = (created as { runId: string }).runId;

    await proposalStore.claimPendingInstallIntents({ runId, limit: 1 });
    expect(await proposalStore.markInstallIntentDone(runId, "a-stale-lease")).toBe(false);
    expect(await proposalStore.markInstallIntentArmed(runId, "a-stale-lease")).toBe(false);
    expect((await proposalStore.readInstallIntent(runId))!.status).toBe("installing");
  });

  it("RECONCILIATION: a crashed drain leaves the intent claimable, and the next pass finishes it", async () => {
    const templateId = await seedTemplate();
    const consumeKey = `ck-${randomUUID()}`;
    const created = await confirmOnce({ consumeKey, templateId });
    const runId = (created as { runId: string }).runId;

    // Pass 1 claims, arms, then "crashes" (never marks done).
    const [first] = await proposalStore.claimPendingInstallIntents({ runId, limit: 1 });
    await proposalStore.markInstallIntentArmed(runId, first.leaseToken!);

    // Expire the lease the way time would.
    await client.query(
      `UPDATE "${q(TEST_SCHEMA)}"."trigger_schedule_install_outbox"
          SET lease_expires_at = now() - interval '1 minute' WHERE run_id = $1`,
      [runId],
    );

    // Pass 2 re-claims it and finishes.
    const [second] = await proposalStore.claimPendingInstallIntents({ runId, limit: 1 });
    expect(second).toBeDefined();
    expect(second.attempts).toBe(2);
    expect(second.leaseToken).not.toBe(first.leaseToken);
    // The arm already happened — the run was never at risk while this was pending.
    expect(second.armedAt).not.toBeNull();
    expect(await proposalStore.markInstallIntentDone(runId, second.leaseToken!)).toBe(true);
    expect((await proposalStore.readInstallIntent(runId))!.status).toBe("done");
  });

  it("RETRY BUDGET: a failing install returns to `pending`, and parks `failed` once exhausted — never silently green", async () => {
    const templateId = await seedTemplate();
    const consumeKey = `ck-${randomUUID()}`;
    const created = await confirmOnce({ consumeKey, templateId });
    const runId = (created as { runId: string }).runId;

    const [claimed] = await proposalStore.claimPendingInstallIntents({ runId, limit: 1 });
    expect(
      await proposalStore.releaseInstallIntent(runId, claimed.leaseToken!, "redis down"),
    ).toBe("retry");
    const retried = await proposalStore.readInstallIntent(runId);
    expect(retried!.status).toBe("pending");

    // Walk it to its LAST allowed attempt — the claim below takes `attempts`
    // to the cap, so the release that follows is the one that parks it. (An
    // intent that is ALREADY at the cap never gets claimed at all; that is the
    // dying-worker case, covered separately below.)
    await client.query(
      `UPDATE "${q(TEST_SCHEMA)}"."trigger_schedule_install_outbox"
          SET attempts = max_attempts - 1 WHERE run_id = $1`,
      [runId],
    );
    const [again] = await proposalStore.claimPendingInstallIntents({ runId, limit: 1 });
    expect(again).toBeDefined();
    expect(
      await proposalStore.releaseInstallIntent(runId, again.leaseToken!, "redis still down"),
    ).toBe("failed");
    const parked = await proposalStore.readInstallIntent(runId);
    expect(parked!.status).toBe("failed");

    // A parked intent is never re-claimed — it awaits ops, visibly.
    expect(await proposalStore.claimPendingInstallIntents({ runId, limit: 1 })).toHaveLength(0);
  });

  it("ERROR TEXT IS BOUNDED — an operator field never becomes unbounded storage", async () => {
    const templateId = await seedTemplate();
    const consumeKey = `ck-${randomUUID()}`;
    const created = await confirmOnce({ consumeKey, templateId });
    const runId = (created as { runId: string }).runId;

    const [claimed] = await proposalStore.claimPendingInstallIntents({ runId, limit: 1 });
    await proposalStore.releaseInstallIntent(runId, claimed.leaseToken!, "x".repeat(5000));
    const row = await client.query(
      `SELECT last_error FROM "${q(TEST_SCHEMA)}"."trigger_schedule_install_outbox" WHERE run_id = $1`,
      [runId],
    );
    expect((row.rows[0].last_error as string).length).toBeLessThanOrEqual(500);
  });

  it("ORDERING IS ENFORCED BY THE DATABASE: an unarmed intent cannot be marked done — codex round-1 finding", async () => {
    // The arm-before-expose rule used to be a property of ONE function's
    // statement order. A reordered drain could close an intent whose run was
    // never armed, and the intent would then stop being claimable — a run no
    // schedule will ever fire, reported as installed. Now the store refuses it.
    const templateId = await seedTemplate();
    const consumeKey = `ck-${randomUUID()}`;
    const created = await confirmOnce({ consumeKey, templateId });
    const runId = (created as { runId: string }).runId;

    const [claimed] = await proposalStore.claimPendingInstallIntents({ runId, limit: 1 });
    // Skip the arm entirely, as an out-of-order caller would.
    expect(await proposalStore.markInstallIntentDone(runId, claimed.leaseToken!)).toBe(false);
    const still = await proposalStore.readInstallIntent(runId);
    expect(still!.status).toBe("installing");
    expect(still!.armedAt).toBeNull();

    // …and it is STILL claimable once the lease lapses, so the run is recovered
    // rather than stranded.
    await client.query(
      `UPDATE "${q(TEST_SCHEMA)}"."trigger_schedule_install_outbox"
          SET lease_expires_at = now() - interval '1 minute' WHERE run_id = $1`,
      [runId],
    );
    expect(await proposalStore.claimPendingInstallIntents({ runId, limit: 1 })).toHaveLength(1);
  });

  it("RETRY BUDGET SURVIVES A DYING WORKER: an exhausted intent is parked at claim time, not re-claimed forever — codex round-1 finding", async () => {
    // A worker that CRASHES never calls the release path, so its lease simply
    // expires. Without a budget check at claim time a crash-looping worker
    // would re-claim the same intent indefinitely, incrementing `attempts` past
    // its cap and never parking — an unbounded retry that reads as healthy.
    const templateId = await seedTemplate();
    const consumeKey = `ck-${randomUUID()}`;
    const created = await confirmOnce({ consumeKey, templateId });
    const runId = (created as { runId: string }).runId;

    await client.query(
      `UPDATE "${q(TEST_SCHEMA)}"."trigger_schedule_install_outbox"
          SET status = 'installing', attempts = max_attempts,
              lease_token = 'dead-worker', lease_expires_at = now() - interval '1 minute'
        WHERE run_id = $1`,
      [runId],
    );

    expect(await proposalStore.claimPendingInstallIntents({ runId, limit: 1 })).toHaveLength(0);
    const parked = await proposalStore.readInstallIntent(runId);
    expect(parked!.status).toBe("failed");
    expect(parked!.leaseToken).toBeNull();
    // Ops can see WHY, even though no release path ever ran.
    const row = await client.query(
      `SELECT last_error FROM "${q(TEST_SCHEMA)}"."trigger_schedule_install_outbox" WHERE run_id = $1`,
      [runId],
    );
    expect(row.rows[0].last_error).toContain("exhausted");

    // And it stays parked.
    expect(await proposalStore.claimPendingInstallIntents({ runId, limit: 1 })).toHaveLength(0);
  });

  it("CASCADE: deleting a run takes its consume row and its install intent with it", async () => {
    const templateId = await seedTemplate();
    const consumeKey = `ck-${randomUUID()}`;
    const created = await confirmOnce({ consumeKey, templateId });
    const runId = (created as { runId: string }).runId;

    await client.query(
      `DELETE FROM "${q(TEST_SCHEMA)}"."agent_runs" WHERE id = $1`,
      [runId],
    );
    expect(await proposalStore.readProposalConsume(consumeKey)).toBeNull();
    expect(await proposalStore.readInstallIntent(runId)).toBeNull();
  });
});
