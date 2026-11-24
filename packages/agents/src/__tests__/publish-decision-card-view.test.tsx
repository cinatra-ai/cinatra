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
import { REVIEW_ISLAND_EMPTY_MARKER } from "../review-gate-card";
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
const PENDING = { state: "pending", runId: RUN_ID, agentName: "Blog publisher", rows: ROWS, mayDecide: true };
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

  // cinatra#4150 W4: a list row draws a compact table under its label, and says how many records it does not draw.
  // Before the fix the card cannot read a list row, so it draws no card and the root lookup fails:
  // red-first-expect: no card root
  it("a list row draws its columns and records as a table, with the count it does not draw", async () => {
    const list = { kind: "list", label: "Recipients", columns: ["Name", "Email"], items: [["Ada", "ada@example.test"], ["Bo", ""]], total: 7 };
    stateMock.mockImplementation(async () => ({ ...PENDING, rows: [ROWS[0], list] }));
    const root = await rootOf(mountOn("chat_thread", okDoor()));
    await settle();
    expect(Array.from(root.querySelectorAll("dt")).map((el) => el.textContent)).toEqual(["Title", "Recipients"]);
    const value = root.querySelector('[data-publish-row-kind="list"]');
    expect(value?.tagName).toBe("DD");
    expect(Array.from(value!.querySelectorAll("th")).map((el) => el.textContent)).toEqual(["Name", "Email"]);
    expect(Array.from(value!.querySelectorAll("tbody tr")).map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => td.textContent))).toEqual([
      ["Ada", "ada@example.test"],
      ["Bo", ""],
    ]);
    expect(value!.querySelector("[data-publish-row-more]")?.textContent).toBe("5 more");
  });

  it("a list row that draws every record has no count line", async () => {
    const list = { kind: "list", label: "Recipients", columns: ["Name"], items: [["Ada"]], total: 1 };
    stateMock.mockImplementation(async () => ({ ...PENDING, rows: [list] }));
    const root = await rootOf(mountOn("run_card", okDoor()));
    await settle();
    expect(root.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(root.querySelector("[data-publish-row-more]")).toBeNull();
  });

  // cinatra#4738, spec XV.1 "a wide table scrolls inside its own frame": the rows sit in a grid track that can never
  // be wider than the card's content box, so a wide table or the items panel cannot push past the card at 360 px.
  // Before the fix the track was sized by its widest row's content:
  // red-first-expect: to include 'grid-cols-[minmax(0,1fr)]'
  it("the row track is minmax(0, 1fr) and no row can widen it", async () => {
    stateMock.mockImplementation(async () => PENDING);
    const root = await rootOf(mountOn("run_card", okDoor()));
    await settle();
    const dl = root.querySelector("dl")!;
    expect(Array.from(dl.classList)).toContain("grid-cols-[minmax(0,1fr)]");
    for (const row of Array.from(dl.children)) expect(Array.from(row.classList)).toContain("min-w-0");
  });

  // Before the list and items rows were read, the card drew nothing for them:
  // red-first-expect: no card root
  it("the table scrolls in its own frame and the items panel keeps to the card's content box", async () => {
    const list = { kind: "list", label: "Recipients", columns: ["Name", "Email"], items: [["Ada", "ada@example.test"]], total: 1 };
    const items = { kind: "artifacts", label: "Pages", ref: "Abc_123-xyz", islandSrc: null };
    stateMock.mockImplementation(async () => ({ ...PENDING, rows: [ROWS[0], list, items] }));
    const root = await rootOf(mountOn("run_card", okDoor()));
    await settle();
    const rows = Array.from(root.querySelector("dl")!.children) as HTMLElement[];
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(Array.from(row.classList)).toContain("min-w-0");
    const tableFrame = root.querySelector("table")!.parentElement!;
    for (const token of ["min-w-0", "max-w-full", "overflow-x-auto"]) expect(Array.from(tableFrame.classList)).toContain(token);
    const itemsValue = root.querySelector<HTMLElement>('dd[data-publish-row-kind="artifacts"]')!;
    for (const token of ["min-w-0", "max-w-full"]) expect(Array.from(itemsValue.classList)).toContain(token);
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
    expect(decide).toHaveBeenLastCalledWith({ runId: RUN_ID, answer: "approve", note: "" });
    await act(async () => {
      fireEvent.click(mounted.container.querySelector(DECLINE)!);
    });
    await settle();
    expect(decide).toHaveBeenLastCalledWith({ runId: RUN_ID, answer: "decline", note: "Not ready yet." });
    expect(stateMock).toHaveBeenCalledTimes(3);
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

// C1b: an artifacts row draws the review-target island through the review card's own frame, addressed by the row's ref;
// a credential host frames the server-minted address only when it names the row's ref. A row with no ref says the items
// could not be shown. Red at C1's head 2ea9dbd1, where the transport refuses the kind (the card draws nothing).
describe("the artifacts row (C1b)", () => {
  const REF = "Abc_123-xyz";
  const ARTIFACTS = { kind: "artifacts", label: "Proposed page", ref: REF, islandSrc: null };
  const frameSrc = async (root: HTMLElement) => {
    await waitFor(() => expect(root.querySelector("iframe")).not.toBeNull());
    return new URL(root.querySelector("iframe")!.getAttribute("src")!, "https://app.example");
  };

  it("draws the island for the row's ref under its label, read only, beside the card's controls", async () => {
    stateMock.mockImplementation(async () => ({ ...PENDING, rows: [ROWS[0], ARTIFACTS] }));
    const root = await rootOf(mountOn("chat_thread", okDoor()));
    await settle();
    expect(Array.from(root.querySelectorAll("dt")).map((el) => el.textContent)).toEqual(["Title", "Proposed page"]);
    const value = root.querySelector('[data-publish-row-kind="artifacts"]');
    expect(value?.tagName).toBe("DD");
    const src = await frameSrc(root);
    expect(src.pathname).toBe("/lifecycle/review-island");
    expect(src.searchParams.get("ref")).toBe(REF);
    expect(src.searchParams.get("ic")).toBeNull();
    // The controls stay the card's, outside the frame.
    expect(root.querySelector(APPROVE)).not.toBeNull();
    expect(value!.querySelector(APPROVE)).toBeNull();
  });

  // The widget address on this row comes from the real broker route, and that wiring is proved end to end in
  // src/app/api/lifecycle-views/publish-decision/__tests__/widget-artifacts-row-4738.test.tsx (cinatra#4738). The tests
  // below pin only the card's own hold over the addresses a broker hands it.

  // cinatra#4738 round 1, finding 2: every widget read brings a fresh single-use credential. Before the fix the row
  // framed each read's address, so the frame reloaded its preview on every poll.
  // red-first-expect: no card root
  it("a widget re-read with a fresh credential for the same row keeps the same frame on the same address", async () => {
    let n = 0;
    globalThis.fetch = (async () => {
      n += 1;
      const islandSrc = `/lifecycle/review-island?ref=${REF}&ic=credential-${n}`;
      return new Response(JSON.stringify({ ...PENDING, rows: [{ ...ARTIFACTS, islandSrc }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const mounted = mountOn("site_widget", okDoor());
    const root = await rootOf(mounted);
    await settle();
    const first = root.querySelector("iframe");
    expect(first).not.toBeNull();
    expect(new URL(first!.getAttribute("src")!, "https://app.example").searchParams.get("ic")).toBe("credential-1");
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
    expect(n).toBe(2);
    expect(root.querySelector("iframe")).toBe(first);
    expect(new URL(first!.getAttribute("src")!, "https://app.example").searchParams.get("ic")).toBe("credential-1");
  });

  it("a widget re-read that names ANOTHER row (a new ref) frames the new row's address at once", async () => {
    let n = 0;
    globalThis.fetch = (async () => {
      n += 1;
      const ref = n === 1 ? REF : "Next_Decision-Ref";
      const islandSrc = `/lifecycle/review-island?ref=${ref}&ic=credential-${n}`;
      return new Response(JSON.stringify({ ...PENDING, rows: [{ ...ARTIFACTS, ref, islandSrc }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const root = await rootOf(mountOn("site_widget", okDoor()));
    await settle();
    expect(root.querySelector("iframe")).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
    const src = await frameSrc(root);
    expect(src.searchParams.get("ref")).toBe("Next_Decision-Ref");
    expect(src.searchParams.get("ic")).toBe("credential-2");
  });

  it("a widget re-read whose address could not be minted keeps the frame it already drew", async () => {
    let n = 0;
    globalThis.fetch = (async () => {
      n += 1;
      const islandSrc = n === 1 ? `/lifecycle/review-island?ref=${REF}&ic=credential-1` : null;
      return new Response(JSON.stringify({ ...PENDING, rows: [{ ...ARTIFACTS, islandSrc }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const root = await rootOf(mountOn("site_widget", okDoor()));
    await settle();
    const first = root.querySelector("iframe");
    expect(first).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
    expect(n).toBe(2);
    expect(root.querySelector("iframe")).toBe(first);
    expect(new URL(first!.getAttribute("src")!, "https://app.example").searchParams.get("ic")).toBe("credential-1");
  });

  // pre-1 MUST-FIX 3: on a widget host the credential is the only proof of the reader, so an address minted for another
  // ref lends this row no credential and the review card's own guard frames NOTHING (no uncredentialed widget frame).
  it("an address minted for another ref lends this row no credential, so a widget host frames nothing", async () => {
    const islandSrc = "/lifecycle/review-island?ref=OtherRef&ic=sealed-credential";
    brokerAnswer = { status: 200, body: { ...PENDING, rows: [{ ...ARTIFACTS, islandSrc }] } };
    const root = await rootOf(mountOn("site_widget", okDoor()));
    await settle();
    const value = root.querySelector('[data-publish-row-kind="artifacts"]');
    expect(value?.querySelector('[data-conformance-id="review-target-island"]')?.getAttribute("data-island-load-state")).toBe("empty");
    expect(root.querySelector("iframe")).toBeNull();
    expect(root.innerHTML).not.toContain("sealed-credential");
  });

  it("a row with no ref says the items could not be shown, and frames nothing", async () => {
    stateMock.mockImplementation(async () => ({ ...PENDING, rows: [{ ...ARTIFACTS, ref: null }] }));
    const root = await rootOf(mountOn("run_card", okDoor()));
    await settle();
    const value = root.querySelector('[data-publish-row-kind="artifacts"]');
    expect(value?.hasAttribute("data-publish-row-unavailable")).toBe(true);
    expect(value?.textContent).toBe("These items could not be shown.");
    expect(root.querySelector("iframe")).toBeNull();
  });
});

// cinatra#4738 grade: the anchors design spec XV.1 (app-lifecycle-cards.html at design main 615ed095) names, drawn by the card
// itself so a capture can count them. Before the fix the card drew none of them (only publish-card), because the rows carried
// data-publish-row-kind and no conformance anchor.
// red-first-expect: no card root
describe("the XV.1 row anchors", () => {
  const REF = "Abc_123-xyz";
  const TEXT = ROWS[0];
  const LIST = { kind: "list", label: "Recipients", columns: ["Name"], items: [["Ada"]], total: 1 };
  const ITEMS = { kind: "artifacts", label: "Proposed page", ref: REF, islandSrc: null };
  const anchors = (root: HTMLElement) =>
    [root, ...Array.from(root.querySelectorAll("[data-conformance-id]"))]
      .filter((el) => el.hasAttribute("data-conformance-id"))
      .map((el) => el.getAttribute("data-conformance-id"));

  it("a text, a list and an items row each carry their own anchor, under the rows anchor, in the declared order", async () => {
    stateMock.mockImplementation(async () => ({ ...PENDING, rows: [TEXT, LIST, ITEMS] }));
    const root = await rootOf(mountOn("chat_thread", okDoor()));
    await settle();
    expect(anchors(root).filter((id) => id!.startsWith("publish-"))).toEqual([
      "publish-card",
      "publish-card-rows",
      "publish-row-text",
      "publish-row-list",
      "publish-row-items",
    ]);
    const frame = root.querySelector('[data-conformance-id="publish-card-rows"]')!;
    expect(frame.querySelector("dl")).not.toBeNull();
    expect(frame.querySelector(APPROVE)).not.toBeNull();
    // Each anchor holds its own label over its own value, and the text row holds the text value.
    expect(root.querySelector('[data-conformance-id="publish-row-text"]')?.textContent).toBe("TitleSpring launch");
    expect(root.querySelector('[data-conformance-id="publish-row-list"] dt')?.textContent).toBe("Recipients");
    expect(root.querySelector('[data-conformance-id="publish-row-items"] dt')?.textContent).toBe("Proposed page");
    expect(root.querySelector('[data-conformance-id="publish-row-items"] [data-publish-row-kind="artifacts"]')).not.toBeNull();
  });

  it("an items row that could not be shown carries the refused anchor and not the items anchor", async () => {
    stateMock.mockImplementation(async () => ({ ...PENDING, rows: [{ ...ITEMS, ref: null }] }));
    const root = await rootOf(mountOn("run_card", okDoor()));
    await settle();
    expect(root.querySelector('[data-conformance-id="publish-row-items"]')).toBeNull();
    const refused = root.querySelector('[data-conformance-id="publish-row-items-refused"]');
    expect(refused?.querySelector("dt")?.textContent).toBe("Proposed page");
    expect(refused?.textContent).toContain("These items could not be shown.");
  });

  it("a card with no rows has no rows anchor, and a settled card keeps its rows anchor beside its marker", async () => {
    stateMock.mockImplementation(async () => ({ ...PENDING, rows: [] }));
    const none = await rootOf(mountOn("run_card", okDoor()));
    await settle();
    expect(none.querySelector('[data-conformance-id="publish-card-rows"]')).toBeNull();
    cleanup();
    stateMock.mockImplementation(async () => ({ ...APPROVED, rows: [TEXT, LIST] }));
    const settled = await rootOf(mountOn("chat_thread", okDoor()));
    await settle();
    expect(settled.querySelector('[data-conformance-id="publish-card-rows"]')).not.toBeNull();
    expect(settled.querySelector('[data-conformance-id="publish-row-list"]')).not.toBeNull();
    expect(settled.querySelector('[data-conformance-id="publish-card-approved"]')).not.toBeNull();
  });
});

// cinatra#4738: design spec XV.1 draws an items row whose island settled empty (none of the named items is the run's own,
// or any other refusal: the island draws one empty document for all of them) as the panel's frame with nothing in it,
// under publish-row-items-empty. Before the fix the card read the island's empty document as a preview that did not
// load, and drew "The preview did not load" with Try again under publish-row-items.
// red-first-expect: no card root
describe("the XV.1 empty items panel", () => {
  const REF = "Abc_123-xyz";
  const ITEMS = { kind: "artifacts", label: "Proposed page", ref: REF, islandSrc: null };
  const frameOf = async (root: HTMLElement) => {
    await waitFor(() => expect(root.querySelector("iframe")).not.toBeNull());
    return root.querySelector("iframe") as HTMLIFrameElement;
  };
  // The island's one empty document, standing in for the document jsdom does not fetch: the card asks the frame one
  // marker question, and this answers it as the served empty document does.
  const serveEmpty = (frame: HTMLIFrameElement) =>
    Object.defineProperty(frame, "contentDocument", {
      configurable: true,
      get: () => ({
        querySelector: (selector: string) => (selector.includes(REVIEW_ISLAND_EMPTY_MARKER) ? ({} as Element) : null),
      }),
    });

  it("an island that settled empty draws the panel frame with nothing in it, under the empty anchor, on the host page", async () => {
    stateMock.mockImplementation(async () => ({ ...PENDING, rows: [ITEMS] }));
    const root = await rootOf(mountOn("chat_thread", okDoor()));
    await settle();
    const frame = await frameOf(root);
    serveEmpty(frame);
    await act(async () => {
      frame.dispatchEvent(new Event("load"));
    });
    await settle();
    expect(root.textContent).not.toContain("The preview did not load");
    expect(root.querySelector('[data-conformance-id="review-target-island-timeout"]')).toBeNull();
    expect(root.querySelector('[data-conformance-id="publish-row-items"]')).toBeNull();
    const empty = root.querySelector('[data-conformance-id="publish-row-items-empty"]');
    expect(empty?.querySelector("dt")?.textContent).toBe("Proposed page");
    // The panel keeps its frame and draws nothing: no words, no skeleton, no control.
    const panel = empty?.querySelector('[data-conformance-id="review-target-island"]');
    expect(panel?.getAttribute("data-island-load-state")).toBe("empty");
    expect(panel?.className).toContain("border");
    expect(empty?.querySelector("dd")?.textContent).toBe("");
    expect(empty?.querySelector("button")).toBeNull();
    expect(empty?.querySelector('[data-conformance-id="review-target-island-skeleton"]')).toBeNull();
    // The same frame stays mounted, so a later document of the same row is not a new load.
    expect(root.querySelector("iframe")).toBe(frame);
    expect(frame.className).toContain("opacity-0");
  });

  it("an island that drew the run's items keeps the items anchor", async () => {
    stateMock.mockImplementation(async () => ({ ...PENDING, rows: [ITEMS] }));
    const root = await rootOf(mountOn("chat_thread", okDoor()));
    await settle();
    const frame = await frameOf(root);
    await act(async () => {
      frame.dispatchEvent(new Event("load"));
    });
    await settle();
    expect(root.querySelector('[data-conformance-id="publish-row-items-empty"]')).toBeNull();
    expect(root.querySelector('[data-conformance-id="publish-row-items"]')).not.toBeNull();
    expect(root.querySelector('[data-conformance-id="review-target-island"]')?.getAttribute("data-island-load-state")).toBe("loaded");
  });

  it("a frame that never answers still shows the failure state with Try again, never the empty panel", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      stateMock.mockImplementation(async () => ({ ...PENDING, rows: [ITEMS] }));
      const root = await rootOf(mountOn("run_card", okDoor()));
      await settle();
      await frameOf(root);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(13_000);
      });
      expect(root.querySelector('[data-conformance-id="review-target-island-timeout"]')).not.toBeNull();
      expect(root.textContent).toContain("The preview did not load");
      expect(root.querySelector('[data-conformance-id="publish-row-items-empty"]')).toBeNull();
      expect(root.querySelector('[data-conformance-id="publish-row-items"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
