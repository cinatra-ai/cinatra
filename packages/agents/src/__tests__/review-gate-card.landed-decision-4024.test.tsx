// @vitest-environment jsdom
// The real card and decision bar; HTTP, router refresh and the browser-only
// prompt field are external ports. No database, pixels or running host claimed.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { LifecycleCardState } from "@cinatra-ai/agent-ui-protocol/renderable-views";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@cinatra-ai/sdk-ui", () => ({ LoadingSpinner: () => null, PromptField: () => null }));
vi.mock("../run-window-actions", () => ({
  loadRunWindowConversation: vi.fn(async () => []),
  sendRunWindowTurn: vi.fn(async () => ({ ok: true, entries: [], fills: [], acted: false })),
}));

import { LifecycleCardSurfaceProvider, LifecycleComposerFocusProvider, createComposerFocusStore } from "../lifecycle-card-runtime";
import { ReviewGateCard } from "../review-gate-card";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const VIEW = { viewType: "artifact_review_gate" as const, schemaVersion: 1, ref: "gate-4024" };
const PENDING: LifecycleCardState = { state: "pending", canDecide: true, canComment: true };
const HEADER = {
  title: "The frozen email", typeLabel: "Email", objectType: "@cinatra-ai/email:body",
  revisionId: "frozen-revision-4024", facts: ["organization", "private", "text/html"],
};
const AUTH = { headers: () => ({ "X-Cinatra-Widget-User-Token": "test-actor-4024" }), credentials: "omit" as const };
function response(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}
function envelope(state: LifecycleCardState) {
  return { kind: "artifact_review_gate", state, body: null, targetHeaders: [HEADER] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function surface(host: "run_card" | "page_gate_region" | "chat_thread" | "site_widget", ref = VIEW.ref, auth = AUTH) {
  return <LifecycleCardSurfaceProvider host={host} auth={host === "site_widget" ? auth : undefined}>
    <ReviewGateCard view={{ ...VIEW, ref }} />
  </LifecycleCardSurfaceProvider>;
}
function expectSettled(container: HTMLElement) {
  expect(container.textContent).not.toContain("Awaiting your decision");
  expect(container.querySelector('[data-conformance-id="review-decision-bar"]')).toBeNull();
  expect(container.querySelector('[data-conformance-id="review-gate-settled"]')).not.toBeNull();
  expect(container.textContent).toContain("Continued");
  expect(container.textContent).toContain("Decided on the revision above.");
  expect(container.textContent).not.toContain("The gate is resolved and the run has been released");
  expect(container.textContent).toContain(HEADER.title);
  const island = container.querySelector('[data-conformance-id="review-target-island"]')!;
  const marker = container.querySelector('[data-conformance-id="review-gate-settled"]')!;
  expect(island.compareDocumentPosition(marker) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
}

describe("#4024 — a committed decision settles the card before its refresh answers", () => {
  for (const host of ["run_card", "page_gate_region", "chat_thread", "site_widget"] as const) {
    it(`${host}: an authenticated approve settles without reload while re-resolve is delayed`, async () => {
      const fresh = deferred<Response>();
      let resolves = 0;
      const fetchPort = vi.fn(async (url: unknown, init?: RequestInit) => String(url).endsWith("/decide") && init?.method === "POST"
        ? response({ outcome: { kind: "decided", disposition: "approve", idempotent: false } })
        : ++resolves === 1 ? response(envelope(PENDING)) : fresh.promise);
      globalThis.fetch = fetchPort as unknown as typeof fetch;
      const { container } = render(surface(host));
      fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
      await waitFor(() => expect(resolves).toBe(2));
      // The response uses ONLY the production endpoint's existing fields;
      // there is no decision time, target snapshot or remote effect in it.
      await waitFor(() => expectSettled(container));
      const sent = fetchPort.mock.calls.find(([url]) => String(url).endsWith("/decide"))![1]!;
      expect(JSON.parse(String(sent.body))).toEqual({ ref: VIEW.ref, disposition: "approve", comment: null });
      expect(sent.credentials).toBe(host === "site_widget" ? "omit" : "same-origin");
      if (host === "site_widget") expect(sent.headers).toMatchObject(AUTH.headers());
      // A later authorized denial must supersede the local settlement.
      await act(async () => fresh.resolve(response({ kind: "artifact_review_gate", state: { state: "absent" }, body: null })));
      await waitFor(() => expect(container.innerHTML).toBe(""));
    });
  }

  it("a failed refresh retains the landed settlement, not the obsolete pending header", async () => {
    let resolves = 0;
    globalThis.fetch = vi.fn(async (url: unknown) => {
      if (String(url).endsWith("/decide")) return response({ outcome: { kind: "decided", disposition: "approve", idempotent: true } });
      if (++resolves === 1) return response(envelope(PENDING));
      throw new Error("external resolve unavailable");
    }) as unknown as typeof fetch;
    const { container } = render(surface("run_card"));
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(resolves).toBe(2));
    expectSettled(container);
  });

  for (const outcome of [
    { kind: "annotated" },
    { kind: "error", message: "The decision did not commit." },
    { kind: "not-permitted", message: "Decision refused." },
    { kind: "blocked", reason: "targets-mismatch" },
    { kind: "decided" },
  ]) {
    it(`does not invent a settlement for ${JSON.stringify(outcome)}`, async () => {
      globalThis.fetch = vi.fn(async (url: unknown) => String(url).endsWith("/decide")
        ? response({ outcome }) : response(envelope(PENDING))) as unknown as typeof fetch;
      const { container } = render(surface("run_card"));
      fireEvent.click(await screen.findByRole("button", { name: outcome.kind === "annotated" ? "Comment" : "Approve" }));
      await waitFor(() => expect(container.querySelector('[data-review-outcome], [data-conformance-id="review-gate-blocked"]')).not.toBeNull());
      expect(container.querySelector('[data-conformance-id="review-gate-settled"]')).toBeNull();
    });
  }

  it("a decision in flight for the old ref never settles a replacement card", async () => {
    const decision = deferred<Response>();
    globalThis.fetch = vi.fn(async (url: unknown) => String(url).endsWith("/decide")
      ? decision.promise : response(envelope(PENDING))) as unknown as typeof fetch;
    const { container, rerender } = render(surface("run_card"));
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    rerender(surface("run_card", "replacement-4024"));
    await act(async () => decision.resolve(response({ outcome: { kind: "decided", disposition: "approve", idempotent: false } })));
    await waitFor(() => expect(container.textContent).toContain("Awaiting your decision"));
    expect(container.querySelector('[data-conformance-id="review-gate-settled"]')).toBeNull();
    expect(container.textContent).not.toContain("The gate is resolved and the run has been released");
  });

  it("does not settle while the decision itself is still outstanding", async () => {
    const decision = deferred<Response>();
    globalThis.fetch = vi.fn(async (url: unknown) => String(url).endsWith("/decide")
      ? decision.promise : response(envelope(PENDING))) as unknown as typeof fetch;
    const { container } = render(surface("run_card"));
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(container.textContent).toContain("Awaiting your decision");
    expect(container.querySelector('[data-conformance-id="review-gate-settled"]')).toBeNull();
    await act(async () => decision.resolve(response({ outcome: { kind: "error", message: "Not committed." } })));
    await waitFor(() => expect(container.textContent).toContain("Not committed."));
  });

  it("a route-bound host action uses its existing canonical outcome, with no extra result fields", async () => {
    let resolves = 0;
    const fresh = deferred<Response>();
    globalThis.fetch = vi.fn(async () => ++resolves === 1 ? response(envelope(PENDING)) : fresh.promise) as unknown as typeof fetch;
    const action = vi.fn(async () => ({ kind: "decided", disposition: "approve", idempotent: false }) as const);
    const { container } = render(<LifecycleCardSurfaceProvider host="page_gate_region">
      <ReviewGateCard view={VIEW} submitAction={action} />
    </LifecycleCardSurfaceProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expectSettled(container));
    expect(action).toHaveBeenCalledWith({ disposition: "approve", comment: null });
  });

  it("a newer authoritative blocked reading supersedes the local success", async () => {
    const fresh = deferred<Response>();
    let resolves = 0;
    globalThis.fetch = vi.fn(async (url: unknown) => String(url).endsWith("/decide")
      ? response({ outcome: { kind: "decided", disposition: "approve", idempotent: false } })
      : ++resolves === 1 ? response(envelope(PENDING)) : fresh.promise) as unknown as typeof fetch;
    const { container } = render(surface("run_card"));
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expectSettled(container));
    await act(async () => fresh.resolve(response(envelope({ state: "settled" }))));
    await waitFor(() => expect(container.querySelector('[data-conformance-id="review-gate-blocked"]')).not.toBeNull());
    expect(container.querySelector('[data-conformance-id="review-gate-settled"]')).toBeNull();
  });

  it("a concurrent composer comment completing first cannot release the old pending Approve into a newer reading", async () => {
    const approve = deferred<Response>();
    let approveFinished = false;
    const approveReply = approve.promise.then((reply) => { approveFinished = true; return reply; });
    const comment = deferred<Response>();
    const afterSubmit = deferred<Response>();
    let resolves = 0;
    const fetchPort = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith("/decide")) {
        return JSON.parse(String(init?.body)).disposition === "comment" ? comment.promise : approveReply;
      }
      return ++resolves === 1 ? response(envelope(PENDING)) : resolves === 2
        ? response({ ...envelope(PENDING), targetHeaders: [{ ...HEADER, title: "New concurrent authoritative revision" }] })
        : afterSubmit.promise;
    });
    globalThis.fetch = fetchPort as unknown as typeof fetch;
    const store = createComposerFocusStore();
    const { container } = render(<LifecycleComposerFocusProvider store={store}>{surface("chat_thread")}</LifecycleComposerFocusProvider>);
    await waitFor(() => expect(typeof store.getCommentAction(VIEW.ref)).toBe("function"));
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    let annotation!: ReturnType<NonNullable<ReturnType<typeof store.getCommentAction>>>;
    await act(async () => { annotation = store.getCommentAction(VIEW.ref)!("A genuine concurrent composer annotation."); });
    expect(fetchPort.mock.calls.filter(([url]) => String(url).endsWith("/decide")).map(([, init]) =>
      JSON.parse(String(init?.body)).disposition)).toEqual(["approve", "comment"]);
    await act(async () => {
      comment.resolve(response({ outcome: { kind: "annotated" } }));
      expect(await annotation).toMatchObject({ ok: true });
    });
    expect(approveFinished).toBe(false);
    fireEvent(window, new Event("focus"));
    await screen.findByText("New concurrent authoritative revision");
    expect(approveFinished).toBe(false);
    await act(async () => approve.resolve(response({ outcome: { kind: "decided", disposition: "approve", idempotent: false } })));
    await waitFor(() => expect(resolves).toBe(3));
    expect(container.textContent).toContain("Awaiting your decision");
    expect(container.querySelector('[data-conformance-id="review-gate-settled"]')).toBeNull();
    expect(container.textContent).not.toContain("The gate is resolved and the run has been released");
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("an ordinary focus refresh preserves an unsent comment on the same pending reading", async () => {
    let resolves = 0;
    globalThis.fetch = vi.fn(async () => { resolves++; return response(envelope(PENDING)); }) as unknown as typeof fetch;
    render(surface("run_card"));
    const comment = await screen.findByRole("textbox");
    fireEvent.change(comment, { target: { value: "Keep this unsent reviewer rationale." } });
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(resolves).toBe(2));
    await act(async () => {});
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Keep this unsent reviewer rationale.");
  });

  it("a newer resolve arriving during submit stays authoritative after the old submit succeeds", async () => {
    const decision = deferred<Response>();
    const refreshAfterSubmit = deferred<Response>();
    const secondReading = { ...envelope(PENDING), targetHeaders: [{ ...HEADER, title: "New authoritative revision" }] };
    let resolves = 0;
    globalThis.fetch = vi.fn(async (url: unknown) => String(url).endsWith("/decide")
      ? decision.promise : ++resolves === 1 ? response(envelope(PENDING)) : resolves === 2 ? response(secondReading) : refreshAfterSubmit.promise) as unknown as typeof fetch;
    const { container } = render(surface("run_card"));
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    fireEvent(window, new Event("focus"));
    await screen.findByText("New authoritative revision");
    await act(async () => decision.resolve(response({ outcome: { kind: "decided", disposition: "approve", idempotent: false } })));
    await waitFor(() => expect(resolves).toBe(3));
    expect(container.textContent).toContain("Awaiting your decision");
    expect(container.querySelector('[data-conformance-id="review-gate-settled"]')).toBeNull();
    expect(container.textContent).not.toContain("The gate is resolved and the run has been released");
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("an in-flight decision cannot settle a widget's replacement credential declaration", async () => {
    const decision = deferred<Response>();
    globalThis.fetch = vi.fn(async (url: unknown) => String(url).endsWith("/decide")
      ? decision.promise : response(envelope(PENDING))) as unknown as typeof fetch;
    const { container, rerender } = render(surface("site_widget"));
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    const replacement = { ...AUTH, headers: () => ({ "X-Cinatra-Widget-User-Token": "replacement-test-actor" }) };
    rerender(surface("site_widget", VIEW.ref, replacement));
    await act(async () => decision.resolve(response({ outcome: { kind: "decided", disposition: "approve", idempotent: false } })));
    await waitFor(() => expect(container.textContent).toContain("Awaiting your decision"));
    expect(container.querySelector('[data-conformance-id="review-gate-settled"]')).toBeNull();
    expect(container.textContent).not.toContain("The gate is resolved and the run has been released");
  });
});
