// The authoritative-refetch contract (cinatra#2565, epic #2564 S1).
// Design: design@6c20871b4108176c1d0193f19ecd2947f6c6355f
// `specs/app-lifecycle-cards.html` at that commit §IV.
//
// Every assertion here is about what a reader may LEARN, not only what they
// see: the order of the checks, the collapse of every denial into `absent`, and
// the refusal of a ref to act as a capability.

import { beforeEach, describe, expect, it, vi } from "vitest";

// The ref codec is keyed off the app secret (the same key source the chat /
// agent-run MCP actor tokens use), so the suite pins one.
process.env.BETTER_AUTH_SECRET ??= "test-secret-for-lifecycle-refs";

const enforceReviewRunAccess = vi.fn();
const readReviewGateState = vi.fn();
const readReviewGate = vi.fn();
const readVerificationRecordForGate = vi.fn();
const readAdvisoryCommentsForGates = vi.fn(async () => []);

vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({
  enforceReviewRunAccess: (...args: unknown[]) => enforceReviewRunAccess(...args),
  readReviewGateState: (...args: unknown[]) => readReviewGateState(...args),
  readReviewGate: (...args: unknown[]) => readReviewGate(...args),
  readAdvisoryCommentsForGates: (...args: unknown[]) =>
    readAdvisoryCommentsForGates(...(args as [])),
}));

vi.mock("@cinatra-ai/agents/lifecycle-verification-read-store", () => ({
  readVerificationRecordForGate: (...args: unknown[]) =>
    readVerificationRecordForGate(...args),
}));

import {
  VERIFICATION_SUMMARY_AUTHOR_KIND_MAX_LENGTH,
  VERIFICATION_SUMMARY_COMMENT_MAX_LENGTH,
  VERIFICATION_SUMMARY_MAX_ADVISORY_COMMENTS,
  VERIFICATION_SUMMARY_MAX_FIELD_DIFF,
  VERIFICATION_SUMMARY_PATH_MAX_LENGTH,
  VERIFICATION_SUMMARY_VALUE_MAX_LENGTH,
  verificationSummaryBodySchema,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";

import {
  LIFECYCLE_RESTRICTED_REASON,
  decodeLifecycleGateRef,
  encodeLifecycleGateRef,
  resolveLifecycleCardState,
} from "../lifecycle-card-refetch";

const actorCtx = {
  actor: { actorType: "human", userId: "u1", source: "route" },
  orgId: "org-1",
  roleHints: { actorOrganizationId: "org-1" },
} as never;

const REF = encodeLifecycleGateRef({ runId: "run-1", reviewTaskId: "task-1" })!;

/** Grant/deny a specific run-access op; every other op denies. */
function accessFor(granted: string[]) {
  enforceReviewRunAccess.mockImplementation(async (_runId, _actor, op) => ({
    ok: granted.includes(op as string),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` clears CALLS, not implementations, so a per-test
  // `mockResolvedValue` would otherwise leak into the next test. The advisory
  // read's default is "no comments" — the shape most cases want.
  readAdvisoryCommentsForGates.mockReset();
  readAdvisoryCommentsForGates.mockResolvedValue([] as never);
});

describe("the ref codec", () => {
  it("round-trips a gate ref", () => {
    expect(decodeLifecycleGateRef(REF)).toEqual({
      runId: "run-1",
      reviewTaskId: "task-1",
    });
  });

  it("is OPAQUE — the encoded ref reveals neither id", () => {
    expect(REF).not.toContain("run-1");
    expect(REF).not.toContain("task-1");
    // And not merely encoded: decoding the bytes as text/base64 yields nothing.
    expect(Buffer.from(REF, "base64url").toString("utf8")).not.toContain("run-1");
  });

  it("is TAMPER-EVIDENT — a flipped byte decodes to nothing", () => {
    const bytes = Buffer.from(REF, "base64url");
    bytes[bytes.length - (16 + 1)] ^= 0xff; // corrupt the ciphertext body
    expect(decodeLifecycleGateRef(bytes.toString("base64url"))).toBeNull();
  });

  it("mints two DIFFERENT refs for the same row (no equality oracle)", () => {
    const a = encodeLifecycleGateRef({ runId: "run-1", reviewTaskId: "task-1" });
    const b = encodeLifecycleGateRef({ runId: "run-1", reviewTaskId: "task-1" });
    expect(a).not.toBe(b);
  });

  it("refuses ids that would not fit the wire bound", () => {
    expect(
      encodeLifecycleGateRef({ runId: "r".repeat(200), reviewTaskId: "t" }),
    ).toBeNull();
    expect(encodeLifecycleGateRef({ runId: "", reviewTaskId: "t" })).toBeNull();
  });

  it("decodes nothing from junk (never throws)", () => {
    for (const junk of ["", "!!!!", "Zm9v", "a".repeat(600), "eyJ4Ijoxf"]) {
      expect(() => decodeLifecycleGateRef(junk)).not.toThrow();
    }
    expect(decodeLifecycleGateRef("!!!!")).toBeNull();
  });

  it("an encoded ref stays inside the wire ref bound", () => {
    expect(REF.length).toBeLessThanOrEqual(512);
  });
});


// ---------------------------------------------------------------------------
// The per-kind ENVELOPE (epic S9, slice S9c)
// ---------------------------------------------------------------------------
//
// The resolver answers `{ kind, state, body }`. The state ladder below is the
// one S1 pinned, unchanged, assertion for assertion; what is added is the body
// each kind is authorized to carry, and the rule that `absent` carries none.

describe("artifact_review_gate — the state ladder (§IV)", () => {
  it("`absent` when the reader has no run READ access — and the gate is never read", async () => {
    accessFor([]);
    const resolved = await resolveLifecycleCardState({
      viewType: "artifact_review_gate",
      ref: REF,
      actorCtx,
    });
    expect(resolved).toEqual({
      kind: "artifact_review_gate",
      state: { state: "absent" },
      body: null,
    });
    // Order is the security property: gate existence is not consulted before
    // the reader is authorized to know about the run at all.
    expect(readReviewGateState).not.toHaveBeenCalled();
  });

  it("`pending` when the gate is open and the reader may decide", async () => {
    accessFor(["read", "approveHitl", "respondToHitl"]);
    readReviewGateState.mockResolvedValue({ status: "pending", targets: [] });
    expect(
      await resolveLifecycleCardState({
        viewType: "artifact_review_gate",
        ref: REF,
        actorCtx,
      }),
    ).toEqual({
      kind: "artifact_review_gate",
      state: { state: "pending", canDecide: true, canComment: true },
      body: null,
    });
  });

  it("`restricted` — may view and comment, may not decide — with a non-enumerating reason", async () => {
    accessFor(["read", "respondToHitl"]);
    readReviewGateState.mockResolvedValue({ status: "pending", targets: [] });
    const resolved = await resolveLifecycleCardState({
      viewType: "artifact_review_gate",
      ref: REF,
      actorCtx,
    });
    expect(resolved).toEqual({
      kind: "artifact_review_gate",
      state: {
        state: "restricted",
        canDecide: false,
        canComment: true,
        reason: LIFECYCLE_RESTRICTED_REASON,
      },
      body: null,
    });
    // The reason describes the READER's standing and names nothing about the item.
    expect(LIFECYCLE_RESTRICTED_REASON).not.toMatch(/run-1|task-1|\d/);
  });

  it("`settled` for a resolved gate — the reload case (a decided gate renders resolved)", async () => {
    accessFor(["read", "approveHitl", "respondToHitl"]);
    readReviewGateState.mockResolvedValue({ status: "resolved", fingerprint: "fp" });
    expect(
      await resolveLifecycleCardState({
        viewType: "artifact_review_gate",
        ref: REF,
        actorCtx,
      }),
    ).toEqual({
      kind: "artifact_review_gate",
      state: { state: "settled" },
      body: null,
    });
  });

  it("`absent` for an unavailable gate — a replayed ref draws no DOM for nothing", async () => {
    accessFor(["read"]);
    readReviewGateState.mockResolvedValue({ status: "unavailable" });
    expect(
      await resolveLifecycleCardState({
        viewType: "artifact_review_gate",
        ref: REF,
        actorCtx,
      }),
    ).toEqual({
      kind: "artifact_review_gate",
      state: { state: "absent" },
      body: null,
    });
  });

  it("`absent` for a ref that does not decode — a forged ref buys nothing", async () => {
    accessFor(["read", "approveHitl"]);
    expect(
      await resolveLifecycleCardState({
        viewType: "artifact_review_gate",
        ref: "not-a-ref!!",
        actorCtx,
      }),
    ).toEqual({
      kind: "artifact_review_gate",
      state: { state: "absent" },
      body: null,
    });
    expect(enforceReviewRunAccess).not.toHaveBeenCalled();
  });

  it("`absent` when the store throws — a failure is not an existence signal", async () => {
    accessFor(["read"]);
    readReviewGateState.mockRejectedValue(new Error("db down"));
    expect(
      await resolveLifecycleCardState({
        viewType: "artifact_review_gate",
        ref: REF,
        actorCtx,
      }),
    ).toEqual({
      kind: "artifact_review_gate",
      state: { state: "absent" },
      body: null,
    });
  });

  it("carries NO body on any path — the target arrives through the island", async () => {
    accessFor(["read", "approveHitl", "respondToHitl"]);
    for (const status of ["pending", "resolved", "unavailable"]) {
      readReviewGateState.mockResolvedValue({ status, targets: [] });
      const resolved = await resolveLifecycleCardState({
        viewType: "artifact_review_gate",
        ref: REF,
        actorCtx,
      });
      expect(resolved.body).toBeNull();
    }
  });
});

const RECORD = {
  id: "vr-1",
  gateId: "gate-row-1",
  reviewedTarget: { artifactId: "art-1", representationRevisionId: "rev-base" },
  repairedTarget: { artifactId: "art-1", representationRevisionId: "rev-fixed" },
  scopeManifest: { paths: ["content.title"] },
  fieldDiff: [{ field: "content.title", before: "old", after: "new" }],
  outcome: "verified",
  createdAt: new Date(0),
};

describe("verification_summary — advisory, and now a reading to draw (§VII)", () => {
  it("`advisory` WITH the sanitized body when the reader may read the run", async () => {
    accessFor(["read"]);
    readReviewGate.mockResolvedValue({ id: "gate-row-1" });
    readVerificationRecordForGate.mockResolvedValue(RECORD);
    expect(
      await resolveLifecycleCardState({
        viewType: "verification_summary",
        ref: REF,
        actorCtx,
      }),
    ).toEqual({
      kind: "verification_summary",
      state: { state: "advisory" },
      body: {
        version: 1,
        outcome: "verified",
        reviewedRevisionId: "rev-base",
        repairedRevisionId: "rev-fixed",
        // The manifest does NOT travel as a list — §VII draws no region for it
        // (cinatra#2861). It travels as the row's own `inScope`.
        fieldDiff: [{ field: "content.title", before: "old", after: "new", inScope: true }],
        advisoryComments: [],
      },
    });
  });

  it("carries §VII's advisory comments — where the reading's PROVENANCE lives", async () => {
    // §VII puts the provenance in the body of a service comment rather than on
    // a line of its own, so a body without the comments is a verdict with no
    // provenance on every host that is not the review page. They ride the same
    // authorized answer as the rest of the reading (epic S9, slice S9e).
    accessFor(["read"]);
    readReviewGate.mockResolvedValue({ id: "gate-row-1" });
    readVerificationRecordForGate.mockResolvedValue(RECORD);
    readAdvisoryCommentsForGates.mockResolvedValue([
      {
        id: "cmt-1",
        gateId: "gate-row-1",
        authorId: "svc",
        authorKind: "service",
        body: "Core analysis of 1 disclosed field(s). [provenance] lane=core-analysis-lane",
        createdAt: new Date(0),
      },
    ] as never);
    const resolved = await resolveLifecycleCardState({
      viewType: "verification_summary",
      ref: REF,
      actorCtx,
    });
    expect(resolved.body).toMatchObject({
      advisoryComments: [
        {
          authorKind: "service",
          body: "Core analysis of 1 disclosed field(s). [provenance] lane=core-analysis-lane",
        },
      ],
    });
    // The comment's own row id is NOT addressable from the card.
    expect(JSON.stringify(resolved.body)).not.toContain("cmt-1");
    expect(verificationSummaryBodySchema.safeParse(resolved.body).success).toBe(true);
  });

  it("drops a half-formed comment rather than drawing an empty panel", async () => {
    accessFor(["read"]);
    readReviewGate.mockResolvedValue({ id: "gate-row-1" });
    readVerificationRecordForGate.mockResolvedValue(RECORD);
    readAdvisoryCommentsForGates.mockResolvedValue([
      { id: "c1", authorKind: "", body: "no author kind" },
      { id: "c2", authorKind: "service", body: "" },
      { id: "c3", authorKind: "agent", body: "kept" },
    ] as never);
    const resolved = await resolveLifecycleCardState({
      viewType: "verification_summary",
      ref: REF,
      actorCtx,
    });
    expect((resolved.body as { advisoryComments: unknown[] }).advisoryComments).toEqual([
      { authorKind: "agent", body: "kept" },
    ]);
  });

  it("clamps the comments to their own ceilings", async () => {
    accessFor(["read"]);
    readReviewGate.mockResolvedValue({ id: "gate-row-1" });
    readVerificationRecordForGate.mockResolvedValue(RECORD);
    readAdvisoryCommentsForGates.mockResolvedValue(
      Array.from({ length: 200 }, (_unused, i) => ({
        id: `c${i}`,
        authorKind: "service".padEnd(200, "x"),
        body: "b".repeat(9000),
      })) as never,
    );
    const resolved = await resolveLifecycleCardState({
      viewType: "verification_summary",
      ref: REF,
      actorCtx,
    });
    const comments = (resolved.body as {
      advisoryComments: { authorKind: string; body: string }[];
    }).advisoryComments;
    expect(comments).toHaveLength(VERIFICATION_SUMMARY_MAX_ADVISORY_COMMENTS);
    expect(comments[0]!.authorKind.length).toBe(VERIFICATION_SUMMARY_AUTHOR_KIND_MAX_LENGTH);
    expect(comments[0]!.body.length).toBe(VERIFICATION_SUMMARY_COMMENT_MAX_LENGTH);
    expect(verificationSummaryBodySchema.safeParse(resolved.body).success).toBe(true);
  });

  it("a comment-store failure keeps the READING, and says the panel is UNKNOWN", async () => {
    // The verdict and the diff are already authorized; losing the comments must
    // cost the provenance panel, not the whole card. And it must cost it
    // HONESTLY (cinatra#2861): `null`, not `[]`. An empty list is the resolver
    // stating that this analysis carries no comments — a fact it did not
    // establish here — and the card draws those two answers differently.
    accessFor(["read"]);
    readReviewGate.mockResolvedValue({ id: "gate-row-1" });
    readVerificationRecordForGate.mockResolvedValue(RECORD);
    readAdvisoryCommentsForGates.mockRejectedValue(new Error("store down") as never);
    const resolved = await resolveLifecycleCardState({
      viewType: "verification_summary",
      ref: REF,
      actorCtx,
    });
    expect(resolved.state).toEqual({ state: "advisory" });
    expect((resolved.body as { advisoryComments: unknown }).advisoryComments).toBeNull();
    expect(verificationSummaryBodySchema.safeParse(resolved.body).success).toBe(true);
  });

  it("…and a SYNCHRONOUS throw from that store keeps the reading too", async () => {
    // A `.catch()` on the call would not cover this shape: a store that throws
    // before returning a promise throws before the handler is attached, and the
    // module's outer guard would turn the whole card into an `absent`. The
    // reading is already authorized at this point; only the panel may be lost.
    accessFor(["read"]);
    readReviewGate.mockResolvedValue({ id: "gate-row-1" });
    readVerificationRecordForGate.mockResolvedValue(RECORD);
    readAdvisoryCommentsForGates.mockImplementation(() => {
      throw new TypeError("not a function on this build");
    });
    const resolved = await resolveLifecycleCardState({
      viewType: "verification_summary",
      ref: REF,
      actorCtx,
    });
    expect(resolved.state).toEqual({ state: "advisory" });
    expect((resolved.body as { advisoryComments: unknown }).advisoryComments).toBeNull();
  });

  it("the body names NO addressable identifier — not the record, gate or artifact", async () => {
    accessFor(["read"]);
    readReviewGate.mockResolvedValue({ id: "gate-row-1" });
    readVerificationRecordForGate.mockResolvedValue(RECORD);
    const resolved = await resolveLifecycleCardState({
      viewType: "verification_summary",
      ref: REF,
      actorCtx,
    });
    const serialized = JSON.stringify(resolved.body);
    expect(serialized).not.toContain("vr-1");
    expect(serialized).not.toContain("gate-row-1");
    expect(serialized).not.toContain("art-1");
  });

  it("clamps every field to the contract's ceilings", async () => {
    accessFor(["read"]);
    readReviewGate.mockResolvedValue({ id: "gate-row-1" });
    readVerificationRecordForGate.mockResolvedValue({
      ...RECORD,
      scopeManifest: { paths: Array.from({ length: 500 }, () => "p".repeat(900)) },
      fieldDiff: Array.from({ length: 500 }, (_unused, i) => ({
        field: `f${i}`.padEnd(900, "x"),
        before: "b".repeat(5000),
        after: undefined,
      })),
    });
    const resolved = await resolveLifecycleCardState({
      viewType: "verification_summary",
      ref: REF,
      actorCtx,
    });
    const body = resolved.body as {
      fieldDiff: { field: string; before: string | null; after: string | null }[];
    };
    expect(body.fieldDiff).toHaveLength(VERIFICATION_SUMMARY_MAX_FIELD_DIFF);
    expect(body.fieldDiff[0]!.field.length).toBe(VERIFICATION_SUMMARY_PATH_MAX_LENGTH);
    expect(body.fieldDiff[0]!.before!.length).toBe(VERIFICATION_SUMMARY_VALUE_MAX_LENGTH);
    // A missing side is `null`, never the string "undefined".
    expect(body.fieldDiff[0]!.after).toBeNull();
    // And what it produces is what the wire contract accepts.
    expect(verificationSummaryBodySchema.safeParse(resolved.body).success).toBe(true);
  });

  it("decides IN-SCOPE against the WHOLE manifest, not the projection's ceilings", async () => {
    // cinatra#2861. The manifest used to travel as a bounded, path-clamped list
    // and the card re-derived the mark from it by set membership. Both ceilings
    // could then lie: an authorized path past the list ceiling, or one longer
    // than the path ceiling, would fail the membership test and the card would
    // mark an AUTHORIZED change as out-of-scope drift — accusing a repair of
    // going outside what a human allowed, on nothing but a ceiling. The mark is
    // decided here, where the manifest is whole and untruncated.
    const longPath = `content.${"deep.".repeat(120)}title`;
    expect(longPath.length).toBeGreaterThan(VERIFICATION_SUMMARY_PATH_MAX_LENGTH);
    const buried = "content.buried";
    accessFor(["read"]);
    readReviewGate.mockResolvedValue({ id: "gate-row-1" });
    readVerificationRecordForGate.mockResolvedValue({
      ...RECORD,
      scopeManifest: {
        // `buried` sits far past any list ceiling the body used to carry, and
        // `longPath` is longer than the path ceiling. Both are authorized.
        paths: [...Array.from({ length: 400 }, (_u, i) => `filler.${i}`), buried, longPath],
      },
      fieldDiff: [
        { field: buried, before: "old", after: "new" },
        { field: longPath, before: "old", after: "new" },
        { field: "content.never-authorized", before: null, after: "x" },
      ],
    });
    const resolved = await resolveLifecycleCardState({
      viewType: "verification_summary",
      ref: REF,
      actorCtx,
    });
    const rows = (resolved.body as { fieldDiff: { inScope: boolean }[] }).fieldDiff;
    expect(rows.map((r) => r.inScope)).toEqual([true, true, false]);
    expect(verificationSummaryBodySchema.safeParse(resolved.body).success).toBe(true);
  });

  it("PINS the service provenance through the comment clamp", async () => {
    // §VII fixes the reading's provenance as the body of a SERVICE comment, and
    // the core APPENDS that comment — so in store order (createdAt ascending)
    // it is LAST. A plain first-N clamp therefore evicts exactly the row the
    // spec says must be there: a gate that collected more than the ceiling of
    // human comments would ship a verdict with no provenance at all
    // (cinatra#2861). The service rows ride through the clamp; the kept rows
    // still come out in store order.
    accessFor(["read"]);
    readReviewGate.mockResolvedValue({ id: "gate-row-1" });
    readVerificationRecordForGate.mockResolvedValue(RECORD);
    readAdvisoryCommentsForGates.mockResolvedValue([
      ...Array.from({ length: VERIFICATION_SUMMARY_MAX_ADVISORY_COMMENTS + 30 }, (_u, i) => ({
        id: `human-${i}`,
        authorKind: "user",
        body: `human comment ${i}`,
      })),
      { id: "svc-1", authorKind: "service", body: "[provenance] lane=core-analysis-lane" },
    ] as never);
    const resolved = await resolveLifecycleCardState({
      viewType: "verification_summary",
      ref: REF,
      actorCtx,
    });
    const comments = (
      resolved.body as { advisoryComments: { authorKind: string; body: string }[] }
    ).advisoryComments;
    expect(comments).toHaveLength(VERIFICATION_SUMMARY_MAX_ADVISORY_COMMENTS);
    // The appended service comment survived…
    expect(comments.some((c) => c.authorKind === "service")).toBe(true);
    // …at the END, which is where the store put it: the clamp changes WHICH
    // rows are kept, never the order they are drawn in.
    expect(comments[comments.length - 1]).toEqual({
      authorKind: "service",
      body: "[provenance] lane=core-analysis-lane",
    });
    expect(comments[0]!.body).toBe("human comment 0");
    expect(verificationSummaryBodySchema.safeParse(resolved.body).success).toBe(true);
  });

  it("`absent` for a verdict outside the closed set — an unreadable row draws nothing", async () => {
    accessFor(["read"]);
    readReviewGate.mockResolvedValue({ id: "gate-row-1" });
    readVerificationRecordForGate.mockResolvedValue({ ...RECORD, outcome: "who-knows" });
    expect(
      await resolveLifecycleCardState({
        viewType: "verification_summary",
        ref: REF,
        actorCtx,
      }),
    ).toEqual({
      kind: "verification_summary",
      state: { state: "absent" },
      body: null,
    });
  });

  it("`absent` without run read access — and the record is never read", async () => {
    accessFor([]);
    expect(
      await resolveLifecycleCardState({
        viewType: "verification_summary",
        ref: REF,
        actorCtx,
      }),
    ).toEqual({
      kind: "verification_summary",
      state: { state: "absent" },
      body: null,
    });
    expect(readVerificationRecordForGate).not.toHaveBeenCalled();
  });

  it("`absent` when no record exists", async () => {
    accessFor(["read"]);
    readReviewGate.mockResolvedValue({ id: "gate-row-1" });
    readVerificationRecordForGate.mockResolvedValue(null);
    expect(
      await resolveLifecycleCardState({
        viewType: "verification_summary",
        ref: REF,
        actorCtx,
      }),
    ).toEqual({
      kind: "verification_summary",
      state: { state: "absent" },
      body: null,
    });
  });
});

describe("trigger_schedule_proposal — the route is the only resolver", () => {
  it("`absent`, so no floor is ever drawn without a proposal behind it", async () => {
    accessFor(["read", "approveHitl"]);
    expect(
      await resolveLifecycleCardState({
        viewType: "trigger_schedule_proposal",
        ref: REF,
        actorCtx,
      }),
    ).toEqual({
      kind: "trigger_schedule_proposal",
      state: { state: "absent" },
      body: null,
    });
  });
});
