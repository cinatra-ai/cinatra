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
//      restricted gate, in pinned order, each naming its own target, and hands
//      out no gate-wide address beside them (a bearer nothing frames).
//   2. A FAILED MINT REFUSES THAT TARGET ONLY.
//   3. EVERY OTHER ANSWER IS THE ONE IT WAS: one target, the settled reading and
//      the cookie arm keep their single address or none.
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
const readReviewTargetHeaders = vi.fn();

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
// order. The route mints one address per header it is handed.
vi.mock("@/lib/lifecycle/lifecycle-target-headers", () => ({
  readReviewTargetHeaders: (...args: unknown[]) => readReviewTargetHeaders(...args),
}));

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

function answerFor(state: Record<string, unknown>, headers: unknown) {
  resolveLifecycleCardState.mockResolvedValue({ kind: "artifact_review_gate", state, body: null });
  readReviewTargetHeaders.mockResolvedValue(headers);
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
    it(`the widget arm mints ONE address per pinned target of a ${name} gate, in pinned order`, async () => {
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
    });
  });
});
