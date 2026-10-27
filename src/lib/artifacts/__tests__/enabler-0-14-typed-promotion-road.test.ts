/**
 * ENABLER 0.14 — THE TYPED PROMOTION ROAD
 * (`PLAN: Agents Lifecycle (C)` §4.1, cinatra#3028 / epic #3023).
 *
 * THE PLAN'S SENTENCE, VERBATIM: "The typed promotion road: a matched base-type
 * row — an upload the matcher associated with an extension — is promoted into
 * that extension's own type as a new revision sharing the content, on the
 * matcher's assertion at its threshold and with the person's confirmation where
 * the product already asks for one; the promote request that exists today
 * becomes the road's entry, and the base row keeps its history; the
 * matcher-associated extensions are the first consumers, wired in the sibling
 * plan. This is what lets every display register for its own type only: the
 * durable claim registry admits one live claimant per type and scope, so
 * shared-base claims by many extensions cannot coexist."
 *
 * WHAT IT FIXES, VERBATIM: "the matcher-associated extensions' work arrives as
 * base-typed uploads that the matcher labels without retyping, so under the
 * one-claimant rule no extension display can ever win for them."
 *
 * THIS IS ACCEPTANCE ITEM 2: "A matched upload is promoted into the extension's
 * type on the person's confirmation." The real-database half — the retype's
 * compare-and-set, the shared resource and the untouched history — is
 * `lifecycle-c-w4-typed-promotion.integration.test.ts`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildPromotionRepresentationAppend,
  mimeAccepted,
  planTypedPromotion,
  promotionRevisionId,
  type ExtensionOwnType,
  type PromotableRow,
} from "@/lib/artifacts/typed-promotion";
import {
  buildPromotionAppendQueries,
  promotionRetypeKey,
} from "@/lib/artifacts/typed-promotion-store";

const BASE_TYPE = "@cinatra-ai/text-artifact:text";
const OWN_TYPE = "@cinatra-ai/brand-voice-artifact:voice";

const row = (over: Partial<PromotableRow> = {}): PromotableRow => ({
  objectType: BASE_TYPE,
  data: { title: "an upload" },
  version: 7,
  latestRevision: {
    representationRevisionId: "rev-base",
    resourceId: "res-shared",
    form: "file",
    mime: "text/markdown",
  },
  ...over,
});

const ownType = (over: Partial<ExtensionOwnType> = {}): ExtensionOwnType => ({
  typeId: OWN_TYPE,
  acceptsMimes: ["text/markdown"],
  ...over,
});

describe("0.14 — the two authorities, and neither substitutes for the other", () => {
  it("promotes on the matcher's assertion AT its threshold and the person's confirmation", () => {
    const plan = planTypedPromotion({
      row: row(),
      ownType: ownType(),
      matcher: { confidence: 0.8, threshold: 0.8 },
      confirmed: true,
      personAsserted: false,
    });
    expect(plan).toEqual({
      ok: true,
      fromType: BASE_TYPE,
      toType: OWN_TYPE,
      sharedResourceId: "res-shared",
      baseRevisionId: "rev-base",
      form: "file",
      expectedVersion: 7,
    });
  });

  it("refuses a confident match with NO confirmation", () => {
    expect(
      planTypedPromotion({
        row: row(),
        ownType: ownType(),
        matcher: { confidence: 0.99, threshold: 0.8 },
        confirmed: false,
        personAsserted: false,
      }),
    ).toEqual({ ok: false, reason: "not-confirmed" });
  });

  it("refuses a confirmation on a row the matcher never associated", () => {
    expect(
      planTypedPromotion({ row: row(), ownType: ownType(), matcher: null, confirmed: true, personAsserted: false }),
    ).toEqual({ ok: false, reason: "no-matcher-assertion" });
  });

  it("refuses a match BELOW the extension's own threshold — the road never lowers one", () => {
    expect(
      planTypedPromotion({
        row: row(),
        ownType: ownType(),
        matcher: { confidence: 0.79, threshold: 0.8 },
        confirmed: true,
        personAsserted: false,
      }),
    ).toEqual({ ok: false, reason: "below-threshold" });
  });
});

describe("0.14 — every refusal is named, and the first one is the honest one", () => {
  const confident = { confidence: 1, threshold: 0.5 };

  it("names an absent row before anything else", () => {
    expect(
      planTypedPromotion({ row: null, ownType: ownType(), matcher: confident, confirmed: true, personAsserted: false }),
    ).toEqual({ ok: false, reason: "row-not-found" });
  });

  it("names an extension that owns no type of its own", () => {
    expect(
      planTypedPromotion({ row: row(), ownType: null, matcher: confident, confirmed: true, personAsserted: false }),
    ).toEqual({ ok: false, reason: "extension-owns-no-type" });
  });

  it("names a row that already carries the extension's own type", () => {
    expect(
      planTypedPromotion({
        row: row({ objectType: OWN_TYPE }),
        ownType: ownType(),
        matcher: confident,
        confirmed: true,
        personAsserted: false,
      }),
    ).toEqual({ ok: false, reason: "already-promoted" });
  });

  it("names a row with no content to share", () => {
    expect(
      planTypedPromotion({
        row: row({ latestRevision: null }),
        ownType: ownType(),
        matcher: confident,
        confirmed: true,
        personAsserted: false,
      }),
    ).toEqual({ ok: false, reason: "no-content" });
  });

  it("re-validates the SHARED content against the TARGET type's accepted forms", () => {
    expect(
      planTypedPromotion({
        row: row(),
        ownType: ownType({ acceptsMimes: ["application/pdf"] }),
        matcher: confident,
        confirmed: true,
        personAsserted: false,
      }),
    ).toEqual({ ok: false, reason: "form-not-accepted" });
  });

  it("refuses a target type that declares no file form at all", () => {
    expect(
      planTypedPromotion({
        row: row(),
        ownType: ownType({ acceptsMimes: [] }),
        matcher: confident,
        confirmed: true,
        personAsserted: false,
      }),
    ).toEqual({ ok: false, reason: "form-not-accepted" });
  });

  it("accepts a family wildcard and ignores a charset parameter", () => {
    expect(mimeAccepted(["text/*"], "text/markdown; charset=utf-8")).toBe(true);
    expect(mimeAccepted(["*/*"], "application/pdf")).toBe(true);
    expect(mimeAccepted(["text/plain"], "text/markdown")).toBe(false);
    expect(mimeAccepted([], "text/plain")).toBe(false);
  });
});

describe("0.14 — the revision that shares the content, and the kept history", () => {
  const plan = planTypedPromotion({
    row: row(),
    ownType: ownType(),
    matcher: { confidence: 0.9, threshold: 0.8 },
    confirmed: true,
    personAsserted: false,
  });

  it("appends a revision SHARING the base revision's resource — no bytes are copied", () => {
    if (!plan.ok) throw new Error("fixture plan refused");
    const op = buildPromotionRepresentationAppend("app", {
      orgId: "org-1",
      artifactId: "art-1",
      representationRevisionId: "rep-fixed",
      sharedResourceId: plan.sharedResourceId,
      form: plan.form,
      createdBy: "user-1",
    });
    expect(op.text).toContain('INSERT INTO "app"."representation"');
    expect(op.values[3]).toBe("res-shared");
    // MAX+1 — the base row KEEPS its history; nothing earlier is rewritten.
    expect(op.text).toContain("MAX(revision)");
    expect(op.text).not.toContain("UPDATE");
    expect(op.text).not.toContain("DELETE");
    // It touches representation and NOTHING else: the retype that precedes it
    // is the guard, so no objects reference is needed or wanted here.
    expect(op.text).not.toContain("objects");
  });

  it("is IDEMPOTENT, so an interrupted promotion converges instead of stacking", () => {
    const op = buildPromotionRepresentationAppend("app", {
      orgId: "org-1",
      artifactId: "art-1",
      representationRevisionId: "rep-fixed",
      sharedResourceId: "res-shared",
      form: "file",
      createdBy: null,
    });
    expect(op.text).toContain("ON CONFLICT (id) DO NOTHING");
  });

  it("names the promotion revision deterministically from what it is a promotion OF", () => {
    const id = promotionRevisionId({
      artifactId: "art-1",
      sharedResourceId: "res-shared",
      toType: OWN_TYPE,
    });
    expect(
      promotionRevisionId({
        artifactId: "art-1",
        sharedResourceId: "res-shared",
        toType: OWN_TYPE,
      }),
    ).toBe(id);
    // A different target type is a different promotion, and a different row's
    // promotion is not this one.
    expect(
      promotionRevisionId({
        artifactId: "art-1",
        sharedResourceId: "res-shared",
        toType: "@other/pkg:thing",
      }),
    ).not.toBe(id);
    expect(
      promotionRevisionId({
        artifactId: "art-2",
        sharedResourceId: "res-shared",
        toType: OWN_TYPE,
      }),
    ).not.toBe(id);
  });

  it("carries the version the retype's compare-and-set anchors on", () => {
    expect(plan.ok && plan.expectedVersion).toBe(7);
    expect(plan.ok && plan.fromType).toBe(BASE_TYPE);
    expect(plan.ok && plan.toType).toBe(OWN_TYPE);
  });
});

describe("0.14 — the retype goes through the canonical history-aware writer", () => {
  const STORE = path.join(process.cwd(), "src/lib/artifacts/typed-promotion-store.ts");
  const source = readFileSync(STORE, "utf8");

  it("the road's DEFAULT retype is the canonical writer, not a raw objects write", () => {
    // A type change is an application-visible mutation, so it belongs in the
    // row's own history with a change event and a Graphiti outbox row — which is
    // what that writer commits alongside it. The real-database tier substitutes
    // the same compare-and-set (its module graph reaches the application boot);
    // this is the pin that the SUBSTITUTION is not what production takes.
    expect(source).toContain("const retype = input.retype ?? canonicalRetype;");
    expect(source).toContain('await import("@/lib/object-history/canonical-writer")');
    expect(source).toContain("historyAwareUpsert(");
    expect(source).toContain("expectedBaseVersion: input.expectedVersion");
  });

  it("the store writes no objects row of its own", () => {
    // The standing proof is the repository audit that refuses direct DML
    // against the objects table; this is its positive half, beside the road it
    // belongs to.
    expect(/(INSERT\s+INTO|UPDATE|DELETE\s+FROM)[^\n]*"objects"/i.test(source)).toBe(false);
  });

  it("maps a lost compare-and-set to row-moved and a missing authority to not-authorized", () => {
    expect(source).toContain('return { ok: false, reason: "row-moved" }');
    expect(source).toContain('return { ok: false, reason: "not-authorized" }');
  });
});

describe("3319 — the promotion intent names its source, and the append re-checks it under the lock", () => {
  const STORE = path.join(process.cwd(), "src/lib/artifacts/typed-promotion-store.ts");
  const source = readFileSync(STORE, "utf8");
  const KEY = {
    artifactId: "art-1",
    extension: "@cinatra-ai/linkedin-artifacts",
    toType: "@cinatra-ai/linkedin-artifacts:post-draft",
    baseVersion: 3,
    sourceRevisionId: "rev-base",
  };
  const FACTS = {
    orgId: "org-1",
    artifactId: "art-1",
    representationRevisionId: "rep_abc123",
    sharedResourceId: "res-1",
    form: "file" as const,
    createdBy: "user-1",
    toType: KEY.toType,
    mime: "text/markdown",
  };
  const HEAD = { type: KEY.toType, version: 4, headRepresentationId: "rev-base" };

  it("3319 T7 promotionRetypeKey is deterministic and changes with the extension, the base version and the source revision", () => {
    const key = promotionRetypeKey(KEY);
    expect(promotionRetypeKey({ ...KEY })).toBe(key);
    expect(key).toBe(
      "typed-promotion:art-1:@cinatra-ai/linkedin-artifacts:@cinatra-ai/linkedin-artifacts:post-draft:v3:rev-base",
    );
    expect(promotionRetypeKey({ ...KEY, extension: "@other/pack" })).not.toBe(key);
    expect(promotionRetypeKey({ ...KEY, baseVersion: 4 })).not.toBe(key);
    expect(promotionRetypeKey({ ...KEY, sourceRevisionId: "rev-edit" })).not.toBe(key);
  });

  it("3319 T7 the retype records the key in the canonical writer's change event as its idempotencyKey", () => {
    expect(source).toContain("idempotencyKey: input.idempotencyKey,");
    // The road names the source the plan read: the base version and the base
    // revision whose resource the promotion shares.
    const road = source.slice(source.indexOf("// 1. THE RETYPE"), source.indexOf("// 2. THE APPEND"));
    expect(road).toContain("idempotencyKey: promotionRetypeKey({");
    expect(road).toContain("baseVersion: plan.expectedVersion,");
    expect(road).toContain("sourceRevisionId: plan.baseRevisionId,");
  });

  it("3319 T7 the converging branch passes the snapshot it decided on as expectHead, and the first append does not", () => {
    const branch = source.slice(source.indexOf("THE CONVERGING BRANCH"), source.indexOf("// 1. THE RETYPE"));
    expect(branch).toContain("expectHead: {");
    expect(branch).toContain("version: row.version,");
    expect(branch).toContain("headRepresentationId: row.latestRevision.representationRevisionId,");
    expect(branch).toContain('if (landed.moved) return { ok: false, reason: "row-moved" };');
    // The event is the THIRD authority, read only after the other two fail.
    expect(branch.indexOf("personAsserted ||")).toBeGreaterThan(-1);
    expect(branch.indexOf("await readPromotionRetypeEvent(")).toBeGreaterThan(
      branch.indexOf("personAsserted ||"),
    );
    const firstAppend = source.slice(source.indexOf("// 2. THE APPEND"), source.indexOf("/** The retype half, as a port. */"));
    expect(firstAppend).toContain("appendPromotionRevision({");
    expect(firstAppend).not.toContain("expectHead");
  });

  it("3319 T7 buildPromotionAppendQueries with expectHead gives four queries, the re-check second", () => {
    const plain = buildPromotionAppendQueries("cinatra_test", FACTS);
    const queries = buildPromotionAppendQueries("cinatra_test", { ...FACTS, expectHead: HEAD });
    expect(queries).toHaveLength(4);
    expect(queries[0]).toEqual(plain[0]);
    expect(queries[1]!.text).toContain("SELECT 1 / COUNT(*)::int AS head_unmoved");
    expect(queries[1]!.text).toContain('FROM "cinatra_test"."objects" o');
    expect(queries[1]!.text).toContain(
      'AND (SELECT id FROM "cinatra_test"."representation" WHERE org_id = $2 AND artifact_id = $1 ORDER BY revision DESC LIMIT 1) = $5',
    );
    expect(queries[1]!.values).toEqual([
      FACTS.artifactId,
      FACTS.orgId,
      HEAD.type,
      HEAD.version,
      HEAD.headRepresentationId,
    ]);
    // The insert and the witness follow the re-check, unchanged.
    expect(queries[2]).toEqual(plain[1]);
    expect(queries[3]).toEqual(plain[2]);
  });

  it("3319 T7 buildPromotionAppendQueries without expectHead gives main's three queries", () => {
    const queries = buildPromotionAppendQueries("cinatra_test", FACTS);
    expect(queries).toHaveLength(3);
    expect(queries[0]!.text).toBe("SELECT pg_advisory_xact_lock(hashtext($1))");
    expect(queries[1]!.text).toContain('INSERT INTO "cinatra_test"."representation"');
    expect(queries[2]!.text).toContain('"cinatra_test"."artifact_audit"');
    expect(queries.some((q) => q.text.includes("head_unmoved"))).toBe(false);
  });
});
