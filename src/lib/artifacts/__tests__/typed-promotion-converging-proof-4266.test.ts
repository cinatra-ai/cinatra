/**
 * cinatra#4266 — a repeated type confirmation on a natively typed file must not
 * append a promotion revision that never happened.
 *
 * THE SENTENCE (specs/app-artifacts.html §VI.1): "it is a user-sourced meaning
 * assertion over those types, never a re-type".
 *
 * THE FAULT ON MAIN. The converging branch of `promoteMatchedArtifactType`
 * treated every `already-promoted` row as one an earlier call retyped and never
 * appended for. A row that carried the pack's type from its upload, confirmed
 * again (a crafted call, a stale second picker), therefore gained a "promoted"
 * revision for a promotion that never ran.
 *
 * THE FIX. The branch appends only when stored state proves that this road
 * retyped the row: the change event its retype commits through the canonical
 * history-aware writer (`provesPromotionRetype`).
 *
 * THE TIER. The road runs end to end over an in-memory stand-in for the four
 * statements it issues (row read, matcher read, change-event read, append
 * transaction). The append keeps the real statement's `ON CONFLICT (id) DO
 * NOTHING` and `MAX + 1` semantics. The change-event read returns every event of
 * the row (by id and org) and leaves the decision to the code under test. The
 * real-database tier (lifecycle-c-w4-object-backed-and-promotion.integration)
 * proves the SQL against Postgres.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const SCHEMA = "cinatra_test_4266";
const ORG = "org-4266";
const EXT = "@cinatra-ai/campaigns-artifact";
const BASE_TYPE = "@cinatra-ai/text-artifact:text";
const OWN_TYPE = "@cinatra-ai/campaigns:voice";

type Rep = { id: string; artifactId: string; resourceId: string; revision: number; form: string };
type Ev = {
  objectId: string;
  orgId: string;
  operation: string;
  history_effect: string;
  object_type: string;
  before_snapshot: unknown;
  after_snapshot: unknown;
  tombstoned_at: string | null;
};

const db = vi.hoisted(() => ({
  objects: new Map<string, { type: string; version: number; data: unknown }>(),
  reps: [] as Array<{ id: string; artifactId: string; resourceId: string; revision: number; form: string }>,
  matcher: new Map<string, number>(),
  persons: new Map<string, string>(),
  events: [] as Array<Record<string, unknown>>,
  proofReads: 0,
}));

vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://stand-in",
  postgresSchema: "cinatra_test_4266",
}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));
vi.mock("@/lib/artifacts/semantic-assertion-store", () => ({
  listActiveAssertions: (_org: string, artifactId: string) => {
    const principal = db.persons.get(artifactId);
    return principal === undefined
      ? []
      : [
          {
            extension: "@cinatra-ai/campaigns-artifact",
            assertedBy: "user",
            assertionBasis: "classic",
            assertedByPrincipal: principal,
          },
        ];
  },
}));
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (input: { queries: Array<{ text: string; values: unknown[] }> }) =>
    input.queries.map((q) => {
      const t = q.text;
      const v = q.values;
      if (/FROM "cinatra_test_4266"\."objects" o/.test(t)) {
        const o = db.objects.get(String(v[0]));
        if (!o || v[1] !== "org-4266") return { rows: [] };
        const latest = db.reps
          .filter((r) => r.artifactId === v[0])
          .sort((a, b) => b.revision - a.revision)[0];
        return {
          rows: [
            {
              type: o.type,
              version: o.version,
              data: o.data,
              rep_id: latest?.id ?? null,
              resource_id: latest?.resourceId ?? null,
              form: latest?.form ?? null,
              mime: "text/markdown",
            },
          ],
        };
      }
      if (/"semantic_assertion"/.test(t) && /asserted_by = 'matcher'/.test(t)) {
        const c = db.matcher.get(String(v[1]));
        return { rows: c === undefined ? [] : [{ confidence: c }] };
      }
      if (/"object_change_event"/.test(t)) {
        db.proofReads += 1;
        return {
          rows: db.events.filter((e) => e.objectId === v[0] && e.orgId === v[1]),
        };
      }
      if (/pg_advisory_xact_lock/.test(t)) return { rows: [] };
      if (/INSERT INTO "cinatra_test_4266"\."representation"/.test(t)) {
        const [id, , artifactId, resourceId, form] = v as string[];
        if (db.reps.some((r) => r.id === id)) return { rows: [] };
        const revision =
          Math.max(0, ...db.reps.filter((r) => r.artifactId === artifactId).map((r) => r.revision)) + 1;
        db.reps.push({ id, artifactId, resourceId, revision, form });
        return { rows: [{ id, revision }] };
      }
      if (/"artifact_audit"/.test(t)) return { rows: [] };
      throw new Error(`unexpected statement in the stand-in: ${t.slice(0, 80)}`);
    }),
}));

import {
  buildPromotionRetypeProofQuery,
  promoteMatchedArtifactType,
} from "@/lib/artifacts/typed-promotion-store";
import {
  PROMOTION_RETYPE_HISTORY_EFFECT,
  promotionRevisionId,
  provesPromotionRetype,
  type PromotionRetypeEvent,
} from "@/lib/artifacts/typed-promotion";

const DATA = { title: "an upload" };

function seedRow(id: string, type: string) {
  db.objects.set(id, { type, version: 1, data: DATA });
  db.reps.push({ id: `rep-base-${id}`, artifactId: id, resourceId: `res-${id}`, revision: 1, form: "file" });
}

/** The change event the canonical writer commits for a write, in its stored shape. */
function seedEvent(id: string, over: Partial<Ev> = {}) {
  db.events.push({
    objectId: id,
    orgId: ORG,
    operation: "update",
    history_effect: PROMOTION_RETYPE_HISTORY_EFFECT,
    object_type: OWN_TYPE,
    before_snapshot: { id, type: BASE_TYPE, data: DATA, version: 1 },
    after_snapshot: { id, type: OWN_TYPE, data: DATA, version: 2 },
    tombstoned_at: null,
    ...over,
  });
}

/** The state an interruption between the two writes leaves: the road's retype
 *  committed (row in the target type, its change event stored), no append. */
function seedInterrupted(id: string) {
  seedRow(id, OWN_TYPE);
  db.objects.get(id)!.version = 2;
  seedEvent(id);
}

function revisionsOf(id: string): Rep[] {
  return db.reps.filter((r) => r.artifactId === id).sort((a, b) => a.revision - b.revision);
}

const NEVER_RETYPE = async () => {
  throw new Error("the converging branch must never retype");
};

function confirm(id: string, over: { threshold?: number | null; principal?: string | null } = {}) {
  return promoteMatchedArtifactType({
    orgId: ORG,
    artifactId: id,
    extension: EXT,
    ownType: { typeId: OWN_TYPE, acceptsMimes: ["text/markdown"] },
    threshold: over.threshold === undefined ? 0.8 : over.threshold,
    confirmed: true,
    createdBy: "user-4266",
    principal: over.principal === undefined ? "user-4266" : over.principal,
    actor: { userId: "user-4266", orgId: ORG },
    authority: {} as never,
    retype: NEVER_RETYPE,
  });
}

beforeEach(() => {
  db.objects.clear();
  db.reps.length = 0;
  db.matcher.clear();
  db.persons.clear();
  db.events.length = 0;
  db.proofReads = 0;
});

describe("cinatra#4266: the converging branch appends only on a proven retype", () => {
  it("a row typed from upload, confirmed twice, keeps its revision count", async () => {
    seedRow("obj-native", OWN_TYPE);
    db.matcher.set("obj-native", 0.9);

    const first = await confirm("obj-native");
    const second = await confirm("obj-native");

    expect(revisionsOf("obj-native"), "a promotion revision was appended that never happened").toHaveLength(1);
    expect(first).toEqual({ ok: false, reason: "already-promoted" });
    expect(second).toEqual({ ok: false, reason: "already-promoted" });
  });

  it("returns the same result as a confirmation of an already-confirmed meaning", async () => {
    // The already-confirmed row: promoted by the road, its revision appended.
    seedInterrupted("obj-confirmed");
    db.matcher.set("obj-confirmed", 0.9);
    expect((await confirm("obj-confirmed")).ok).toBe(true);
    const confirmedAgain = await confirm("obj-confirmed");

    seedRow("obj-native-2", OWN_TYPE);
    db.matcher.set("obj-native-2", 0.9);
    const native = await confirm("obj-native-2");

    expect(native).toEqual(confirmedAgain);
    expect(revisionsOf("obj-native-2")).toHaveLength(1);
  });

  it("a row whose every change event carries its current type appends nothing", async () => {
    // A create and a content-only update, both in the pack's own type.
    seedRow("obj-edited", OWN_TYPE);
    db.matcher.set("obj-edited", 0.9);
    seedEvent("obj-edited", {
      operation: "create",
      before_snapshot: null,
      after_snapshot: { type: OWN_TYPE, data: DATA },
    });
    seedEvent("obj-edited", {
      before_snapshot: { type: OWN_TYPE, data: DATA },
      after_snapshot: { type: OWN_TYPE, data: { title: "renamed" } },
    });

    expect(await confirm("obj-edited")).toEqual({ ok: false, reason: "already-promoted" });
    expect(revisionsOf("obj-edited"), "a promotion revision was appended that never happened").toHaveLength(1);
  });

  it("the same holds on the person's own road", async () => {
    seedRow("obj-native-person", OWN_TYPE);
    db.persons.set("obj-native-person", "principal-alice");

    expect(await confirm("obj-native-person", { threshold: null, principal: "principal-alice" })).toEqual({
      ok: false,
      reason: "already-promoted",
    });
    expect(revisionsOf("obj-native-person"), "a promotion revision was appended that never happened").toHaveLength(1);
  });

  it("a row whose retype was interrupted before the append gets exactly one promotion revision", async () => {
    seedInterrupted("obj-interrupted");
    db.matcher.set("obj-interrupted", 0.9);

    const out = await confirm("obj-interrupted");
    expect(out).toMatchObject({ ok: true, retyped: false, revision: 2, toType: OWN_TYPE });
    const revs = revisionsOf("obj-interrupted");
    expect(revs).toHaveLength(2);
    expect(revs[1]!.id).toBe(
      promotionRevisionId({
        artifactId: "obj-interrupted",
        sharedResourceId: "res-obj-interrupted",
        toType: OWN_TYPE,
      }),
    );
    expect(revs[1]!.resourceId).toBe("res-obj-interrupted");

    // A further confirmation lands nothing more.
    expect(await confirm("obj-interrupted")).toEqual({ ok: false, reason: "already-promoted" });
    expect(revisionsOf("obj-interrupted")).toHaveLength(2);
  });

  it("completes an interrupted promotion on the person's own road too", async () => {
    seedInterrupted("obj-interrupted-person");
    db.persons.set("obj-interrupted-person", "principal-alice");

    const out = await confirm("obj-interrupted-person", { threshold: null, principal: "principal-alice" });
    expect(out).toMatchObject({ ok: true, retyped: false, revision: 2 });
    expect(revisionsOf("obj-interrupted-person")).toHaveLength(2);
  });

  it("a proof stored for another organization proves nothing here", async () => {
    seedRow("obj-foreign-proof", OWN_TYPE);
    db.matcher.set("obj-foreign-proof", 0.9);
    seedEvent("obj-foreign-proof", { orgId: "org-other" });

    expect(await confirm("obj-foreign-proof")).toEqual({ ok: false, reason: "already-promoted" });
    expect(revisionsOf("obj-foreign-proof")).toHaveLength(1);
  });

  it("reads no proof when an authority already refuses", async () => {
    // No matcher association and no person's assertion: refused before the read.
    seedInterrupted("obj-no-authority");
    expect(await confirm("obj-no-authority")).toEqual({ ok: false, reason: "already-promoted" });
    expect(db.proofReads).toBe(0);
    expect(revisionsOf("obj-no-authority")).toHaveLength(1);
  });
});

describe("cinatra#4266: provesPromotionRetype reads the road's own retype only", () => {
  const PROOF: PromotionRetypeEvent = {
    operation: "update",
    historyEffect: PROMOTION_RETYPE_HISTORY_EFFECT,
    objectType: OWN_TYPE,
    beforeSnapshot: { type: BASE_TYPE, data: { a: 1, b: [1, 2] } },
    afterSnapshot: { type: OWN_TYPE, data: { b: [1, 2], a: 1 } },
    tombstonedAt: null,
  };
  const with_ = (over: Partial<PromotionRetypeEvent>) => [{ ...PROOF, ...over }];

  it("accepts the road's retype (data equal in any key order, tombstone absent or null)", () => {
    expect(provesPromotionRetype([PROOF], OWN_TYPE)).toBe(true);
    expect(provesPromotionRetype(with_({ tombstonedAt: undefined }), OWN_TYPE)).toBe(true);
    expect(provesPromotionRetype([{ ...PROOF, operation: "create" }, PROOF], OWN_TYPE)).toBe(true);
  });

  it("reads snapshots stored as JSON text, and refuses text it cannot parse", () => {
    expect(
      provesPromotionRetype(
        with_({
          beforeSnapshot: JSON.stringify(PROOF.beforeSnapshot),
          afterSnapshot: JSON.stringify(PROOF.afterSnapshot),
        }),
        OWN_TYPE,
      ),
    ).toBe(true);
    expect(provesPromotionRetype(with_({ beforeSnapshot: "{not json" }), OWN_TYPE)).toBe(false);
    expect(provesPromotionRetype(with_({ afterSnapshot: "[]" }), OWN_TYPE)).toBe(false);
  });

  it.each([
    ["no events", [] as PromotionRetypeEvent[]],
    ["a create", with_({ operation: "create", beforeSnapshot: null })],
    ["a delete", with_({ operation: "delete" })],
    ["an operation in another case", with_({ operation: "UPDATE" })],
    ["another history effect", with_({ historyEffect: "irreversible-external" })],
    ["a missing history effect", with_({ historyEffect: undefined })],
    ["an event of another type", with_({ objectType: BASE_TYPE })],
    ["a tombstoned event", with_({ tombstonedAt: "2026-10-24T00:00:00Z" })],
    ["a missing before snapshot", with_({ beforeSnapshot: null })],
    ["a missing after snapshot", with_({ afterSnapshot: undefined })],
    ["an array snapshot", with_({ beforeSnapshot: [BASE_TYPE] })],
    ["a content-only update", with_({ beforeSnapshot: { type: OWN_TYPE, data: { a: 1, b: [1, 2] } } })],
    ["a before type that is not a string", with_({ beforeSnapshot: { type: 7, data: { a: 1, b: [1, 2] } } })],
    ["an empty before type", with_({ beforeSnapshot: { type: "", data: { a: 1, b: [1, 2] } } })],
    ["a before snapshot with no type", with_({ beforeSnapshot: { data: { a: 1, b: [1, 2] } } })],
    ["an after snapshot in another type", with_({ afterSnapshot: { type: "@x/y:z", data: { a: 1, b: [1, 2] } } })],
    ["a retype that also changed the data", with_({ afterSnapshot: { type: OWN_TYPE, data: { a: 2, b: [1, 2] } } })],
    ["array order changed", with_({ afterSnapshot: { type: OWN_TYPE, data: { a: 1, b: [2, 1] } } })],
    ["a before snapshot with no data key", with_({ beforeSnapshot: { type: BASE_TYPE } })],
    ["an after snapshot with no data key", with_({ afterSnapshot: { type: OWN_TYPE } })],
  ])("refuses %s", (_name, events) => {
    expect(provesPromotionRetype(events, OWN_TYPE)).toBe(false);
  });

  it("refuses a malformed input or target", () => {
    expect(provesPromotionRetype(null, OWN_TYPE)).toBe(false);
    expect(provesPromotionRetype(undefined, OWN_TYPE)).toBe(false);
    expect(provesPromotionRetype({} as never, OWN_TYPE)).toBe(false);
    expect(provesPromotionRetype([null as never, 5 as never], OWN_TYPE)).toBe(false);
    expect(provesPromotionRetype([PROOF], "")).toBe(false);
    expect(provesPromotionRetype([PROOF], OWN_TYPE.toUpperCase())).toBe(false);
  });

  it("null data on both sides is unchanged data", () => {
    expect(
      provesPromotionRetype(
        with_({
          beforeSnapshot: { type: BASE_TYPE, data: null },
          afterSnapshot: { type: OWN_TYPE, data: null },
        }),
        OWN_TYPE,
      ),
    ).toBe(true);
  });
});

describe("cinatra#4266: the proof read's statement", () => {
  it("reads this row's own live update events into the target type, in this organization", () => {
    const q = buildPromotionRetypeProofQuery(SCHEMA, { orgId: ORG, artifactId: "obj-1", toType: OWN_TYPE });
    expect(q.values).toEqual(["obj-1", ORG, OWN_TYPE]);
    expect(q.text).toContain(`FROM "${SCHEMA}"."object_change_event"`);
    expect(q.text).toContain("object_id = $1 AND org_id = $2 AND object_type = $3");
    expect(q.text).toContain("operation = 'update' AND tombstoned_at IS NULL");
    expect(q.text).toContain("(before_snapshot->>'type') IS DISTINCT FROM $3");
    expect(q.text).toMatch(/LIMIT \d+$/);
  });

  it("quotes the schema name", () => {
    const q = buildPromotionRetypeProofQuery('we"ird', { orgId: ORG, artifactId: "obj-1", toType: OWN_TYPE });
    expect(q.text).toContain(`FROM "we""ird"."object_change_event"`);
  });
});
