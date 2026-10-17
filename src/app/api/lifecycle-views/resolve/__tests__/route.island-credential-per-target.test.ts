// POST /api/lifecycle-views/resolve — ONE SINGLE-USE ISLAND ADDRESS PER PINNED
// TARGET (cinatra#4129).
//
// A pending gate that pins several targets is drawn as pairs on every host:
// each target's header directly above its own island frame, and each frame
// names the one pinned revision it draws. On the site widget a frame is
// authenticated by the single-use credential in its address, and one grant
// paints ONE document — so a gate the card pairs needs one address per target,
// minted through the same, unchanged minter the single island uses.
//
// What is pinned here:
//
//   1. THE WIDGET ARM MINTS ONE ADDRESS PER PINNED TARGET of a pending or
//      restricted gate, each naming its own target, and hands out no
//      gate-wide address beside them (a bearer nothing frames).
//   2. A FAILED MINT REFUSES THAT TARGET ONLY.
//   3. EVERY OTHER ANSWER IS THE ONE IT WAS: one target, the settled reading and
//      the cookie arm keep their single address or none.
//   4. PAIRS ONLY OVER COMPLETE HEADERS. A reading that says its headers are
//      not complete (cut at their bound of twelve, or carrying an id inexactly)
//      keeps the ONE gate-wide address for its one aggregate island, and the
//      answer says so. A target this reader cannot read has no header and
//      leaves the reading complete; the header reader decides that, and its own
//      suite pins it.
//
// The header reader is stubbed here (and only here): the sibling suite leaves it
// real, and its answer there is `null`.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveReviewActorContext = vi.fn();
const resolveWidgetLifecycleActorContext = vi.fn();
const mintWidgetReviewIslandUrl = vi.fn();
const resolveAssistantWidgetBinding = vi.fn();
const resolveLifecycleCardState = vi.fn();
const attachLifecycleSuggestions = vi.fn();
const attachLifecycleSettledOutcome = vi.fn();
const decodeLifecycleGateRef = vi.fn();
const readReviewGateRecordedPrompt = vi.fn();
const readReviewTargetHeadersReading = vi.fn();

const MOCKED_MODULES = [
  "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-actor",
  "@/lib/lifecycle/widget-lifecycle-actor",
  "@/lib/assistant-widget-handles",
  "@/lib/lifecycle/lifecycle-card-ref",
  "@/lib/lifecycle/lifecycle-card-refetch",
  "@/lib/lifecycle/lifecycle-suggestion-chips",
  "@/lib/lifecycle/lifecycle-settled-outcome",
  "@/lib/lifecycle/trigger-schedule-proposal-card",
  "@/app/artifacts/[id]/review-gate-ports",
  "@/lib/lifecycle/lifecycle-target-headers",
] as const;

vi.mock(
  "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-actor",
  () => ({ resolveReviewActorContext: () => resolveReviewActorContext() }),
);
vi.mock("@/lib/lifecycle/widget-lifecycle-actor", () => ({
  resolveWidgetLifecycleActorContext: (...a: unknown[]) =>
    resolveWidgetLifecycleActorContext(...a),
  mintWidgetReviewIslandUrl: (...a: unknown[]) => mintWidgetReviewIslandUrl(...a),
}));
vi.mock("@/lib/assistant-widget-handles", () => ({
  resolveAssistantWidgetBinding: (...a: unknown[]) => resolveAssistantWidgetBinding(...a),
}));
vi.mock("@/lib/lifecycle/lifecycle-card-ref", () => ({
  decodeLifecycleGateRef: (...a: unknown[]) => decodeLifecycleGateRef(...a),
}));
vi.mock("@/lib/lifecycle/lifecycle-card-refetch", () => ({
  resolveLifecycleCardState: (...a: unknown[]) => resolveLifecycleCardState(...a),
}));
vi.mock("@/lib/lifecycle/lifecycle-suggestion-chips", () => ({
  attachLifecycleSuggestions: (...a: unknown[]) => attachLifecycleSuggestions(...a),
}));
vi.mock("@/lib/lifecycle/lifecycle-settled-outcome", () => ({
  attachLifecycleSettledOutcome: (...a: unknown[]) => attachLifecycleSettledOutcome(...a),
}));
vi.mock("@/lib/lifecycle/trigger-schedule-proposal-card", () => ({
  resolveTriggerScheduleProposalCard: vi.fn(),
}));
vi.mock("@/app/artifacts/[id]/review-gate-ports", () => ({
  readReviewGateRecordedPrompt: (...args: unknown[]) => readReviewGateRecordedPrompt(...args),
}));
// The reader's headers: one per pinned target the reader may read, in pinned
// order, and whether they are complete. The headers-only
// reader answers the same reading's headers.
vi.mock("@/lib/lifecycle/lifecycle-target-headers", () => ({
  readReviewTargetHeadersReading: (...args: unknown[]) => readReviewTargetHeadersReading(...args),
  readReviewTargetHeaders: async (...args: unknown[]) =>
    ((await readReviewTargetHeadersReading(...args)) as { headers: unknown }).headers,
}));

import {
  parseLifecycleResolveEnvelope,
  reviewGateTargetDrawing,
  type LifecycleTargetHeader,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";

import { POST } from "../route";

const REF = "ref-opaque";
const ORIGIN = "https://blog.example.com";
const ISLAND_PATH = "/lifecycle/review-island";
/** What the minter hands back, one call after another — a DIFFERENT credential
 *  each time, as the real minter's fresh seal is. */
const MINTED = [
  `${ISLAND_PATH}?ref=ref-opaque&ic=sealed-value-one`,
  `${ISLAND_PATH}?ref=ref-opaque&ic=sealed-value-two`,
];

/** The claims the widget door consumed — the only input a credential is built from. */
const CLAIMS = {
  orgId: "org-1",
  userId: "u1",
  jti: "jti-1",
  siteId: "site-1",
  client: "wordpress",
  instanceId: "inst-1",
  agentSlug: "wordpress-content-editor",
};

const WIDGET_ACTOR = {
  actor: { actorType: "human", source: "a2a", userId: "u1", orgId: "org-1" },
  orgId: "org-1",
  roleHints: { platformRole: "member", orgRole: "member", actorOrganizationId: "org-1" },
};

const COOKIE_ACTOR = {
  actor: { actorType: "human", source: "route", userId: "u1", orgId: "org-1" },
  orgId: "org-1",
  roleHints: { actorOrganizationId: "org-1" },
};

const header = (revisionId: string, title: string) => ({
  title,
  typeLabel: "Email",
  objectType: "",
  revisionId,
  facts: ["team", "private"],
});
const REVISION_ONE = "rev_8f3a1c2d4e5f6a7b";
const REVISION_TWO = "rev_11223344556677";
const TWO_HEADERS = [
  header(REVISION_ONE, "Q3 re-engagement email"),
  header(REVISION_TWO, "Q3 cohort brief"),
];

const PENDING = { state: "pending", canDecide: true, canComment: true };
const RESTRICTED = {
  state: "restricted",
  canDecide: false,
  canComment: true,
  reason: "no approve",
};

function post(opts: { widget: boolean }): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.widget) {
    headers["X-Cinatra-Widget-User-Token"] = "cwu_b";
    headers["X-Cinatra-Widget-Assistant"] = "wordpress";
    headers["X-Cinatra-Widget-Origin"] = ORIGIN;
  }
  return new Request("https://app.test/api/lifecycle-views/resolve", {
    method: "POST",
    headers,
    body: JSON.stringify({ viewType: "artifact_review_gate", ref: REF }),
  });
}

/** The gate's answer, its headers, and the number of targets the gate pins —
 *  by default exactly the targets the headers name. */
function answerFor(
  state: Record<string, unknown>,
  headers: unknown[] | null,
  pinnedCount: number = headers?.length ?? 0,
) {
  resolveLifecycleCardState.mockResolvedValue({ kind: "artifact_review_gate", state, body: null });
  readReviewTargetHeadersReading.mockResolvedValue({
    headers,
    pinnedCount,
    complete: headers !== null && headers.length === pinnedCount,
  });
}

async function resolveAs(widget: boolean): Promise<Record<string, unknown>> {
  const res = await POST(post({ widget }));
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

/** The query of an address, read the way the island page reads it. */
const queryOf = (src: unknown): URLSearchParams => {
  expect(typeof src).toBe("string");
  const url = new URL(src as string, "https://island.invalid");
  expect(url.pathname).toBe(ISLAND_PATH);
  return url.searchParams;
};

/** The arguments of the ONE singleton mint — every per-target call must be these. */
const MINT_ARGUMENTS = { claims: CLAIMS, ref: REF, runId: "run-1", reviewTaskId: "task-1" };

beforeEach(() => {
  vi.clearAllMocks();
  readReviewGateRecordedPrompt.mockResolvedValue(null);
  resolveReviewActorContext.mockResolvedValue(COOKIE_ACTOR);
  resolveAssistantWidgetBinding.mockReturnValue({
    handle: "wordpress",
    agentSlug: "wordpress-content-editor",
  });
  resolveWidgetLifecycleActorContext.mockResolvedValue({
    ok: true,
    actorCtx: WIDGET_ACTOR,
    claims: CLAIMS,
  });
  decodeLifecycleGateRef.mockReturnValue({ runId: "run-1", reviewTaskId: "task-1" });
  attachLifecycleSuggestions.mockImplementation(async (state: unknown) => state);
  attachLifecycleSettledOutcome.mockImplementation(async (state: unknown) => state);
  answerFor(PENDING, null);
  // A case that queues its own answers must not leave one for the next case.
  mintWidgetReviewIslandUrl.mockReset();
  let call = 0;
  mintWidgetReviewIslandUrl.mockImplementation(() => {
    const minted = MINTED[Math.min(call, MINTED.length - 1)];
    call += 1;
    return minted;
  });
});

// Restored after every case; the module stubs stay registered for the cases
// that follow (the route imports one of them lazily) and are removed once the
// file is done.
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.resetModules();
});

afterAll(() => {
  for (const path of MOCKED_MODULES) vi.doUnmock(path);
  vi.resetModules();
});

describe("cinatra#4129 — one single-use island address per pinned target", () => {
  for (const [name, state] of [
    ["pending", PENDING],
    ["restricted", RESTRICTED],
  ] as const) {
    it(`the widget arm mints ONE address per pinned target of a ${name} gate`, async () => {
      answerFor(state, TWO_HEADERS);
      const answer = await resolveAs(true);

      expect(mintWidgetReviewIslandUrl).toHaveBeenCalledTimes(2);
      expect(mintWidgetReviewIslandUrl.mock.calls).toEqual([[MINT_ARGUMENTS], [MINT_ARGUMENTS]]);

      const byRevision = answer.islandSrcByRevision as Record<string, unknown>;
      expect(Object.keys(byRevision)).toEqual([REVISION_ONE, REVISION_TWO]);
      const one = queryOf(byRevision[REVISION_ONE]);
      const two = queryOf(byRevision[REVISION_TWO]);
      // Each address names its OWN target, carries the credential of its OWN
      // mint, and addresses the card's own gate.
      expect(one.get("target")).toBe(REVISION_ONE);
      expect(two.get("target")).toBe(REVISION_TWO);
      expect(one.get("ic")).toBe("sealed-value-one");
      expect(two.get("ic")).toBe("sealed-value-two");
      expect(one.get("ref")).toBe(REF);
      expect(two.get("ref")).toBe(REF);
      // No gate-wide address beside them: a minted bearer no frame takes.
      expect("islandSrc" in answer).toBe(false);
      expect(answer.targetHeaders).toEqual(TWO_HEADERS);
      expect(answer.targetHeadersComplete).toBe(true);
    });
  }

  it("a failed mint refuses that target only", async () => {
    answerFor(PENDING, TWO_HEADERS);
    mintWidgetReviewIslandUrl.mockReset();
    mintWidgetReviewIslandUrl.mockReturnValueOnce(MINTED[0]).mockReturnValueOnce(null);
    const answer = await resolveAs(true);

    expect(mintWidgetReviewIslandUrl).toHaveBeenCalledTimes(2);
    const byRevision = answer.islandSrcByRevision as Record<string, unknown>;
    expect(Object.keys(byRevision)).toEqual([REVISION_ONE, REVISION_TWO]);
    expect(byRevision[REVISION_TWO]).toBeNull();
    const one = queryOf(byRevision[REVISION_ONE]);
    expect(one.get("target")).toBe(REVISION_ONE);
    expect(one.get("ic")).toBe("sealed-value-one");
    expect("islandSrc" in answer).toBe(false);
  });

  it("one header keeps the singleton", async () => {
    answerFor(PENDING, [TWO_HEADERS[0]]);
    const answer = await resolveAs(true);

    expect(mintWidgetReviewIslandUrl).toHaveBeenCalledTimes(1);
    expect(mintWidgetReviewIslandUrl).toHaveBeenCalledWith(MINT_ARGUMENTS);
    expect(answer.islandSrc).toBe(MINTED[0]);
    expect("islandSrcByRevision" in answer).toBe(false);
  });

  it("the settled reading keeps one address", async () => {
    answerFor({ state: "settled", outcome: "approved", decidedByName: "Dana Okonkwo" }, TWO_HEADERS);
    const answer = await resolveAs(true);

    expect(mintWidgetReviewIslandUrl).toHaveBeenCalledTimes(1);
    expect(mintWidgetReviewIslandUrl).toHaveBeenCalledWith(MINT_ARGUMENTS);
    expect(answer.islandSrc).toBe(MINTED[0]);
    expect("islandSrcByRevision" in answer).toBe(false);
  });

  it("the cookie arm mints nothing", async () => {
    answerFor(PENDING, TWO_HEADERS);
    const answer = await resolveAs(false);

    expect(mintWidgetReviewIslandUrl).not.toHaveBeenCalled();
    expect("islandSrc" in answer).toBe(false);
    expect("islandSrcByRevision" in answer).toBe(false);
    expect(answer).toEqual({
      kind: "artifact_review_gate",
      state: PENDING,
      body: null,
      targetHeaders: TWO_HEADERS,
      targetHeadersComplete: true,
    });
  });
});

describe("pairs only over complete headers — every other gate keeps its one aggregate island", () => {
  /** Twelve headers — the bound — of a gate that pins sixteen. */
  const BOUND_HEADERS = Array.from({ length: 12 }, (_, i) =>
    header(`rev_bound_${String(i + 1).padStart(2, "0")}`, `Pinned target ${i + 1}`),
  );

  for (const [name, headers, pinned] of [
    ["a reading that says its two headers are not complete", TWO_HEADERS, 3],
    ["a gate that pins SIXTEEN targets, its headers cut at the bound of twelve", BOUND_HEADERS, 16],
  ] as const) {
    for (const [stateName, state] of [
      ["pending", PENDING],
      ["restricted", RESTRICTED],
    ] as const) {
      it(`${name} (${stateName}): the widget arm mints the ONE gate-wide address and no per-target map`, async () => {
        answerFor(state, [...headers], pinned);
        const answer = await resolveAs(true);

        expect(mintWidgetReviewIslandUrl).toHaveBeenCalledTimes(1);
        expect(mintWidgetReviewIslandUrl).toHaveBeenCalledWith(MINT_ARGUMENTS);
        expect(answer.islandSrc).toBe(MINTED[0]);
        expect(queryOf(answer.islandSrc).has("target"), "the address is the whole gate's").toBe(false);
        expect("islandSrcByRevision" in answer).toBe(false);
        expect(answer.targetHeaders).toEqual(headers);
        expect(answer.targetHeadersComplete).toBe(false);
      });
    }

    it(`${name}: the cookie arm mints nothing and says the headers are not complete`, async () => {
      answerFor(PENDING, [...headers], pinned);
      const answer = await resolveAs(false);

      expect(mintWidgetReviewIslandUrl).not.toHaveBeenCalled();
      expect(answer).toEqual({
        kind: "artifact_review_gate",
        state: PENDING,
        body: null,
        targetHeaders: headers,
        targetHeadersComplete: false,
      });
    });
  }

  // EACH PAIR'S SELECTOR NAMES ITS OWN TARGET ALONE. A pair is addressed, keyed
  // and filtered by its revision id, so a WHOLE pinned set whose revision ids
  // are not distinct, or not within the map's key bound, keeps the gate's one
  // aggregate island: ONE credential for ONE frame, never one shared by two.
  /** Two headers whose revision ids are `length` characters long and differ. */
  const keyedHeaders = (length: number) => [
    header(`a${"7".repeat(length - 1)}`, "Q3 re-engagement email"),
    header(`b${"7".repeat(length - 1)}`, "Q3 cohort brief"),
  ];
  for (const [name, selectorHeaders] of [
    [
      "two pinned targets of different artifacts that share ONE revision id",
      [header(REVISION_ONE, "Q3 re-engagement email"), header(REVISION_ONE, "Q3 cohort brief")],
    ],
    ["revision ids one character past the per-target key bound (129)", keyedHeaders(129)],
    ["revision ids the header cut at its 200-character bound", keyedHeaders(200)],
    // The address REWRITES an id that is not well-formed UTF-16: the island
    // would read U+FFFD where the pair was drawn for a lone surrogate.
    [
      "a revision id the address would rewrite (a lone surrogate)",
      [header(REVISION_ONE, "Q3 re-engagement email"), header("rev-\uD800-a", "Q3 cohort brief")],
    ],
    // Within the raw bound, but 768 characters once percent-encoded.
    [
      "a multibyte revision id of exactly 128 characters, 768 once encoded",
      [header(REVISION_ONE, "Q3 re-engagement email"), header("é".repeat(128), "Q3 cohort brief")],
    ],
  ] as const) {
    for (const [stateName, state] of [
      ["pending", PENDING],
      ["restricted", RESTRICTED],
    ] as const) {
      it(`${name} (${stateName}): a WHOLE pinned set keeps the ONE gate-wide address`, async () => {
        answerFor(state, [...selectorHeaders]);
        const answer = await resolveAs(true);

        expect(mintWidgetReviewIslandUrl).toHaveBeenCalledTimes(1);
        expect(mintWidgetReviewIslandUrl).toHaveBeenCalledWith(MINT_ARGUMENTS);
        expect(answer.islandSrc).toBe(MINTED[0]);
        expect(queryOf(answer.islandSrc).has("target"), "the address is the whole gate's").toBe(false);
        expect("islandSrcByRevision" in answer).toBe(false);
        expect(answer.targetHeaders).toEqual(selectorHeaders);
        expect(answer.targetHeadersComplete).toBe(true);
      });
    }
  }

  it("revision ids AT the per-target key bound (128) are still drawn as pairs, one address each", async () => {
    const atBound = keyedHeaders(128);
    answerFor(PENDING, atBound);
    const answer = await resolveAs(true);

    expect(mintWidgetReviewIslandUrl).toHaveBeenCalledTimes(2);
    const byRevision = answer.islandSrcByRevision as Record<string, unknown>;
    expect(Object.keys(byRevision)).toEqual(atBound.map((h) => h.revisionId));
    expect(queryOf(byRevision[atBound[0]!.revisionId]).get("ic")).toBe("sealed-value-one");
    expect(queryOf(byRevision[atBound[1]!.revisionId]).get("ic")).toBe("sealed-value-two");
    expect("islandSrc" in answer).toBe(false);
  });

  // EVERY ADDRESS HANDED OUT FITS THE BOUND THE CARD READS IT UNDER. The route
  // proves each per-target address before it hands it out; an address that does
  // not fit is null for that target alone, and the answer still parses.
  /** A minter whose every address is `length` characters long and carries a
   *  fresh credential. */
  const mintAddressesOf = (length: number) => {
    const prefix = `${ISLAND_PATH}?ref=ref-opaque&ic=`;
    let call = 0;
    mintWidgetReviewIslandUrl.mockImplementation(() => {
      call += 1;
      return `${prefix}${String(call).padStart(length - prefix.length, "c")}`;
    });
  };
  // REVISION_ONE is the longer id: 20 characters, so its address is the minted
  // one plus `&target=` (8) plus 20.
  it("a per-target address of exactly 2048 characters is handed out", async () => {
    expect(REVISION_ONE).toHaveLength(20);
    mintAddressesOf(2048 - 8 - 20);
    answerFor(PENDING, TWO_HEADERS);
    const answer = await resolveAs(true);

    const byRevision = answer.islandSrcByRevision as Record<string, string>;
    expect(byRevision[REVISION_ONE]).toHaveLength(2048);
    expect(queryOf(byRevision[REVISION_ONE]).get("target")).toBe(REVISION_ONE);
    expect("islandSrc" in answer).toBe(false);
    expect(parseLifecycleResolveEnvelope("artifact_review_gate", answer)).not.toBeNull();
  });

  it("a per-target address one character past 2048 is null for that target alone: the other keeps its own, and no gate-wide grant is minted", async () => {
    expect(REVISION_TWO).toHaveLength(18);
    mintAddressesOf(2048 - 8 - 20 + 1);
    answerFor(PENDING, TWO_HEADERS);
    const answer = await resolveAs(true);

    // One grant per target, and none for the gate beside them.
    expect(mintWidgetReviewIslandUrl).toHaveBeenCalledTimes(2);
    expect(mintWidgetReviewIslandUrl).toHaveBeenNthCalledWith(1, MINT_ARGUMENTS);
    expect(mintWidgetReviewIslandUrl).toHaveBeenNthCalledWith(2, MINT_ARGUMENTS);
    expect("islandSrc" in answer).toBe(false);
    const byRevision = answer.islandSrcByRevision as Record<string, string | null>;
    expect(Object.keys(byRevision)).toEqual([REVISION_ONE, REVISION_TWO]);
    expect(byRevision[REVISION_ONE]).toBeNull();
    expect(byRevision[REVISION_TWO]).toHaveLength(2048 - 1);
    expect(queryOf(byRevision[REVISION_TWO]).get("target")).toBe(REVISION_TWO);
    // The card reads the answer: every address it carries fits the bound.
    const parsed = parseLifecycleResolveEnvelope("artifact_review_gate", answer);
    expect(parsed).not.toBeNull();
    expect(answer.targetHeadersComplete).toBe(true);
    // AND THE CARD DRAWS IT AS PAIRS (cinatra#4129): the drawing is read from
    // this very answer's transport by the one rule the card reads, so the
    // target whose address could not be expressed draws its own failed island
    // and the other paints from its own grant. The card's own render of this
    // shape is pinned in its suite.
    expect(
      reviewGateTargetDrawing({
        targetHeaders: answer.targetHeaders as LifecycleTargetHeader[],
        targetHeadersComplete: answer.targetHeadersComplete as boolean,
        islandSrcByRevision:
          (parsed as { islandSrcByRevision?: Parameters<typeof reviewGateTargetDrawing>[0]["islandSrcByRevision"] })
            .islandSrcByRevision ?? null,
        gateWideCredential: false,
      }),
    ).toBe("pairs");
  });

  it("at the ref's and the credential's own bounds, every selector the rule admits fits", async () => {
    const ref = "R".repeat(512);
    const credential = "c".repeat(1024);
    mintWidgetReviewIslandUrl.mockImplementation(
      () => `${ISLAND_PATH}?ref=${ref}&ic=${credential}`,
    );
    const atBound = keyedHeaders(128);
    answerFor(PENDING, atBound);
    const res = await POST(
      new Request("https://app.test/api/lifecycle-views/resolve", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Cinatra-Widget-User-Token": "cwu_b",
          "X-Cinatra-Widget-Assistant": "wordpress",
          "X-Cinatra-Widget-Origin": ORIGIN,
        },
        body: JSON.stringify({ viewType: "artifact_review_gate", ref }),
      }),
    );
    const answer = (await res.json()) as Record<string, unknown>;
    const byRevision = answer.islandSrcByRevision as Record<string, string>;
    expect(Object.keys(byRevision)).toEqual(atBound.map((h) => h.revisionId));
    for (const src of Object.values(byRevision)) expect(src).toHaveLength(1705);
  });

  it("an answer with no headers carries no completeness either", async () => {
    answerFor(PENDING, null, 3);
    const answer = await resolveAs(false);
    expect(answer).toEqual({ kind: "artifact_review_gate", state: PENDING, body: null });
  });
});
