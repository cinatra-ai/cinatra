/**
 * THE REPAIR INHERITS THE ANSWERED SCREEN (cinatra#3080), against a real
 * Postgres.
 *
 * The drawing: "Regenerate sends the work back to be made again from the words
 * in the note field, settles this gate as superseded, and raises its successor
 * over the new revision" — a press, then the work, with nothing between them.
 * A repair run that walks into its producing template's context-selection
 * screen parks there, so no revision is filed and the settled review never
 * gets its successor.
 *
 * A slot the producing run already answered is not a question for the repair,
 * where that answer can be read back completely. Finalize now records the
 * WHOLE answer of every finalize of a slot — the complete ordered ref set, an
 * empty one included — in the same transaction as the per-ref audit rows, and
 * the repair inherits the LATEST recorded answer. A run finalized before that
 * record existed keeps the earlier reading: it inherits only the empty answer
 * its audit rows can prove.
 *
 * Every answer here is written THROUGH `finalizeContextSelectionPinsAtomic`,
 * the finalize route's own call: with the slot's answer (the road this change
 * adds) or without it (the call as it stood before, which records no answer).
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

import type { ContextCandidate } from "@/lib/artifacts/context-route-support";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";
import { runContextAnswersDdlSql } from "../../../../migrations/core/core__0113_run-context-answers.mjs";

const TEST_SCHEMA = "cinatra_test_context_inherit_3080";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-3080-context-inherit";
const SLOT = "draftContext";
const PACKAGE = "@cinatra-ai/context-inherit-fixture-agent";
const OTHER_PACKAGE = "@cinatra-ai/web-research-agent";

let inheritance: typeof import("@/lib/artifacts/context-repair-inheritance");
let finalize: typeof import("@/lib/artifacts/context-selection-finalize");
let store: typeof import("@/lib/artifacts/run-context-selections-store");
let client: Client;

/** A candidate as the resolver hands it back — never written anywhere. */
function candidate(over: Partial<ContextCandidate> = {}): ContextCandidate {
  return {
    artifactId: `art-${randomUUID()}`,
    representationRevisionId: `rev-${randomUUID()}`,
    semanticAssertionId: `sem-${randomUUID()}`,
    extension: "@cinatra-ai/brand-voice-artifact",
    sourceScope: "organization",
    ownerId: ORG,
    ...over,
  };
}

/** A ref finalize will admit: a live GENERIC artifact (the type finalize's
 *  coherence gate admits unconditionally), its representation over a live
 *  resource, and an eligible assertion of the candidate's extension. */
async function finalizableRef(): Promise<ContextCandidate> {
  const ref = candidate();
  const resourceId = `res-${randomUUID()}`;
  await client.query(
    `INSERT INTO "${q(TEST_SCHEMA)}"."objects" (id, type, data, org_id)
     VALUES ($1, '@cinatra-ai/artifact:object', '{}'::jsonb, $2)`,
    [ref.artifactId, ORG],
  );
  await client.query(
    `INSERT INTO "${q(TEST_SCHEMA)}"."resource" (id, org_id, kind, substance_key, mime, size_bytes)
     VALUES ($1, $2, 'blob', $3, 'text/markdown', 12)`,
    [resourceId, ORG, `blob:${randomUUID().replaceAll("-", "")}`],
  );
  await client.query(
    `INSERT INTO "${q(TEST_SCHEMA)}"."representation" (id, org_id, artifact_id, resource_id, revision, form)
     VALUES ($1, $2, $3, $4, 1, 'file')`,
    [ref.representationRevisionId, ORG, ref.artifactId, resourceId],
  );
  await client.query(
    `INSERT INTO "${q(TEST_SCHEMA)}"."semantic_assertion" (id, org_id, artifact_id, extension, asserted_by, eligibility)
     VALUES ($1, $2, $3, $4, 'agent', 'eligible')`,
    [ref.semanticAssertionId, ORG, ref.artifactId, ref.extension],
  );
  return ref;
}

/** ONE finalize of the slot as the production road writes it: the finalize
 *  route's own call, referrer = the producing run. `record: false` is the
 *  call as it stood before whole answers were recorded (no answer argument).
 *  Returns, per ref, whether its audit row was newly written. */
function finalizedWith(input: {
  parentRunId: string;
  refs: ContextCandidate[];
  packageName?: string;
  slotId?: string;
  selectedBy?: "user" | "agent" | "autonomous";
  selectionMode?: "interactive" | "autonomous";
  record?: boolean;
}): boolean[] {
  const parentPackageName = input.packageName ?? PACKAGE;
  const slotId = input.slotId ?? SLOT;
  const selectedBy = input.selectedBy ?? "user";
  const selectionMode = input.selectionMode ?? "interactive";
  const inputs = input.refs.map((ref) => ({
    selection: {
      orgId: ORG,
      parentRunId: input.parentRunId,
      parentPackageName,
      slotId,
      artifactId: ref.artifactId,
      representationRevisionId: ref.representationRevisionId,
      semanticAssertionId: ref.semanticAssertionId,
      extension: ref.extension,
      sourceScope: ref.sourceScope,
      selectedBy,
      selectionMode,
    },
    referrerKind: "agent_run" as const,
    referrerId: input.parentRunId,
    createdBy: null,
  }));
  const results =
    input.record === false
      ? finalize.finalizeContextSelectionPinsAtomic(inputs)
      : finalize.finalizeContextSelectionPinsAtomic(inputs, {
          orgId: ORG,
          parentRunId: input.parentRunId,
          parentPackageName,
          slotId,
          selectedBy,
          selectionMode,
        });
  return results.map((result) => result.selectionWritten);
}

/** The recorded answers of the producing run's slot, in sequence order. */
async function recordedAnswers(
  parentRunId: string,
): Promise<Array<{ seq: number; artifactIds: string[] }>> {
  const res = await client.query(
    `SELECT answer_seq, refs FROM "${q(TEST_SCHEMA)}"."run_context_answers"
     WHERE org_id = $1 AND parent_run_id = $2 AND slot_id = $3 ORDER BY answer_seq`,
    [ORG, parentRunId, SLOT],
  );
  return res.rows.map((r: { answer_seq: number; refs: Array<{ artifactId: string }> }) => ({
    seq: Number(r.answer_seq),
    artifactIds: r.refs.map((ref) => ref.artifactId),
  }));
}

/** The artifact ids the audit store holds for the producing run's slot. */
async function auditedArtifactIds(parentRunId: string): Promise<string[]> {
  const res = await client.query(
    `SELECT artifact_id FROM "${q(TEST_SCHEMA)}"."run_context_selections"
     WHERE org_id = $1 AND parent_run_id = $2 AND slot_id = $3 ORDER BY artifact_id`,
    [ORG, parentRunId, SLOT],
  );
  return res.rows.map((r: { artifact_id: string }) => r.artifact_id);
}

/** The read as both context routes make it. */
function inheritedFor(input: {
  run: Parameters<typeof inheritance.resolveInheritedContextSelection>[0]["run"];
  candidates: ContextCandidate[];
  slotId?: string;
  parentPackageName?: string;
  slotMinItems?: number;
  declaredSelectionMode?: "interactive" | "autonomous";
}) {
  return inheritance.resolveInheritedContextSelection({
    run: input.run,
    slotId: input.slotId ?? SLOT,
    parentPackageName: input.parentPackageName ?? PACKAGE,
    candidates: input.candidates,
    slotMinItems: input.slotMinItems ?? 1,
    declaredSelectionMode: input.declaredSelectionMode ?? "interactive",
  });
}

/** The repair run the dispatch drain mints: its source type, the delivered
 *  request it carries (the drain's own shape, `baseTarget` included) and the
 *  producing run it names. */
function repairRun(
  producingRunId: string | null,
  over: { baseTarget?: { artifactId: string; representationRevisionId: string } | null } = {},
) {
  const baseTarget =
    over.baseTarget === undefined
      ? { artifactId: `art-${randomUUID()}`, representationRevisionId: `rev-${randomUUID()}` }
      : over.baseTarget;
  return {
    id: `lifecycle-repair-run:${randomUUID()}`,
    orgId: ORG,
    sourceType: "lifecycle_repair",
    parentRunId: producingRunId,
    inputParams: {
      idea: { title: "an idea" },
      lifecycleRepairRequest: {
        kind: "lifecycle_repair_request",
        repairId: randomUUID(),
        ...(baseTarget ? { baseTarget, expectedBaseRevisionId: baseTarget.representationRevisionId } : {}),
      },
    },
  };
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

  inheritance = await import("@/lib/artifacts/context-repair-inheritance");
  finalize = await import("@/lib/artifacts/context-selection-finalize");
  store = await import("@/lib/artifacts/run-context-selections-store");
  client = new Client({ connectionString: DB_URL });
  await client.connect();
}, 90_000);

afterAll(async () => {
  if (!HAS_DB) return;
  await client?.end().catch(() => {});
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean })
    .__cinatraPostgresSchemaInitialized;
});

// -------------------------------------------------------------------------
// THE FORWARD MIGRATION. A database from before this change has the audit
// table and no answer table; the migration adds the table and backfills
// nothing, so every earlier run keeps exactly the reading it had.
// -------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("cinatra#3080 — the whole-answer table arrives without inventing answers", () => {
  it("is additive: the earlier audit rows read the same, no answer is backfilled, and a pre-migration run inherits exactly what it did before", async () => {
    // The schema as it stood before this change: no answer table.
    await client.query(`DROP TABLE "${q(TEST_SCHEMA)}"."run_context_answers"`);
    await client.query(`DROP FUNCTION "${q(TEST_SCHEMA)}"."fn_run_context_answers_append_only"()`);

    // Two producing runs finalized THEN, through the call as it stood: one
    // that picked a context, one that answered its one slot with nothing.
    const picked = await finalizableRef();
    const pickedRun = `run-${randomUUID()}`;
    expect(finalizedWith({ parentRunId: pickedRun, refs: [picked], record: false })).toEqual([true]);
    const emptyRun = `run-${randomUUID()}`;
    expect(finalizedWith({ parentRunId: emptyRun, refs: [], record: false })).toEqual([]);
    const before = store.readRunContextSelectionsForRun({ orgId: ORG, parentRunId: pickedRun });
    expect(before.map((row) => row.artifactId)).toEqual([picked.artifactId]);

    // The forward migration, as the runner applies it (the app schema first
    // on the search path), twice: it is idempotent.
    await client.query(`SET search_path TO "${q(TEST_SCHEMA)}"`);
    await client.query(runContextAnswersDdlSql);
    await client.query(runContextAnswersDdlSql);
    await client.query(`RESET search_path`);

    // Nothing invented: the table is there and empty.
    const count = await client.query(
      `SELECT count(*)::int AS n FROM "${q(TEST_SCHEMA)}"."run_context_answers"`,
    );
    expect(count.rows[0].n).toBe(0);
    // The earlier rows read exactly as before.
    expect(store.readRunContextSelectionsForRun({ orgId: ORG, parentRunId: pickedRun })).toEqual(before);
    expect(store.readLatestRunContextAnswer({ orgId: ORG, parentRunId: pickedRun, slotId: SLOT })).toBeNull();

    // And each run inherits what it did before: the picked slot opens the
    // screen, the empty one is inherited as empty.
    expect(inheritedFor({ run: repairRun(pickedRun), candidates: [picked], slotMinItems: 0 })).toBeNull();
    expect(
      inheritedFor({ run: repairRun(emptyRun), candidates: [picked], slotMinItems: 0 }),
    ).toEqual({ refs: [], selectedBy: "user" });

    // The table the migration made takes the new answers, append-only.
    const later = `run-${randomUUID()}`;
    expect(finalizedWith({ parentRunId: later, refs: [picked] })).toEqual([true]);
    expect(await recordedAnswers(later)).toEqual([{ seq: 1, artifactIds: [picked.artifactId] }]);
    await expect(
      client.query(
        `DELETE FROM "${q(TEST_SCHEMA)}"."run_context_answers" WHERE parent_run_id = $1`,
        [later],
      ),
    ).rejects.toThrow(/append-only/);
  });
});

describe.skipIf(!HAS_DB)(
  "cinatra#3080 — a repair inherits the latest WHOLE answer its own producing run recorded",
  () => {
    it("a correction that ADDS a ref: [A] then [A, B] — the repair inherits [A, B]", async () => {
      const producingRunId = `run-${randomUUID()}`;
      const first = await finalizableRef();
      const added = await finalizableRef();
      expect(finalizedWith({ parentRunId: producingRunId, refs: [first] })).toEqual([true]);
      expect(finalizedWith({ parentRunId: producingRunId, refs: [first, added] })).toEqual([
        false,
        true,
      ]);
      expect(await recordedAnswers(producingRunId)).toEqual([
        { seq: 1, artifactIds: [first.artifactId] },
        { seq: 2, artifactIds: [first.artifactId, added.artifactId] },
      ]);

      const other = candidate();
      const inherited = inheritedFor({
        run: repairRun(producingRunId),
        candidates: [other, added, first],
      });
      expect(inherited).not.toBeNull();
      expect(inherited!.refs.map((r) => r.artifactId)).toEqual([first.artifactId, added.artifactId]);
      expect(inherited!.selectedBy).toBe("user");
      expect(inheritance.effectiveSelectionMode("interactive", inherited)).toBe("autonomous");
    });

    it("a correction that REMOVES a ref: [A, B] then [A] — the repair inherits [A], and the withdrawn ref never comes back", async () => {
      const producingRunId = `run-${randomUUID()}`;
      const kept = await finalizableRef();
      const withdrawn = await finalizableRef();
      expect(finalizedWith({ parentRunId: producingRunId, refs: [kept, withdrawn] })).toEqual([
        true,
        true,
      ]);
      expect(finalizedWith({ parentRunId: producingRunId, refs: [kept] })).toEqual([false]);
      // The audit rows still hold both; the recorded answer does not.
      expect(await auditedArtifactIds(producingRunId)).toEqual(
        [kept.artifactId, withdrawn.artifactId].sort(),
      );

      const inherited = inheritedFor({
        run: repairRun(producingRunId),
        candidates: [kept, withdrawn],
      });
      expect(inherited!.refs.map((r) => r.artifactId)).toEqual([kept.artifactId]);
    });

    it("a slot CLEARED after an answer: [A] then [] — the repair inherits [] where the slot admits it, and opens the screen where it does not", async () => {
      const producingRunId = `run-${randomUUID()}`;
      const once = await finalizableRef();
      expect(finalizedWith({ parentRunId: producingRunId, refs: [once] })).toEqual([true]);
      // The cleared answer writes no audit row and is still recorded.
      expect(finalizedWith({ parentRunId: producingRunId, refs: [] })).toEqual([]);
      expect(await recordedAnswers(producingRunId)).toEqual([
        { seq: 1, artifactIds: [once.artifactId] },
        { seq: 2, artifactIds: [] },
      ]);

      expect(
        inheritedFor({ run: repairRun(producingRunId), candidates: [once], slotMinItems: 0 }),
      ).toEqual({ refs: [], selectedBy: "user" });
      expect(
        inheritedFor({ run: repairRun(producingRunId), candidates: [once], slotMinItems: 1 }),
      ).toBeNull();
    });

    it("two finalizes less than a millisecond apart are ordered by the record's sequence, not the clock", async () => {
      const producingRunId = `run-${randomUUID()}`;
      const firstThought = await finalizableRef();
      const later = await finalizableRef();
      finalizedWith({ parentRunId: producingRunId, refs: [firstThought] });
      finalizedWith({ parentRunId: producingRunId, refs: [later] });

      // Put the two write moments a tenth of a millisecond apart, the LATER
      // answer first on the clock. Nothing in the product writes this table
      // but finalize; the trigger is lifted here only to place the moments.
      const table = `"${q(TEST_SCHEMA)}"."run_context_answers"`;
      await client.query(`ALTER TABLE ${table} DISABLE TRIGGER trg_run_context_answers_append_only`);
      try {
        await client.query(
          `UPDATE ${table} SET answered_at = CASE answer_seq
             WHEN 1 THEN '2026-08-31T09:00:00.000200Z'::timestamptz
             ELSE '2026-08-31T09:00:00.000100Z'::timestamptz END
           WHERE org_id = $1 AND parent_run_id = $2`,
          [ORG, producingRunId],
        );
      } finally {
        await client.query(`ALTER TABLE ${table} ENABLE TRIGGER trg_run_context_answers_append_only`);
      }

      const inherited = inheritedFor({
        run: repairRun(producingRunId),
        candidates: [firstThought, later],
      });
      expect(inherited!.refs.map((r) => r.artifactId)).toEqual([later.artifactId]);
    });

    it("an answer recorded under ANOTHER package never leaks across packages", async () => {
      const producingRunId = `run-${randomUUID()}`;
      const picked = await finalizableRef();
      expect(
        finalizedWith({ parentRunId: producingRunId, refs: [picked], packageName: OTHER_PACKAGE }),
      ).toEqual([true]);

      const inherited = inheritedFor({
        run: repairRun(producingRunId),
        candidates: [picked],
        slotMinItems: 0,
      });
      expect(inherited).toBeNull();
      expect(inheritance.effectiveSelectionMode("interactive", inherited)).toBe("interactive");
      // Read under the package it WAS recorded under, it is that package's.
      expect(
        inheritedFor({
          run: repairRun(producingRunId),
          candidates: [picked],
          parentPackageName: OTHER_PACKAGE,
        })!.refs.map((r) => r.artifactId),
      ).toEqual([picked.artifactId]);
    });

    it("a recorded ref that is no longer allocated to the slot opens the screen — part of the answer is not the answer", async () => {
      const producingRunId = `run-${randomUUID()}`;
      const stillThere = await finalizableRef();
      const goneSince = await finalizableRef();
      finalizedWith({ parentRunId: producingRunId, refs: [stillThere, goneSince] });

      expect(
        inheritedFor({ run: repairRun(producingRunId), candidates: [stillThere] }),
      ).toBeNull();
    });

    it("a recorded answer keeps who gave it: a resolver's answer is never promoted to a person's", async () => {
      const producingRunId = `run-${randomUUID()}`;
      const picked = await finalizableRef();
      finalizedWith({
        parentRunId: producingRunId,
        refs: [picked],
        selectedBy: "autonomous",
        selectionMode: "autonomous",
      });
      expect(
        inheritedFor({ run: repairRun(producingRunId), candidates: [picked] })!.selectedBy,
      ).toBe("autonomous");
    });

    it("an incoherent ref aborts the whole finalize: no audit row, no pin and NO recorded answer", async () => {
      const producingRunId = `run-${randomUUID()}`;
      const good = await finalizableRef();
      const incoherent = { ...(await finalizableRef()), semanticAssertionId: `sem-${randomUUID()}` };
      expect(() => finalizedWith({ parentRunId: producingRunId, refs: [good, incoherent] })).toThrow();
      expect(await auditedArtifactIds(producingRunId)).toEqual([]);
      expect(await recordedAnswers(producingRunId)).toEqual([]);
    });

    it("an ORDINARY run inherits nothing, whatever its producing run recorded", async () => {
      const producingRunId = `run-${randomUUID()}`;
      const picked = await finalizableRef();
      finalizedWith({ parentRunId: producingRunId, refs: [picked] });
      const ordinary = {
        id: `run-${randomUUID()}`,
        orgId: ORG,
        sourceType: "agent_builder",
        parentRunId: producingRunId,
        inputParams: { idea: { title: "an idea" } },
      };
      expect(inheritedFor({ run: ordinary, candidates: [picked] })).toBeNull();
      // A row merely stamped as a repair, without the delivered request, too.
      expect(
        inheritedFor({
          run: { ...ordinary, sourceType: "lifecycle_repair" },
          candidates: [picked],
        }),
      ).toBeNull();
    });

    it("a repair inherits only from ITS OWN producing run — never from a stranger's recorded answer", async () => {
      const strangerRunId = `run-${randomUUID()}`;
      const picked = await finalizableRef();
      finalizedWith({ parentRunId: strangerRunId, refs: [picked] });
      expect(inheritedFor({ run: repairRun(`run-${randomUUID()}`), candidates: [picked] })).toBeNull();
      expect(inheritedFor({ run: repairRun(null), candidates: [picked] })).toBeNull();
    });
  },
);

// -------------------------------------------------------------------------
// A RUN WITH NO RECORDED ANSWER (finalized before whole answers were
// recorded): the per-ref audit rows prove only the empty answer.
// -------------------------------------------------------------------------
describe.skipIf(!HAS_DB)(
  "cinatra#3080 — a producing run with no recorded answer keeps the earlier, fail-closed reading",
  () => {
    it("rows without a record: an answer that holds refs is never inherited, however it was corrected", async () => {
      const added = `run-${randomUUID()}`;
      const a = await finalizableRef();
      const b = await finalizableRef();
      finalizedWith({ parentRunId: added, refs: [a], record: false });
      finalizedWith({ parentRunId: added, refs: [a, b], record: false });
      expect(inheritedFor({ run: repairRun(added), candidates: [a, b] })).toBeNull();

      const removed = `run-${randomUUID()}`;
      finalizedWith({ parentRunId: removed, refs: [a, b], record: false });
      finalizedWith({ parentRunId: removed, refs: [a], record: false });
      expect(inheritedFor({ run: repairRun(removed), candidates: [a, b] })).toBeNull();

      const cleared = `run-${randomUUID()}`;
      finalizedWith({ parentRunId: cleared, refs: [a], record: false });
      finalizedWith({ parentRunId: cleared, refs: [], record: false });
      expect(
        inheritedFor({ run: repairRun(cleared), candidates: [a], slotMinItems: 0 }),
      ).toBeNull();
    });

    it("rows for this slot under ANOTHER package still stop the empty answer", async () => {
      const producingRunId = `run-${randomUUID()}`;
      const picked = await finalizableRef();
      finalizedWith({
        parentRunId: producingRunId,
        refs: [picked],
        packageName: OTHER_PACKAGE,
        record: false,
      });
      expect(
        inheritedFor({ run: repairRun(producingRunId), candidates: [picked], slotMinItems: 0 }),
      ).toBeNull();
    });

    it("the EMPTY answer reads as before: no row and no record, a slot that admits emptiness and a repair raised over a filed revision", async () => {
      const producingRunId = `run-${randomUUID()}`;
      expect(
        inheritedFor({ run: repairRun(producingRunId), candidates: [candidate()], slotMinItems: 0 }),
      ).toEqual({ refs: [], selectedBy: "user" });
      expect(
        inheritedFor({
          run: repairRun(producingRunId),
          candidates: [],
          slotMinItems: 0,
          declaredSelectionMode: "autonomous",
        }),
      ).toEqual({ refs: [], selectedBy: "autonomous" });
      // The fail-closed sides: no base revision, or a slot that requires items.
      expect(
        inheritedFor({
          run: repairRun(producingRunId, { baseTarget: null }),
          candidates: [candidate()],
          slotMinItems: 0,
        }),
      ).toBeNull();
      expect(
        inheritedFor({ run: repairRun(producingRunId), candidates: [candidate()], slotMinItems: 1 }),
      ).toBeNull();
    });

    it("a sibling slot answered under this package also shows the run ran the context flow", async () => {
      const producingRunId = `run-${randomUUID()}`;
      const elsewhere = await finalizableRef();
      finalizedWith({
        parentRunId: producingRunId,
        refs: [elsewhere],
        slotId: "someOtherSlot",
        record: false,
      });
      expect(
        inheritedFor({
          run: repairRun(producingRunId, { baseTarget: null }),
          candidates: [candidate()],
          slotMinItems: 0,
        }),
      ).toEqual({ refs: [], selectedBy: "user" });
    });

    it("an ORDINARY run reads no base revision out of its own params, whatever they hold", async () => {
      expect(
        inheritance.deliveredRepairBaseRevisionId({
          id: `run-${randomUUID()}`,
          orgId: ORG,
          sourceType: "agent_builder",
          parentRunId: `run-${randomUUID()}`,
          inputParams: {
            lifecycleRepairRequest: {
              kind: "lifecycle_repair_request",
              baseTarget: { artifactId: "a", representationRevisionId: "r" },
            },
          },
        }),
      ).toBeNull();
    });
  },
);
