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

describe("0.14 — the revision that shares the content, and the kept history", () => {
  const plan = planTypedPromotion({
    row: row(),
    ownType: ownType(),
    matcher: { confidence: 0.9, threshold: 0.8 },
    confirmed: true,
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
    // The standing proof is scripts/audit/objects-writer-drift-gate.mjs; this is
    // its positive half, beside the road it belongs to.
    expect(/(INSERT\s+INTO|UPDATE|DELETE\s+FROM)[^\n]*"objects"/i.test(source)).toBe(false);
  });

  it("maps a lost compare-and-set to row-moved and a missing authority to not-authorized", () => {
    expect(source).toContain('return { ok: false, reason: "row-moved" }');
    expect(source).toContain('return { ok: false, reason: "not-authorized" }');
  });
});
