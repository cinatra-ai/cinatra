// @vitest-environment jsdom
// The publish card (cinatra#4150 part 7a-1b): design 635da007, specs/app-lifecycle-cards.html XV and IV.1.
// Red first: at the base the module under test does not exist, so this file fails at its import.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, waitFor } from "@testing-library/react";

import type { LifecycleCardHost } from "@cinatra-ai/agent-ui-protocol/renderable-views";

const stateMock = vi.fn();
vi.mock("../publish-decision-card-actions", () => ({
  getPublishDecisionCardStateAction: (input: { runId: string }) => stateMock(input),
}));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import {
  PublishDecisionCard,
  publishDecisionIsSettled,
  publishGateIsOpen,
  usePublishDecisionCardRead,
  type PublishDecisionDecide,
} from "../publish-decision-card-view";

const RUN_ID = "run-4150";
const ROWS = [
  { label: "Title", value: "Spring launch" },
  { label: "Site", value: "Company blog" },
];
const PENDING = { state: "pending", runId: RUN_ID, agentName: "Blog publisher", rows: ROWS, decisionId: "d1", mayDecide: true };
const RESTRICTED = { ...PENDING, mayDecide: false };
const APPROVED = { state: "approved", runId: RUN_ID, agentName: "Blog publisher", rows: ROWS, deciderName: "Dana Okafor" };
const DECLINED = { ...APPROVED, state: "declined", reason: "Not ready yet." };
const EXPIRED = { state: "expired", runId: RUN_ID, agentName: "Blog publisher", rows: ROWS };

const HOSTS: LifecycleCardHost[] = ["chat_thread", "site_widget", "run_card", "page_gate_region"];
const ROOT = '[data-lifecycle-card="publish_decision"]';
const APPROVE = '[data-action="approve-publish -> released"]';
const DECLINE = '[data-action="decline-publish -> declined"]';
const WIDGET_AUTH = { headers: () => ({ Authorization: "Bearer cwu_site" }), credentials: "omit" as const };

let brokerAnswer: { status: number; body: unknown };
let requests: Array<{ url: string; init: RequestInit }>;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  stateMock.mockReset();
  stateMock.mockImplementation(async () => PENDING);
  brokerAnswer = { status: 200, body: PENDING };
  requests = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(brokerAnswer.body), {
      status: brokerAnswer.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
});

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    await Promise.resolve();
  });
}

function mountOn(host: LifecycleCardHost, decide?: PublishDecisionDecide) {
  const auth = host === "site_widget" ? WIDGET_AUTH : undefined;
  const frame = host === "site_widget" ? { assistant: "a", instanceId: "i" } : undefined;
  return render(
    <LifecycleCardSurfaceProvider host={host} auth={auth} frame={frame}>
      <PublishDecisionCard runId={RUN_ID} decide={decide} />
    </LifecycleCardSurfaceProvider>,
  );
}

async function rootOf(mounted: ReturnType<typeof render>): Promise<HTMLElement> {
  return waitFor(() => {
    const found = mounted.container.querySelector<HTMLElement>(ROOT);
    if (!found) throw new Error("no card root");
    return found;
  });
}

const okDoor = (): PublishDecisionDecide => vi.fn(async () => "decided" as const);

describe("the drawn card", () => {
  it("the root carries its identity, host and state, and draws the question, the rows and both controls", async () => {
    for (const host of HOSTS) {
      const mounted = mountOn(host, okDoor());
      await settle();
      const root = await rootOf(mounted);
      expect(root.getAttribute("data-lifecycle-card-host"), host).toBe(host);
      expect(root.getAttribute("data-lifecycle-card-state"), host).toBe("pending");
      expect(root.getAttribute("data-conformance-id"), host).toBe("publish-card");
      expect(root.textContent).toContain("Allow this change outside Cinatra?");
      expect(root.textContent).toContain("Blog publisher \u00b7 nothing outside Cinatra has changed yet");
      const labels = Array.from(root.querySelectorAll("dt")).map((el) => el.textContent);
      const values = Array.from(root.querySelectorAll("dd")).map((el) => el.textContent);
      expect(labels).toEqual(["Title", "Site"]);
      expect(values).toEqual(["Spring launch", "Company blog"]);
      expect(root.querySelector("textarea")).not.toBeNull();
      expect(root.textContent).toContain("recorded with Do not allow");
      const decline = root.querySelector<HTMLButtonElement>('[data-action="decline-publish -> declined"]');
      const approve = root.querySelector<HTMLButtonElement>('[data-action="approve-publish -> released"]');
      expect(decline?.textContent).toBe("Do not allow");
      expect(approve?.textContent).toBe("Allow");
      expect(decline?.disabled).toBe(false);
      expect(approve?.disabled).toBe(false);
      // Two controls and no third: no Continue beneath them.
      expect(root.querySelectorAll("button")).toHaveLength(2);
      cleanup();
    }
  });

  it("every host draws EXACTLY ONE publish card", async () => {
    const hosts: LifecycleCardHost[] = ["chat_thread", "site_widget", "run_card", "page_gate_region"];
    expect(hosts).toEqual(HOSTS);
    for (const host of hosts) {
      const mounted = mountOn(host, okDoor());
      await settle();
      await waitFor(() =>
        expect(mounted.container.querySelectorAll('[data-lifecycle-card="publish_decision"]')).toHaveLength(1),
      );
      cleanup();
    }
  });

  it("restricted: rows stay, both controls are disabled and the reason is shown, with no note field", async () => {
    stateMock.mockImplementation(async () => RESTRICTED);
    const root = await rootOf(mountOn("run_card", okDoor()));
    await settle();
    expect(root.getAttribute("data-lifecycle-card-state")).toBe("restricted");
    expect(root.querySelectorAll("dd")).toHaveLength(2);
    expect(root.querySelector<HTMLButtonElement>(APPROVE)?.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>(DECLINE)?.disabled).toBe(true);
    expect(root.textContent).toContain("Deciding whether this change is made needs approve access on the run, so Do not allow and Allow stay disabled with the reason shown.");
    expect(root.querySelector("textarea")).toBeNull();
    // IV.1: the restricted card's frame carries its spec anchor, and only the restricted card draws it.
    const frame = root.querySelector('[data-conformance-id="publish-state-restricted"]');
    expect(frame?.querySelectorAll("dd")).toHaveLength(2);
    expect(frame?.querySelector(APPROVE)).not.toBeNull();
  });

  it("only the restricted card draws the restricted anchor", async () => {
    const root = await rootOf(mountOn("run_card", okDoor()));
    await settle();
    expect(root.getAttribute("data-lifecycle-card-state")).toBe("pending");
    expect(root.querySelector('[data-conformance-id^="publish-state-"]')).toBeNull();
  });

  it("a host that passes no decide door draws both controls disabled", async () => {
    const root = await rootOf(mountOn("chat_thread"));
    await settle();
    expect(root.getAttribute("data-lifecycle-card-state")).toBe("pending");
    expect(root.querySelector<HTMLButtonElement>(APPROVE)?.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>(DECLINE)?.disabled).toBe(true);
    expect(root.textContent).not.toContain("needs approve access");
  });

  it.each([
    [APPROVED, "publish-card-approved", "Allowed", "Approved by Dana Okafor. The run goes on to the agent's own step that makes the change."],
    [DECLINED, "publish-card-declined", "Not allowed", "Declined by Dana Okafor. The run ended, and nothing outside Cinatra changed. Reason: \u201cNot ready yet.\u201d"],
    [{ ...DECLINED, reason: null, deciderName: null }, "publish-card-declined", "Not allowed", "Declined. The run ended, and nothing outside Cinatra changed."],
    [EXPIRED, "publish-card-expired", "Expired", "No one decided before this request expired. The run ended, and nothing outside Cinatra changed."],
  ])("a settled card keeps its rows, drops the controls and the note, and draws its marker (%#)", async (answer, id, label, line) => {
    stateMock.mockImplementation(async () => answer);
    const root = await rootOf(mountOn("page_gate_region", okDoor()));
    await settle();
    expect(root.getAttribute("data-lifecycle-card-state")).toBe(answer.state);
    expect(root.querySelectorAll("dd")).toHaveLength(2);
    expect(root.querySelector("button")).toBeNull();
    expect(root.querySelector("textarea")).toBeNull();
    expect(root.textContent).not.toContain("nothing outside Cinatra has changed yet");
    const marker = root.querySelector(`[data-conformance-id="${id}"]`);
    expect(marker?.querySelector('[data-slot="status-pill"]')?.textContent).toContain(label);
    expect(marker?.textContent).toContain(line);
    if (answer.state === "expired") expect(marker?.textContent).not.toContain(" by ");
  });

  it("the three settled readings carry the spec's exact copy: the generic question and the marker, nothing more", async () => {
    // specs/app-lifecycle-cards.html section XV: one generic question on every settled card, and a marker that is a chip
    // followed by one line. No agent, site or service is named in the card's own words, and none says "published" (the agent\u2019s own display name is its own words).
    const spec: Array<[typeof APPROVED | typeof EXPIRED, string]> = [
      [APPROVED, "AllowedApproved by Dana Okafor. The run goes on to the agent's own step that makes the change."],
      [DECLINED, "Not allowedDeclined by Dana Okafor. The run ended, and nothing outside Cinatra changed. Reason: \u201cNot ready yet.\u201d"],
      [EXPIRED, "ExpiredNo one decided before this request expired. The run ended, and nothing outside Cinatra changed."],
    ];
    for (const [answer, marker] of spec) {
      stateMock.mockImplementation(async () => answer);
      const mounted = mountOn("chat_thread", okDoor());
      await settle();
      const root = await rootOf(mounted);
      expect(root.querySelector("span.font-bold")?.textContent).toBe("Allow this change outside Cinatra?");
      expect(root.querySelector(`[data-conformance-id="publish-card-${answer.state}"]`)?.textContent).toBe(marker);
      expect(root.textContent).not.toMatch(/published|publishing|Publish this/i);
      cleanup();
    }
  });

  it("a pending card with no rows draws no row list", async () => {
    stateMock.mockImplementation(async () => ({ ...PENDING, rows: [] }));
    const root = await rootOf(mountOn("run_card", okDoor()));
    expect(root.querySelector("dl")).toBeNull();
  });
});

describe("the absences: no open decision draws nothing", () => {
  it("a run with no publish decision draws NO card DOM, on every host", async () => {
    stateMock.mockImplementation(async () => ({ state: "none" }));
    brokerAnswer = { status: 200, body: { state: "none" } };
    for (const host of HOSTS) {
      const mounted = mountOn(host, okDoor());
      await settle();
      expect(mounted.container.innerHTML, host).toBe("");
      cleanup();
    }
    expect(stateMock).toHaveBeenCalledWith({ runId: RUN_ID });
  });

  it("a failed read draws nothing: a rejected action, an unreadable answer", async () => {
    for (const failure of [async () => Promise.reject(new Error("boom")), async () => ({ state: "pending" })]) {
      stateMock.mockImplementation(failure);
      const mounted = mountOn("chat_thread", okDoor());
      await settle();
      expect(mounted.container.innerHTML).toBe("");
      cleanup();
    }
  });

  it("a subtree that declared no host draws nothing and reads nothing", async () => {
    const mounted = render(<PublishDecisionCard runId={RUN_ID} />);
    await settle();
    expect(mounted.container.innerHTML).toBe("");
    expect(stateMock).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });

  it("a failed RE-read keeps the last authorized answer on screen", async () => {
    const mounted = mountOn("run_card", okDoor());
    await rootOf(mounted);
    stateMock.mockImplementation(async () => Promise.reject(new Error("offline")));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
    expect(stateMock).toHaveBeenCalledTimes(2);
    expect(mounted.container.querySelector(ROOT)?.getAttribute("data-lifecycle-card-state")).toBe("pending");
  });
});

describe("the broker read on the site widget", () => {
  it("GETs the run's card with the widget's own credential, sends no body and never calls the cookie action", async () => {
    const root = await rootOf(mountOn("site_widget", okDoor()));
    expect(root.getAttribute("data-lifecycle-card-host")).toBe("site_widget");
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request!.url).toBe("/api/lifecycle-views/publish-decision?runId=run-4150");
    expect(request!.init.method).toBe("GET");
    expect(request!.init.body).toBeUndefined();
    expect(request!.init.credentials).toBe("omit");
    expect(request!.init.headers).toEqual({ Authorization: "Bearer cwu_site" });
    expect(stateMock).not.toHaveBeenCalled();
  });

  it("a refused credential takes the card away; a server error draws nothing", async () => {
    const mounted = mountOn("site_widget", okDoor());
    await rootOf(mounted);
    brokerAnswer = { status: 401, body: { error: "Unauthorized" } };
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
    expect(mounted.container.innerHTML).toBe("");
    cleanup();
    brokerAnswer = { status: 500, body: { error: "boom" } };
    const again = mountOn("site_widget", okDoor());
    await settle();
    expect(again.container.innerHTML).toBe("");
  });

  it("a 403 refusal takes the card away like a 401", async () => {
    const mounted = mountOn("site_widget", okDoor());
    await rootOf(mounted);
    brokerAnswer = { status: 403, body: { error: "Forbidden" } };
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
    expect(mounted.container.innerHTML).toBe("");
  });
});

describe("the host's change signal", () => {
  it("a run that opens its decision AFTER a `none` read draws the card when the host's wireRef moves, with no focus", async () => {
    stateMock.mockImplementation(async () => ({ state: "none" }));
    const at = (wireRef: string) => (
      <LifecycleCardSurfaceProvider host="run_card">
        <PublishDecisionCard runId={RUN_ID} wireRef={wireRef} />
      </LifecycleCardSurfaceProvider>
    );
    const mounted = render(at("running"));
    await settle();
    expect(mounted.container.querySelector(ROOT)).toBeNull();
    stateMock.mockImplementation(async () => PENDING);
    mounted.rerender(at("pending_approval"));
    await settle();
    expect((await rootOf(mounted)).getAttribute("data-lifecycle-card-state")).toBe("pending");
    expect(stateMock).toHaveBeenCalledTimes(2);
  });
});

// THE SHARED READ'S OWN TICK. The host's change signal cannot carry every move (a run can open its decision with no
// status or signal change), so while the host's run has not finished the read repeats on the run surfaces' cadence.
describe("the shared read's tick while the run has not finished", () => {
  const TICK = 5_000;
  const readWith = (runStatus: string | null) =>
    renderHook((props: { runStatus: string | null }) => usePublishDecisionCardRead({ runId: RUN_ID, auth: null, runStatus: props.runStatus }), {
      initialProps: { runStatus },
    });
  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a decision opened with NO signal change is read on the next tick, and the tick stops once the run is terminal", async () => {
    stateMock.mockImplementation(async () => ({ state: "none" }));
    const hook = readWith("pending_approval");
    await advance(0);
    expect(stateMock).toHaveBeenCalledTimes(1);
    expect(hook.result.current.state?.state).toBe("none");

    stateMock.mockImplementation(async () => PENDING);
    await advance(TICK);
    expect(stateMock).toHaveBeenCalledTimes(2);
    expect(hook.result.current.state?.state).toBe("pending");

    hook.rerender({ runStatus: "completed" });
    await advance(0);
    const atTerminal = stateMock.mock.calls.length;
    await advance(TICK * 4);
    expect(stateMock).toHaveBeenCalledTimes(atTerminal);
  });

  it("a run that ENDS with its decision unanswered is no longer an open gate: one final read, and no cached `pending` survives", async () => {
    stateMock.mockImplementation(async () => PENDING);
    const hook = readWith("pending_approval");
    await advance(0);
    expect(hook.result.current.state?.state).toBe("pending");
    expect(publishGateIsOpen(hook.result.current)).toBe(true);
    const beforeEnd = stateMock.mock.calls.length;

    // The run is cancelled while parked; its decision is closed only by the later sweep, so the read still answers
    // `pending`. A run in a terminal status is parked at no gate.
    hook.rerender({ runStatus: "stopped" });
    await advance(0);
    expect(stateMock).toHaveBeenCalledTimes(beforeEnd + 1);
    expect(publishGateIsOpen(hook.result.current)).toBe(false);
    expect(hook.result.current.state?.state).toBe("none");
    await advance(TICK * 4);
    expect(stateMock).toHaveBeenCalledTimes(beforeEnd + 1);
    expect(publishGateIsOpen(hook.result.current)).toBe(false);
  });

  it("the two predicates: an open gate is a `pending` read for a run that has not ended; settled is never `pending` or `none`", () => {
    const at = (state: unknown) =>
      ({ state, refreshing: false, reload: () => undefined }) as unknown as Parameters<typeof publishGateIsOpen>[0];
    const settled = { ...PENDING, deciderName: "Ana" };
    // The read is the truth: a `pending` read is open whatever non-terminal status the host still holds.
    expect(publishGateIsOpen(at(PENDING))).toBe(true);
    expect(publishGateIsOpen(at(PENDING), "running")).toBe(true);
    expect(publishGateIsOpen(at(PENDING), "pending_approval")).toBe(true);
    expect(publishGateIsOpen(at(PENDING), "stopped")).toBe(false);
    expect(publishGateIsOpen(at(PENDING), "completed")).toBe(false);
    for (const state of [null, { state: "none" }, { ...settled, state: "approved" }, { ...settled, state: "expired" }]) {
      expect(publishGateIsOpen(at(state), "running")).toBe(false);
    }
    expect(publishDecisionIsSettled(at({ ...settled, state: "approved" }))).toBe(true);
    expect(publishDecisionIsSettled(at({ ...settled, state: "declined", reason: null }))).toBe(true);
    expect(publishDecisionIsSettled(at({ ...settled, state: "expired" }))).toBe(true);
    for (const state of [null, { state: "none" }, PENDING]) {
      expect(publishDecisionIsSettled(at(state))).toBe(false);
    }
  });

  it("the tick stops when the host unmounts, and pauses while the document is hidden", async () => {
    stateMock.mockImplementation(async () => ({ state: "none" }));
    const hook = readWith("running");
    await advance(0);
    await advance(TICK);
    expect(stateMock).toHaveBeenCalledTimes(2);

    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await advance(TICK * 3);
    expect(stateMock).toHaveBeenCalledTimes(2);
    visibility.mockRestore();
    await advance(TICK);
    expect(stateMock).toHaveBeenCalledTimes(3);

    hook.unmount();
    await advance(TICK * 4);
    expect(stateMock).toHaveBeenCalledTimes(3);
  });

  it("never overlaps reads: a tick is skipped while a read is still out", async () => {
    let release: (value: unknown) => void = () => {};
    stateMock.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    readWith("running");
    await advance(TICK * 3);
    expect(stateMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      release({ state: "none" });
    });
    await advance(TICK);
    expect(stateMock).toHaveBeenCalledTimes(2);
  });

  it("a slow read is never starved or overlapped by host signals: one read out at a time, it lands, then exactly one follow-up", async () => {
    const releases: Array<(value: unknown) => void> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    stateMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          releases.push((value) => {
            inFlight -= 1;
            resolve(value);
          });
        }),
    );
    const hook = renderHook(
      (props: { wireRef: string }) =>
        usePublishDecisionCardRead({ runId: RUN_ID, auth: null, wireRef: props.wireRef, runStatus: "pending_approval" }),
      { initialProps: { wireRef: "pending_approval:no-gate:0" } },
    );
    await advance(0);
    expect(stateMock).toHaveBeenCalledTimes(1);
    // The host's signal moves every 2 s (each successful run poll) while the first read is still out.
    for (let n = 1; n <= 5; n++) {
      hook.rerender({ wireRef: `pending_approval:no-gate:${n}` });
      await advance(2_000);
    }
    expect(stateMock).toHaveBeenCalledTimes(1);
    expect(maxInFlight).toBe(1);

    await act(async () => {
      releases[0]!(PENDING);
    });
    await advance(0);
    // The slow result LANDS (a mere signal change does not discard it), and the signals it missed coalesce into ONE
    // follow-up read.
    expect(hook.result.current.state?.state).toBe("pending");
    expect(stateMock).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);

    await act(async () => {
      releases[1]!({ state: "none" });
    });
    await advance(0);
    expect(hook.result.current.state?.state).toBe("none");
    expect(stateMock).toHaveBeenCalledTimes(2);
  });

  it("the broker read is handed an abort signal, aborted when the host unmounts", async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal);
      return new Promise<Response>(() => undefined);
    }) as unknown as typeof fetch;
    const hook = renderHook(() => usePublishDecisionCardRead({ runId: RUN_ID, auth: WIDGET_AUTH, runStatus: "running" }));
    await advance(0);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]!.aborted).toBe(false);
    hook.unmount();
    expect(signals[0]!.aborted).toBe(true);
  });
});

describe("the decide door", () => {
  it("Allow sends approve with no note, Do not allow sends the written note, and the card re-reads", async () => {
    const decide = vi.fn<PublishDecisionDecide>(async () => "decided");
    const mounted = mountOn("run_card", decide);
    const root = await rootOf(mounted);
    fireEvent.change(root.querySelector("textarea")!, { target: { value: "Not ready yet." } });
    await act(async () => {
      fireEvent.click(root.querySelector(APPROVE)!);
    });
    await settle();
    expect(decide).toHaveBeenLastCalledWith({ runId: RUN_ID, decisionId: "d1", answer: "approve", note: "" });
    await act(async () => {
      fireEvent.click(mounted.container.querySelector(DECLINE)!);
    });
    await settle();
    expect(decide).toHaveBeenLastCalledWith({ runId: RUN_ID, decisionId: "d1", answer: "decline", note: "Not ready yet." });
    expect(stateMock).toHaveBeenCalledTimes(3);
  });

  // the answer names the decision the card SHOWS, so a card drawn for an earlier
  // gate can never answer a newer one it has not drawn.
  it("each answer names the decision the card shows, and a card re-read onto a newer decision names that one", async () => {
    const decide = vi.fn<PublishDecisionDecide>(async () => "failed");
    const mounted = mountOn("site_widget", decide);
    const root = await rootOf(mounted);
    await act(async () => {
      fireEvent.click(root.querySelector(DECLINE)!);
    });
    await settle();
    expect(decide.mock.calls[0]![0]).toMatchObject({ runId: RUN_ID, decisionId: "d1", answer: "decline" });
    brokerAnswer = { status: 200, body: { ...PENDING, decisionId: "d2" } };
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
    await act(async () => {
      fireEvent.click(mounted.container.querySelector(APPROVE)!);
    });
    await settle();
    expect(decide.mock.calls[1]![0]).toMatchObject({ runId: RUN_ID, decisionId: "d2", answer: "approve" });
  });

  // an answer that did not land is told, never silent.
  // What the card holds for one decision (the note, "no longer open", the answer in flight) never reaches another.
  const moveTo = async (next: unknown) => {
    brokerAnswer = { status: 200, body: next };
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
  };

  it("a re-read onto a newer decision starts its note over, and Do not allow sends the newer decision's own note", async () => {
    const decide = vi.fn<PublishDecisionDecide>(async () => "decided");
    const mounted = mountOn("site_widget", decide);
    const root = await rootOf(mounted);
    await act(async () => {
      fireEvent.change(root.querySelector("textarea")!, { target: { value: "Wrong channel." } });
    });
    await moveTo({ ...PENDING, decisionId: "d2" });
    const after = await rootOf(mounted);
    // red-first-expect: expected 'Wrong channel.' to be ''
    expect(after.querySelector("textarea")?.value).toBe("");
    await act(async () => {
      fireEvent.click(after.querySelector(DECLINE)!);
    });
    await settle();
    expect(decide).toHaveBeenLastCalledWith({ runId: RUN_ID, decisionId: "d2", answer: "decline", note: "" });
  });

  it("a card that read no longer open draws the newer decision a re-read brings, with its controls", async () => {
    const mounted = mountOn("site_widget", vi.fn<PublishDecisionDecide>(async () => "not_open"));
    const root = await rootOf(mounted);
    await act(async () => {
      fireEvent.click(root.querySelector(APPROVE)!);
    });
    await settle();
    expect((await rootOf(mounted)).getAttribute("data-lifecycle-card-state")).toBe("no_longer_open");
    await moveTo({ ...PENDING, decisionId: "d2" });
    const after = await rootOf(mounted);
    // red-first-expect: expected 'no_longer_open' to be 'pending'
    expect(after.getAttribute("data-lifecycle-card-state")).toBe("pending");
    expect(after.querySelector<HTMLButtonElement>(APPROVE)?.disabled).toBe(false);
  });

  it("a reply that comes back for a decision the card no longer shows changes nothing on the newer one", async () => {
    const replies: Array<(outcome: "not_open" | "failed") => void> = [];
    const decide = vi.fn<PublishDecisionDecide>(() => new Promise((resolve) => replies.push(resolve)));
    const mounted = mountOn("site_widget", decide);
    const root = await rootOf(mounted);
    await act(async () => {
      fireEvent.click(root.querySelector(APPROVE)!);
    });
    await moveTo({ ...PENDING, decisionId: "d2" });
    // The earlier decision's answer is still out; the newer decision's controls are its own.
    // red-first-expect: expected true to be false
    expect((await rootOf(mounted)).querySelector<HTMLButtonElement>(APPROVE)?.disabled).toBe(false);
    await act(async () => {
      replies[0]!("not_open");
    });
    await settle();
    const after = await rootOf(mounted);
    expect(after.getAttribute("data-lifecycle-card-state")).toBe("pending");
    expect(after.querySelector('[role="status"]')).toBeNull();
    await act(async () => {
      fireEvent.click(after.querySelector(APPROVE)!);
    });
    expect(decide.mock.calls[1]![0]).toMatchObject({ decisionId: "d2", answer: "approve" });
    await act(async () => {
      replies[1]!("failed");
    });
    await settle();
    expect((await rootOf(mounted)).querySelector('[role="status"]')?.textContent).toBe("The decision could not be sent.");
  });

  it("a decision allowed whose run did not go on offers Allow only, with no note and no Do not allow", async () => {
    stateMock.mockImplementation(async () => ({ ...PENDING, resumeOnly: true }));
    const root = await rootOf(mountOn("run_card", okDoor()));
    expect(root.getAttribute("data-lifecycle-card-state")).toBe("pending");
    expect(root.querySelector<HTMLButtonElement>(APPROVE)?.disabled).toBe(false);
    expect(root.querySelector(DECLINE)).toBeNull();
    expect(root.querySelector("textarea")).toBeNull();
    expect(root.textContent).toContain("Allow again to let it go on.");
  });

  it("an answer that did not land says so under the controls, keeps them live, and clears on the next answer", async () => {
    let answer: "failed" | "decided" = "failed";
    const mounted = mountOn("run_card", vi.fn<PublishDecisionDecide>(async () => answer));
    const root = await rootOf(mounted);
    expect(root.textContent).not.toContain("The decision could not be sent.");
    await act(async () => {
      fireEvent.click(root.querySelector(DECLINE)!);
    });
    await settle();
    const after = await rootOf(mounted);
    expect(after.getAttribute("data-lifecycle-card-state")).toBe("pending");
    expect(after.querySelector('[role="status"]')?.textContent).toBe("The decision could not be sent.");
    expect(after.querySelector<HTMLButtonElement>(DECLINE)?.disabled).toBe(false);
    answer = "decided";
    await act(async () => {
      fireEvent.click(after.querySelector(APPROVE)!);
    });
    await settle();
    expect((await rootOf(mounted)).textContent).not.toContain("The decision could not be sent.");
  });

  it("the note field takes no more than the decision store records (2,000 characters)", async () => {
    const root = await rootOf(mountOn("chat_thread", vi.fn<PublishDecisionDecide>(async () => "decided")));
    expect(root.querySelector("textarea")?.maxLength).toBe(2000);
  });

  it("an answer that is no longer open is reported, and Refresh draws loading until the re-read lands", async () => {
    const mounted = mountOn("chat_thread", vi.fn<PublishDecisionDecide>(async () => "not_open"));
    const root = await rootOf(mounted);
    await act(async () => {
      fireEvent.click(root.querySelector(APPROVE)!);
    });
    await settle();
    const closed = await rootOf(mounted);
    expect(closed.getAttribute("data-lifecycle-card-state")).toBe("no_longer_open");
    expect(closed.textContent).toContain("This request is no longer open");
    expect(closed.querySelector(APPROVE)).toBeNull();
    expect(closed.querySelector('[data-conformance-id="publish-state-no-longer-open"]')?.textContent).toContain(
      "This request is no longer open",
    );
    let land: (value: unknown) => void = () => undefined;
    stateMock.mockImplementation(() => new Promise((resolve) => (land = resolve)));
    await act(async () => {
      fireEvent.click(closed.querySelector("button")!);
    });
    expect((await rootOf(mounted)).getAttribute("data-lifecycle-card-state")).toBe("loading");
    expect(mounted.container.querySelector("button")).toBeNull();
    expect(mounted.container.querySelector('[data-conformance-id="publish-state-loading"]')?.getAttribute("aria-busy")).toBe("true");
    expect(mounted.container.querySelector('[data-conformance-id="publish-state-no-longer-open"]')).toBeNull();
    await act(async () => {
      land(EXPIRED);
    });
    await settle();
    expect((await rootOf(mounted)).getAttribute("data-lifecycle-card-state")).toBe("expired");
    expect(mounted.container.querySelector('[data-conformance-id^="publish-state-"]')).toBeNull();
  });

  it("a Refresh whose re-read FAILS ends loading and keeps the last answer on screen", async () => {
    const mounted = mountOn("chat_thread", vi.fn<PublishDecisionDecide>(async () => "not_open"));
    const root = await rootOf(mounted);
    await act(async () => {
      fireEvent.click(root.querySelector(APPROVE)!);
    });
    await settle();
    stateMock.mockImplementation(async () => Promise.reject(new Error("offline")));
    await act(async () => {
      fireEvent.click((await rootOf(mounted)).querySelector("button")!);
    });
    await settle();
    const after = await rootOf(mounted);
    expect(after.getAttribute("data-lifecycle-card-state")).toBe("pending");
    expect(after.querySelector(APPROVE)).not.toBeNull();
  });

  it("a door that fails leaves the card as it was, with its controls live again", async () => {
    const mounted = mountOn("run_card", vi.fn<PublishDecisionDecide>(async () => Promise.reject(new Error("down"))));
    const root = await rootOf(mounted);
    await act(async () => {
      fireEvent.click(root.querySelector(DECLINE)!);
    });
    await settle();
    const after = await rootOf(mounted);
    expect(after.getAttribute("data-lifecycle-card-state")).toBe("pending");
    expect(after.querySelector<HTMLButtonElement>(DECLINE)?.disabled).toBe(false);
    expect(stateMock).toHaveBeenCalledTimes(1);
  });
});
