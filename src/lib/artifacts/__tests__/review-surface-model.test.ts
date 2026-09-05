/**
 * Unit tests for the PURE artifact-review surface model (cinatra#1795 S12 item 4;
 * spec design@0c484154b069c6369a33c1375056126289888997). Proves the §III provenance mapping, the §V permission
 * copy, and — the load-bearing rule — the FAIL-CLOSED submit-result → outcome
 * mapping (§IV: a fingerprint conflict / settled gate is a BLOCK, never a silent
 * success). No React / DB — every seam is plain data.
 */
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
  reviewProvenanceConformanceId,
  reviewProvenanceLabel,
  reviewRevisionMarker,
  reviewTypeLabel,
  reviewTargetRowFacts,
  REVIEW_DISPOSITIONS,
} from "../review-surface-model";
import type { ReviewSettledOutcome } from "../review-surface-model";
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
    expect(reviewTypeLabel("@acme/support-desk:case")).toBe("Support Desk");
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
  it("a comment-only reviewer sees the terminal-needs-approve reason", () => {
    const reason = reviewDecideDisabledReason({ canDecide: false, canComment: true });
    expect(reason).toMatch(/approve access/);
    expect(reason).toMatch(/Comment/);
  });
  it("a reviewer with neither sees the no-approve-access reason", () => {
    expect(reviewDecideDisabledReason({ canDecide: false, canComment: false })).toMatch(/approve access/);
  });
  it("blocked copy covers every closed reason", () => {
    expect(reviewBlockedCopy("no-longer-pending").title).toMatch(/no longer open/);
    expect(reviewBlockedCopy("targets-mismatch").title).toMatch(/out of date/);
    expect(reviewBlockedCopy("revision-not-live").title).toMatch(/no longer live/);
  });
});

describe("§IV — the disposition set is exactly three (no 'request changes')", () => {
  it("approve / reject / comment only", () => {
    expect([...REVIEW_DISPOSITIONS].sort()).toEqual(["approve", "comment", "reject"]);
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

// RE-PINNED (cinatra#2934, fix leg 12). Everything below used to hold the
// three-way reading — "Approved by …" / "Rejected by …" / "Changes requested" —
// which the ratified drawings have since closed on both axes. Lifecycle cards
// §XIII.1: "Continued is the only settled reading; there is no second status
// after it", drawn as the marker "Continued" over "Decided on the revision
// above." Artifact review §VI: the review "draws no card that names who
// requested changes". The disposition survives as a RECORD (the run's rows, and
// the element's own `data-review-outcome`); it is no longer a reading, and the
// decider is no longer a parameter.
describe("the settled copy is the drawing's one marker", () => {
  it("the local settled union is the SAME closed set the wire carries", () => {
    // This model deliberately keeps its own local union rather than importing
    // the wire type, so the two are pinned together HERE. The exhaustive record
    // fails to compile if a member is added on one side, and the comparison
    // fails at runtime if one is added on the other.
    const local: Record<ReviewSettledOutcome, true> = {
      approved: true,
      rejected: true,
      changes_requested: true,
    };
    expect(Object.keys(local).sort()).toEqual([...LIFECYCLE_SETTLED_OUTCOMES].sort());
  });

  it("reads the drawing's marker for every disposition", () => {
    for (const outcome of LIFECYCLE_SETTLED_OUTCOMES) {
      expect(reviewSettledCopy(outcome)).toEqual({
        title: "Continued",
        body: "Decided on the revision above.",
      });
    }
  });

  it("takes no decider at all — there is nowhere on this surface to put one", () => {
    expect(reviewSettledCopy.length).toBe(1);
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
    expect(line).toBe("organization · organization · text/markdown · updated 8 minutes ago");
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
    expect(facts).toEqual(["team", "private", "text/html", "updated 8 minutes ago"]);
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
    expect(facts[3]).toBe("updated 8 minutes ago");
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
    expect(facts).toEqual(["team", "private", "text/html", "updated 8 minutes ago"]);
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
