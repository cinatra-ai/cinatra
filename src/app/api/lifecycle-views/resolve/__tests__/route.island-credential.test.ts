// POST /api/lifecycle-views/resolve — THE ISLAND CREDENTIAL'S ONE MINT SITE
// (cinatra#2754).
//
// The review card frames a same-origin, server-rendered island. On a genuinely
// third-party page that frame load carries no header and no cookie, so the
// credential has to be sealed into the URL — and only this route can seal one:
// it is the single place that holds a just-consumed `cwu_`, a gate the reader
// was authorized for on the same request, and an answer on its way to the card.
//
// What is pinned here:
//
//   1. THE WIDGET ARM MINTS, from the consumed claims and the ref's own gate.
//   2. THE COOKIE ARM DOES NOT, and its answer is byte-identical to the answer
//      it gave before this slice — no key, not even a null one.
//   3. NO CREDENTIAL FOR A CARD THAT DRAWS NO ISLAND (settled, absent) and none
//      for a kind that has no island at all.
//   4. A MINT THAT CANNOT BE EXPRESSED (no key, out-of-bounds id) is silent: the
//      rest of the answer is unchanged and the card composes its bare URL.
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveReviewActorContext = vi.fn();
const resolveWidgetLifecycleActorContext = vi.fn();
const mintWidgetReviewIslandUrl = vi.fn();
const resolveAssistantWidgetBinding = vi.fn();
const resolveLifecycleCardState = vi.fn();
const attachLifecycleSuggestions = vi.fn();
const attachLifecycleSettledOutcome = vi.fn();
const decodeLifecycleGateRef = vi.fn();

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
// The settled reading is composed on this route too, and the mint now reads its
// answer (a decided gate frames an island). Stubbed to a pass-through so this
// suite still measures the MINT and not the outcome projection, which carries
// its own suite next door.
vi.mock("@/lib/lifecycle/lifecycle-settled-outcome", () => ({
  attachLifecycleSettledOutcome: (...a: unknown[]) => attachLifecycleSettledOutcome(...a),
}));
vi.mock("@/lib/lifecycle/trigger-schedule-proposal-card", () => ({
  resolveTriggerScheduleProposalCard: vi.fn(),
}));

import { POST } from "../route";

const REF = "ref-opaque";
const ORIGIN = "https://blog.example.com";
const ISLAND_URL = "/lifecycle/review-island?ref=ref-opaque&ic=sealed-value";

/** The claims the S8a door consumed — the ONLY input the credential is built
 *  from. Nothing a parent page or a request field can influence appears here. */
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

function post(opts: { widget: boolean; viewType?: string }): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.widget) {
    headers["X-Cinatra-Widget-User-Token"] = "cwu_b";
    headers["X-Cinatra-Widget-Assistant"] = "wordpress";
    headers["X-Cinatra-Widget-Origin"] = ORIGIN;
  }
  return new Request("https://app.test/api/lifecycle-views/resolve", {
    method: "POST",
    headers,
    body: JSON.stringify({ viewType: opts.viewType ?? "artifact_review_gate", ref: REF }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
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
  resolveLifecycleCardState.mockResolvedValue({
    kind: "artifact_review_gate",
    state: { state: "pending", canDecide: true, canComment: true },
    body: null,
  });
  attachLifecycleSuggestions.mockImplementation(async (state: unknown) => state);
  attachLifecycleSettledOutcome.mockImplementation(async (state: unknown) => state);
  mintWidgetReviewIslandUrl.mockReturnValue(ISLAND_URL);
});

describe("the widget arm carries the island credential", () => {
  it("answers with the SERVER-MINTED island URL beside the state", async () => {
    const res = await POST(post({ widget: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      kind: "artifact_review_gate",
      state: { state: "pending", canDecide: true, canComment: true },
      body: null,
      islandSrc: ISLAND_URL,
    });
  });

  it("builds it from the CONSUMED CLAIMS and the ref's own gate, and nothing else", async () => {
    await POST(post({ widget: true }));
    expect(mintWidgetReviewIslandUrl).toHaveBeenCalledWith({
      claims: CLAIMS,
      ref: REF,
      runId: "run-1",
      reviewTaskId: "task-1",
    });
  });

  it("mints for a RESTRICTED reader too — they read the target, they just cannot decide", async () => {
    resolveLifecycleCardState.mockResolvedValue({
      kind: "artifact_review_gate",
      state: { state: "restricted", canDecide: false, canComment: true, reason: "no approve" },
      body: null,
    });
    const answer = (await (await POST(post({ widget: true }))).json()) as {
      islandSrc?: string;
    };
    expect(answer.islandSrc).toBe(ISLAND_URL);
  });

  // "A resolved gate opens read-only: what was decided, and the reviewed
  // target(s), kept for the run's audit trail." Inside a third-party application
  // that kept target is authenticated by this credential and nothing else, so a
  // decided reading needs one exactly as a pending reading does.
  it("mints for a DECIDED gate — its card keeps the reviewed target in the same island", async () => {
    resolveLifecycleCardState.mockResolvedValue({
      kind: "artifact_review_gate",
      state: { state: "settled", outcome: "approved", decidedByName: "Dana Okonkwo" },
      body: null,
    });
    const answer = (await (await POST(post({ widget: true }))).json()) as {
      islandSrc?: string;
    };
    expect(answer.islandSrc).toBe(ISLAND_URL);
  });

  it("mints NOTHING when the ref does not decode — there is no gate to bind to", async () => {
    decodeLifecycleGateRef.mockReturnValue(null);
    const answer = (await (await POST(post({ widget: true }))).json()) as Record<string, unknown>;
    expect(mintWidgetReviewIslandUrl).not.toHaveBeenCalled();
    expect("islandSrc" in answer).toBe(false);
  });

  it("stays silent when the credential cannot be expressed — the card still draws", async () => {
    // No signing key, an out-of-bounds id: the mint answers `null` and the card
    // composes its bare URL rather than framing a broken one.
    mintWidgetReviewIslandUrl.mockReturnValue(null);
    const answer = (await (await POST(post({ widget: true }))).json()) as Record<string, unknown>;
    expect(answer.state).toEqual({ state: "pending", canDecide: true, canComment: true });
    expect("islandSrc" in answer).toBe(false);
  });
});

describe("no credential for a card that draws no island", () => {
  // A settled state whose disposition this build cannot read draws the GENERIC
  // panel, not the decided reading — no island, so no credential.
  for (const state of [{ state: "settled" }, { state: "absent" }] as const) {
    it(`does not mint for \`${state.state}\``, async () => {
      resolveLifecycleCardState.mockResolvedValue({
        kind: "artifact_review_gate",
        state,
        body: null,
      });
      const answer = (await (await POST(post({ widget: true }))).json()) as Record<
        string,
        unknown
      >;
      expect(mintWidgetReviewIslandUrl).not.toHaveBeenCalled();
      expect("islandSrc" in answer).toBe(false);
    });
  }

  it("does not mint for a kind that has no island at all", async () => {
    resolveLifecycleCardState.mockResolvedValue({
      kind: "verification_summary",
      state: { state: "advisory" },
      body: { version: 1 },
    });
    const answer = (await (
      await POST(post({ widget: true, viewType: "verification_summary" }))
    ).json()) as Record<string, unknown>;
    expect(mintWidgetReviewIslandUrl).not.toHaveBeenCalled();
    expect("islandSrc" in answer).toBe(false);
  });
});

describe("the cookie arm is untouched — the credential is ADDITIVE", () => {
  it("answers exactly what it answered before this slice: no island key at all", async () => {
    const res = await POST(post({ widget: false }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      kind: "artifact_review_gate",
      state: { state: "pending", canDecide: true, canComment: true },
      body: null,
    });
    expect(mintWidgetReviewIslandUrl).not.toHaveBeenCalled();
  });

  it("decodes the ref ONCE, for the reading it composes — never a second time for a credential it will not mint", async () => {
    await POST(post({ widget: false }));
    // The credential branch is not entered at all on this arm, so it decodes
    // nothing. The ONE decode this answer makes is §IV's target header
    // (cinatra#3141 item 7), which is addressed by the gate the ref names and is
    // composed on both arms alike; a second decode here would be the mint's,
    // and there is none.
    expect(mintWidgetReviewIslandUrl).not.toHaveBeenCalled();
    expect(decodeLifecycleGateRef).toHaveBeenCalledTimes(1);
  });
});

describe("a refused widget reader gets no credential either", () => {
  it("401s, and nothing is minted", async () => {
    resolveWidgetLifecycleActorContext.mockResolvedValue({ ok: false, reason: "token_rejected" });
    const res = await POST(post({ widget: true }));
    expect(res.status).toBe(401);
    expect(mintWidgetReviewIslandUrl).not.toHaveBeenCalled();
    expect(resolveLifecycleCardState).not.toHaveBeenCalled();
  });
});
