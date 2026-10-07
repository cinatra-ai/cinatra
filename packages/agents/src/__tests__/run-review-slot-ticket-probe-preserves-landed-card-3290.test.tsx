// @vitest-environment jsdom
// App320: an indeterminate ticket probe must not replace a landed review card.
// The actual slot reader and ReviewGateCard are composed; only HTTP is a seam.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  LifecycleCardSurfaceProvider,
  useRunReviewSlot,
  type LifecycleCardAuth,
  type RunReviewSlot,
} from "../lifecycle-card-runtime";
import { ReviewGateCard } from "../review-gate-card";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

const OLD = {
  ref: "ticket-that-landed",
  awaiting: false,
  producedReviewPark: true,
  reviewTaskId: "review-task-on-file",
};
const NEXT = { ...OLD, ref: "fresh-seal-for-the-same-gate" };
const PENDING = { state: "pending", canDecide: true, canComment: true };
const response = (state: unknown, status = 200) => new Response(
  JSON.stringify({ kind: "artifact_review_gate", state, body: null }),
  { status, headers: { "Content-Type": "application/json" } },
);

function SlotCard({ status, read, runId, initial }: { status: string; read: () => Promise<RunReviewSlot>; runId: string; initial: RunReviewSlot }) {
  const reading = { status, initial, read, runId };
  const { slot } = useRunReviewSlot(reading);
  return slot.ref ? <ReviewGateCard view={{
    viewType: "artifact_review_gate", schemaVersion: 1, ref: slot.ref,
  }} /> : null;
}

async function advance(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 1000) {
    await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(1000, ms - elapsed)); });
  }
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

async function landed(probe: () => Promise<Response>, auth?: LifecycleCardAuth, initial: RunReviewSlot = OLD) {
  let next: RunReviewSlot = initial;
  let probing = false;
  const probeCalls = vi.fn(probe);
  const replacementResolves = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    expect(body.viewType).toBe("artifact_review_gate");
    if (body.ref === OLD.ref && !probing) return response(PENDING);
    if (body.ref === OLD.ref) return probeCalls();
    replacementResolves();
    // New identity has not been authorized. Keeping the previous card here
    // would be a real leak; retention can only leave the old identity alone.
    return new Promise<Response>(() => {});
  }));
  const read = vi.fn(async () => next);
  const tree = (status = "pending_approval", credential = auth, host = auth ? "site_widget" as const : "run_card" as const, runId = "run-on-file") => (
    <LifecycleCardSurfaceProvider host={host} auth={credential}>
      <SlotCard status={status} read={read} runId={runId} initial={initial} />
    </LifecycleCardSurfaceProvider>
  );
  const rendered = render(tree());
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const root = rendered.container.querySelector('[data-conformance-id="review-gate-card"]');
  expect(root, "a real review must land before the failure is driven").not.toBeNull();
  expect(root?.querySelector('[data-conformance-id="review-decision-bar"]')).not.toBeNull();
  probing = true;
  return {
    ...rendered, root, tree, probeCalls, replacementResolves,
    setNext: (value: RunReviewSlot) => { next = value; },
    async look() { next = NEXT; await advance(4000); expect(probeCalls).toHaveBeenCalled(); },
  };
}

describe("ticket probe preserves only an admitted landed review", () => {
  it.each([
    ["transport failure", async () => { throw new TypeError("network unavailable"); }],
    ["abort", async () => { throw new DOMException("read aborted", "AbortError"); }],
    ["503 with no authoritative body", async () => new Response("", { status: 503 })],
    ["502 HTML error", async () => new Response("upstream unavailable", { status: 502 })],
    ["unparseable successful response", async () => new Response("not protocol JSON", { status: 200 })],
  ])("keeps the exact landed card through %s", async (_label, probe) => {
    const page = await landed(probe);
    await page.look();
    expect(page.container.querySelector('[data-conformance-id="review-gate-card"]')).toBe(page.root);
    expect(page.root?.isConnected).toBe(true);
    expect(page.replacementResolves).not.toHaveBeenCalled();
  });

  it("keeps the landed card when the old gate is authoritatively still pending", async () => {
    const page = await landed(async () => response(PENDING));
    await page.look();
    expect(page.container.querySelector('[data-conformance-id="review-gate-card"]')).toBe(page.root);
    expect(page.replacementResolves).not.toHaveBeenCalled();
  });

  it.each([
    ["401 without a body", async () => new Response("", { status: 401 })],
    ["actual route401 error body", async () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })],
    ["403 with malformed body", async () => new Response("not JSON", { status: 403 })],
    ["absent", async () => response({ state: "absent" })],
    ["settled", async () => response({ state: "settled" })],
    ["restricted", async () => response({ state: "restricted", canDecide: false, canComment: false, reason: "Access changed" })],
    ["non-OK authoritative absent", async () => response({ state: "absent" }, 503)],
  ])("withdraws the prior card for %s", async (_label, probe) => {
    const page = await landed(probe);
    await page.look();
    expect(page.root?.isConnected).toBe(false);
    expect(page.container.querySelector('[data-conformance-id="review-gate-card"]')).toBeNull();
    expect(page.replacementResolves).toHaveBeenCalled();
  });

  it("does not carry the old card into another gate even if its probe is indeterminate", async () => {
    const page = await landed(async () => { throw new TypeError("network unavailable"); });
    page.setNext({ ...NEXT, reviewTaskId: "a-different-review-task" } as RunReviewSlot);
    await advance(4000);
    expect(page.root?.isConnected).toBe(false);
    expect(page.container.querySelector('[data-conformance-id="review-gate-card"]')).toBeNull();
    expect(page.replacementResolves).toHaveBeenCalled();
  });

  it("does not carry a pending old gate into the new stable gate identity", async () => {
    const page = await landed(async () => response(PENDING));
    page.setNext({ ...NEXT, reviewTaskId: "a-different-review-task" } as RunReviewSlot);
    await advance(4000);
    expect(page.root?.isConnected).toBe(false);
    expect(page.container.querySelector('[data-conformance-id="review-gate-card"]')).toBeNull();
    expect(page.replacementResolves).toHaveBeenCalled();
  });

  it.each([
    ["unknown transport", async () => { throw new TypeError("network unavailable"); }],
    ["pending old gate", async () => response(PENDING)],
  ])("does not carry unidentifiable changed tickets for %s", async (_label, probe) => {
    const unidentified = { ref: OLD.ref, awaiting: false, producedReviewPark: true };
    const page = await landed(probe, undefined, unidentified);
    page.setNext({ ...unidentified, ref: NEXT.ref });
    await advance(4000);
    expect(page.root?.isConnected).toBe(false);
    expect(page.container.querySelector('[data-conformance-id="review-gate-card"]')).toBeNull();
    expect(page.replacementResolves).toHaveBeenCalled();
  });

  it("does not treat an empty stable identity as same-gate evidence", async () => {
    const empty = { ...OLD, reviewTaskId: "" };
    const page = await landed(async () => response(PENDING), undefined, empty);
    page.setNext({ ...empty, ref: NEXT.ref });
    await advance(4000);
    expect(page.root?.isConnected).toBe(false);
    expect(page.container.querySelector('[data-conformance-id="review-gate-card"]')).toBeNull();
  });

  it("drops the old card immediately when the run leaves this wait", async () => {
    const page = await landed(async () => { throw new TypeError("network unavailable"); });
    page.rerender(page.tree("running"));
    expect(page.root?.isConnected).toBe(false);
    expect(page.container.querySelector('[data-conformance-id="review-gate-card"]')).toBeNull();
  });

  it("does not retain old authorization after the widget credential changes", async () => {
    const auth = { credentials: "omit" as const, headers: () => ({ "X-Cinatra-Widget-User-Token": "first-user" }) };
    const page = await landed(async () => { throw new TypeError("network unavailable"); }, auth);
    const changed = { ...auth, headers: () => ({ "X-Cinatra-Widget-User-Token": "different-user" }) };
    page.setNext(NEXT);
    page.rerender(page.tree("pending_approval", changed));
    expect(page.root?.isConnected).toBe(false);
    expect(page.container.querySelector('[data-conformance-id="review-gate-card"]')).toBeNull();
    await advance(4000);
    expect(page.container.querySelector('[data-conformance-id="review-gate-card"]')).toBeNull();
  });

  it("does not commit a late indeterminate probe after a credential change", async () => {
    let finish!: (answer: Response) => void;
    const auth = { credentials: "omit" as const, headers: () => ({ "X-Cinatra-Widget-User-Token": "first-user" }) };
    const page = await landed(() => new Promise<Response>((done) => { finish = done; }), auth);
    page.setNext(NEXT);
    await advance(3000);
    expect(page.probeCalls).toHaveBeenCalled();
    const changed = { ...auth, headers: () => ({ "X-Cinatra-Widget-User-Token": "different-user" }) };
    page.rerender(page.tree("pending_approval", changed));
    await act(async () => { finish(new Response("", { status: 503 })); });
    expect(page.root?.isConnected).toBe(false);
    expect(page.container.querySelector('[data-conformance-id="review-gate-card"]')).toBeNull();
  });

  it("does not commit a late indeterminate probe after the run leaves the wait", async () => {
    let finish!: (answer: Response) => void;
    const page = await landed(() => new Promise<Response>((done) => { finish = done; }));
    page.setNext(NEXT);
    await advance(3000);
    expect(page.probeCalls).toHaveBeenCalled();
    page.rerender(page.tree("running"));
    await act(async () => { finish(new Response("", { status: 503 })); });
    expect(page.root?.isConnected).toBe(false);
    expect(page.container.querySelector('[data-conformance-id="review-gate-card"]')).toBeNull();
  });

  it("invalidates a different run under the same status without forcing a remount", async () => {
    const page = await landed(async () => response(PENDING));
    page.setNext(NEXT);
    page.rerender(page.tree("pending_approval", undefined, "run_card", "another-run"));
    expect(page.root?.isConnected).toBe(false);
    expect(page.container.querySelector('[data-conformance-id="review-gate-card"]')).toBeNull();
  });

  it("ignores a late indeterminate probe from another run with the same status", async () => {
    let finish!: (answer: Response) => void;
    const page = await landed(() => new Promise<Response>((done) => { finish = done; }));
    page.setNext(NEXT);
    await advance(3000);
    expect(page.probeCalls).toHaveBeenCalled();
    page.rerender(page.tree("pending_approval", undefined, "run_card", "another-run"));
    await act(async () => { finish(new Response("", { status: 503 })); });
    expect(page.root?.isConnected).toBe(false);
    expect(page.container.querySelector('[data-conformance-id="review-gate-card"]')).toBeNull();
  });

  it("hides the card when the host rejects the credential declaration", async () => {
    const auth = { credentials: "omit" as const, headers: () => ({ "X-Cinatra-Widget-User-Token": "first-user" }) };
    const page = await landed(async () => { throw new TypeError("network unavailable"); }, auth);
    page.rerender(page.tree("pending_approval", auth, "run_card"));
    expect(page.root?.isConnected).toBe(false);
    expect(page.container.querySelector('[data-conformance-id="review-gate-card"]')).toBeNull();
  });
});
