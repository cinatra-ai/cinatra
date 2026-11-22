// @vitest-environment jsdom
// The publish card (cinatra#4150 part 7a-1b): design 635da007, specs/app-lifecycle-cards.html XV and IV.1.
// Red first: at the base the module under test does not exist, so this file fails at its import.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import type { LifecycleCardHost } from "@cinatra-ai/agent-ui-protocol/renderable-views";

const stateMock = vi.fn();
vi.mock("../publish-decision-card-actions", () => ({
  getPublishDecisionCardStateAction: (input: { runId: string }) => stateMock(input),
}));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { PublishDecisionCard, type PublishDecisionDecide } from "../publish-decision-card-view";

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
      expect(root.textContent).toContain("Publish this?");
      expect(root.textContent).toContain("Blog publisher \u00b7 nothing has been published");
      const labels = Array.from(root.querySelectorAll("dt")).map((el) => el.textContent);
      const values = Array.from(root.querySelectorAll("dd")).map((el) => el.textContent);
      expect(labels).toEqual(["Title", "Site"]);
      expect(values).toEqual(["Spring launch", "Company blog"]);
      expect(root.querySelector("textarea")).not.toBeNull();
      expect(root.textContent).toContain("recorded with Do not publish");
      const decline = root.querySelector<HTMLButtonElement>('[data-action="decline-publish -> declined"]');
      const approve = root.querySelector<HTMLButtonElement>('[data-action="approve-publish -> released"]');
      expect(decline?.textContent).toBe("Do not publish");
      expect(approve?.textContent).toBe("Publish");
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
    expect(root.textContent).toContain("needs approve access on the run");
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
    [APPROVED, "publish-card-approved", "Publish approved", "Approved by Dana Okafor. The run goes on to the agent's own publishing step."],
    [DECLINED, "publish-card-declined", "Not published", "Declined by Dana Okafor. The run ended, and nothing was published. Reason: \u201cNot ready yet.\u201d"],
    [{ ...DECLINED, reason: null, deciderName: null }, "publish-card-declined", "Not published", "Declined. The run ended, and nothing was published."],
    [EXPIRED, "publish-card-expired", "Expired", "No one decided before this request expired. The run ended, and nothing was published."],
  ])("a settled card keeps its rows, drops the controls and the note, and draws its marker (%#)", async (answer, id, label, line) => {
    stateMock.mockImplementation(async () => answer);
    const root = await rootOf(mountOn("page_gate_region", okDoor()));
    await settle();
    expect(root.getAttribute("data-lifecycle-card-state")).toBe(answer.state);
    expect(root.querySelectorAll("dd")).toHaveLength(2);
    expect(root.querySelector("button")).toBeNull();
    expect(root.querySelector("textarea")).toBeNull();
    expect(root.textContent).not.toContain("nothing has been published");
    const marker = root.querySelector(`[data-conformance-id="${id}"]`);
    expect(marker?.querySelector('[data-slot="status-pill"]')?.textContent).toContain(label);
    expect(marker?.textContent).toContain(line);
    if (answer.state === "expired") expect(marker?.textContent).not.toContain(" by ");
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

describe("the decide door", () => {
  it("Publish sends approve with no note, Do not publish sends the written note, and the card re-reads", async () => {
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
    expect(closed.textContent).toContain("This publish request is no longer open");
    expect(closed.querySelector(APPROVE)).toBeNull();
    expect(closed.querySelector('[data-conformance-id="publish-state-no-longer-open"]')?.textContent).toContain(
      "This publish request is no longer open",
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
