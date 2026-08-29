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
import { describe, expect, it } from "vitest";

import {
  buildTypedPromotionQueries,
  mimeAccepted,
  planTypedPromotion,
  readTypedPromotionResult,
  type ExtensionOwnType,
  type PromotableRow,
} from "@/lib/artifacts/typed-promotion";

const BASE_TYPE = "@cinatra-ai/text-artifact:text";
const OWN_TYPE = "@cinatra-ai/brand-voice-artifact:voice";

const row = (over: Partial<PromotableRow> = {}): PromotableRow => ({
  objectType: BASE_TYPE,
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
      }),
    ).toEqual({ ok: false, reason: "not-confirmed" });
  });

  it("refuses a confirmation on a row the matcher never associated", () => {
    expect(
      planTypedPromotion({ row: row(), ownType: ownType(), matcher: null, confirmed: true }),
    ).toEqual({ ok: false, reason: "no-matcher-assertion" });
  });

  it("refuses a match BELOW the extension's own threshold — the road never lowers one", () => {
    expect(
      planTypedPromotion({
        row: row(),
        ownType: ownType(),
        matcher: { confidence: 0.79, threshold: 0.8 },
        confirmed: true,
      }),
    ).toEqual({ ok: false, reason: "below-threshold" });
  });
});

describe("0.14 — every refusal is named, and the first one is the honest one", () => {
  const confident = { confidence: 1, threshold: 0.5 };

  it("names an absent row before anything else", () => {
    expect(
      planTypedPromotion({ row: null, ownType: ownType(), matcher: confident, confirmed: true }),
    ).toEqual({ ok: false, reason: "row-not-found" });
  });

  it("names an extension that owns no type of its own", () => {
    expect(
      planTypedPromotion({ row: row(), ownType: null, matcher: confident, confirmed: true }),
    ).toEqual({ ok: false, reason: "extension-owns-no-type" });
  });

  it("names a row that already carries the extension's own type", () => {
    expect(
      planTypedPromotion({
        row: row({ objectType: OWN_TYPE }),
        ownType: ownType(),
        matcher: confident,
        confirmed: true,
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

describe("0.14 — the compare-and-set, the shared content and the kept history", () => {
  const plan = planTypedPromotion({
    row: row(),
    ownType: ownType(),
    matcher: { confidence: 0.9, threshold: 0.8 },
    confirmed: true,
  });

  it("retypes under a compare-and-set on BOTH the version and the current type", () => {
    if (!plan.ok) throw new Error("fixture plan refused");
    const built = buildTypedPromotionQueries("app", {
      orgId: "org-1",
      artifactId: "art-1",
      plan,
      createdBy: "user-1",
    });
    const update = built.queries[1]!;
    expect(update.text).toContain("UPDATE");
    expect(update.text).toContain("type = $3::text AND version = $5::bigint");
    expect(update.values).toEqual(["art-1", "org-1", BASE_TYPE, OWN_TYPE, 7]);
    // Promotions of ONE row serialize against each other and against the
    // revision allocation.
    expect(built.queries[0]!.text).toContain("pg_advisory_xact_lock");
  });

  it("appends a revision SHARING the base revision's resource — no bytes are copied", () => {
    if (!plan.ok) throw new Error("fixture plan refused");
    const built = buildTypedPromotionQueries("app", {
      orgId: "org-1",
      artifactId: "art-1",
      plan,
      createdBy: null,
    });
    const insert = built.queries[2]!;
    expect(insert.text).toContain('INSERT INTO "app"."representation"');
    expect(insert.values[3]).toBe("res-shared");
    // MAX+1 — the base row KEEPS its history; nothing earlier is rewritten.
    expect(insert.text).toContain("MAX(revision)");
    expect(insert.text).not.toContain("UPDATE");
    expect(insert.text).not.toContain("DELETE");
    // GUARDED ON THE RETYPE: a revision appended without it would announce a
    // promotion that did not happen.
    expect(insert.text).toContain("WHERE EXISTS");
  });

  it("reports a lost race as row-moved rather than a half-applied promotion", () => {
    const applied = readTypedPromotionResult(
      [{ rows: [] }, { rows: [] }, { rows: [] }],
      { newRepresentationRevisionId: "rev-new", toType: OWN_TYPE },
    );
    expect(applied).toEqual({ ok: false, reason: "row-moved" });
  });

  it("reports the appended revision when the retype won", () => {
    const applied = readTypedPromotionResult(
      [{ rows: [{}] }, { rows: [{ id: "art-1" }] }, { rows: [{ id: "rev-new", revision: 2 }] }],
      { newRepresentationRevisionId: "rev-new", toType: OWN_TYPE },
    );
    expect(applied).toEqual({
      ok: true,
      representationRevisionId: "rev-new",
      revision: 2,
      toType: OWN_TYPE,
    });
  });

  it("reports row-moved when the retype won but the append did not", () => {
    expect(
      readTypedPromotionResult([{ rows: [{}] }, { rows: [{ id: "art-1" }] }, { rows: [] }], {
        newRepresentationRevisionId: "rev-new",
        toType: OWN_TYPE,
      }),
    ).toEqual({ ok: false, reason: "row-moved" });
  });
});
