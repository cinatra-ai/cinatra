/**
 * cinatra#3559 — one shared replay helper keeps integration setup off the
 * shared `public` tables.
 *
 * Every `*.integration.test.ts` that needs a store schema replays
 * `buildCreateStoreSchemaQueries` into its OWN throwaway schema. A handful of
 * those statements do not target the throwaway schema at all: they ALTER, index
 * or re-create triggers on the SHARED `public` tables. Two files replaying them
 * at the same time take `AccessExclusiveLock` on the same shared object, and
 * Postgres resolves that by killing one of them with `40P01 deadlock detected`.
 *
 * This suite pins the helper's SELECTION against the real output of the store's
 * own schema builder, statement by statement. It needs no database: the
 * selection is a pure function of the statement text.
 */
import { describe, expect, it } from "vitest";

import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";
import {
  isReplayedHead,
  replayStoreSchema,
  selectReplayStatements,
  targetsSharedPublicTable,
} from "@/lib/test-support/store-schema-replay";

const SCHEMA = "cinatra_test_3559_selection";
const STATEMENTS = buildCreateStoreSchemaQueries(SCHEMA);
const SELECTED = selectReplayStatements(STATEMENTS);

type Match = (text: string) => boolean;

const startsWith =
  (prefix: string): Match =>
  (text) =>
    text.trim().startsWith(prefix);

const contains =
  (needle: string): Match =>
  (text) =>
    text.includes(needle);

/** The one statement of the builder that `match` picks out. */
function only(match: Match): string {
  const hits = STATEMENTS.filter((statement) => match(statement.text));
  expect(hits).toHaveLength(1);
  return hits[0]!.text;
}

const isSelected = (text: string): boolean =>
  SELECTED.some((statement) => statement.text === text);

/**
 * GROUP A — the statements whose OWN target is a shared `public` table AND
 * whose leading six characters the four-head filter accepts, so a replay that
 * only filters on the head runs them. These are the contended objects.
 */
const GROUP_A: ReadonlyArray<readonly [string, Match]> = [
  [
    'ALTER TABLE public."team" ADD COLUMN slug',
    startsWith('ALTER TABLE public."team" ADD COLUMN IF NOT EXISTS slug'),
  ],
  [
    'ALTER TABLE public."team" ALTER COLUMN slug SET NOT NULL',
    startsWith('ALTER TABLE public."team" ALTER COLUMN slug SET NOT NULL'),
  ],
  [
    "CREATE UNIQUE INDEX team_slug_uniq_in_org",
    startsWith("CREATE UNIQUE INDEX IF NOT EXISTS team_slug_uniq_in_org"),
  ],
  [
    "CREATE UNIQUE INDEX member_org_user_uniq",
    startsWith("CREATE UNIQUE INDEX IF NOT EXISTS member_org_user_uniq"),
  ],
  [
    "DROP TRIGGER user_slug_move_trg",
    startsWith("DROP TRIGGER IF EXISTS user_slug_move_trg"),
  ],
  ["CREATE TRIGGER user_slug_move_trg", startsWith("CREATE TRIGGER user_slug_move_trg")],
  [
    "DROP TRIGGER team_slug_move_trg",
    startsWith("DROP TRIGGER IF EXISTS team_slug_move_trg"),
  ],
  ["CREATE TRIGGER team_slug_move_trg", startsWith("CREATE TRIGGER team_slug_move_trg")],
  [
    "DROP TRIGGER org_slug_move_trg",
    startsWith("DROP TRIGGER IF EXISTS org_slug_move_trg"),
  ],
  ["CREATE TRIGGER org_slug_move_trg", startsWith("CREATE TRIGGER org_slug_move_trg")],
  [
    // The one statement that spells the shared schema QUOTED. It provisions an
    // app-owned column on the auth-owned session table, so its target is a
    // shared table like the rest of this group — an unquoted-schema test reads
    // it as schema-local and replays it, which is the whole point of pinning it
    // here by its literal text.
    'ALTER TABLE IF EXISTS "public"."session" ADD COLUMN cinatra_db_created_at',
    startsWith('ALTER TABLE IF EXISTS "public"."session"'),
  ],
];

/**
 * GROUP B — statements that name a shared `public` table as their target but
 * whose leading six characters the four-head filter never accepts (`UPDATE`,
 * and the `DO $body$` blocks, whose head reads `DO $BO`). The helper neither
 * replays nor needs to skip them; these arms RECORD that, so a future change to
 * the head filter cannot quietly start replaying them.
 */
const GROUP_B: ReadonlyArray<readonly [string, Match]> = [
  ['UPDATE public."team" SET slug', startsWith('UPDATE public."team"')],
  ["DO block adding the team_slug_format CHECK", contains("ADD CONSTRAINT team_slug_format")],
  ['DO block deleting duplicate public."member" rows', contains('DELETE FROM public."member"')],
];

describe("shared-public selection — GROUP A is skipped", () => {
  for (const [name, match] of GROUP_A) {
    it(`${name} is accepted by the head filter and skipped by the helper`, () => {
      const text = only(match);
      expect(isReplayedHead(text)).toBe(true);
      expect(targetsSharedPublicTable(text)).toBe(true);
      expect(isSelected(text)).toBe(false);
    });
  }
});

describe("shared-public selection — GROUP B is never selected at all", () => {
  for (const [name, match] of GROUP_B) {
    it(`${name} is rejected by the head filter, so no skip is needed`, () => {
      const text = only(match);
      expect(isReplayedHead(text)).toBe(false);
      expect(isSelected(text)).toBe(false);
    });
  }
});

describe("shared-public selection — what the helper must keep", () => {
  it('keeps the schema-local function whose BODY updates public."team"', () => {
    // GROUP C. The skip is anchored on the statement's LEADING command for
    // exactly this statement: an unanchored search for `UPDATE public."` would
    // match inside this function body and stop the schema under test getting a
    // function it needs.
    const text = only(contains("_decollide_team_slugs() RETURNS void"));
    expect(text).toContain('UPDATE public."team" SET slug = candidate');
    expect(isReplayedHead(text)).toBe(true);
    expect(targetsSharedPublicTable(text)).toBe(false);
    expect(isSelected(text)).toBe(true);
  });

  it("keeps the schema-local project_slug_move_trg trigger pair", () => {
    for (const prefix of [
      "DROP TRIGGER IF EXISTS project_slug_move_trg",
      "CREATE TRIGGER project_slug_move_trg",
    ]) {
      const text = only(startsWith(prefix));
      expect(targetsSharedPublicTable(text)).toBe(false);
      expect(isSelected(text)).toBe(true);
    }
  });

  it("keeps schema-local function bodies that READ a shared public table", () => {
    const reading = STATEMENTS.filter(
      (statement) =>
        isReplayedHead(statement.text) && /FROM\s+public\s*\.\s*"/i.test(statement.text),
    );
    expect(reading.length).toBeGreaterThan(0);
    for (const statement of reading) {
      expect(targetsSharedPublicTable(statement.text)).toBe(false);
      expect(isSelected(statement.text)).toBe(true);
    }
  });

  it('does not read `REFERENCES public."user"(id) ON DELETE CASCADE` as an ON clause', () => {
    // The ON test applies to a TRIGGER or an INDEX only, so a foreign key's
    // `ON DELETE` action can never be mistaken for `ON <shared table>`. These
    // statements sit inside `DO $body$` blocks, which the head filter rejects,
    // so the helper leaves their handling exactly as it is today.
    const referencing = STATEMENTS.filter((statement) =>
      statement.text.includes('REFERENCES public."user"(id) ON DELETE CASCADE'),
    );
    expect(referencing.length).toBeGreaterThan(0);
    for (const statement of referencing) {
      expect(targetsSharedPublicTable(statement.text)).toBe(false);
    }
  });
});

describe("shared-public selection — the invariants of the whole replay", () => {
  it("selects nothing whose own target is a shared public table", () => {
    expect(SELECTED.length).toBeGreaterThan(0);
    expect(
      SELECTED.filter((statement) => targetsSharedPublicTable(statement.text)).map(
        (statement) => statement.text,
      ),
    ).toEqual([]);
  });

  it("selects only the four accepted statement heads", () => {
    expect(
      SELECTED.filter((statement) => !isReplayedHead(statement.text)).map(
        (statement) => statement.text,
      ),
    ).toEqual([]);
  });

  it("drops exactly the head-accepted shared-public statements this suite names", () => {
    const headAccepted = STATEMENTS.filter((statement) => isReplayedHead(statement.text));
    const dropped = headAccepted.filter((statement) =>
      targetsSharedPublicTable(statement.text),
    );
    expect(dropped).toHaveLength(GROUP_A.length);
    expect(headAccepted.length - SELECTED.length).toBe(GROUP_A.length);
  });

  it("selects no statement whose target names the shared schema, in EITHER spelling", () => {
    // Written WITHOUT the helper's own predicate on purpose: an arm that asks
    // `targetsSharedPublicTable` which statements target a shared table cannot
    // catch a spelling that predicate does not know about. This one reads the
    // selected text directly.
    const offenders = SELECTED.map((statement) => statement.text.trim()).filter((text) => {
      const head = /^(?:ALTER\s+TABLE|DROP\s+TABLE|UPDATE|DELETE\s+FROM|INSERT\s+INTO|TRUNCATE)\b/i;
      const target = text.slice(0, 200);
      const namesShared =
        target.includes('public."') || target.includes('"public"."');
      if (head.test(text) && namesShared) return true;
      return /\bON\s+"?public"?\s*\.\s*"/i.test(target) && /\b(?:TRIGGER|INDEX)\b/i.test(text.slice(0, 60));
    });
    expect(offenders).toEqual([]);
  });

  it("keeps the builder's order", () => {
    const order = STATEMENTS.filter(
      (statement) =>
        isReplayedHead(statement.text) && !targetsSharedPublicTable(statement.text),
    ).map((statement) => statement.text);
    expect(SELECTED.map((statement) => statement.text)).toEqual(order);
  });
});

describe("shared-public selection — the per-call accepted head", () => {
  // The copied loops were NOT all the same: three of them also accepted the
  // head of an anonymous `DO $$ BEGIN` block, because the bootstrap creates its
  // ENUM types in those blocks and the tables that reference the types need
  // them. The helper serves both shapes from one module by taking the extra
  // head as a per-call option, so a file that asked for the blocks still gets
  // them and a file that did not still does not.
  const DO_HEAD = "DO $$ ";
  const WITH_DO = { additionalHeads: [DO_HEAD] } as const;
  const doBlocks = STATEMENTS.filter(
    (statement) => statement.text.trim().slice(0, 6).toUpperCase() === DO_HEAD,
  );
  const withDo = selectReplayStatements(STATEMENTS, WITH_DO);

  it("has blocks to argue about", () => {
    expect(doBlocks.length).toBeGreaterThan(0);
  });

  it("a caller that does not name the head receives no block", () => {
    for (const statement of doBlocks) {
      expect(isReplayedHead(statement.text)).toBe(false);
      expect(isSelected(statement.text)).toBe(false);
    }
  });

  it("a caller that names the head receives every block, and nothing else", () => {
    for (const statement of doBlocks) {
      expect(isReplayedHead(statement.text, WITH_DO)).toBe(true);
      expect(withDo.some((selected) => selected.text === statement.text)).toBe(true);
    }
    expect(withDo.length).toBe(SELECTED.length + doBlocks.length);
  });

  it("no block the option admits targets a shared public table", () => {
    // Measured, not assumed: if one ever did, it would be a contended object
    // this replay hands back to the three callers that need the block, and it
    // would have to be argued in the change's record rather than skipped here.
    expect(
      doBlocks
        .filter((statement) => targetsSharedPublicTable(statement.text))
        .map((statement) => statement.text),
    ).toEqual([]);
  });

  it("the shared-public skip still applies when the option is on", () => {
    expect(
      withDo.filter((statement) => targetsSharedPublicTable(statement.text)),
    ).toEqual([]);
  });

  it("a head that is not six characters long matches nothing", () => {
    // Four of the re-pointed files spelled their fifth head `DO $$` — five
    // characters, which can never equal a six-character head. The option keeps
    // that harmless rather than quietly widening those files' replay.
    const fiveCharacters = { additionalHeads: ["DO $$"] } as const;
    expect(selectReplayStatements(STATEMENTS, fiveCharacters).map((s) => s.text)).toEqual(
      SELECTED.map((s) => s.text),
    );
  });
});

describe("shared-public selection — the target clause is the statement's own", () => {
  it("does not read a shared table named inside a quoted argument as a target", () => {
    // A trigger's `EXECUTE FUNCTION` arguments are text the statement passes
    // on, never an object it locks. The builder emits no such statement today;
    // this arm keeps the distinction from being lost if it ever does.
    const local =
      'CREATE TRIGGER x AFTER UPDATE ON "s"."t" FOR EACH ROW EXECUTE FUNCTION s.f(\'ON public."team"\')';
    expect(targetsSharedPublicTable(local)).toBe(false);
  });

  it("still reads a real ON clause on a shared table as a target", () => {
    for (const shared of [
      'CREATE TRIGGER x AFTER UPDATE ON public."team" FOR EACH ROW EXECUTE FUNCTION s.f()',
      'CREATE UNIQUE INDEX IF NOT EXISTS x ON "public"."member" (org_id)',
      'ALTER TABLE IF EXISTS "public"."session" ADD COLUMN IF NOT EXISTS c timestamptz',
    ]) {
      expect(targetsSharedPublicTable(shared)).toBe(true);
    }
  });
});

describe("the replay itself — what reaches the client", () => {
  type Call = { text: string; values: unknown[] };

  function fakeClient(fail?: (call: Call, seen: number) => unknown) {
    const calls: Call[] = [];
    return {
      calls,
      async query(text: string, values?: unknown[]): Promise<unknown> {
        const call = { text, values: values ?? [] };
        calls.push(call);
        const seen = calls.filter((c) => c.text === text).length;
        const err = fail?.(call, seen);
        if (err) throw err;
        return { rows: [] };
      },
    };
  }

  const LOCAL = { text: 'CREATE TABLE "s"."t" (id text)', values: ["a"] };
  const SHARED = { text: 'ALTER TABLE IF EXISTS "public"."session" ADD COLUMN c text' };
  const SEED = { text: 'INSERT INTO "s"."t" VALUES (1)' };

  it("runs the selected statements in order and forwards their values", async () => {
    const client = fakeClient();
    await replayStoreSchema(client, [LOCAL, SHARED, SEED]);
    expect(client.calls).toEqual([{ text: LOCAL.text, values: ["a"] }]);
  });

  it("tolerates a does-not-exist and an already-exists error and goes on", async () => {
    const second = { text: 'CREATE INDEX i ON "s"."t" (id)' };
    const client = fakeClient((call) =>
      call.text === LOCAL.text
        ? new Error('relation "x" does not exist')
        : new Error('relation "i" already exists'),
    );
    await expect(replayStoreSchema(client, [LOCAL, second])).resolves.toBeUndefined();
    expect(client.calls).toHaveLength(2);
  });

  it("propagates any other error", async () => {
    const client = fakeClient(() => new Error("syntax error at or near"));
    await expect(replayStoreSchema(client, [LOCAL])).rejects.toThrow("syntax error");
  });

  it("retries a deadlock victim exactly once, then propagates", async () => {
    const once = fakeClient((_call, seen) =>
      seen === 1 ? Object.assign(new Error("deadlock detected"), { code: "40P01" }) : undefined,
    );
    await replayStoreSchema(once, [LOCAL]);
    expect(once.calls).toHaveLength(2);

    const always = fakeClient(() =>
      Object.assign(new Error("deadlock detected"), { code: "40P01" }),
    );
    await expect(replayStoreSchema(always, [LOCAL])).rejects.toThrow("deadlock detected");
    expect(always.calls).toHaveLength(2);
  });
});
