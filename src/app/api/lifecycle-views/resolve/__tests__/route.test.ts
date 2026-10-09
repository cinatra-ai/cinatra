import { beforeEach, describe, expect, it, vi } from "vitest";
const d = vi.hoisted(() => ({ actor: vi.fn(), resolve: vi.fn(), prompt: vi.fn() }));
vi.mock("@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-actor", () => ({ resolveReviewActorContext: d.actor }));
vi.mock("@/lib/lifecycle/widget-lifecycle-actor", () => ({ resolveWidgetLifecycleActorContext: vi.fn(), mintWidgetReviewIslandUrl: vi.fn() }));
vi.mock("@/lib/assistant-widget-handles", () => ({ resolveAssistantWidgetBinding: vi.fn() }));
vi.mock("@/lib/lifecycle/lifecycle-card-refetch", () => ({ resolveLifecycleCardState: d.resolve }));
vi.mock("@/lib/lifecycle/lifecycle-suggestion-chips", () => ({ attachLifecycleSuggestions: async (s: unknown) => s }));
vi.mock("@/lib/lifecycle/lifecycle-settled-outcome", () => ({ attachLifecycleSettledOutcome: async (s: unknown) => s }));
vi.mock("@/lib/lifecycle/lifecycle-target-headers", () => ({ readReviewTargetHeaders: async () => null }));
vi.mock("@/lib/lifecycle/trigger-schedule-proposal-card", () => ({ resolveTriggerScheduleProposalCard: vi.fn() }));
vi.mock("@/app/artifacts/[id]/review-gate-ports", () => ({ readReviewGateRecordedPrompt: d.prompt }));
import { encodeLifecycleGateRef } from "@/lib/lifecycle/lifecycle-card-ref";
import { POST } from "../route";
process.env.BETTER_AUTH_SECRET ??= "test-secret-for-review-note";
const ref = encodeLifecycleGateRef({ runId: "run", reviewTaskId: "task" })!;
const actor = { actor: { actorType: "human", userId: "reader", source: "route" }, orgId: "org", roleHints: { actorOrganizationId: "org" } };
function post(viewType = "artifact_review_gate", r = ref) { return new Request("https://app.example/api/lifecycle-views/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ viewType, ref: r }) }); }
beforeEach(() => { vi.clearAllMocks(); d.actor.mockResolvedValue(actor); d.resolve.mockResolvedValue({ kind: "artifact_review_gate", state: { state: "pending", canDecide: true, canComment: true }, body: null }); d.prompt.mockResolvedValue("  a red fox in snow  "); });
describe("approved app-artifact-review §VI authorized envelope-only Note", () => {
  it("adds the pinned producer words only after resolving the current reader; the body stays null", async () => {
    const res = await POST(post()); expect(res.status).toBe(200);
    expect(d.prompt).toHaveBeenCalledWith({ runId: "run", reviewTaskId: "task", actorCtx: actor });
    expect(d.resolve.mock.invocationCallOrder[0]).toBeLessThan(d.prompt.mock.invocationCallOrder[0]);
    expect(await res.json()).toEqual({ kind: "artifact_review_gate", state: { state: "pending", canDecide: true, canComment: true }, body: null, recordedPrompt: "  a red fox in snow  " });
  });
  it("a reader-only pending floor can read producer words without terminal authority", async () => {
    d.resolve.mockResolvedValue({ kind: "artifact_review_gate", state: { state: "restricted", canComment: true }, body: null });
    expect((await (await POST(post())).json()).recordedPrompt).toBe("  a red fox in snow  ");
  });
  it("missing words stay omitted, with no live or caller-supplied fallback", async () => {
    d.prompt.mockResolvedValue(null); const body = await (await POST(post())).json(); expect(body).not.toHaveProperty("recordedPrompt"); expect(body.body).toBeNull();
  });
  for (const state of ["absent", "settled"]) it(`never reads producer words for ${state}`, async () => {
    d.resolve.mockResolvedValue({ kind: "artifact_review_gate", state: { state }, body: null });
    const body = await (await POST(post())).json(); expect(d.prompt).not.toHaveBeenCalled(); expect(body).not.toHaveProperty("recordedPrompt");
  });
  it("an unsigned ref cannot ask for a producer prompt", async () => {
    const body = await (await POST(post("artifact_review_gate", "not-a-signed-ref"))).json(); expect(d.prompt).not.toHaveBeenCalled(); expect(body).not.toHaveProperty("recordedPrompt");
  });
  it("no credential never reaches the prompt reader", async () => {
    d.actor.mockResolvedValue(null); expect((await POST(post())).status).toBe(401); expect(d.resolve).not.toHaveBeenCalled(); expect(d.prompt).not.toHaveBeenCalled();
  });
});
