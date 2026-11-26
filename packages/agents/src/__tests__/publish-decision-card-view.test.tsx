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

/** The island's own report that it drew a panel (cinatra#3089): `island-ready`, then `panel-mounted`, from the frame's
 *  window and naming the attempt the card stamped on its name, as `island-height-reporter.tsx` posts them. */
async function islandReportsAPanel(frame: HTMLIFrameElement) {
  const name = frame.getAttribute("name") ?? "";
  const attempt = Number(name.slice(name.indexOf(":") + 1));
  for (const type of ["island-ready", "panel-mounted"]) {
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { channel: "cinatra-review-island-progress", type, attempt },
          origin: window.location.origin,
          source: frame.contentWindow as Window,
        }),
      );
    });
  }
  await settle();
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
  it("the row track is minmax(0, 1fr) and no row can widen it", async () => {
    stateMock.mockImplementation(async () => PENDING);
    const root = await rootOf(mountOn("run_card", okDoor()));
    await settle();
    const dl = root.querySelector("dl")!;
    expect(Array.from(dl.classList)).toContain("grid-cols-[minmax(0,1fr)]");
    for (const row of Array.from(dl.children)) expect(Array.from(row.classList)).toContain("min-w-0");
  });

  // Before the list and items rows were read, the card drew nothing for them:
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

  it("a reply that comes back after a re-read settled the decision never replaces the settled reading", async () => {
    for (const settled of [APPROVED, DECLINED, EXPIRED]) {
      brokerAnswer = { status: 200, body: PENDING };
      const replies: Array<(outcome: "not_open" | "failed") => void> = [];
      const decide = vi.fn<PublishDecisionDecide>(() => new Promise((resolve) => replies.push(resolve)));
      const mounted = mountOn("site_widget", decide);
      const root = await rootOf(mounted);
      await act(async () => {
        fireEvent.click(root.querySelector(APPROVE)!);
      });
      await moveTo(settled);
      expect((await rootOf(mounted)).getAttribute("data-lifecycle-card-state")).toBe(settled.state);
      await act(async () => {
        replies[0]!("not_open");
      });
      await settle();
      const after = await rootOf(mounted);
      expect(after.getAttribute("data-lifecycle-card-state")).toBe(settled.state);
      expect(after.textContent).not.toContain("no longer open");
      mounted.unmount();
    }
  });

  // The settled re-read and the late reply land in ONE batch: the reply's guard still reads the open decision (the ref
  // follows the drawn decision only after a commit), so the reply's reading is recorded. The card still draws the
  // settled decision: "no longer open" and "failed" speak only for the decision the card shows.
  it("a settled re-read and a late reply in the same batch: the settled reading stands", async () => {
    for (const [settled, outcome] of [[APPROVED, "not_open"], [DECLINED, "not_open"], [EXPIRED, "failed"]] as const) {
      const replies: Array<(outcome: "not_open" | "failed") => void> = [];
      const decide = vi.fn<PublishDecisionDecide>(() => new Promise((resolve) => replies.push(resolve)));
      const read = (state: unknown) => ({ state: state as never, refreshing: false, reload: () => undefined });
      const card = (state: unknown) => (
        <LifecycleCardSurfaceProvider host="run_card">
          <PublishDecisionCard runId={RUN_ID} decide={decide} read={read(state)} />
        </LifecycleCardSurfaceProvider>
      );
      const mounted = render(card(PENDING));
      await act(async () => {
        fireEvent.click((await rootOf(mounted)).querySelector(APPROVE)!);
      });
      expect(decide).toHaveBeenCalledTimes(1);
      await act(async () => {
        mounted.rerender(card(settled));
        replies[0]!(outcome);
        await Promise.resolve();
        await Promise.resolve();
      });
      await settle();
      const after = await rootOf(mounted);
      expect(after.getAttribute("data-lifecycle-card-state")).toBe(settled.state);
      expect(after.textContent).not.toContain("no longer open");
      expect(after.textContent).not.toContain("The decision could not be sent.");
      mounted.unmount();
    }
  });

  it("a reply that lands while a read briefly drew no decision leaves the controls live when the same decision returns", async () => {
    const replies: Array<(outcome: "failed") => void> = [];
    const decide = vi.fn<PublishDecisionDecide>(() => new Promise((resolve) => replies.push(resolve)));
    const read = (state: unknown) => ({ state: state as never, refreshing: false, reload: () => undefined });
    const card = (state: unknown) => (
      <LifecycleCardSurfaceProvider host="run_card">
        <PublishDecisionCard runId={RUN_ID} decide={decide} read={read(state)} />
      </LifecycleCardSurfaceProvider>
    );
    const mounted = render(card(PENDING));
    await act(async () => {
      fireEvent.click((await rootOf(mounted)).querySelector(APPROVE)!);
    });
    expect(decide).toHaveBeenCalledTimes(1);
    // A read fault answers "none" while the answer is in flight; the answer then fails.
    await act(async () => {
      mounted.rerender(card({ state: "none" }));
    });
    await settle();
    await act(async () => {
      replies[0]!("failed");
      await Promise.resolve();
      await Promise.resolve();
    });
    await settle();
    // The next read draws the same open decision again: its controls are live.
    await act(async () => {
      mounted.rerender(card(PENDING));
    });
    await settle();
    const after = await rootOf(mounted);
    expect(after.querySelector<HTMLButtonElement>(APPROVE)?.disabled).toBe(false);
    expect(after.querySelector<HTMLButtonElement>(DECLINE)?.disabled).toBe(false);
    mounted.unmount();
  });

  it("the same decision allowed by another person whose run did not go on offers Allow again, whatever the open request's reply said", async () => {
    for (const replyFirst of [true, false]) {
      const replies: Array<(outcome: "not_open") => void> = [];
      const decide = vi.fn<PublishDecisionDecide>(() => new Promise((resolve) => replies.push(resolve)));
      const read = (state: unknown) => ({ state: state as never, refreshing: false, reload: () => undefined });
      const card = (state: unknown) => (
        <LifecycleCardSurfaceProvider host="run_card">
          <PublishDecisionCard runId={RUN_ID} decide={decide} read={read(state)} />
        </LifecycleCardSurfaceProvider>
      );
      const mounted = render(card(PENDING));
      await act(async () => {
        fireEvent.click((await rootOf(mounted)).querySelector(APPROVE)!);
      });
      const reply = async () => {
        await act(async () => {
          replies[0]!("not_open");
          await Promise.resolve();
          await Promise.resolve();
        });
        await settle();
      };
      const allowAgain = async () => {
        await act(async () => {
          mounted.rerender(card({ ...PENDING, resumeOnly: true }));
        });
        await settle();
      };
      // Another person allowed the same decision and its resume failed: the next read draws it as Allow again.
      if (replyFirst) {
        await reply();
        await allowAgain();
      } else {
        await allowAgain();
        await reply();
      }
      const after = await rootOf(mounted);
      expect(after.getAttribute("data-lifecycle-card-state"), String(replyFirst)).toBe("pending");
      expect(after.textContent).not.toContain("no longer open");
      expect(after.textContent).toContain("Allow again to let it go on.");
      expect(after.querySelector<HTMLButtonElement>(APPROVE)?.disabled).toBe(false);
      mounted.unmount();
    }
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

  it("the Allow-again card carries the anchor the approved design names for it (app-lifecycle-cards.html XV)", async () => {
    stateMock.mockImplementation(async () => ({ ...PENDING, resumeOnly: true }));
    const root = await rootOf(mountOn("run_card", okDoor()));
    expect(root.querySelectorAll('[data-conformance-id="publish-card-allow-again"]')).toHaveLength(1);
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

  // cinatra#4738: every widget read brings a fresh single-use credential. Before the fix the row
  // framed each read's address, so the frame reloaded its preview on every poll.
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
    await islandReportsAPanel(frame);
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

// cinatra#4738: the island spends a widget frame's single-use credential before its later reads, so a refusal after the
// spend (or a reload of the frame) serves the same empty document as a row with nothing to show. A row whose
// credentialed frame settled empty takes the next fresh broker address once and loads again; a second empty answer is
// the row's reading and is not reloaded. Before this the row held the spent address and stayed empty until it remounted.
// On main the card cannot read an items row at all, so it draws no card:
describe("an empty widget items frame and a fresh broker address", () => {
  const REF = "Abc_123-xyz";
  const ITEMS = { kind: "artifacts", label: "Proposed page", ref: REF, islandSrc: null };
  const credentialOf = (frame: Element | null) =>
    frame === null ? null : new URL(frame.getAttribute("src")!, "https://app.example").searchParams.get("ic");
  const serveEmpty = (frame: HTMLIFrameElement) =>
    Object.defineProperty(frame, "contentDocument", {
      configurable: true,
      get: () => ({
        querySelector: (selector: string) => (selector.includes(REVIEW_ISLAND_EMPTY_MARKER) ? ({} as Element) : null),
      }),
    });
  const load = async (frame: HTMLIFrameElement, empty: boolean) => {
    if (empty) serveEmpty(frame);
    await act(async () => {
      frame.dispatchEvent(new Event("load"));
    });
    await settle();
  };
  const focus = async () => {
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
  };
  let reads = 0;
  beforeEach(() => {
    reads = 0;
    globalThis.fetch = (async () => {
      reads += 1;
      const islandSrc = `/lifecycle/review-island?ref=${REF}&ic=credential-${reads}`;
      return new Response(JSON.stringify({ ...PENDING, rows: [{ ...ITEMS, islandSrc }] }), { status: 200 });
    }) as unknown as typeof fetch;
  });

  it("a spent credential that settled empty frames the next fresh address once, and draws the items it serves", async () => {
    const root = await rootOf(mountOn("site_widget", okDoor()));
    await settle();
    const first = root.querySelector("iframe")!;
    expect(credentialOf(first)).toBe("credential-1");
    await load(first, true);
    expect(root.querySelector('[data-conformance-id="publish-row-items-empty"]')).not.toBeNull();
    await focus();
    expect(reads).toBe(2);
    const second = root.querySelector("iframe")!;
    expect(credentialOf(second)).toBe("credential-2");
    await load(second, false);
    await islandReportsAPanel(second);
    expect(root.querySelector('[data-conformance-id="publish-row-items-empty"]')).toBeNull();
    expect(root.querySelector('[data-conformance-id="publish-row-items"]')).not.toBeNull();
    expect(root.querySelector('[data-conformance-id="review-target-island"]')?.getAttribute("data-island-load-state")).toBe("loaded");
    // A drawn frame keeps its address on later reads, as before.
    await focus();
    expect(reads).toBe(3);
    expect(root.querySelector("iframe")).toBe(second);
    expect(credentialOf(root.querySelector("iframe"))).toBe("credential-2");
  });

  it("a second empty answer keeps the empty panel and later fresh addresses do not reload it", async () => {
    const root = await rootOf(mountOn("site_widget", okDoor()));
    await settle();
    await load(root.querySelector("iframe")!, true);
    await focus();
    const second = root.querySelector("iframe")!;
    expect(credentialOf(second)).toBe("credential-2");
    await load(second, true);
    expect(root.querySelector('[data-conformance-id="publish-row-items-empty"]')).not.toBeNull();
    await focus();
    await focus();
    expect(reads).toBe(4);
    expect(root.querySelector("iframe")).toBe(second);
    expect(credentialOf(second)).toBe("credential-2");
    expect(root.querySelector('[data-conformance-id="publish-row-items-empty"]')).not.toBeNull();
    expect(root.querySelector('[data-conformance-id="review-target-island"]')?.getAttribute("data-island-load-state")).toBe("empty");
  });

  it("a cookie host's empty row is final: a re-read does not load it again", async () => {
    stateMock.mockImplementation(async () => ({ ...PENDING, rows: [ITEMS] }));
    const root = await rootOf(mountOn("chat_thread", okDoor()));
    await settle();
    const frame = root.querySelector("iframe")!;
    await load(frame, true);
    await focus();
    expect(root.querySelector("iframe")).toBe(frame);
    expect(root.querySelector('[data-conformance-id="publish-row-items-empty"]')).not.toBeNull();
  });
});

// cinatra#3089, design spec XV.1 "Allow waits for the items": "Until every item is drawn, Allow is shown but disabled, so
// nothing is released that was not on screen; Do not allow and the note field stay live". In this card an item counts as
// shown once its island frame has LOADED and the island itself has reported, for that frame's attempt and from that
// frame's window, `island-ready` and a `panel-mounted`. A page that only loads (an error, sign-in or redirect page)
// never counts.
describe("XV.1: Allow waits for the items", () => {
  const REF = "Abc_123-xyz";
  const ITEMS = { kind: "artifacts", label: "Proposed page", ref: REF, islandSrc: null };
  const WAITS = "Allow waits until the items are shown.";
  const allowOf = (root: HTMLElement) => root.querySelector<HTMLButtonElement>(APPROVE)!;
  const declineOf = (root: HTMLElement) => root.querySelector<HTMLButtonElement>(DECLINE)!;
  const description = (root: HTMLElement) => {
    const id = allowOf(root).getAttribute("aria-describedby");
    return id ? (root.ownerDocument.getElementById(id)?.textContent ?? null) : null;
  };
  const waitLine = (root: HTMLElement) =>
    root.querySelector<HTMLElement>(
      '[data-conformance-id="publish-allow-waits-failed"], [data-conformance-id="publish-allow-waits-refused"], [data-conformance-id="publish-allow-waits-empty"]',
    );
  const frameOf = async (root: HTMLElement) => {
    await waitFor(() => expect(root.querySelector("iframe")).not.toBeNull());
    return root.querySelector("iframe") as HTMLIFrameElement;
  };
  const loaded = async (frame: HTMLIFrameElement) => {
    await act(async () => {
      frame.dispatchEvent(new Event("load"));
    });
    await settle();
  };
  /** The attempt the card stamped on a frame's name, which the island names back. */
  const attemptOf = (frame: HTMLIFrameElement) => {
    const name = frame.getAttribute("name") ?? "";
    return Number(name.slice(name.indexOf(":") + 1));
  };
  /** One message as the island's reporter posts it (`island-height-report.ts`), by default from this frame's window. */
  const post = async (
    frame: HTMLIFrameElement,
    data: unknown,
    over: { origin?: string; source?: Window | null } = {},
  ) => {
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data,
          origin: over.origin ?? window.location.origin,
          source: (over.source === undefined ? frame.contentWindow : over.source) as Window,
        }),
      );
    });
    await settle();
  };
  const progress = (type: "island-ready" | "panel-mounted", attempt: number) => ({
    channel: "cinatra-review-island-progress",
    type,
    attempt,
  });
  /** The island's own report that it drew a panel: ready, then a mounted panel, for the frame's current attempt. */
  const reported = async (
    frame: HTMLIFrameElement,
    over: { origin?: string; source?: Window | null; attempt?: number } = {},
  ) => {
    const attempt = over.attempt ?? attemptOf(frame);
    await post(frame, progress("island-ready", attempt), over);
    await post(frame, progress("panel-mounted", attempt), over);
  };
  /** The frame loaded the island and the island reported a panel. */
  const shown = async (frame: HTMLIFrameElement) => {
    await loaded(frame);
    await reported(frame);
  };
  const paint = (scheme: "light" | "dark" | "none") => {
    document.documentElement.className = scheme === "none" ? "" : scheme === "dark" ? "dark" : "cinatra";
  };

  it("Allow is disabled until the items frame has loaded AND the island reported a panel; Do not allow and the note stay live", async () => {
    stateMock.mockImplementation(async () => ({ ...PENDING, rows: [ROWS[0], ITEMS] }));
    const root = await rootOf(mountOn("chat_thread", okDoor()));
    await settle();
    const frame = await frameOf(root);
    expect(allowOf(root).disabled).toBe(true);
    expect(declineOf(root).disabled).toBe(false);
    expect(root.querySelector("textarea")?.disabled).toBe(false);
    expect(root.querySelector('[data-conformance-id="publish-card-rows"]')).not.toBeNull();
    // While the panel loads the line is not drawn; the same sentence is the button's description.
    expect(waitLine(root)).toBeNull();
    expect(description(root)).toBe(WAITS);
    // A blank frame's load is not the island: no report, so the items are not shown (the Codex finding on #4838).
    await loaded(frame);
    expect(allowOf(root).disabled).toBe(true);
    expect(root.querySelector('[data-island-load-state="loading"]')).not.toBeNull();
    expect(description(root)).toBe(WAITS);
    await reported(frame);
    expect(allowOf(root).disabled).toBe(false);
    expect(allowOf(root).hasAttribute("aria-describedby")).toBe(false);
    expect(root.textContent).not.toContain(WAITS);
    expect(root.querySelector('[data-conformance-id="publish-card-items-shown"]')).not.toBeNull();
    expect(root.querySelector('[data-conformance-id="publish-card-rows"]')).toBeNull();
  });

  it("a panel that did not load keeps Allow disabled with the failed line, and its Try again brings Allow back once loaded", async () => {
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
      expect(root.textContent).not.toContain("does not block your decision");
      expect(allowOf(root).disabled).toBe(true);
      expect(declineOf(root).disabled).toBe(false);
      const line = waitLine(root);
      expect(line?.getAttribute("data-conformance-id")).toBe("publish-allow-waits-failed");
      expect(line?.textContent).toBe(WAITS);
      expect(allowOf(root).getAttribute("aria-describedby")).toBe(line?.id);
      expect(root.querySelector('[data-conformance-id="publish-card-items-failed"]')).not.toBeNull();
      const retry = root.querySelector<HTMLButtonElement>('[data-action="retry-review-target-island -> reload"]')!;
      await act(async () => {
        fireEvent.click(retry);
      });
      await settle();
      expect(allowOf(root).disabled).toBe(true);
      await shown(await frameOf(root));
      expect(root.querySelector('[data-conformance-id="review-target-island-timeout"]')).toBeNull();
      expect(allowOf(root).disabled).toBe(false);
      expect(waitLine(root)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a row whose items could not be shown keeps Allow disabled with the refused line, and Do not allow is the answer left", async () => {
    const decide = okDoor();
    stateMock.mockImplementation(async () => ({ ...PENDING, rows: [{ ...ITEMS, ref: null }] }));
    const root = await rootOf(mountOn("run_card", decide));
    await settle();
    expect(allowOf(root).disabled).toBe(true);
    const line = waitLine(root);
    expect(line?.getAttribute("data-conformance-id")).toBe("publish-allow-waits-refused");
    expect(allowOf(root).getAttribute("aria-describedby")).toBe(line?.id);
    await act(async () => {
      fireEvent.click(declineOf(root));
    });
    await settle();
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ answer: "decline", decisionId: "d1" }));
  });

  it("a panel that stays empty keeps Allow disabled with the empty line", async () => {
    stateMock.mockImplementation(async () => ({ ...PENDING, rows: [ITEMS] }));
    const root = await rootOf(mountOn("chat_thread", okDoor()));
    await settle();
    const frame = await frameOf(root);
    Object.defineProperty(frame, "contentDocument", {
      configurable: true,
      get: () => ({
        querySelector: (selector: string) => (selector.includes(REVIEW_ISLAND_EMPTY_MARKER) ? ({} as Element) : null),
      }),
    });
    await loaded(frame);
    expect(root.querySelector('[data-conformance-id="publish-row-items-empty"]')).not.toBeNull();
    expect(allowOf(root).disabled).toBe(true);
    expect(waitLine(root)?.getAttribute("data-conformance-id")).toBe("publish-allow-waits-empty");
    expect(declineOf(root).disabled).toBe(false);
  });

  it("a widget panel with no address it may frame draws nothing, so Allow waits there too", async () => {
    const islandSrc = "/lifecycle/review-island?ref=OtherRef&ic=sealed-credential";
    brokerAnswer = { status: 200, body: { ...PENDING, rows: [{ ...ITEMS, islandSrc }] } };
    const root = await rootOf(mountOn("site_widget", okDoor()));
    await settle();
    expect(root.querySelector("iframe")).toBeNull();
    expect(allowOf(root).disabled).toBe(true);
    expect(waitLine(root)?.getAttribute("data-conformance-id")).toBe("publish-allow-waits-empty");
  });

  it("Allow again waits for the items as well", async () => {
    stateMock.mockImplementation(async () => ({ ...PENDING, rows: [ITEMS], resumeOnly: true }));
    const root = await rootOf(mountOn("chat_thread", okDoor()));
    await settle();
    const frame = await frameOf(root);
    expect(allowOf(root).disabled).toBe(true);
    await shown(frame);
    expect(allowOf(root).disabled).toBe(false);
  });

  it("a palette change navigates the frame: Allow waits again, and only the replacement frame's load counts", async () => {
    const schemeOf = (frame: HTMLIFrameElement) => new URL(frame.src, window.location.href).searchParams.get("scheme");
    try {
      paint("light");
      stateMock.mockImplementation(async () => ({ ...PENDING, rows: [ITEMS] }));
      const root = await rootOf(mountOn("chat_thread", okDoor()));
      await settle();
      const frame = await frameOf(root);
      await shown(frame);
      expect(allowOf(root).disabled).toBe(false);
      const outgoingWindow = frame.contentWindow;
      const outgoingAttempt = attemptOf(frame);
      await act(async () => {
        paint("dark");
      });
      await settle();
      expect(allowOf(root).disabled).toBe(true);
      expect(root.querySelector('[data-conformance-id="publish-card-items-shown"]')).toBeNull();
      // The navigation is a new attempt: a new frame element in the new palette. A load of the outgoing frame is not it.
      const replacement = await frameOf(root);
      expect(replacement).not.toBe(frame);
      expect(schemeOf(replacement)).toBe("dark");
      await loaded(frame);
      expect(allowOf(root).disabled).toBe(true);
      // The replacement loads, but the only report is the earlier attempt's: from the outgoing window, and then one
      // naming the earlier attempt from the replacement's own window. Neither is the replacement's island.
      await loaded(replacement);
      await reported(replacement, { source: outgoingWindow, attempt: outgoingAttempt });
      await reported(replacement, { attempt: outgoingAttempt });
      expect(attemptOf(replacement)).not.toBe(outgoingAttempt);
      expect(allowOf(root).disabled).toBe(true);
      await reported(replacement);
      expect(allowOf(root).disabled).toBe(false);
    } finally {
      paint("none");
    }
  });

  it("a click on Allow right after a navigation commits, with no act flush between, sends nothing", async () => {
    const decide = okDoor();
    const reactEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const before = reactEnv.IS_REACT_ACT_ENVIRONMENT;
    let observer: MutationObserver | null = null;
    try {
      paint("light");
      stateMock.mockImplementation(async () => ({ ...PENDING, rows: [ITEMS] }));
      const root = await rootOf(mountOn("chat_thread", decide));
      await settle();
      await shown(await frameOf(root));
      expect(allowOf(root).disabled).toBe(false);
      // The click lands in the first microtask after React commits the navigated frame: no act() scope, no effect flush.
      let clicked = false;
      observer = new MutationObserver(() => {
        if (clicked || root.querySelector('[data-island-load-state="loading"]') === null) return;
        clicked = true;
        fireEvent.click(allowOf(root));
      });
      observer.observe(root, { subtree: true, childList: true, attributes: true });
      reactEnv.IS_REACT_ACT_ENVIRONMENT = false;
      paint("dark");
      await new Promise((r) => setTimeout(r, 20));
      expect(clicked).toBe(true);
      expect(decide).not.toHaveBeenCalled();
    } finally {
      observer?.disconnect();
      reactEnv.IS_REACT_ACT_ENVIRONMENT = before;
      paint("none");
    }
  });

  it("a palette change while the island is still loading restarts the load bound for the replacement frame", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      paint("light");
      stateMock.mockImplementation(async () => ({ ...PENDING, rows: [ITEMS] }));
      const root = await rootOf(mountOn("chat_thread", okDoor()));
      await settle();
      await frameOf(root);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      await act(async () => {
        paint("dark");
      });
      await settle();
      // Past the first frame's deadline, well inside the replacement's own.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(root.querySelector('[data-conformance-id="review-target-island-timeout"]')).toBeNull();
      expect(allowOf(root).disabled).toBe(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(8_000);
      });
      expect(root.querySelector('[data-conformance-id="review-target-island-timeout"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
      paint("none");
    }
  });

  it("a frame that loads but never reports stays loading, then the time limit fails it; a late report heals it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      stateMock.mockImplementation(async () => ({ ...PENDING, rows: [ITEMS] }));
      const root = await rootOf(mountOn("chat_thread", okDoor()));
      await settle();
      const frame = await frameOf(root);
      await loaded(frame);
      expect(allowOf(root).disabled).toBe(true);
      expect(root.querySelector('[data-island-load-state="loading"]')).not.toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(13_000);
      });
      expect(root.querySelector('[data-conformance-id="review-target-island-timeout"]')).not.toBeNull();
      expect(waitLine(root)?.getAttribute("data-conformance-id")).toBe("publish-allow-waits-failed");
      expect(allowOf(root).disabled).toBe(true);
      await reported(frame);
      expect(root.querySelector('[data-conformance-id="review-target-island-timeout"]')).toBeNull();
      expect(allowOf(root).disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a report from another window or another origin is not the island's", async () => {
    stateMock.mockImplementation(async () => ({ ...PENDING, rows: [ITEMS] }));
    const root = await rootOf(mountOn("chat_thread", okDoor()));
    await settle();
    const frame = await frameOf(root);
    await loaded(frame);
    const sibling = document.createElement("iframe");
    document.body.appendChild(sibling);
    try {
      await reported(frame, { source: window });
      await reported(frame, { source: sibling.contentWindow });
      await reported(frame, { source: null });
      await reported(frame, { origin: "https://elsewhere.example" });
      expect(allowOf(root).disabled).toBe(true);
      await reported(frame);
      expect(allowOf(root).disabled).toBe(false);
    } finally {
      sibling.remove();
    }
  });

  it("a height report, an island that is ready with no panel, and a panel before ready never count", async () => {
    stateMock.mockImplementation(async () => ({ ...PENDING, rows: [ITEMS] }));
    const root = await rootOf(mountOn("chat_thread", okDoor()));
    await settle();
    const frame = await frameOf(root);
    await loaded(frame);
    const attempt = attemptOf(frame);
    // A panel report before the island said it is ready, the height report (zero and real), and an empty body.
    await post(frame, progress("panel-mounted", attempt));
    await post(frame, { type: "cinatra.review-island.height", height: 0 });
    await post(frame, { type: "cinatra.review-island.height", height: 480 });
    await post(frame, {});
    await post(frame, { ...progress("panel-mounted", attempt), extra: true });
    expect(allowOf(root).disabled).toBe(true);
    // Ready alone is an island with no panel drawn yet.
    await post(frame, progress("island-ready", attempt));
    expect(allowOf(root).disabled).toBe(true);
    await post(frame, progress("panel-mounted", attempt));
    expect(allowOf(root).disabled).toBe(false);
  });

  it("the report and the load are both needed, in either order, for every items row", async () => {
    stateMock.mockImplementation(async () => ({ ...PENDING, rows: [ITEMS, { ...ITEMS, label: "Proposed post" }] }));
    const root = await rootOf(mountOn("chat_thread", okDoor()));
    await settle();
    await waitFor(() => expect(root.querySelectorAll("iframe").length).toBe(2));
    const [first, second] = Array.from(root.querySelectorAll("iframe"));
    // The first row's island reports before its frame's load event: the report alone is not enough.
    await reported(first);
    expect(allowOf(root).disabled).toBe(true);
    await loaded(first);
    expect(root.querySelectorAll('[data-island-load-state="loaded"]').length).toBe(1);
    // The second row loads with no report: one row shown is not every row.
    await loaded(second);
    expect(allowOf(root).disabled).toBe(true);
    expect(root.querySelector('[data-conformance-id="publish-card-items-shown"]')).toBeNull();
    await reported(second);
    expect(allowOf(root).disabled).toBe(false);
    expect(root.querySelector('[data-conformance-id="publish-card-items-shown"]')).not.toBeNull();
  });
});
