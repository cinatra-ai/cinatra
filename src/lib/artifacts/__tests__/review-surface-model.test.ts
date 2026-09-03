/**
 * Unit tests for the PURE artifact-review surface model (cinatra#1795 S12 item 4;
 * spec design@458fb7ffce6cf4ab6a2c60d3ff47198135d8ea2f). Proves the §III provenance mapping, the §V permission
 * copy, and — the load-bearing rule — the FAIL-CLOSED submit-result → outcome
 * mapping (§IV: a fingerprint conflict / settled gate is a BLOCK, never a silent
 * success). No React / DB — every seam is plain data.
 */
import { REVIEW_FLOOR_ACTIONS } from "@/lib/artifacts/review-surface-model";
import {
  artifactReviewGateSchemaQueries,
  lifecycleRepairSchemaQueries,
} from "@/lib/artifacts/artifact-review-gate-schema";
import { describe, expect, it } from "vitest";

import type { ReviewTargetMount } from "@/lib/artifacts/artifact-review-preparation";
import type {
  SubmitDecisionError,
  SubmitDecisionResult,
} from "@/lib/artifacts/artifact-review-decision";
import {
  mapSubmitResultToOutcome,
  mapChangesRequestedToOutcome,
  reviewBlockedCopy,
  reviewDecideDisabledReason,
  reviewSettledCopy,
  reviewSettledWord,
  reviewSettledAct,
  reviewSettledActForOutcome,
  REVIEW_SETTLED_ACT_STORAGE,
  REVIEW_SETTLED_ACT_TITLE,
  reviewProvenanceConformanceId,
  reviewProvenanceLabel,
  reviewRevisionMarker,
  reviewTypeLabel,
  reviewTargetRowFacts,
  REVIEW_DISPOSITIONS,
} from "../review-surface-model";
import type { RecordChangesRequestedResult } from "@cinatra-ai/agents/lifecycle-review-changes-requested";
import { LIFECYCLE_SETTLED_OUTCOMES } from "@cinatra-ai/agent-ui-protocol/renderable-views";

const form: ReviewTargetMount = {
  kind: "form",
  slot: "detail",
  arm: "first-party",
  form: "markdown",
};

const buildMap: ReviewTargetMount = {
  kind: "build-map",
  slot: "detail",
  packageName: "@cinatra-ai/email",
  generatedKey: "@cinatra-ai/email::detail",
};
const runtime: ReviewTargetMount = {
  kind: "runtime",
  slot: "detail",
  packageName: "@acme/support",
  // Only .kind/.slot/.packageName are read by the model; a minimal descriptor
  // stands in for the (unused) runtime tuple.
  descriptor: { tuple: { digest: "d".repeat(64) } },
} as ReviewTargetMount;
const floor: ReviewTargetMount = {
  kind: "floor",
  slot: "detail",
  packageName: "@acme/support",
  reason: "requires-rebuild",
};

describe("§V — provenance conformance id from the OPAQUE mount kind", () => {
  // THE DRAWING FORBIDS A PROVENANCE REGION ON A RENDERED TARGET (§V of the
  // ratified artifact-review drawing, read at its default branch): "It is not
  // put on screen: a display shows the work and nothing about itself — no
  // renderer name, no package identity, no provenance line — because the reader
  // is deciding on the work, not on what drew it", and a build-time renderer and
  // a runtime one "are drawn the same way, because nothing on either target says
  // which resolved it". The lifecycle-cards drawing §III says the same in its own
  // words: "no chip, no package identity, no provenance line".
  //
  // ONLY THE FLOOR SPEAKS: "The one that does speak on a surface is the floor,
  // and only because a reader must be told a render failed."
  it("build-map and runtime carry NO region; only a floor keeps its anchor", () => {
    expect(reviewProvenanceConformanceId(buildMap)).toBeNull();
    expect(reviewProvenanceConformanceId(runtime)).toBeNull();
    expect(reviewProvenanceConformanceId(floor)).toBe("review-target-floor");
  });

  // cinatra#2931 W4 — the maintainer's answer of 2026-08-23 (Q1): the built-in
  // markdown / plain-text rendering carries NO label above the reviewed work.
  // §V of the pinned review spec draws a provenance strip for the two renderer
  // tiers a PACKAGE supplies and for the floor; the host's own text rendering is
  // none of those three, and it is not given a fourth strip — it is given none.
  // The reviewer sees the draft, and nothing above the draft.
  it("the form rung has NO provenance region at all — no fourth strip, no reused one", () => {
    expect(reviewProvenanceConformanceId(form)).toBeNull();
  });

  it("only a floor has a label to print — a rendered target names nothing", () => {
    expect(reviewProvenanceLabel(buildMap)).toBeNull();
    expect(reviewProvenanceLabel(runtime)).toBeNull();
    expect(reviewProvenanceLabel(floor)).toMatchObject({ kind: "floor" });
  });

  it("the form rung has no provenance label to print", () => {
    expect(reviewProvenanceLabel(form)).toBeNull();
  });
});

describe("§II — the immutable header projections", () => {
  it("prettifies an object-type id into a short type label", () => {
    expect(reviewTypeLabel("@cinatra-ai/email:draft")).toBe("Email");
    // SENTENCE case, as every pill the drawing draws is written (fix leg 7).
    expect(reviewTypeLabel("@acme/support-desk:case")).toBe("Support desk");
    expect(reviewTypeLabel("plain")).toBe("Plain");
  });

  it("truncates a long revision id for display, preserving the exact id", () => {
    const m = reviewRevisionMarker("rev_0123456789abcdef");
    expect(m.full).toBe("rev_0123456789abcdef");
    expect(m.short.endsWith("…")).toBe(true);
    expect(reviewRevisionMarker("rev_short").short).toBe("rev_short");
  });
});

describe("§V — permission copy + blocked copy", () => {
  it("no disabled reason when the reviewer may decide", () => {
    expect(reviewDecideDisabledReason({ canDecide: true, canComment: true })).toBeNull();
  });
  it("a comment-only reviewer is told which access the terminal actions need", () => {
    const reason = reviewDecideDisabledReason({ canDecide: false, canComment: true });
    // RE-PINNED to the floor's vocabulary (cinatra#3080 item 1). The right is
    // unchanged — a terminal decision still needs the run's approve access — but
    // the sentence a PENDING reviewer reads may not name a retired action, and
    // this one used to read "A terminal Approve / Reject needs approve access".
    expect(reason).toMatch(/decision access/);
    expect(reason).toMatch(/Continue and Regenerate/);
    expect(reason).toMatch(/Comment/);
    expect(reason).not.toMatch(/\bapprove/i);
    expect(reason).not.toMatch(/\breject/i);
  });
  it("a reviewer with neither is told the terminal actions are disabled", () => {
    const reason = reviewDecideDisabledReason({ canDecide: false, canComment: false });
    expect(reason).toMatch(/decision access/);
    expect(reason).toMatch(/Continue and Regenerate/);
    expect(reason).not.toMatch(/\bapprove/i);
    expect(reason).not.toMatch(/\breject/i);
  });
  it("blocked copy covers every closed reason", () => {
    expect(reviewBlockedCopy("no-longer-pending").title).toMatch(/no longer open/);
    expect(reviewBlockedCopy("targets-mismatch").title).toMatch(/out of date/);
    expect(reviewBlockedCopy("revision-not-live").title).toMatch(/no longer live/);
  });
});

describe("§IV — what a NEW decision may carry (cinatra#3080)", () => {
  it("approve (Continue's stored value) and comment only — reject is retired", () => {
    expect([...REVIEW_DISPOSITIONS].sort()).toEqual(["approve", "comment"]);
  });

  it("the FLOOR is the three actions, and it is a different set from the dispositions", () => {
    // The two are deliberately not the same list any more: Regenerate is on the
    // floor and carries no disposition (it rides the change road), and `approve`
    // is a stored value that no button says out loud.
    expect([...REVIEW_FLOOR_ACTIONS]).toEqual(["comment", "regenerate", "continue"]);
    expect([...REVIEW_DISPOSITIONS]).not.toContain("regenerate");
  });
});

describe("§IV/§V — FAIL-CLOSED submit-result → visible outcome", () => {
  const ok = (idempotent: boolean): SubmitDecisionResult => ({
    ok: true,
    idempotent,
    fingerprint: "fp",
    plan: null,
  });
  const err = (error: SubmitDecisionError): SubmitDecisionResult => ({ ok: false, error });

  it("an approved commit → decided(approve); idempotent flag carried", () => {
    expect(mapSubmitResultToOutcome(ok(false), "approve")).toEqual({
      kind: "decided",
      disposition: "approve",
      idempotent: false,
    });
    expect(mapSubmitResultToOutcome(ok(true), "reject")).toEqual({
      kind: "decided",
      disposition: "reject",
      idempotent: true,
    });
  });

  it("a committed comment → annotated (non-terminal, gate stays pending)", () => {
    expect(mapSubmitResultToOutcome(ok(false), "comment")).toEqual({ kind: "annotated" });
  });

  it("a fingerprint conflict is a BLOCK, never a silent success", () => {
    expect(mapSubmitResultToOutcome(err({ kind: "gate-conflict" }), "approve")).toEqual({
      kind: "blocked",
      reason: "no-longer-pending",
    });
  });

  it("a settled / moved-on gate blocks", () => {
    expect(mapSubmitResultToOutcome(err({ kind: "gate-not-pending" }), "approve")).toMatchObject({
      kind: "blocked",
      reason: "no-longer-pending",
    });
  });

  it("a substituted / incomplete target set is a hard block (targets-mismatch)", () => {
    expect(mapSubmitResultToOutcome(err({ kind: "target-substitution", substituted: [] }), "approve")).toMatchObject({
      kind: "blocked",
      reason: "targets-mismatch",
    });
    expect(mapSubmitResultToOutcome(err({ kind: "incomplete-coverage", missing: [] }), "approve")).toMatchObject({
      kind: "blocked",
      reason: "targets-mismatch",
    });
  });

  it("a vanished revision blocks as revision-not-live", () => {
    expect(mapSubmitResultToOutcome(err({ kind: "revision-not-member", targets: [] }), "approve")).toMatchObject({
      kind: "blocked",
      reason: "revision-not-live",
    });
  });

  it("a run-access denial disables (not-permitted), never a block/success", () => {
    expect(mapSubmitResultToOutcome(err({ kind: "run-access-denied", status: 403 }), "reject")).toMatchObject({
      kind: "not-permitted",
    });
  });

  it("a transient (invalid / commit-failed) is a retryable error, not a block", () => {
    expect(mapSubmitResultToOutcome(err({ kind: "invalid-decision", message: "x" }), "approve")).toMatchObject({
      kind: "error",
    });
    expect(mapSubmitResultToOutcome(err({ kind: "commit-failed", message: "db" }), "approve")).toMatchObject({
      kind: "error",
    });
  });
});

// ---------------------------------------------------------------------------
// The LIFECYCLE prompt-window path (cinatra#2063; owner ruling 2026-07-25):
// mapChangesRequestedToOutcome maps the S2 recordChangesRequested store result to
// the surface outcome — a committed request is `changes-requested`; every failure
// reuses the SAME fail-closed blocked/error states as the base decision (never a
// silent success on a settled gate).
// ---------------------------------------------------------------------------

describe("mapChangesRequestedToOutcome — lifecycle prompt-window path (§IV/§V fail-closed)", () => {
  const ok = (
    over: Partial<Extract<RecordChangesRequestedResult, { ok: true }>> = {},
  ): RecordChangesRequestedResult => ({
    ok: true,
    repairId: "rep-1",
    route: { kind: "producer_repair", continuationMode: "async_effects_gated" },
    attempt: 1,
    status: "requested",
    idempotent: false,
    ...over,
  });
  const fail = (code: string): RecordChangesRequestedResult => ({ ok: false, code, error: code });

  it("a repair-capable producer's request is `changes-requested` (requested, gate resolved into a repair)", () => {
    expect(mapChangesRequestedToOutcome(ok())).toEqual({
      kind: "changes-requested",
      status: "requested",
      idempotent: false,
    });
  });

  it("an escalated request (non-repairing / cycle bound) is `changes-requested` (escalated)", () => {
    expect(mapChangesRequestedToOutcome(ok({ status: "escalated" }))).toMatchObject({
      kind: "changes-requested",
      status: "escalated",
    });
  });

  it("a response-lost idempotent re-drive carries idempotent:true", () => {
    expect(mapChangesRequestedToOutcome(ok({ idempotent: true }))).toMatchObject({
      kind: "changes-requested",
      idempotent: true,
    });
  });

  it("FAIL-CLOSED: a settled / conflicting / non-lifecycle gate is a BLOCK (no-longer-pending), never a silent success", () => {
    for (const code of ["gate-conflict", "gate-not-pending", "not-a-lifecycle-gate"]) {
      expect(mapChangesRequestedToOutcome(fail(code))).toMatchObject({
        kind: "blocked",
        reason: "no-longer-pending",
      });
    }
  });

  it("a tombstoned / moved base blocks as revision-not-live (the review no longer applies)", () => {
    expect(mapChangesRequestedToOutcome(fail("tombstoned-base"))).toMatchObject({
      kind: "blocked",
      reason: "revision-not-live",
    });
    expect(mapChangesRequestedToOutcome(fail("stale-base"))).toMatchObject({
      kind: "blocked",
      reason: "revision-not-live",
    });
  });

  it("a mismatched pinned set blocks as targets-mismatch", () => {
    expect(mapChangesRequestedToOutcome(fail("targets-mismatch"))).toMatchObject({
      kind: "blocked",
      reason: "targets-mismatch",
    });
  });

  it("any other failure (invalid-request / idempotency-key-reuse / empty-feedback) is a retryable error", () => {
    for (const code of ["invalid-request", "idempotency-key-reuse", "empty-feedback"]) {
      expect(mapChangesRequestedToOutcome(fail(code))).toMatchObject({ kind: "error" });
    }
  });
});

// ---------------------------------------------------------------------------
// §IV — the SETTLED reading (cinatra#2855; plan §4.2)
// ---------------------------------------------------------------------------

describe("the settled WORD for a stored disposition (cinatra#3080)", () => {
  it("reads every stored disposition as the drawing's settled word", () => {
    // "…records how it was settled (continued, superseded by a regeneration,
    // changes requested)". A raw column value is never one of those.
    expect(reviewSettledWord("approve")).toBe("Continued");
    expect(reviewSettledWord("changes_requested")).toBe("Superseded");
    expect(reviewSettledWord("reject")).toBe("Rejected");
  });

  it("never hands back a machine token, whatever the column holds", () => {
    for (const raw of ["approve", "reject", "changes_requested", "comment", "", null, undefined]) {
      const word = reviewSettledWord(raw);
      expect(word).not.toMatch(/_/);
      expect(word).toBe(word[0].toUpperCase() + word.slice(1));
      expect(word.length).toBeGreaterThan(0);
    }
  });

  it("agrees with the settled CARD's title, so the rail and the card cannot drift", () => {
    expect(reviewSettledWord("approve")).toBe(reviewSettledCopy("approved").title);
    expect(reviewSettledWord("reject")).toBe(reviewSettledCopy("rejected").title);
    expect(reviewSettledWord("changes_requested")).toBe(
      reviewSettledCopy("changes_requested").title,
    );
  });
});

describe("the settled copy names the outcome and its decider", () => {
  it("is keyed on the SAME closed set the wire carries", () => {
    // This model deliberately keeps its own local union rather than importing
    // the wire type, so the two are pinned together HERE. A value added on one
    // side and not the other fails this, in front of the switch that would
    // otherwise fall through to nothing.
    const covered = [...LIFECYCLE_SETTLED_OUTCOMES].map((outcome) =>
      reviewSettledCopy(outcome),
    );
    expect(covered).toHaveLength(3);
    for (const copy of covered) {
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.body.length).toBeGreaterThan(0);
    }
  });

  it("names the ACT, and never the decider (cinatra#3080, fix leg 6)", () => {
    // cinatra#3080 — a gate whose STORED disposition is `approve` reads as
    // CONTINUED. The row is unmigrated and unmigratable-by-design: what changed
    // is the word the person is shown, not the value the store holds, so a gate
    // decided before the relabel and one decided after it read identically.
    //
    // AND THE MARKER CARRIES NO NAME. The four settled markers the ratified
    // drawings draw — twice in §XIII.1, twice in §II of the cards drawing —
    // read "Continued" or "Superseded" over a sentence about the revision, and
    // not one of them names a person. The decider still travels on the wire for
    // the audit trail. The signature takes the outcome ALONE, so a caller
    // cannot re-introduce one by passing it.
    expect(reviewSettledCopy("approved")).toEqual({
      title: "Continued",
      body: "Decided on the revision above. These are the words that will be sent.",
    });
    // A LEGACY reject row stays readable — it simply can no longer be produced.
    expect(reviewSettledCopy("rejected").title).toBe("Rejected");
    // cinatra#3080 item 4 — a gate the change road settled reads SUPERSEDED.
    // The stored disposition is unchanged (`changes_requested`, "the change
    // road's existing representation"); the WORD is the drawing's.
    expect(reviewSettledCopy("changes_requested").title).toBe("Superseded");
    expect(reviewSettledCopy.length).toBe(1);
  });

  it("reads as a finished sentence with no decider at all", () => {
    // The resolver drops a decider it cannot name safely, so the copy must not
    // depend on one: never "Approved by" and a dangling nothing.
    for (const outcome of LIFECYCLE_SETTLED_OUTCOMES) {
      const { title } = reviewSettledCopy(outcome);
      expect(title.endsWith(" by")).toBe(false);
      expect(title.includes(" by ")).toBe(false);
    }
    expect(reviewSettledCopy("approved").title).toBe("Continued");
    expect(reviewSettledCopy("rejected").title).toBe("Rejected");
    expect(reviewSettledCopy("changes_requested").title).toBe("Superseded");
  });

  it("does NOT claim a live repair the way the post-press notice does", () => {
    // The decision bar's `requested` line says "a repair is now in flight" — a
    // fact about what the reviewer's own press started. A settled card has not
    // read that, so it may not assert it.
    expect(reviewSettledCopy("changes_requested").body).toBe(
      "The gate is settled as superseded. The reviewed revision is kept as it was, and the review has moved on from it.",
    );
    expect(reviewSettledCopy("changes_requested").body).not.toContain("in flight");
  });

  it("is a DIFFERENT reading from the generic blocked copy it replaces", () => {
    // The generic sentence survives — for a settled card with no outcome — and
    // the two must not converge into one vague line.
    const generic = reviewBlockedCopy("no-longer-pending");
    for (const outcome of LIFECYCLE_SETTLED_OUTCOMES) {
      expect(reviewSettledCopy(outcome).title).not.toBe(generic.title);
      expect(reviewSettledCopy(outcome).body).not.toBe(generic.body);
    }
    expect(generic.title).toBe("This review is no longer open");
  });
});

describe("reviewTargetRowFacts — the header meta line's read-only row facts", () => {
  // THE DRAWING DRAWS THE PAIR BARE. §IV names the facts — "the read-only row
  // facts the host authorized — owner level / visibility, MIME, and updated
  // time" — and every example line in the ratified drawings prints them with no
  // label at all: "… · Team · Private · text/html · updated 8 min ago" (§IV, and
  // the same line again in §V.1's read-only review target). The labelled form
  // shipped here was a local reading of a plan sentence; the drawing decides, so
  // the labels go and both facts stay.
  it("prints the two scope facts BARE, in the drawing's order", () => {
    const facts = reviewTargetRowFacts(
      {
        ownerLevel: "organization",
        visibility: "organization",
        mime: "text/markdown",
        updatedAt: "2026-08-31T08:19:26.458Z",
      },
      new Date("2026-08-31T08:27:26.458Z"),
    );
    const line = facts.join(" · ");
    // The drawn reading (fix leg 7): the values spoken, and the unit abbreviated
    // as §IV prints it — "Team · Private · text/html · updated 8 min ago".
    expect(line).toBe("Organization · Organization · text/markdown · updated 8 min ago");
    expect(line).not.toContain("Ownership:");
    expect(line).not.toContain("Visibility:");
  });

  it("keeps BOTH facts, in the order the drawing draws them", () => {
    const facts = reviewTargetRowFacts(
      {
        ownerLevel: "team",
        visibility: "private",
        mime: "text/html",
        updatedAt: "2026-08-31T08:19:26.458Z",
      },
      new Date("2026-08-31T08:27:26.458Z"),
    );
    expect(facts).toEqual(["Team", "Private", "text/html", "updated 8 min ago"]);
  });

  // ITEM 6 of cinatra#3141 — "the time is raw". The drawing draws a RELATIVE
  // time on the header's mono line ("… · text/html · updated 8 min ago"); the
  // line printed the raw ISO timestamp the row carries instead.
  it("draws a relative updated time, never the raw ISO timestamp (the drawing: \u201cupdated 8 min ago\u201d)", () => {
    const now = new Date("2026-08-31T08:27:26.458Z");
    const facts = reviewTargetRowFacts(
      {
        ownerLevel: "organization",
        visibility: "organization",
        mime: "text/markdown",
        updatedAt: "2026-08-31T08:19:26.458Z",
      },
      now,
    );
    expect(facts[3]).toBe("updated 8 min ago");
    expect(facts.join(" · ")).not.toContain("2026-08-31T08:19:26.458Z");
  });

  it("the bare scope pair and the relative time stand on the same line", () => {
    const now = new Date("2026-08-31T08:27:26.458Z");
    const facts = reviewTargetRowFacts(
      {
        ownerLevel: "team",
        visibility: "private",
        mime: "text/html",
        updatedAt: "2026-08-31T08:19:26.458Z",
      },
      now,
    );
    expect(facts).toEqual(["Team", "Private", "text/html", "updated 8 min ago"]);
  });

  it("falls back to the value it was handed when that value is not a readable instant", () => {
    const facts = reviewTargetRowFacts({
      ownerLevel: "user",
      visibility: "private",
      mime: "text/plain",
      updatedAt: "not-an-instant",
    });
    expect(facts[3]).toBe("updated not-an-instant");
  });

  it("carries no type keying — every artifact type reads the same line", () => {
    const a = reviewTargetRowFacts({ ownerLevel: "user", visibility: "private", mime: "application/pdf", updatedAt: "now" });
    const b = reviewTargetRowFacts({ ownerLevel: "user", visibility: "private", mime: "text/plain", updatedAt: "now" });
    expect(a.slice(0, 2)).toEqual(b.slice(0, 2));
  });
});

describe("cinatra#3080 — the settled act, and the schema gap it is stored across", () => {
  const ACTS = ["continued", "superseded", "rejected"] as const;

  it("THE SCHEMA GAP IS REAL: the gate table admits no `superseded` disposition", () => {
    // Regenerate's act is SUPERSEDED and the column cannot hold that word. This
    // reads the shipped DDL rather than asserting a remembered fact, so the day
    // a migration widens the constraint this test says so and the encoding table
    // above is revisited instead of quietly lying.
    //
    // IT READS THE WHOLE BOOTSTRAP, in order (the convergence round). The gate
    // table's CHECK is created by the first query set and then DROPPED and
    // RE-ADDED by `lifecycleRepairSchemaQueries`, which runs after it — so a
    // guard that read only the first set would stay green while the effective
    // constraint widened underneath it.
    const gateDdl = artifactReviewGateSchemaQueries("any_schema").map((query) => query.text);
    const repairDdl = lifecycleRepairSchemaQueries("any_schema").map((query) => query.text);
    const bootstrap = [...gateDdl, ...repairDdl];
    expect(bootstrap.join("\n")).toContain("disposition IN ('approve','reject','changes_requested')");
    // NO disposition constraint anywhere in the bootstrap admits the word — and
    // the check is scoped to the disposition statements, because `superseded`
    // IS a legal `lifecycle_repair.status`, which is a different column saying
    // a different thing (the repair a supersede started, not the gate's own
    // recorded act).
    const dispositionChecks = bootstrap.filter(
      (text) => text.includes("CHECK") && text.includes("disposition IN"),
    );
    expect(dispositionChecks.length).toBeGreaterThan(0);
    for (const check of dispositionChecks) expect(check).not.toContain("superseded");
    // The LAST word on the gate table's disposition — the constraint actually
    // in force after the bootstrap has run — admits the same three values.
    const lastGateCheck = bootstrap
      .filter((text) => text.includes("artifact_review_gates_disposition_check") && text.includes("CHECK"))
      .pop();
    expect(lastGateCheck).toBeDefined();
    expect(lastGateCheck).toContain("disposition IN ('approve','reject','changes_requested')");
    // …so the act SUPERSEDED is written as `changes_requested`, and that relation
    // lives in exactly one place.
    expect(REVIEW_SETTLED_ACT_STORAGE.superseded).toBe("changes_requested");
  });

  it("the stored disposition and the surface name the SAME act, in both directions", () => {
    for (const act of ACTS) {
      const stored = REVIEW_SETTLED_ACT_STORAGE[act];
      expect(reviewSettledAct(stored)).toBe(act);
      expect(reviewSettledWord(stored)).toBe(REVIEW_SETTLED_ACT_TITLE[act]);
    }
  });

  it("the CARD and the RAIL cannot drift: one act, one word", () => {
    // The card reads the wire outcome, the rail reads the stored column. Both
    // resolve to the same act and read its one title.
    const pairs: Array<[Parameters<typeof reviewSettledCopy>[0], (typeof ACTS)[number]]> = [
      ["approved", "continued"],
      ["changes_requested", "superseded"],
      ["rejected", "rejected"],
    ];
    for (const [outcome, act] of pairs) {
      expect(reviewSettledActForOutcome(outcome)).toBe(act);
      expect(reviewSettledCopy(outcome).title).toBe(REVIEW_SETTLED_ACT_TITLE[act]);
      expect(reviewSettledWord(REVIEW_SETTLED_ACT_STORAGE[act])).toBe(
        reviewSettledCopy(outcome).title,
      );
    }
  });

  it("no name rides the word, whatever a caller holds (cinatra#3080, fix leg 6)", () => {
    // The surface that used to read "Superseded by {name}" is the one the sixth
    // reading photographed. A name handed to this function is not appended: it
    // is not a parameter, and every reading of an act is the act's one title.
    expect(reviewSettledCopy("changes_requested").title).toBe("Superseded");
    expect(
      (reviewSettledCopy as (o: "changes_requested", name?: string) => { title: string })(
        "changes_requested",
        "Ada",
      ).title,
    ).toBe("Superseded");
  });

  it("a value this build cannot read says Settled, and never a raw column", () => {
    expect(reviewSettledAct("comment")).toBeNull();
    expect(reviewSettledWord("comment")).toBe("Settled");
    expect(reviewSettledWord(null)).toBe("Settled");
  });
});
