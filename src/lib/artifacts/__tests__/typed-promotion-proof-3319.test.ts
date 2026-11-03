/**
 * cinatra#3319 / cinatra#4266 — the typed promotion store appends a promotion
 * revision ONLY on proof that the promotion retyped the row.
 *
 * The proof is the row's LATEST type change: it must land in the target type, in
 * this organization, and carry the key the promotion's own retype records,
 * `typed-promotion:<promotion revision id>:<the event's base version>`. A
 * restore, a merge, a native type, the person's standing assertion and a later
 * move away are no proof, and a failed proof read throws.
 *
 * The real store runs. Its database is a fake that answers the four statements
 * the store sends (the row read, the matcher read, the proof read and the append
 * transaction) and records every append. The proof read's SQL itself runs on a
 * real database in lifecycle-c-w4-object-backed-and-promotion.integration.test.ts.
 *
 *   pnpm exec vitest run src/lib/artifacts/__tests__/typed-promotion-proof-3319.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { promotionRevisionId } from "../typed-promotion";

const ORG = "org-3319";
const ART = "art-3319";
const RES = "res-3319";
const PRINCIPAL = "u-3319";
const EXT = "@acme/voice";
const BASE_TYPE = "@cinatra-ai/markdown-artifact:artifact";
const OWN_TYPE = "@acme/voice:brief";
const OTHER_TYPE = "@acme/other:thing";
const OWN = { typeId: OWN_TYPE, acceptsMimes: ["text/markdown"] };

type EventRow = {
  object_type: string;
  before_type: string | null;
  base_version: unknown;
  result_version: unknown;
  idempotency_key: string;
  org_id: string;
};

const db = vi.hoisted(() => ({
  row: null as null | { type: string; version: number },
  matcher: null as null | number,
  personAsserted: false,
  events: [] as Array<Record<string, unknown>>,
  proofThrows: false,
  revisionPresent: false,
  appends: [] as unknown[][],
  /** The row's content revisions, oldest first (the row read names the last). */
  reps: [] as Array<{ id: string; resource: string }>,
  /** Runs once the proof read has selected its rows (a concurrent writer). */
  afterProofRead: null as null | (() => void),
  /** How the proof read's result is missing, when it is. */
  proofAnswer: "rows" as "rows" | "no-result" | "no-rows",
}));

vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://stub",
  postgresSchema: "cinatra_test",
}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (input: { queries: Array<{ text: string; values?: unknown[] }> }) => {
    const text = input.queries[0]?.text ?? "";
    if (text.includes("pg_advisory_xact_lock")) {
      // The insert's own guard, as Postgres runs it: `1 / 0` when the latest
      // revision is not the one the row read named, which aborts the whole
      // transaction. A statement without the guard always inserts.
      const insert = input.queries.find((q) => q.text.includes('INSERT INTO "cinatra_test"."representation"'));
      const values = insert?.values ?? [];
      if (insert?.text.includes("latest.id") && values[6] !== db.reps.at(-1)?.id) {
        throw new Error("division by zero");
      }
      db.appends.push(values);
      const landed = !db.revisionPresent;
      db.revisionPresent = true;
      if (landed) db.reps.push({ id: String(values[0]), resource: String(values[3]) });
      return input.queries.map((q) =>
        q === insert && landed ? { rows: [{ revision: db.reps.length }] } : { rows: [] },
      );
    }
    if (text.includes('"object_change_event"')) {
      if (db.proofThrows) throw new Error("history read failed");
      if (db.proofAnswer === "no-result") return [];
      if (db.proofAnswer === "no-rows") return [{}];
      const rows = [...db.events];
      db.afterProofRead?.();
      return [{ rows }];
    }
    if (text.includes('"semantic_assertion"')) {
      return [{ rows: db.matcher === null ? [] : [{ confidence: db.matcher }] }];
    }
    if (text.includes('"objects" o')) {
      return [
        {
          rows: db.row
            ? [
                {
                  type: db.row.type,
                  version: db.row.version,
                  data: { title: "an upload" },
                  rep_id: db.reps.at(-1)!.id,
                  resource_id: db.reps.at(-1)!.resource,
                  form: "file",
                  mime: "text/markdown",
                },
              ]
            : [],
        },
      ];
    }
    throw new Error(`unexpected statement: ${text.slice(0, 60)}`);
  },
}));
vi.mock("@/lib/artifacts/semantic-assertion-store", () => ({
  listActiveAssertions: () =>
    db.personAsserted
      ? [
          {
            extension: EXT,
            assertedBy: "user",
            assertionBasis: "classic",
            assertedByPrincipal: PRINCIPAL,
          },
        ]
      : [],
}));
// The production retype: the canonical writer, recorded. It records the change
// event with the key it is given, as the real writer does.
const historyAwareUpsert = vi.fn(
  (input: { type: string }, options: { expectedBaseVersion: number; idempotencyKey?: string }) => {
    const before = db.row!.type;
    db.row = { type: input.type, version: options.expectedBaseVersion + 1 };
    db.events.push(
      event({
        type: input.type,
        before,
        base: options.expectedBaseVersion,
        key: options.idempotencyKey ?? "evt-generated",
      }),
    );
  },
);
vi.mock("@/lib/object-history/canonical-writer", () => ({
  historyAwareUpsert: (...a: unknown[]) =>
    historyAwareUpsert(...(a as Parameters<typeof historyAwareUpsert>)),
}));
vi.mock("@/lib/object-history/errors", () => ({ VersionConflictError: class extends Error {} }));
vi.mock("@/lib/org-write/authority", () => ({ OrgWriteAuthorityError: class extends Error {} }));

/** The key the promotion's own retype records for a retype from `base`. */
function promotionKey(base: number, over: { resource?: string; type?: string } = {}): string {
  const id = promotionRevisionId({
    artifactId: ART,
    sharedResourceId: over.resource ?? RES,
    toType: over.type ?? OWN_TYPE,
  });
  return `typed-promotion:${id}:${base}`;
}
function event(input: {
  type: string;
  before: string | null;
  base: unknown;
  result?: unknown;
  key: string;
  org?: string;
}): EventRow {
  return {
    object_type: input.type,
    before_type: input.before,
    base_version: input.base,
    result_version:
      input.result ?? (typeof input.base === "number" ? input.base + 1 : 1),
    idempotency_key: input.key,
    org_id: input.org ?? ORG,
  };
}
const created = (type: string) => event({ type, before: null, base: null, result: 1, key: "evt-create" });
const keyedRetype = (base = 3) =>
  event({ type: OWN_TYPE, before: BASE_TYPE, base, key: promotionKey(base) });

const AUTHORITY = { orgId: ORG } as never;
type PromoteArgs = Parameters<
  (typeof import("../typed-promotion-store"))["promoteMatchedArtifactType"]
>[0];
function args(over: Partial<PromoteArgs> = {}): PromoteArgs {
  return {
    orgId: ORG,
    artifactId: ART,
    extension: EXT,
    ownType: OWN,
    threshold: 0.7,
    confirmed: true,
    createdBy: PRINCIPAL,
    principal: PRINCIPAL,
    actor: { userId: PRINCIPAL, orgId: ORG },
    authority: AUTHORITY,
    ...over,
  };
}
/** A row that already carries the pack's own type, with the person's own
 *  assertion standing: every condition of the converging road but the proof. */
function convergingRow(events: Array<Record<string, unknown>>): void {
  db.row = { type: OWN_TYPE, version: 4 };
  db.personAsserted = true;
  db.events = events;
}
async function store() {
  return import("../typed-promotion-store");
}

beforeEach(() => {
  db.row = null;
  db.matcher = null;
  db.personAsserted = false;
  db.events = [];
  db.proofThrows = false;
  db.revisionPresent = false;
  db.appends = [];
  db.reps = [{ id: "rep_base", resource: RES }];
  db.afterProofRead = null;
  db.proofAnswer = "rows";
  historyAwareUpsert.mockClear();
});

describe("the converging road appends only on the promotion's own keyed retype", () => {
  it("P1: an interrupted promotion (its keyed retype on record, no revision) gets exactly one revision, and a second confirmation adds none (green at base)", async () => {
    convergingRow([keyedRetype(3), created(BASE_TYPE)]);
    const { promoteMatchedArtifactType } = await store();
    const first = await promoteMatchedArtifactType(args());
    expect(first).toMatchObject({ ok: true, revision: 2, toType: OWN_TYPE, retyped: false });
    expect(await promoteMatchedArtifactType(args())).toEqual({
      ok: false,
      reason: "already-promoted",
    });
    expect(db.appends).toHaveLength(2);
    expect(db.revisionPresent).toBe(true);
  });

  it("P2: a content edit after the keyed retype is no type change, so the proof still holds (green at base)", async () => {
    convergingRow([
      keyedRetype(3),
      event({ type: OWN_TYPE, before: OWN_TYPE, base: 4, key: "evt-edit" }),
    ]);
    const { promoteMatchedArtifactType } = await store();
    expect(await promoteMatchedArtifactType(args())).toMatchObject({ ok: true, revision: 2 });
  });

  it("4266: a row typed from upload, its own meaning confirmed twice, gains no revision", async () => {
    convergingRow([created(OWN_TYPE)]);
    const { promoteMatchedArtifactType } = await store();
    for (let i = 0; i < 2; i += 1) {
      expect(await promoteMatchedArtifactType(args())).toEqual({
        ok: false,
        reason: "already-promoted",
      });
    }
    expect(db.appends).toEqual([]);
  });

  it("R12-MF2a: a restore back into the type (a generic key) is no proof", async () => {
    convergingRow([
      created(OWN_TYPE),
      event({ type: OTHER_TYPE, before: OWN_TYPE, base: 1, key: "evt-move" }),
      event({ type: OWN_TYPE, before: OTHER_TYPE, base: 2, key: "restore:evt-7" }),
    ]);
    const { promoteMatchedArtifactType } = await store();
    expect(await promoteMatchedArtifactType(args())).toEqual({
      ok: false,
      reason: "already-promoted",
    });
    expect(db.appends).toEqual([]);
  });

  it("R12-MF2b: a keyed promotion into another type is no proof for this one", async () => {
    convergingRow([
      event({
        type: OTHER_TYPE,
        before: BASE_TYPE,
        base: 3,
        key: promotionKey(3, { type: OTHER_TYPE }),
      }),
    ]);
    const { promoteMatchedArtifactType } = await store();
    expect(await promoteMatchedArtifactType(args())).toEqual({
      ok: false,
      reason: "already-promoted",
    });
    expect(db.appends).toEqual([]);
  });

  it("R12-MF2c: a key made for another resource is no proof", async () => {
    convergingRow([
      event({
        type: OWN_TYPE,
        before: BASE_TYPE,
        base: 3,
        key: promotionKey(3, { resource: "res-other" }),
      }),
    ]);
    const { promoteMatchedArtifactType } = await store();
    expect(await promoteMatchedArtifactType(args())).toEqual({
      ok: false,
      reason: "already-promoted",
    });
    expect(db.appends).toEqual([]);
  });

  it("R12-MF2d: a key made for another base version than the event's own is no proof", async () => {
    convergingRow([event({ type: OWN_TYPE, before: BASE_TYPE, base: 4, key: promotionKey(3) })]);
    const { promoteMatchedArtifactType } = await store();
    expect(await promoteMatchedArtifactType(args())).toEqual({
      ok: false,
      reason: "already-promoted",
    });
    expect(db.appends).toEqual([]);
  });

  it("R12-MF2e: an event of another organization is no proof", async () => {
    convergingRow([
      event({ type: OWN_TYPE, before: BASE_TYPE, base: 3, key: promotionKey(3), org: "org-other" }),
    ]);
    const { promoteMatchedArtifactType } = await store();
    expect(await promoteMatchedArtifactType(args())).toEqual({
      ok: false,
      reason: "already-promoted",
    });
    expect(db.appends).toEqual([]);
  });

  it("R11a: a failed proof read throws and appends nothing", async () => {
    convergingRow([keyedRetype(3)]);
    db.proofThrows = true;
    const { promoteMatchedArtifactType } = await store();
    await expect(promoteMatchedArtifactType(args())).rejects.toThrow("history read failed");
    expect(db.appends).toEqual([]);
  });

  it("R11b: only the LATEST type change counts, whatever order the rows come in: a move away and back after the keyed retype is no proof", async () => {
    convergingRow([
      event({ type: OWN_TYPE, before: OTHER_TYPE, base: 6, key: "restore:evt-9" }),
      keyedRetype(3),
      event({ type: OTHER_TYPE, before: OWN_TYPE, base: 4, key: "evt-move" }),
    ]);
    const { promoteMatchedArtifactType } = await store();
    expect(await promoteMatchedArtifactType(args())).toEqual({
      ok: false,
      reason: "already-promoted",
    });
    expect(db.appends).toEqual([]);
  });

  it("C2b-null: an event with no base version is no proof, even with a promotion key", async () => {
    convergingRow([event({ type: OWN_TYPE, before: BASE_TYPE, base: null, result: 4, key: promotionKey(0) })]);
    const { promoteMatchedArtifactType } = await store();
    expect(await promoteMatchedArtifactType(args())).toEqual({
      ok: false,
      reason: "already-promoted",
    });
    expect(db.appends).toEqual([]);
  });

  it("C2b-string: versions the driver answers as text still prove (green at base)", async () => {
    convergingRow([
      event({ type: OWN_TYPE, before: BASE_TYPE, base: "3", result: "4", key: promotionKey(3) }),
    ]);
    const { promoteMatchedArtifactType } = await store();
    expect(await promoteMatchedArtifactType(args())).toMatchObject({ ok: true, revision: 2 });
  });

  it("C2c: on proof, a revision that is already present lands nothing and the road refuses (green at base)", async () => {
    convergingRow([keyedRetype(3)]);
    db.revisionPresent = true;
    const { promoteMatchedArtifactType } = await store();
    expect(await promoteMatchedArtifactType(args())).toEqual({
      ok: false,
      reason: "already-promoted",
    });
    expect(db.appends).toHaveLength(1);
  });

  it("C2f: a latest type change whose result version the driver answers unreadably is no proof, however its key reads", async () => {
    const { promoteMatchedArtifactType } = await store();
    for (const unreadable of [null, undefined, "abc", "4.5", "-1", 4.5, Number.NaN]) {
      // `event` falls back to base + 1 for a missing result, so set it after.
      convergingRow([{ ...keyedRetype(3), result_version: unreadable }]);
      expect(await promoteMatchedArtifactType(args())).toEqual({
        ok: false,
        reason: "already-promoted",
      });
    }
    expect(db.appends).toEqual([]);
  });

  it("C2g: no type-change row at all (no rows, or only rows that left the type as it was) is no proof", async () => {
    const { promoteMatchedArtifactType } = await store();
    convergingRow([]);
    expect(await promoteMatchedArtifactType(args())).toEqual({
      ok: false,
      reason: "already-promoted",
    });
    // A data-only update: the row's type before and after are the same.
    convergingRow([
      event({ type: OWN_TYPE, before: OWN_TYPE, base: 3, key: promotionKey(3) }),
    ]);
    expect(await promoteMatchedArtifactType(args())).toEqual({
      ok: false,
      reason: "already-promoted",
    });
    expect(db.appends).toEqual([]);
  });
});

describe("the fresh road keys its retype and appends only on its own proof", () => {
  function baseRow(): void {
    db.row = { type: BASE_TYPE, version: 3 };
    db.matcher = 0.9;
    db.events = [created(BASE_TYPE)];
  }
  type RetypeInput = { toType: string; expectedVersion: number; idempotencyKey?: string };

  it("R8: the retype is handed the promotion's key for the version it is anchored on", async () => {
    baseRow();
    const seen: RetypeInput[] = [];
    const retype = vi.fn(async (input: RetypeInput) => {
      seen.push(input);
      db.events.push(
        event({ type: input.toType, before: BASE_TYPE, base: input.expectedVersion, key: promotionKey(3) }),
      );
      return { ok: true as const };
    });
    const { promoteMatchedArtifactType } = await store();
    await promoteMatchedArtifactType(args({ retype }));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ toType: OWN_TYPE, expectedVersion: 3, idempotencyKey: promotionKey(3) });
  });

  it("P3: a retype that records the key is its own proof: one revision, retyped (green at base)", async () => {
    baseRow();
    const retype = async (input: RetypeInput) => {
      db.events.push(
        event({
          type: input.toType,
          before: BASE_TYPE,
          base: input.expectedVersion,
          key: input.idempotencyKey ?? promotionKey(input.expectedVersion),
        }),
      );
      return { ok: true as const };
    };
    const { promoteMatchedArtifactType } = await store();
    expect(await promoteMatchedArtifactType(args({ retype }))).toMatchObject({
      ok: true,
      revision: 2,
      toType: OWN_TYPE,
      retyped: true,
    });
    expect(db.appends).toHaveLength(1);
  });

  it("P4: another writer moving the row between the retype and the proof read: nothing appended, promotion-unproven", async () => {
    baseRow();
    const retype = async (input: RetypeInput) => {
      db.events.push(
        event({ type: input.toType, before: BASE_TYPE, base: 3, key: promotionKey(3) }),
        event({ type: OTHER_TYPE, before: input.toType, base: 4, key: "evt-other-writer" }),
      );
      return { ok: true as const };
    };
    const { promoteMatchedArtifactType } = await store();
    expect(await promoteMatchedArtifactType(args({ retype }))).toEqual({
      ok: false,
      reason: "promotion-unproven",
    });
    expect(db.appends).toEqual([]);
  });

  it("P5: a retype whose event carries no promotion key proves nothing: nothing appended", async () => {
    baseRow();
    const retype = async (input: RetypeInput) => {
      db.events.push(event({ type: input.toType, before: BASE_TYPE, base: 3, key: "evt-generated" }));
      return { ok: true as const };
    };
    const { promoteMatchedArtifactType } = await store();
    expect(await promoteMatchedArtifactType(args({ retype }))).toEqual({
      ok: false,
      reason: "promotion-unproven",
    });
    expect(db.appends).toEqual([]);
  });

  it("CANON: the production retype passes the key to the canonical writer, whose event then proves the append", async () => {
    baseRow();
    const { promoteMatchedArtifactType } = await store();
    const out = await promoteMatchedArtifactType(args());
    expect(historyAwareUpsert).toHaveBeenCalledTimes(1);
    expect(historyAwareUpsert.mock.calls[0]![1]).toMatchObject({
      expectedBaseVersion: 3,
      idempotencyKey: promotionKey(3),
    });
    expect(out).toMatchObject({ ok: true, retyped: true, revision: 2 });
    expect(db.appends).toHaveLength(1);
  });
});

/** A content editor's revision over its own resource (the editor's append). */
const EDITOR_REP = { id: "rep_editor", resource: "res-editor" };
const repIds = () => db.reps.map((r) => r.id);

describe("C4: a content writer after the row read is never superseded by the promotion's stale resource", () => {
  it("C4a: the fresh road, an editor appending between the retype and the append: nothing appended, representation-moved, the editor's revision stays latest", async () => {
    db.row = { type: BASE_TYPE, version: 3 };
    db.matcher = 0.9;
    db.events = [created(BASE_TYPE)];
    const retype = async (input: { toType: string; expectedVersion: number; idempotencyKey?: string }) => {
      db.events.push(
        event({ type: input.toType, before: BASE_TYPE, base: 3, key: input.idempotencyKey ?? promotionKey(3) }),
      );
      db.reps.push(EDITOR_REP);
      return { ok: true as const };
    };
    const { promoteMatchedArtifactType } = await store();
    expect(await promoteMatchedArtifactType(args({ retype }))).toEqual({
      ok: false,
      reason: "representation-moved",
    });
    expect(repIds()).toEqual(["rep_base", "rep_editor"]);
  });

  it("C4b: the converging road, an editor appending between the proof read and the append: nothing appended, the editor's revision stays latest", async () => {
    convergingRow([keyedRetype(3)]);
    db.afterProofRead = () => db.reps.push(EDITOR_REP);
    const { promoteMatchedArtifactType } = await store();
    expect(await promoteMatchedArtifactType(args())).toEqual({
      ok: false,
      reason: "already-promoted",
    });
    expect(repIds()).toEqual(["rep_base", "rep_editor"]);
  });

  it("C4c: the accepted type-only window, a move away after the proof read: the revision lands over the base content and supersedes no content (green at base)", async () => {
    convergingRow([keyedRetype(3)]);
    db.afterProofRead = () =>
      db.events.push(event({ type: OTHER_TYPE, before: OWN_TYPE, base: 4, key: "evt-move" }));
    const { promoteMatchedArtifactType } = await store();
    expect(await promoteMatchedArtifactType(args())).toMatchObject({ ok: true, revision: 2 });
    expect(db.reps.map((r) => r.resource)).toEqual([RES, RES]);
  });
});

describe("C1/C2: a version is a nonnegative safe integer or its digits, and nothing else", () => {
  const NOT_VERSIONS: unknown[] = [
    "9007199254740993", "9".repeat(400), -1, 4.5, "4.5", "1e3", Number.POSITIVE_INFINITY, " 3", "3 ", "\t3",
    "+1", "-1", "", true, {}, [3], BigInt(3),
  ];
  const refused = { ok: false, reason: "already-promoted" };

  it("C1a: a result version that is not one is no proof, however its key reads (red at cfd83771 for the unsafe digits and -1)", async () => {
    const { promoteMatchedArtifactType } = await store();
    for (const result of NOT_VERSIONS) {
      convergingRow([{ ...keyedRetype(3), result_version: result }]);
      expect(await promoteMatchedArtifactType(args()), String(result)).toEqual(refused);
    }
    expect(db.appends).toEqual([]);
  });

  it("C1b: a base version that is not one is no proof, even under the key a lenient parse would make (red at cfd83771 for the unsafe digits and -1)", async () => {
    const { promoteMatchedArtifactType } = await store();
    for (const base of NOT_VERSIONS) {
      const lenient = typeof base === "string" ? Number(base) : Number(base as number);
      convergingRow([event({ type: OWN_TYPE, before: BASE_TYPE, base, result: 5, key: promotionKey(lenient) })]);
      expect(await promoteMatchedArtifactType(args()), String(base)).toEqual(refused);
    }
    expect(db.appends).toEqual([]);
  });

  it("C1c: digits and safe integers up to the safe maximum still prove (green at base)", async () => {
    const { promoteMatchedArtifactType } = await store();
    for (const base of ["0", 0, "9007199254740991", Number.MAX_SAFE_INTEGER]) {
      db.revisionPresent = false;
      db.reps = [{ id: "rep_base", resource: RES }];
      convergingRow([event({ type: OWN_TYPE, before: BASE_TYPE, base, result: "5", key: promotionKey(Number(base)) })]);
      expect(await promoteMatchedArtifactType(args()), String(base)).toMatchObject({ ok: true, revision: 2 });
    }
  });

  it("NOTE-278: a proof read with no result, or a result with no rows, is no proof (green at base)", async () => {
    const { promoteMatchedArtifactType } = await store();
    for (const answer of ["no-result", "no-rows"] as const) {
      convergingRow([keyedRetype(3)]);
      db.proofAnswer = answer;
      expect(await promoteMatchedArtifactType(args()), answer).toEqual(refused);
    }
    expect(db.appends).toEqual([]);
  });
});
