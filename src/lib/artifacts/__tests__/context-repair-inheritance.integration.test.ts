/**
 * THE REPAIR INHERITS THE ANSWERED SCREEN (cinatra#3080, the fix leg's one
 * remaining defect), against a real Postgres.
 *
 * The drawing: "Regenerate sends the work back to be made again from the words
 * in the note field, settles this gate as superseded, and raises its successor
 * over the new revision" — a press, then the work, with nothing between them.
 * The last reading of the running application measured a repair run that
 * carried the producing run's own input fields correctly and then STOPPED
 * anyway, parked on the producing template's context-selection screen, so no
 * revision was filed and the settled review never got its successor.
 *
 * A slot the producing run already answered is not a question for the repair.
 * These cases drive the read that decides it — against the SAME append-only
 * audit store the answer was written to — and pin the four refusals that keep
 * it from becoming a way around the screen for anything else.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   CINATRA_DB_INTEGRATION_TESTS=1 SUPABASE_DB_URL=postgres://…/… \
 *     pnpm exec vitest run src/lib/artifacts/__tests__/context-repair-inheritance.integration
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

import type { ContextCandidate } from "@/lib/artifacts/context-route-support";

const TEST_SCHEMA = "cinatra_test_context_inherit_3080";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !DB_URL.includes("unused:unused");
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-3080-context-inherit";
const SLOT = "draftContext";
const PACKAGE = "@cinatra-ai/context-inherit-fixture-agent";

let inheritance: typeof import("@/lib/artifacts/context-repair-inheritance");
let client: Client;

/** A candidate as the resolver hands it back — the triple plus the fields only
 *  the resolver may supply. */
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

/** ONE answer the producing run's finalize wrote: every ref of a selection
 *  commits in ONE batch, so every row of one answer shares one `selected_at`
 *  — which is exactly what tells a LATER correction from the answer it
 *  superseded. `at` is explicit so a correction can be placed after the answer
 *  it replaces without depending on clock resolution. */
async function answeredWith(input: {
  parentRunId: string;
  refs: ContextCandidate[];
  slotId?: string;
  at?: string;
  selectedBy?: "user" | "agent" | "autonomous";
  packageName?: string;
}) {
  const at = input.at ?? new Date().toISOString();
  const values: unknown[] = [];
  const tuples = input.refs.map((ref, i) => {
    const b = i * 12;
    values.push(
      `rcs-${randomUUID()}`,
      ORG,
      input.parentRunId,
      input.packageName ?? PACKAGE,
      input.slotId ?? SLOT,
      ref.artifactId,
      ref.representationRevisionId,
      ref.semanticAssertionId,
      ref.extension,
      ref.sourceScope,
      input.selectedBy ?? "user",
      at,
    );
    return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},'interactive',$${b + 12})`;
  });
  if (tuples.length === 0) return;
  await client.query(
    `INSERT INTO "${q(TEST_SCHEMA)}"."run_context_selections"
       (id, org_id, parent_run_id, parent_package_name, slot_id, artifact_id,
        representation_revision_id, semantic_assertion_id, extension, source_scope,
        selected_by, selection_mode, selected_at)
     VALUES ${tuples.join(",")}`,
    values,
  );
}

/** The audit row the producing run's own finalize wrote for its pick. */
async function answered(parentRunId: string, ref: ContextCandidate, slotId = SLOT) {
  await answeredWith({ parentRunId, refs: [ref], slotId });
}

/** The read as both context routes make it: the run, the slot, the package the
 *  slot is being run under, the candidate set resolved NOW, and the slot's own
 *  `minItems`. */
function inheritedFor(input: {
  run: Parameters<
    typeof inheritance.resolveInheritedContextSelection
  >[0]["run"];
  candidates: ContextCandidate[];
  slotId?: string;
  parentPackageName?: string;
  slotMinItems?: number;
}) {
  return inheritance.resolveInheritedContextSelection({
    run: input.run,
    slotId: input.slotId ?? SLOT,
    parentPackageName: input.parentPackageName ?? PACKAGE,
    candidates: input.candidates,
    slotMinItems: input.slotMinItems ?? 1,
  });
}

/** The repair run the dispatch drain mints: its source type, the delivered
 *  request it carries, and the producing run it names. */
function repairRun(producingRunId: string | null) {
  return {
    id: `lifecycle-repair-run:${randomUUID()}`,
    orgId: ORG,
    sourceType: "lifecycle_repair",
    parentRunId: producingRunId,
    inputParams: {
      idea: { title: "an idea" },
      lifecycleRepairRequest: { kind: "lifecycle_repair_request", repairId: randomUUID() },
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

describe.skipIf(!HAS_DB)(
  "cinatra#3080 — a repair inherits every answered human step from its own producing run",
  () => {
    it("the context selection the producing run answered is the repair's answer, so no human step stands between the press and the work", async () => {
      const producingRunId = `run-${randomUUID()}`;
      const picked = candidate();
      await answered(producingRunId, picked);

      // The resolver hands back the whole eligible set, the pick among it.
      const candidates = [candidate(), picked, candidate()];
      const inherited = inheritedFor({ run: repairRun(producingRunId), candidates });

      expect(inherited).not.toBeNull();
      expect(inherited!.refs).toHaveLength(1);
      // The ref returned is the RESOLVER's candidate, matched by the audited
      // triple — history supplies the identity of the pick and nothing else.
      expect(inherited!.refs[0]).toBe(picked);
      // And the slot therefore runs in the flow's own no-person mode: the
      // interactive screen the producing run answered does not open again.
      expect(inheritance.effectiveSelectionMode("interactive", inherited)).toBe("autonomous");
    });

    it("an ORDINARY run inherits nothing — the screen still opens for every run that is not a repair", async () => {
      const producingRunId = `run-${randomUUID()}`;
      const picked = candidate();
      await answered(producingRunId, picked);

      // The same rows, the same slot, the same candidates — an ordinary run.
      const ordinary = {
        id: `run-${randomUUID()}`,
        orgId: ORG,
        sourceType: "agent_builder",
        parentRunId: producingRunId,
        inputParams: { idea: { title: "an idea" } },
      };
      const inherited = inheritedFor({ run: ordinary, candidates: [picked] });
      expect(inherited).toBeNull();
      expect(inheritance.effectiveSelectionMode("interactive", inherited)).toBe("interactive");
    });

    it("a repair inherits only from ITS OWN producing run — never from a stranger's answered screen", async () => {
      const strangerRunId = `run-${randomUUID()}`;
      const picked = candidate();
      await answered(strangerRunId, picked);

      const ownProducer = `run-${randomUUID()}`;
      expect(inheritedFor({ run: repairRun(ownProducer), candidates: [picked] })).toBeNull();

      // A repair naming no producing run of its own inherits nothing either.
      expect(inheritedFor({ run: repairRun(null), candidates: [picked] })).toBeNull();
    });

    it("a slot the producing run never answered is still a question", async () => {
      const producingRunId = `run-${randomUUID()}`;
      const picked = candidate();
      await answered(producingRunId, picked, "someOtherSlot");

      expect(inheritedFor({ run: repairRun(producingRunId), candidates: [picked] })).toBeNull();
    });

    it("part of an answer is not an answer: a pick that no longer resolves is not inherited", async () => {
      const producingRunId = `run-${randomUUID()}`;
      const stillThere = candidate();
      const goneSince = candidate();
      // ONE answer of two refs — one batch, one `selected_at`.
      await answeredWith({ parentRunId: producingRunId, refs: [stillThere, goneSince] });

      // The resolver no longer offers one of the two the person picked.
      const inherited = inheritedFor({
        run: repairRun(producingRunId),
        candidates: [stillThere],
      });
      // Not "the half that survived" — nothing, so the screen opens and a
      // person answers it rather than the work being made from a context
      // nobody chose.
      expect(inherited).toBeNull();
      expect(inheritance.effectiveSelectionMode("interactive", inherited)).toBe("interactive");
    });

    it("the delivered repair request is required, so a row merely stamped as a repair inherits nothing", async () => {
      const producingRunId = `run-${randomUUID()}`;
      const picked = candidate();
      await answered(producingRunId, picked);

      expect(
        inheritedFor({
          run: {
            id: `run-${randomUUID()}`,
            orgId: ORG,
            sourceType: "lifecycle_repair",
            parentRunId: producingRunId,
            inputParams: { idea: { title: "an idea" } },
          },
          candidates: [picked],
        }),
      ).toBeNull();
    });

    // ---------------------------------------------------------------------
    // The convergence round's readings (cinatra#3080 fix leg 2).
    // ---------------------------------------------------------------------

    it("the answer a run HOLDS is its latest one — a correction supersedes the answer it replaced, it does not join it", async () => {
      const producingRunId = `run-${randomUUID()}`;
      const firstThought = candidate();
      const corrected = candidate();
      // The store is append-only and says so: "corrections are a NEW row,
      // never a mutation". So a person who answered and then answered again
      // leaves BOTH rows standing.
      await answeredWith({
        parentRunId: producingRunId,
        refs: [firstThought],
        at: "2026-08-31T09:00:00.000Z",
      });
      await answeredWith({
        parentRunId: producingRunId,
        refs: [corrected],
        at: "2026-08-31T10:00:00.000Z",
      });

      const inherited = inheritedFor({
        run: repairRun(producingRunId),
        candidates: [firstThought, corrected],
      });
      // Not both. An `override` slot handed two refs is refused outright at
      // finalize, and the work would be remade from a context the person had
      // already withdrawn.
      expect(inherited).not.toBeNull();
      expect(inherited!.refs).toEqual([corrected]);
    });

    it("the answer is read under the package the slot is being run under, so an earlier package identity never contaminates it", async () => {
      const producingRunId = `run-${randomUUID()}`;
      const underAnotherPackage = candidate();
      await answeredWith({
        parentRunId: producingRunId,
        refs: [underAnotherPackage],
        packageName: "@cinatra-ai/some-other-agent",
      });

      expect(
        inheritedFor({ run: repairRun(producingRunId), candidates: [underAnotherPackage] }),
      ).toBeNull();
    });

    it("an answer of NOTHING is an answer where the slot admits one and the producing run demonstrably ran the context flow", async () => {
      const producingRunId = `run-${randomUUID()}`;
      const elsewhere = candidate();
      // The producing run answered a DIFFERENT slot: it reached the end of the
      // context flow, and answered this one with nothing.
      await answeredWith({
        parentRunId: producingRunId,
        refs: [elsewhere],
        slotId: "someOtherSlot",
      });

      const inherited = inheritedFor({
        run: repairRun(producingRunId),
        candidates: [candidate()],
        slotMinItems: 0,
      });
      expect(inherited).not.toBeNull();
      expect(inherited!.refs).toEqual([]);
      // The empty answer still keeps the person out of the repair's road.
      expect(inheritance.effectiveSelectionMode("interactive", inherited)).toBe("autonomous");
    });

    it("a producing run that answered nothing ANYWHERE is unreadable, so the screen opens — the fail-closed side", async () => {
      const producingRunId = `run-${randomUUID()}`;
      // No audited row at all: "answered with nothing" and "never reached"
      // cannot be told apart from a store that records only picks.
      expect(
        inheritedFor({
          run: repairRun(producingRunId),
          candidates: [candidate()],
          slotMinItems: 0,
        }),
      ).toBeNull();
    });

    it("the provenance travels verbatim: a pick a resolver made is never promoted to a person's choice", async () => {
      const byAPerson = `run-${randomUUID()}`;
      const personsPick = candidate();
      await answeredWith({ parentRunId: byAPerson, refs: [personsPick], selectedBy: "user" });
      expect(inheritedFor({ run: repairRun(byAPerson), candidates: [personsPick] })!.selectedBy).toBe(
        "user",
      );

      const byAResolver = `run-${randomUUID()}`;
      const machinesPick = candidate();
      await answeredWith({
        parentRunId: byAResolver,
        refs: [machinesPick],
        selectedBy: "autonomous",
      });
      // The repair writes its own audit row from this, so crediting a person
      // here would put someone's name on a choice nobody made.
      expect(
        inheritedFor({ run: repairRun(byAResolver), candidates: [machinesPick] })!.selectedBy,
      ).toBe("autonomous");
    });
  },
);
