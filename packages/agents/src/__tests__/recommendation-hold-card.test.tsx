// @vitest-environment jsdom
/**
 * `RecommendationHoldCard` — the ONE card for `recommendation_hold`, and the
 * proof that the 4-second poll is gone (cinatra#2568 AC-1 + AC-5, epic #2564).
 *
 * WHAT #2568 ORDERED, AND WHAT THIS PINS. The issue's deliverable put the poll
 * retirement LAST — "the 4s poll is retired LAST, after replay + routing exist"
 * — and its AC-1 ends with "the poll code path is deleted", AC-5 with "the
 * interaction renders via the one-card registry (no parallel chip-row mount
 * remains)". Both landed together, because they are the same change: the row
 * stops being a hand-rolled interval beside the panel and becomes a card whose
 * only inputs are the wire, the reader's focus and its own decision.
 *
 * The suite locks five things:
 *
 *   1. NO STEADY-STATE TIMER. After a SUCCESSFUL resolve, twenty seconds of fake
 *      time produce no second read. The old code would have issued five.
 *   2. THE WIRE IS THE TRIGGER. A change in the typed hold interrupt's ref — an
 *      announcement, and its paired RESUME nulling it — re-reads the authority.
 *      That is what makes a re-parked run visible without a poll.
 *   3. A FAILED RESOLVE IS RETRIED, BOUNDED. The one case the wire cannot
 *      recover on its own — a hold announcement whose resolve 500s on a tab that
 *      stays visible, focused and online — heals without user interaction, and a
 *      backend that is genuinely down is asked four times and then left alone.
 *      (Codex round 2 found exactly this scenario; these tests are its answer.)
 *   4. FAIL-CLOSED HOST GATING. With no `LifecycleCardSurfaceProvider` there is
 *      no host, so there is no card DOM and no resolve at all.
 *   5. THE ROW ITSELF IS UNCHANGED. The card composes the shipped
 *      `RunRecommendationChipRow`; the held/confirmed/skipped drawings are the
 *      ones that already shipped.
 *   6. THE HOST DECLARATION SELECTS THE TRANSPORT, AND ONLY THE TRANSPORT
 *      (cinatra#2790). A credential-declaring host draws the same row, reads it
 *      through the broker and decides it through the broker, carrying its own
 *      proof and omitting cookies on every single call; a cookie host is
 *      byte-for-byte what it was and never touches either broker path.
 *
 * Plus source assertions that no second chip-row mount and no repeating timer
 * survived on the hosts the riders touched — the "no parallel mount" half of
 * AC-5 is a structural claim, so it is checked structurally.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/recommendation-hold-card.test.tsx
 */
import React from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

import {
  LIFECYCLE_RECOMMENDATION_DECIDE_PATH,
  LIFECYCLE_RECOMMENDATION_HOLD_PATH,
} from "../lifecycle-card-runtime";

vi.mock("lucide-react", () => {
  const StubIcon: React.FC = () => null;
  return new Proxy({} as Record<string, React.FC>, {
    get: (_target, prop) => {
      if (prop === "__esModule") return true;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      return StubIcon;
    },
    has: () => true,
    ownKeys: () => ["Check", "ChevronDown", "default"],
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
});

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: routerRefresh }),
}));

type HoldState =
  | { state: "none" }
  | {
      state: "held";
      agentPackageName: string;
      promptText: string;
      recommendations: {
        skillId: string;
        skillRevisionId: string;
        recommended: boolean;
        name?: string;
      }[];
      holdRef: string;
      canDecide?: boolean;
    }
  | { state: "confirmed"; skillNames: string[]; decided?: DecidedSkill[] }
  | { state: "skipped"; decided?: DecidedSkill[] };

type DecidedSkill = {
  skillId: string;
  /** §V's chips print the NAME, settled and held alike (cinatra#2841). */
  name: string;
  mark: "confirmed" | "adjusted" | "skipped";
};

const holdStateMock = vi.fn(async (input: { runId: string }): Promise<HoldState> => {
  void input;
  return { state: "none" };
});
// Takes the confirm PAYLOAD so the suite can read it back: cinatra#2841's
// per-chip adjusted set rides that payload, and a mock that swallowed it could
// not tell a durable adjustment from a plain confirm.
const confirmMock = vi.fn(async (input?: unknown) => {
  void input;
  return { ok: true, dispatched: true };
});
const skipMock = vi.fn(async () => ({ ok: true, dispatched: true }));

vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: (input: { runId: string }) => holdStateMock(input),
  // The ARGUMENTS are forwarded (cinatra#2841): the reader's per-chip adjust
  // decisions ride the confirm payload, so a suite that swallowed them could not
  // tell a durable adjustment from a plain confirm.
  confirmRunRecommendationAction: (input: unknown) => confirmMock(input),
  skipRunRecommendationAction: () => skipMock(),
}));

// The chip-row fetches candidates from `./server-actions` when they are not
// prefetched. That module's graph is server-only; the row's own behaviour is not
// under test here (it shipped with cinatra#2067), so the one function the row
// calls is stubbed.
vi.mock("../server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

beforeEach(() => {
  holdStateMock.mockImplementation(async () => ({ state: "none" }));
});

const HELD: HoldState = {
  state: "held",
  agentPackageName: "@cinatra-test/hold-fixture-agent",
  promptText: "{}",
  recommendations: [
    { skillId: "skill-a", skillRevisionId: "rev-a", recommended: true, name: "Skill A" },
  ],
  holdRef: "hold-ref-1",
};

async function mountCard(props: {
  wireRef?: string | null;
  host?: "run_card" | "chat_thread" | "site_widget" | "page_gate_region" | null;
  /** The host's credential declaration, when it has one (cinatra#2577). */
  auth?: { headers: () => Record<string, string>; credentials: RequestCredentials };
}) {
  const { RecommendationHoldCard } = await import("../run-recommendation-chip-row");
  const { LifecycleCardSurfaceProvider } = await import("../lifecycle-card-runtime");
  const card = (
    <RecommendationHoldCard
      runId="run-2568"
      agentPackageName="@cinatra-test/hold-fixture-agent"
      wireRef={props.wireRef ?? null}
    />
  );
  const host = props.host === undefined ? "run_card" : props.host;
  return render(
    host === null ? (
      card
    ) : (
      <LifecycleCardSurfaceProvider host={host} auth={props.auth}>
        {card}
      </LifecycleCardSurfaceProvider>
    ),
  );
}

/**
 * THE BROKER TRANSPORT, ANSWERED AS THE SHIPPED ROUTES ANSWER IT
 * (cinatra#2790, epic #2784 S9f).
 *
 * WHY A STUB AT ALL, AND WHY A FAITHFUL ONE. The card's two transports are
 * chosen by the host's own declaration: a cookie host calls the server actions
 * this suite already mocks, and a credential-declaring host POSTs to the two
 * broker routes. jsdom has no origin a relative URL can resolve against, so an
 * unstubbed run of the second transport THROWS inside the card's own catch and
 * draws nothing — silence that reads exactly like a refusal. A suite that does
 * not answer these two paths therefore cannot tell "the widget is fail-closed"
 * from "the widget was never asked", which is precisely how the absence pin
 * this file used to carry survived the slice that deleted its subject.
 *
 * So the stub answers what the routes answer, and nothing more generous:
 *   - the READ returns the `RunRecommendationHoldState` itself
 *     (`/api/lifecycle-views/recommendation-hold` → `Response.json(state)`);
 *   - the DECISION returns `{ outcome }` wrapping the core's own result.
 *
 * AN UNEXPECTED PATH IS A FAILURE, NEVER A NULL. A request this stub does not
 * recognise rejects, so a card that starts calling somewhere else is caught here
 * instead of quietly drawing nothing.
 */
function installBrokerStub(
  options: {
    hold?: () => HoldState;
    decide?: (body: Record<string, unknown>) => unknown;
  } = {},
) {
  type Recorded = {
    url: string;
    init: RequestInit;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  };
  const calls: Recorded[] = [];
  const answer = (payload: unknown) =>
    ({ ok: true, json: async () => payload }) as unknown as Response;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const i = init ?? {};
    const body = (() => {
      try {
        return JSON.parse(String(i.body ?? "{}")) as Record<string, unknown>;
      } catch {
        return {} as Record<string, unknown>;
      }
    })();
    const headers = (i.headers ?? {}) as Record<string, string>;
    calls.push({ url, init: i, headers, body });
    // THE ROUTE CONTRACT, ENFORCED BY THE STUB (and not only by the assertions
    // that happen to be written beside each arm). Both routes are POST-only and
    // both 401 a request with no widget proof — there is no session fallback to
    // fall back TO — so a stub that answered a GET, or answered a request that
    // carried no proof, would let a transport that dropped its credential pass
    // for the wrong reason. That is the failure mode this whole change exists to
    // remove, so it is refused HERE, once, for every arm.
    if (i.method !== "POST") {
      throw new Error(`the card used ${String(i.method)} on a POST-only route: ${url}`);
    }
    if (!headers["X-Cinatra-Widget-User-Token"]) {
      throw new Error(`the card reached ${url} with no widget proof — the route answers 401`);
    }
    if (url === LIFECYCLE_RECOMMENDATION_HOLD_PATH) {
      return answer(options.hold ? options.hold() : { state: "none" });
    }
    if (url === LIFECYCLE_RECOMMENDATION_DECIDE_PATH) {
      return answer({
        outcome: options.decide ? options.decide(body) : { ok: true, dispatched: true },
      });
    }
    throw new Error(`the card requested an unstubbed path: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    calls,
    callsTo: (path: string) => calls.filter((c) => c.url === path),
    restore: () => vi.unstubAllGlobals(),
  };
}

/** The widget's declaration: its own proof, and cookies OMITTED. */
const WIDGET_DECLARATION = {
  headers: () => ({ "X-Cinatra-Widget-User-Token": "cwu_x" }),
  credentials: "omit" as RequestCredentials,
};

describe("RecommendationHoldCard — the poll is gone (cinatra#2568 AC-1)", () => {
  it("resolves ONCE and never again on a timer — 20 seconds produce no second read", async () => {
    holdStateMock.mockImplementation(async () => HELD);
    vi.useFakeTimers({ shouldAdvanceTime: true });

    await mountCard({ wireRef: "hold-ref-1" });
    await waitFor(() =>
      expect(document.querySelector("[data-run-recommendation-chip-row]")).not.toBeNull(),
    );
    const afterMount = holdStateMock.mock.calls.length;

    // Five old poll intervals' worth of time.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });

    expect(holdStateMock.mock.calls.length).toBe(afterMount);
  });

  it("re-reads the authority when the typed hold interrupt's ref changes", async () => {
    holdStateMock.mockImplementation(async () => HELD);
    const { rerender } = await mountCard({ wireRef: null });
    await waitFor(() => expect(holdStateMock).toHaveBeenCalled());
    const afterMount = holdStateMock.mock.calls.length;

    const { RecommendationHoldCard } = await import("../run-recommendation-chip-row");
    const { LifecycleCardSurfaceProvider } = await import("../lifecycle-card-runtime");
    rerender(
      <LifecycleCardSurfaceProvider host="run_card">
        <RecommendationHoldCard
          runId="run-2568"
          agentPackageName="@cinatra-test/hold-fixture-agent"
          wireRef="hold-ref-1"
        />
      </LifecycleCardSurfaceProvider>,
    );

    await waitFor(() =>
      expect(holdStateMock.mock.calls.length).toBeGreaterThan(afterMount),
    );
  });

  it("re-reads when the RESUME retires the hold (the ref goes back to null)", async () => {
    holdStateMock.mockImplementation(async () => HELD);
    const { rerender } = await mountCard({ wireRef: "hold-ref-1" });
    await waitFor(() =>
      expect(document.querySelector("[data-run-recommendation-chip-row]")).not.toBeNull(),
    );
    const afterMount = holdStateMock.mock.calls.length;

    holdStateMock.mockImplementation(async () => ({
      state: "confirmed",
      skillNames: ["Skill A"],
    }));
    const { RecommendationHoldCard } = await import("../run-recommendation-chip-row");
    const { LifecycleCardSurfaceProvider } = await import("../lifecycle-card-runtime");
    rerender(
      <LifecycleCardSurfaceProvider host="run_card">
        <RecommendationHoldCard
          runId="run-2568"
          agentPackageName="@cinatra-test/hold-fixture-agent"
          wireRef={null}
        />
      </LifecycleCardSurfaceProvider>,
    );

    await waitFor(() =>
      expect(holdStateMock.mock.calls.length).toBeGreaterThan(afterMount),
    );
    await waitFor(() =>
      expect(
        document.querySelector('[data-run-recommendation-decision="confirmed"]'),
      ).not.toBeNull(),
    );
  });
});

describe("RecommendationHoldCard — a failed resolve is retried, a successful one is not", () => {
  it("recovers a transiently-failed wire resolve with NO user interaction (codex round 2)", async () => {
    // The exact blocking scenario: the card has authoritatively resolved
    // `none`, a hold is created, its ref lands, THAT resolve 500s, the stream
    // stays healthy and says nothing more, and the reader never leaves the tab.
    // Without the failure budget the run sits parked behind a card that draws
    // nothing, forever.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    holdStateMock.mockImplementation(async () => ({ state: "none" }));
    const { rerender } = await mountCard({ wireRef: null });
    await waitFor(() => expect(holdStateMock).toHaveBeenCalled());

    holdStateMock.mockImplementationOnce(async () => {
      throw new Error("500");
    });
    holdStateMock.mockImplementation(async () => HELD);

    const { RecommendationHoldCard } = await import("../run-recommendation-chip-row");
    const { LifecycleCardSurfaceProvider } = await import("../lifecycle-card-runtime");
    rerender(
      <LifecycleCardSurfaceProvider host="run_card">
        <RecommendationHoldCard
          runId="run-2568"
          agentPackageName="@cinatra-test/hold-fixture-agent"
          wireRef="hold-ref-1"
        />
      </LifecycleCardSurfaceProvider>,
    );

    // No focus, no visibility change, no connectivity event — only time.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await waitFor(() =>
      expect(document.querySelector("[data-run-recommendation-chip-row]")).not.toBeNull(),
    );
  });

  it("recovers the mirror case: a failed RESUME resolve stops showing a decided row as pending", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    holdStateMock.mockImplementation(async () => HELD);
    const { rerender } = await mountCard({ wireRef: "hold-ref-1" });
    await waitFor(() =>
      expect(document.querySelector("[data-run-recommendation-chip-row]")).not.toBeNull(),
    );

    holdStateMock.mockImplementationOnce(async () => {
      throw new Error("500");
    });
    holdStateMock.mockImplementation(async () => ({
      state: "confirmed",
      skillNames: ["Skill A"],
    }));

    const { RecommendationHoldCard } = await import("../run-recommendation-chip-row");
    const { LifecycleCardSurfaceProvider } = await import("../lifecycle-card-runtime");
    rerender(
      <LifecycleCardSurfaceProvider host="run_card">
        <RecommendationHoldCard
          runId="run-2568"
          agentPackageName="@cinatra-test/hold-fixture-agent"
          wireRef={null}
        />
      </LifecycleCardSurfaceProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await waitFor(() =>
      expect(
        document.querySelector('[data-run-recommendation-decision="confirmed"]'),
      ).not.toBeNull(),
    );
  });

  it("stops after a BOUNDED number of failures — a down backend is not hammered", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    holdStateMock.mockImplementation(async () => {
      throw new Error("down");
    });
    await mountCard({ wireRef: "hold-ref-1" });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    // One initial attempt + the three-step failure budget, then silence — never
    // the unbounded 4-second re-ask this replaced (which would be ~30 calls).
    expect(holdStateMock.mock.calls.length).toBe(4);
  });
});

describe("RecommendationHoldCard — a failed resolve is recovered by events, not by a timer", () => {
  it("draws nothing when the FIRST resolve fails, then recovers on focus", async () => {
    holdStateMock.mockImplementationOnce(async () => {
      throw new Error("offline");
    });
    holdStateMock.mockImplementation(async () => HELD);

    const { container } = await mountCard({ wireRef: "hold-ref-1" });
    await waitFor(() => expect(holdStateMock).toHaveBeenCalled());
    // A failed resolve is never turned into a state — silent, never optimistic.
    expect(container.innerHTML).toBe("");

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() =>
      expect(document.querySelector("[data-run-recommendation-chip-row]")).not.toBeNull(),
    );
  });

  it("recovers on `online` — the dominant cause of a swallowed resolve", async () => {
    holdStateMock.mockImplementationOnce(async () => {
      throw new Error("offline");
    });
    holdStateMock.mockImplementation(async () => HELD);

    await mountCard({ wireRef: "hold-ref-1" });
    await waitFor(() => expect(holdStateMock).toHaveBeenCalled());

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() =>
      expect(document.querySelector("[data-run-recommendation-chip-row]")).not.toBeNull(),
    );
  });

  it("does not re-resolve for a visibilitychange that HIDES the tab", async () => {
    holdStateMock.mockImplementation(async () => HELD);
    await mountCard({ wireRef: "hold-ref-1" });
    await waitFor(() => expect(holdStateMock).toHaveBeenCalled());
    const afterMount = holdStateMock.mock.calls.length;

    const spy = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(holdStateMock.mock.calls.length).toBe(afterMount);

    spy.mockReturnValue("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() =>
      expect(holdStateMock.mock.calls.length).toBeGreaterThan(afterMount),
    );
    spy.mockRestore();
  });
});

describe("RecommendationHoldCard — host gating and the drawn states (AC-5)", () => {
  it("renders NO DOM and issues NO resolve without a declared host", async () => {
    holdStateMock.mockImplementation(async () => HELD);
    const { container } = await mountCard({ wireRef: "hold-ref-1", host: null });
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.innerHTML).toBe("");
    expect(holdStateMock).not.toHaveBeenCalled();
  });

  // THE PRESENCE PIN, FLIPPED FROM AN ABSENCE PIN (cinatra#2790, epic #2784 S9f).
  //
  // WHAT STOOD HERE. Until the broker entry landed, this arm pinned the exact
  // opposite — "draws nothing on a host that declares a CREDENTIAL" — because
  // the card's state read and its two decisions were cookie-bound server
  // actions, and on a frame that is same-origin to the app a drawn card would
  // have read and acted as whoever else was signed in on that browser. The
  // guard keyed on the CREDENTIAL rather than on the surface, and its own
  // comment named the condition for deleting it: the broker-aware entry.
  //
  // WHY FLIPPING IT IS THE WORK, NOT A FORMALITY. The entry landed and the guard
  // went with it — but the pin stayed, and it kept passing for a reason with
  // nothing to do with the product: jsdom cannot fetch a relative URL, so the
  // broker transport threw, the card drew nothing, and the absence assertion
  // read that silence as a refusal. It therefore asserted the ratified §IX
  // parity was NOT met while the tree met it, and it would have stayed green
  // with the whole broker read deleted. Stubbed faithfully — the shipped route
  // answers a held run with the state itself — the old arm fails against the
  // shipped card. That failure is what this pin replaces.
  it("DRAWS on a host that declares a CREDENTIAL — read through the broker, never a session", async () => {
    const broker = installBrokerStub({ hold: () => HELD });
    try {
      holdStateMock.mockImplementation(async () => HELD);
      const { container } = await mountCard({
        wireRef: "hold-ref-1",
        host: "site_widget",
        auth: {
          headers: () => ({ "X-Cinatra-Widget-User-Token": "cwu_x" }),
          credentials: "omit",
        },
      });

      // IT DRAWS — the whole §V row, on the host that declared itself.
      const root = await waitFor(() => {
        const found = container.querySelector("[data-run-recommendation-chip-row]");
        if (!found) throw new Error("the credential-declaring host drew no card");
        return found;
      });
      expect(root.getAttribute("data-lifecycle-card")).toBe("recommendation_hold");
      expect(root.getAttribute("data-lifecycle-card-host")).toBe("site_widget");
      expect(root.getAttribute("data-lifecycle-card-state")).toBe("held");
      expect(root.querySelector('[data-skill-action="confirm"]')).not.toBeNull();
      expect(root.querySelector('[data-skill-action="adjust"]')).not.toBeNull();
      expect(root.querySelector('[data-skill-action="skip"]')).not.toBeNull();

      // …AND THE OUTGOING REQUEST IS ASSERTED BESIDE IT, which is what stops
      // this pin from becoming the mirror of the one it replaces: a card that
      // drew from an ambient session would satisfy every line above.
      const reads = broker.callsTo(LIFECYCLE_RECOMMENDATION_HOLD_PATH);
      expect(reads.length).toBeGreaterThan(0);
      expect(reads[0].init.method).toBe("POST");
      expect(reads[0].headers["X-Cinatra-Widget-User-Token"]).toBe("cwu_x");
      expect(reads[0].init.credentials).toBe("omit");
      expect(reads[0].body).toEqual({ runId: "run-2568" });

      // The cookie-bound reader was never asked. On this host there is no
      // session to fall back to, and the point of the slice is that there is no
      // fallback to fall back TO.
      expect(holdStateMock).not.toHaveBeenCalled();
    } finally {
      broker.restore();
    }
  });

  it("draws IDENTICALLY on page_gate_region and chat_thread — the per-surface matrix is gone", async () => {
    // The removed rule said "a widget visitor never shapes a run's skills", and
    // it made this kind FALSE on `site_widget` in a presence table. The table is
    // gone: what a host draws is no longer a property of which host it is. The
    // widget's own remaining gate is the credential guard above, not a matrix.
    holdStateMock.mockImplementation(async () => HELD);
    const widget = await mountCard({ wireRef: "hold-ref-1", host: "page_gate_region" });
    await act(async () => {
      await Promise.resolve();
    });
    expect(holdStateMock).toHaveBeenCalled();
    // React mints a fresh `useId` per mount, so the two renders differ in their
    // generated ARIA ids. Normalising them is what makes "the same drawing" a
    // byte comparison instead of a spot check.
    //
    // The card root also carries `data-lifecycle-card-host`, which by
    // definition differs per host — it is the mount's IDENTITY, required on the
    // §V root so each authorized mount is labelled with the host it actually
    // declared (cinatra#2841; `ReviewGateCard` has emitted it per host since it
    // shipped). That is not the thing this pin guards. The guarantee here is
    // that what a host DRAWS — its content, its affordances, its state — is not
    // a property of which host it is, so the label is normalised and everything
    // else still compares byte for byte, including all three chip actions.
    const stripGeneratedIds = (html: string) =>
      html
        .replaceAll(/radix-_r_[0-9a-z]+_/g, "radix-_r_ID_")
        .replaceAll(/data-lifecycle-card-host="[a-z_]+"/g, 'data-lifecycle-card-host="HOST"')
        // The chat host also stamps its own evidence marker on the same root —
        // again an identity, not a drawing. Normalised for the same reason, and
        // asserted explicitly below so its presence is still pinned.
        .replaceAll(/ ?data-chat-thread-recommendation-hold=""/g, "");
    const widgetHtml = stripGeneratedIds(widget.container.innerHTML);
    expect(widgetHtml).not.toBe("");
    // REDRAWN (cinatra#2841): the decision affordances are PER CHIP now — the
    // row-level pair this used to name does not exist on any host.
    expect(widgetHtml).toContain('data-action="confirm-skill -> confirmed"');
    expect(widgetHtml).toContain('data-action="adjust-skill -> adjusted"');
    expect(widgetHtml).toContain('data-action="skip-skill -> skipped"');
    expect(widgetHtml).not.toContain("confirm-run-recommendation");
    expect(widgetHtml).not.toContain("skip-run-recommendation");
    // The label is normalised above, so assert it is REALLY there and really
    // host-correct on each mount — otherwise the normalisation could hide a
    // missing or wrong identity.
    expect(widget.container.querySelector('[data-lifecycle-card="recommendation_hold"]')
      ?.getAttribute("data-lifecycle-card-host")).toBe("page_gate_region");

    cleanup();
    holdStateMock.mockClear();
    const chat = await mountCard({ wireRef: "hold-ref-1", host: "chat_thread" });
    await act(async () => {
      await Promise.resolve();
    });
    expect(chat.container.querySelector('[data-lifecycle-card="recommendation_hold"]')
      ?.getAttribute("data-lifecycle-card-host")).toBe("chat_thread");
    // The chat mount's evidence marker rides that same root, and no other host
    // carries it.
    expect(chat.container.querySelector("[data-chat-thread-recommendation-hold]")).not.toBeNull();
    expect(widget.container.querySelector("[data-chat-thread-recommendation-hold]")).toBeNull();
    expect(stripGeneratedIds(chat.container.innerHTML)).toBe(widgetHtml);
  });

  it("draws nothing before the first authorized resolve answers", async () => {
    let release: (value: HoldState) => void = () => undefined;
    holdStateMock.mockImplementation(
      () => new Promise<HoldState>((resolve) => (release = resolve)),
    );
    const { container } = await mountCard({ wireRef: "hold-ref-1" });
    expect(container.innerHTML).toBe("");
    await act(async () => {
      release(HELD);
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(document.querySelector("[data-run-recommendation-chip-row]")).not.toBeNull(),
    );
  });

  it("draws the redrawn chip-row for a held run and the settled row for a decided one", async () => {
    // The old assertion named the heading plate ("Confirm the skills for this
    // run"). That heading is not drawn any more (§V: "the row is the whole
    // card"), so the assertion is replaced by the thing that IS drawn — a chip
    // carrying its own three affordances — rather than deleted.
    holdStateMock.mockImplementation(async () => HELD);
    const { unmount } = await mountCard({ wireRef: "hold-ref-1" });
    await waitFor(() =>
      expect(document.querySelectorAll("[data-recommendation-chip]")).toHaveLength(1),
    );
    expect(screen.queryByText(/confirm the skills for this run/i)).toBeNull();
    unmount();
    cleanup();

    holdStateMock.mockImplementation(async () => ({
      state: "skipped",
      decided: [{ skillId: "skill-a", name: "Skill A", mark: "skipped" }],
    }));
    await mountCard({ wireRef: null });
    await waitFor(() =>
      expect(
        document.querySelector('[data-run-recommendation-decision="skipped"]'),
      ).not.toBeNull(),
    );
    expect(
      document.querySelector('[data-recommendation-chip][data-chip-mark="skipped"]'),
    ).not.toBeNull();
  });

  // The RUNTIME instance contract for this kind on its declared host, asserted
  // on real DOM rather than on source text: ONE row draws, and it carries the
  // decision affordances the ratified set names. The count is the point —
  // a second adapter drawing beside this one would make it two.
  // The affordances named here are the REDRAWN per-chip set (cinatra#2841), the
  // set scripts/audit/chat-hitl-anchor-contract.json ratifies for this owner.
  // The row-level confirm/skip pair this assertion used to name is not emitted
  // on any host any more, so asserting it would test a retired drawing.
  it("hosts run_card and chat_thread each draw EXACTLY ONE chip row, carrying the ratified decisions", async () => {
    // BOTH production mounts are driven here, and the hosts are named as
    // LITERALS, one per line, because this test IS the record of which hosts
    // were actually driven (the S9e shape, review-gate-card.test.tsx).
    //
    // `chat_thread` joined this list when cinatra#2786 (S9b) landed the
    // assistant-dispatch-turn mount and the one-card gate enumerated it: a host
    // with a production adapter and no COUNTED instance proof is a host where a
    // second renderer could arrive unseen, which is the whole failure the
    // one-card rule exists to prevent.
    for (const host of ["run_card", "chat_thread"] as const) {
      holdStateMock.mockImplementation(async () => HELD);
      const { container, unmount } = await mountCard({ wireRef: "hold-ref-1", host });
      await waitFor(() =>
        expect(container.querySelector("[data-run-recommendation-chip-row]")).not.toBeNull(),
      );
      // EXACTLY ONE instance on this host. A second adapter drawing beside this
      // one is only ever visible as a COUNT on rendered DOM — a presence check
      // cannot see a duplicate.
      expect(container.querySelectorAll("[data-run-recommendation-chip-row]")).toHaveLength(1);
      expect(
        container.querySelectorAll('[data-lifecycle-card="recommendation_hold"]'),
      ).toHaveLength(1);
      const root = container.querySelector("[data-run-recommendation-chip-row]")!;
      // The card's IDENTITY, read off the root it mounted rather than assumed. The
      // owner emits these since cinatra#2841 closed the root-identity obligation,
      // so the instance proof can now name which card, on which host, in which
      // state it photographed — the thing the recorded obligation said it could not.
      expect(container.querySelector('[data-lifecycle-card="recommendation_hold"]')).not.toBeNull();
      expect(container.querySelector('[data-conformance-id="run-chip-row"]')).not.toBeNull();
      // The host is read back off the root, so this asserts the mount DECLARED
      // the host being driven rather than a constant the test supplied.
      expect(root.getAttribute("data-lifecycle-card-host")).toBe(host);
      expect(root.getAttribute("data-lifecycle-card-state")).toBe("held");
      expect(root.querySelector('[data-skill-action="confirm"]')).not.toBeNull();
      expect(root.querySelector('[data-skill-action="adjust"]')).not.toBeNull();
      expect(root.querySelector('[data-skill-action="skip"]')).not.toBeNull();
      // Every value above came from the VALIDATED hold state, not from a literal:
      // drop the skills the state carried and the row draws nothing to press.
      expect(root.textContent).toContain("Skill A");
      unmount();
      cleanup();
    }
  });

  // THE RUNTIME INSTANCE CONTRACT ON EVERY HOST THAT ENUMERATES A PRODUCTION
  // ADAPTER (cinatra#2790, epic #2784 S9f). The run card was the only such host
  // until this slice; the widget conversation column and the review page's gate
  // region are the two it added, and S9b (cinatra#2794) added the chat thread —
  // so the count that makes "one rendered instance per kind x host" true has to
  // be taken on ALL FOUR rather than on one and generalized to the rest. This
  // list is what the one-card gate's R8 reads back as the kind's instance
  // proof, so a host that gains an adapter and is not driven here is a
  // violation rather than a silent gap.
  //
  // THE WIDGET HOST IS DRIVEN THROUGH ITS OWN TRANSPORT, which is the point of
  // driving it at all: a credential-declaring surface never reaches the
  // cookie-bound server action, so the run through it proves the broker read
  // paints the same single row — and the assertion that the action was NOT
  // called is what keeps that honest.
  it("every host with a production adapter draws EXACTLY ONE chip row", async () => {
    const WIDGET_AUTH = {
      headers: () => ({ "X-Cinatra-Widget-User-Token": "cwu_x" }),
      credentials: "omit" as RequestCredentials,
    };
    const brokerFetch = vi.fn(async () => ({ ok: true, json: async () => HELD }) as unknown as Response);
    vi.stubGlobal("fetch", brokerFetch);
    try {
      // The hosts are named as literals, one per line, because this test IS the
      // record of which hosts were actually driven.
      for (const host of ["run_card", "chat_thread", "site_widget", "page_gate_region"] as const) {
        const viaBroker = host === "site_widget";
        holdStateMock.mockClear();
        brokerFetch.mockClear();
        holdStateMock.mockImplementation(async () => HELD);
        const { container, unmount } = await mountCard({
          wireRef: "hold-ref-1",
          host,
          ...(viaBroker ? { auth: WIDGET_AUTH } : {}),
        });
        await waitFor(() =>
          expect(container.querySelector("[data-run-recommendation-chip-row]")).not.toBeNull(),
        );
        // EXACTLY ONE instance on this host. A second adapter drawing beside
        // this one is the failure the one-card rule exists to prevent, and it
        // is only visible as a COUNT on rendered DOM.
        expect(container.querySelectorAll("[data-run-recommendation-chip-row]")).toHaveLength(1);
        const root = container.querySelector("[data-run-recommendation-chip-row]")!;
        expect(root.getAttribute("data-lifecycle-card")).toBe("recommendation_hold");
        expect(root.getAttribute("data-lifecycle-card-host")).toBe(host);
        expect(root.getAttribute("data-lifecycle-card-state")).toBe("held");
        expect(root.querySelector('[data-skill-action="confirm"]')).not.toBeNull();
        expect(root.querySelector('[data-skill-action="adjust"]')).not.toBeNull();
        expect(root.querySelector('[data-skill-action="skip"]')).not.toBeNull();
        // …and the row really came from the transport this host declares.
        expect(brokerFetch.mock.calls.length > 0).toBe(viaBroker);
        expect(holdStateMock.mock.calls.length > 0).toBe(!viaBroker);
        unmount();
        cleanup();
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("draws nothing at all for a run that was never held", async () => {
    holdStateMock.mockImplementation(async () => ({ state: "none" }));
    const { container } = await mountCard({ wireRef: null });
    await waitFor(() => expect(holdStateMock).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });
});

// ---------------------------------------------------------------------------
// THE RATIFIED §V DRAWING (cinatra#2841)
// ---------------------------------------------------------------------------
//
// design `specs/app-lifecycle-cards.html` §V at design commit 60b27dfbb8a2:
//
//   "one chip per skill, each carrying its own Confirm, Adjust and Skip";
//   "THE ROW IS THE WHOLE CARD. There is no heading plate above it and no
//    row-level submit beneath it … A skill is settled by pressing one of ITS
//    OWN three affordances, and each chip then shows what it recorded."
//
// Both halves are asserted: what §V draws must render, and what it does NOT
// draw must be absent. The absence half is written as an EXPLICIT negative,
// because "the heading is gone" is the whole point of the redraw and a suite
// that only checks the new chips would pass with the old plate still on screen.
// The last test in the block is the negative control for those negatives.

const THREE_SKILLS = [
  { skillId: "skill-enrich", skillRevisionId: "rev-1", recommended: true, name: "Enrich contacts" },
  { skillId: "skill-draft", skillRevisionId: "rev-2", recommended: true, name: "Draft email" },
  { skillId: "skill-send", skillRevisionId: "rev-3", recommended: true, name: "Schedule send" },
];

const HELD_THREE: HoldState = {
  state: "held",
  agentPackageName: "@cinatra-test/hold-fixture-agent",
  promptText: "{}",
  recommendations: THREE_SKILLS,
  holdRef: "hold-ref-3",
  canDecide: true,
};

const chips = () => [...document.querySelectorAll("[data-recommendation-chip]")];
const chipFor = (skillId: string) =>
  document.querySelector(`[data-recommendation-chip][data-skill-id="${skillId}"]`);
const press = async (skillId: string, action: "confirm" | "adjust" | "skip") => {
  const btn = document.querySelector(
    `[data-skill-action="${action}"][data-skill-id="${skillId}"]`,
  ) as HTMLButtonElement | null;
  if (!btn) throw new Error(`no ${action} affordance on ${skillId}`);
  await act(async () => {
    btn.click();
    await Promise.resolve();
  });
};

describe("§V — one chip per skill, each with its own Confirm / Adjust / Skip", () => {
  it("draws ONE chip per offered skill, and each chip carries all three affordances", async () => {
    holdStateMock.mockImplementation(async () => HELD_THREE);
    await mountCard({ wireRef: "hold-ref-3" });
    await waitFor(() => expect(chips()).toHaveLength(3));

    for (const skill of THREE_SKILLS) {
      const chip = chipFor(skill.skillId);
      expect(chip).not.toBeNull();
      expect(chip!.textContent).toContain(skill.name);
      // Its OWN three, scoped to the chip — not three shared by the row.
      expect(chip!.querySelector('[data-skill-action="confirm"]')).not.toBeNull();
      expect(chip!.querySelector('[data-skill-action="adjust"]')).not.toBeNull();
      expect(chip!.querySelector('[data-skill-action="skip"]')).not.toBeNull();
      expect(chip!.getAttribute("data-chip-mark")).toBe("undecided");
    }
    // Three chips × three affordances, and nothing else that presses.
    expect(document.querySelectorAll("[data-skill-action]")).toHaveLength(9);
  });

  it("draws NO heading plate — nothing states the question a second time", async () => {
    holdStateMock.mockImplementation(async () => HELD_THREE);
    await mountCard({ wireRef: "hold-ref-3" });
    await waitFor(() => expect(chips()).toHaveLength(3));

    expect(screen.queryByText(/confirm the skills for this run/i)).toBeNull();
    expect(screen.queryByText(/recommended for your request/i)).toBeNull();
    expect(screen.queryByText(/adjust the selection, then confirm/i)).toBeNull();
    // …and no collapsible "Skills (n/m)" selector plate either.
    expect(screen.queryByText(/^Skills \(\d+\/\d+\)$/)).toBeNull();
  });

  it("draws NO card-level submit — nothing decides every skill at once", async () => {
    holdStateMock.mockImplementation(async () => HELD_THREE);
    const { container } = await mountCard({ wireRef: "hold-ref-3" });
    await waitFor(() => expect(chips()).toHaveLength(3));

    expect(container.querySelector('[data-action="confirm-run-recommendation"]')).toBeNull();
    expect(container.querySelector('[data-action="skip-run-recommendation"]')).toBeNull();
    // Structural form of the same claim: every button on the card belongs to a
    // chip. A row-level pair would be a button with no chip ancestor.
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      expect(b.closest("[data-recommendation-chip]")).not.toBeNull();
    }
  });

  it("records each chip's OWN mark and releases only once EVERY chip is decided", async () => {
    holdStateMock.mockImplementation(async () => HELD_THREE);
    await mountCard({ wireRef: "hold-ref-3" });
    await waitFor(() => expect(chips()).toHaveLength(3));

    await press("skill-enrich", "confirm");
    expect(chipFor("skill-enrich")!.getAttribute("data-chip-mark")).toBe("confirmed");
    // Two chips are still undecided — the run is NOT released.
    expect(confirmMock).not.toHaveBeenCalled();
    expect(skipMock).not.toHaveBeenCalled();

    await press("skill-draft", "skip");
    expect(chipFor("skill-draft")!.getAttribute("data-chip-mark")).toBe("skipped");
    expect(confirmMock).not.toHaveBeenCalled();

    await press("skill-send", "confirm");
    expect(chipFor("skill-send")!.getAttribute("data-chip-mark")).toBe("confirmed");
    // The last chip completes the row, and the whole-row release fires ONCE
    // (the named store deviation — the hold has no partial-decision record).
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(skipMock).not.toHaveBeenCalled();
  });

  it("a row whose every chip was SKIPPED releases through the skip path, not an empty confirm", async () => {
    // An empty confirmed selection writes no selection row at all, which reads
    // back as NO decision — so "the reader kept nothing" is recorded as the
    // hold's skip evidence, which is exactly what it means.
    holdStateMock.mockImplementation(async () => HELD_THREE);
    await mountCard({ wireRef: "hold-ref-3" });
    await waitFor(() => expect(chips()).toHaveLength(3));

    await press("skill-enrich", "skip");
    await press("skill-draft", "skip");
    await press("skill-send", "skip");

    await waitFor(() => expect(skipMock).toHaveBeenCalledTimes(1));
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("ADJUST opens that skill's own panel, and settling it there marks the chip adjusted", async () => {
    holdStateMock.mockImplementation(async () => HELD_THREE);
    await mountCard({ wireRef: "hold-ref-3" });
    await waitFor(() => expect(chips()).toHaveLength(3));

    await press("skill-draft", "adjust");
    // The panel is THIS skill's — it names the skill Adjust was pressed on.
    await waitFor(() =>
      expect(
        document.querySelector('[data-skill-action="adjust-keep"][data-skill-id="skill-draft"]'),
      ).not.toBeNull(),
    );
    const keep = document.querySelector(
      '[data-skill-action="adjust-keep"][data-skill-id="skill-draft"]',
    ) as HTMLButtonElement;
    await act(async () => {
      keep.click();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(chipFor("skill-draft")!.getAttribute("data-chip-mark")).toBe("adjusted"),
    );
    // Adjust decides ONE skill; the other two still hold the row open.
    expect(confirmMock).not.toHaveBeenCalled();
  });
});

describe("§V — the settled and the read-only readings", () => {
  it("SETTLED: one chip per skill, each stating what it recorded, and nothing left to press", async () => {
    holdStateMock.mockImplementation(async () => ({
      state: "confirmed",
      skillNames: ["Enrich contacts", "Draft email"],
      decided: [
        { skillId: "skill-enrich", name: "Enrich contacts", mark: "confirmed" },
        { skillId: "skill-draft", name: "Draft email", mark: "adjusted" },
        { skillId: "skill-send", name: "Schedule send", mark: "skipped" },
      ],
    }));
    const { container } = await mountCard({ wireRef: null });
    await waitFor(() => expect(chips()).toHaveLength(3));

    expect(chipFor("skill-enrich")!.getAttribute("data-chip-mark")).toBe("confirmed");
    expect(chipFor("skill-enrich")!.textContent).toContain("Confirmed");
    expect(chipFor("skill-draft")!.getAttribute("data-chip-mark")).toBe("adjusted");
    expect(chipFor("skill-draft")!.textContent).toContain("Adjusted");
    expect(chipFor("skill-send")!.getAttribute("data-chip-mark")).toBe("skipped");
    expect(chipFor("skill-send")!.textContent).toContain("Skipped");

    // "there is nothing left to press", and nothing summarised above the row.
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.querySelectorAll("[data-skill-action]")).toHaveLength(0);
    expect(screen.queryByText(/skills confirmed/i)).toBeNull();
  });

  it("READ-ONLY: every chip keeps its three affordances on screen, DISABLED, over the reason", async () => {
    holdStateMock.mockImplementation(async () => ({ ...HELD_THREE, canDecide: false }));
    const { container } = await mountCard({ wireRef: "hold-ref-3" });
    await waitFor(() => expect(chips()).toHaveLength(3));

    // Drawn, not removed — "the reader sees exactly what is being asked, and
    // that it is not theirs to answer."
    const controls = [...container.querySelectorAll("[data-skill-action]")];
    expect(controls).toHaveLength(9);
    for (const c of controls) expect((c as HTMLButtonElement).disabled).toBe(true);
    for (const chip of chips()) expect(chip.getAttribute("aria-disabled")).toBe("true");
    expect(container.querySelector("[data-run-recommendation-restricted]")?.textContent).toMatch(
      /needs run access on it/i,
    );

    // And a disabled affordance decides nothing.
    await press("skill-enrich", "confirm").catch(() => undefined);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(chipFor("skill-enrich")!.getAttribute("data-chip-mark")).toBe("undecided");
  });

  it("NEGATIVE CONTROL: the absence assertions above can fail — the same queries find what IS drawn", async () => {
    // Every negative in this block is only worth its ink if the query behind it
    // is live. Same query APIs, same DOM, asserted POSITIVELY here: a suite that
    // silently stopped matching anything would go red on this test first.
    holdStateMock.mockImplementation(async () => HELD_THREE);
    const { container } = await mountCard({ wireRef: "hold-ref-3" });
    await waitFor(() => expect(chips()).toHaveLength(3));

    // `queryByText` (used for the absent heading) does find text on this card.
    expect(screen.queryByText("Enrich contacts")).not.toBeNull();
    // `querySelector('[data-action=…]')` (used for the absent row-level submit)
    // does find an action attribute on this card.
    expect(container.querySelector('[data-action="confirm-skill -> confirmed"]')).not.toBeNull();
    // The chip count is read off the fixture, not hardcoded: a four-skill hold
    // draws four chips, so "three" is a measurement rather than a constant.
    cleanup();
    holdStateMock.mockImplementation(async () => ({
      ...HELD_THREE,
      recommendations: [
        ...THREE_SKILLS,
        { skillId: "skill-extra", skillRevisionId: "rev-4", recommended: false, name: "Log outcome" },
      ],
    }));
    await mountCard({ wireRef: "hold-ref-3" });
    await waitFor(() => expect(chips()).toHaveLength(4));
    // …and the non-recommended candidate keeps its shipped marking.
    expect(chipFor("skill-extra")!.getAttribute("data-forced")).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// Structural assertions — "the poll code path is DELETED", "no parallel mount"
// ---------------------------------------------------------------------------
//
// AC-1 and AC-5 are claims about what no longer EXISTS, so they are checked by
// reading the hosts. The repo's established pattern for exactly this is the
// review-surface conformance suite and the S2 card suite's host half.

describe("the retired poll leaves nothing behind on the hosts (AC-1 / AC-5)", () => {
  const read = (file: string) =>
    readFileSync(path.join(__dirname, "..", file), "utf8");

  it("the run panel has no interval and no direct chip-row mount", () => {
    const panel = read("agentic-run-panel.tsx");
    expect(panel).not.toMatch(/setInterval\s*\(\s*fetchState/);
    expect(panel).not.toMatch(/getRunRecommendationHoldStateAction/);
    expect(panel).not.toMatch(/<RunRecommendationChipRow/);
    // The host declaration stays, for the two kinds this panel still draws.
    expect(panel).toMatch(/host="run_card"/);
  });

  it("the run panel has no CARD mount either — one owner, one place", () => {
    // cinatra#3047. The poll went first and the card that replaced it went
    // after: this panel's copy was the run page's SECOND placement of the row —
    // beside the rail at the schedule moment, inside this panel at the HITL,
    // working and review moments — so the row now has one owner, the run page's
    // own rail step, and the panel mounts nothing for this kind.
    const panel = read("agentic-run-panel.tsx");
    expect(panel).not.toMatch(/<RecommendationHoldCard/);
    expect(panel).not.toContain("panelMountsRecommendationCard");
    expect(panel).not.toContain("recommendationCardNode");
  });

  it("the stepper's dev-preview row has no interval and no direct chip-row mount", () => {
    const stepper = read("orchestrator-stepper-panel.tsx");
    expect(stepper).not.toMatch(/setInterval\s*\(\s*fetchState/);
    expect(stepper).not.toMatch(/getRunRecommendationHoldStateAction/);
    expect(stepper).not.toMatch(/<RunRecommendationChipRow/);
    expect(stepper).toMatch(/<RecommendationHoldCard/);
  });

  it("the run-detail SCREEN has no parallel read, no prefetch and no direct chip-row mount", () => {
    // THE FOURTH RENDERER (cinatra#2573, epic #2564 D-1; found by the S7
    // acceptance lane). `instance-screens.tsx` ran its own park read, its own
    // actor-scoped candidate prefetch and its own confirmed/skipped derivation,
    // then mounted the row directly — a second implementation of the same
    // interaction on the one surface where the HELD state has no other host (a
    // held run is `pending_input`, and `AgenticRunPanel` renders only above that
    // status). All of it is deleted; what remains is the card under a declared
    // host, so this screen draws the interaction the way every other host does.
    const instanceScreens = read("instance-screens.tsx");
    expect(instanceScreens).not.toMatch(/<RunRecommendationChipRow/);
    expect(instanceScreens).not.toMatch(/getRunRecommendations\b/);
    expect(instanceScreens).not.toMatch(/resolveRecommendationCandidateSkillIds/);
    expect(instanceScreens).not.toMatch(/encodeRecommendationHoldRef/);
    expect(instanceScreens).not.toMatch(/readRunSelectedSkillRevisions/);
    expect(instanceScreens).not.toMatch(/hasRunRecommendationSkip/);
    expect(instanceScreens).not.toMatch(/setInterval/);
    // The one mount that remains is the card, under its own declared host — and
    // since cinatra#3047 it is UNGATED, because it is the only one on this page:
    // the run panel's own copy is deleted, so there is no branch on which this
    // screen must stand down.
    expect(instanceScreens).toMatch(/<RecommendationHoldCard/);
    expect(instanceScreens).toMatch(/host="run_card"/);
    expect(instanceScreens).not.toMatch(/screenHostsRecommendationCard/);
    expect(instanceScreens).toMatch(
      /const recommendationCardNode = \(\s*<LifecycleCardSurfaceProvider host="run_card">\s*<RecommendationHoldCard/,
    );
    // The park is still read, and never to DRAW the interaction. Two uses, one
    // per screen, and the import above them:
    //
    //   • the run screen withholds the Run button while a hold is live (the
    //     run's dispatchability, not a rendering of the interaction), and asks
    //     the same read whether the rail carries an entry at all
    //     (`recommendationRailEntry`, cinatra#2790);
    //   • the SETUP run page asks that same entry question for its own rail
    //     (cinatra#2970) — whether the row exists and can be opened, never what
    //     the card draws inside it.
    //
    // "Does the run carry this step" is the RAIL's question and the rail's
    // alone; the card remains the one authority on the interaction, and neither
    // screen derives a state, a candidate set or a decision from the park.
    expect([...instanceScreens.matchAll(/readRecommendationParkForRun/g)]).toHaveLength(3);
    // Each screen reads it ONCE, so a second read cannot creep back in under
    // either of them.
    const runScreen = instanceScreens.slice(
      instanceScreens.indexOf("export async function SetupScreen"),
      instanceScreens.indexOf("export async function PermissionsScreen"),
    );
    const triggerScreen = instanceScreens.slice(
      instanceScreens.indexOf("export async function TriggerScreen"),
    );
    expect([...runScreen.matchAll(/await readRecommendationParkForRun\(/g)]).toHaveLength(1);
    expect([...triggerScreen.matchAll(/await readRecommendationParkForRun\(/g)]).toHaveLength(1);
    // And what each does with it is the ENTRY predicate, not a derivation.
    expect(triggerScreen).toMatch(/recommendationRailEntry\(\{/);
    expect(triggerScreen).not.toMatch(/<RunRecommendationChipRow/);
  });

  it("the card has no repeating timer — the retired poll cannot come back through it", () => {
    const card = read("run-recommendation-chip-row.tsx");
    // The behavioural half of this invariant ("a successful resolve schedules
    // nothing") is the fake-timer test at the top of this file. This half bans
    // the primitive a poll would be rebuilt from, and counts the ones that are
    // allowed to exist. There are TWO, and neither repeats:
    //
    //   1. the bounded FAILURE budget — armed only when a resolve threw, spent
    //      after three delays, and cleared by its own effect;
    //   2. the one-shot READ DEADLINE (cinatra#2790, epic #2784 S9f) — armed once
    //      per trigger, so a request that never settles cannot leave the
    //      conversation withholding the run progress card for ever. It fires at
    //      most once and is cleared with the effect that armed it.
    //
    // `setInterval` could express neither, which is why it stays banned outright.
    expect(card).not.toMatch(/setInterval/);
    expect([...card.matchAll(/setTimeout\(/g)]).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// THE THREE GRADED §V CONFORMANCE FINDINGS (cinatra#2841 / PR #2866)
// ---------------------------------------------------------------------------
//
// The live capture grading of the redrawn card found three ways the shipped
// surface still failed the ratified drawing. Each is pinned here at the level
// the defect actually lived at:
//
//   1. the ADJUSTED settled mark was UNREACHABLE — an in-set Adjust landed as a
//      `recommended_confirmed` row and read back `Confirmed`, so §V's three
//      marks reduced to two on screen;
//   2. the settled chip printed the package-qualified skill ID while the held
//      chip printed the display NAME — §V names skills, on both readings;
//   3. no truthful `recommendation_hold` capture could satisfy the capture
//      contract, because the card root emitted none of the three
//      `data-lifecycle-card*` attributes the contract identifies it by.

/** Open a skill's ADJUST panel and settle it there with "Keep it in this run". */
const adjustKeep = async (skillId: string) => {
  await press(skillId, "adjust");
  await waitFor(() =>
    expect(
      document.querySelector(`[data-skill-action="adjust-keep"][data-skill-id="${skillId}"]`),
    ).not.toBeNull(),
  );
  const keep = document.querySelector(
    `[data-skill-action="adjust-keep"][data-skill-id="${skillId}"]`,
  ) as HTMLButtonElement;
  await act(async () => {
    keep.click();
    await Promise.resolve();
  });
};

type ConfirmPayload = {
  confirmedSkillIds: string[];
  adjustedSkillIds?: string[];
  forcedRevisions?: Record<string, string>;
};
const confirmPayload = (): ConfirmPayload =>
  confirmMock.mock.calls[0]![0] as ConfirmPayload;

describe("finding 1 — the ADJUSTED mark is reachable for a skill IN the scored set", () => {
  it("an in-set Adjust -> Keep is carried to the store as an ADJUSTED skill, not a plain confirm", async () => {
    // THE DEFECT: `deriveConfirmedSelection` stamps `user_forced` — the only
    // source that read back as `adjusted` — exclusively for an id OUTSIDE the
    // scored set, and this row only ever offers the scored set. So the reader
    // could open Adjust, keep the skill, and get a chip reading `Confirmed`.
    holdStateMock.mockImplementation(async () => HELD_THREE);
    await mountCard({ wireRef: "hold-ref-3" });
    await waitFor(() => expect(chips()).toHaveLength(3));

    await press("skill-enrich", "confirm");
    await adjustKeep("skill-draft");
    expect(chipFor("skill-draft")!.getAttribute("data-chip-mark")).toBe("adjusted");
    await press("skill-send", "confirm");

    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    const payload = confirmPayload();
    // All three are kept, and exactly the adjusted one is named as adjusted.
    expect([...payload.confirmedSkillIds].sort()).toEqual([
      "skill-draft",
      "skill-enrich",
      "skill-send",
    ]);
    expect(payload.adjustedSkillIds).toEqual(["skill-draft"]);
  });

  it("NEGATIVE CONTROL: a row settled with plain Confirms names NO adjusted skill", async () => {
    // The assertion above is only worth its ink if the field can be absent.
    holdStateMock.mockImplementation(async () => HELD_THREE);
    await mountCard({ wireRef: "hold-ref-3" });
    await waitFor(() => expect(chips()).toHaveLength(3));

    await press("skill-enrich", "confirm");
    await press("skill-draft", "confirm");
    await press("skill-send", "confirm");

    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(confirmPayload().adjustedSkillIds).toBeUndefined();
  });

  it("an ADJUSTED skill that was never recommended still rides forcedRevisions", async () => {
    // Forcing a below-threshold candidate on IS its adjustment, and the store
    // keeps that apart from an in-set edit (`user_forced` vs `user_adjusted`) —
    // only the first contradicts the scorer. The row reports both facts and the
    // derivation decides; it never drops the pinned revision.
    holdStateMock.mockImplementation(async () => ({
      ...HELD_THREE,
      recommendations: [
        ...THREE_SKILLS,
        { skillId: "skill-extra", skillRevisionId: "rev-4", recommended: false, name: "Log outcome" },
      ],
    }));
    await mountCard({ wireRef: "hold-ref-3" });
    await waitFor(() => expect(chips()).toHaveLength(4));

    await press("skill-enrich", "confirm");
    await press("skill-draft", "confirm");
    await press("skill-send", "confirm");
    await adjustKeep("skill-extra");

    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    const payload = confirmPayload();
    expect(payload.forcedRevisions).toEqual({ "skill-extra": "rev-4" });
    expect(payload.adjustedSkillIds).toEqual(["skill-extra"]);
  });

  it("SETTLED: the mark the store can now record draws as `Adjusted`, not `Confirmed`", async () => {
    // The other end of the same chain: a `user_adjusted` selection row is
    // derived to the `adjusted` mark (pinned in the actions suite), and the
    // settled chip draws it. Before the fix no server answer could produce this.
    holdStateMock.mockImplementation(async () => ({
      state: "confirmed",
      skillNames: ["Draft email"],
      decided: [{ skillId: "skill-draft", name: "Draft email", mark: "adjusted" }],
    }));
    await mountCard({ wireRef: null });
    await waitFor(() => expect(chips()).toHaveLength(1));

    expect(chipFor("skill-draft")!.getAttribute("data-chip-mark")).toBe("adjusted");
    expect(chipFor("skill-draft")!.textContent).toContain("Adjusted");
    expect(chipFor("skill-draft")!.textContent).not.toContain("Confirmed");
  });
});

describe("finding 2 — a settled chip prints the SAME display name a held chip prints", () => {
  it("prints the name, and never the package-qualified id", async () => {
    holdStateMock.mockImplementation(async () => ({
      state: "confirmed",
      skillNames: ["Blog writing"],
      decided: [
        {
          skillId: "@cinatra-ai/blog-writing-skill:blog-writing",
          name: "Blog writing",
          mark: "confirmed",
        },
      ],
    }));
    const { container } = await mountCard({ wireRef: null });
    await waitFor(() => expect(chips()).toHaveLength(1));

    const chip = chips()[0]!;
    expect(chip.textContent).toContain("Blog writing");
    // The id is machine-readable on the chip, and printed nowhere: §V draws a
    // name and no second, package-qualified line beside it.
    expect(chip.getAttribute("data-skill-id")).toBe(
      "@cinatra-ai/blog-writing-skill:blog-writing",
    );
    expect(container.textContent).not.toContain("@cinatra-ai/blog-writing-skill");
  });

  it("the HELD and the SETTLED reading label the same skill identically", async () => {
    // The graded defect stated exactly: held chips read `blog-writing`, settled
    // chips read `@cinatra-ai/blog-writing-skill:blog-writing`.
    holdStateMock.mockImplementation(async () => ({
      state: "held",
      agentPackageName: "@cinatra-test/hold-fixture-agent",
      promptText: "{}",
      recommendations: [
        {
          skillId: "@cinatra-ai/blog-writing-skill:blog-writing",
          skillRevisionId: "rev-b",
          recommended: true,
          name: "Blog writing",
        },
      ],
      holdRef: "hold-ref-name",
    }));
    await mountCard({ wireRef: "hold-ref-name" });
    await waitFor(() => expect(chips()).toHaveLength(1));
    const heldLabel = chips()[0]!.querySelector(".font-medium")!.textContent;
    cleanup();

    holdStateMock.mockImplementation(async () => ({
      state: "confirmed",
      skillNames: ["Blog writing"],
      decided: [
        {
          skillId: "@cinatra-ai/blog-writing-skill:blog-writing",
          name: "Blog writing",
          mark: "confirmed",
        },
      ],
    }));
    await mountCard({ wireRef: null });
    await waitFor(() => expect(chips()).toHaveLength(1));
    const settledLabel = chips()[0]!.querySelector(".font-medium")!.textContent;

    expect(settledLabel).toBe(heldLabel);
    expect(settledLabel).toBe("Blog writing");
  });

  it("falls back to the id when nothing could name the skill — a true label, never an invented one", async () => {
    holdStateMock.mockImplementation(async () => ({
      state: "skipped",
      // What `decidedSkillsFromEvidence` produces when the name join resolves
      // nothing: the id IS the name, which is the truest label available.
      decided: [{ skillId: "orphan-skill", name: "orphan-skill", mark: "skipped" }],
    }));
    await mountCard({ wireRef: null });
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(chips()[0]!.textContent).toContain("orphan-skill");
  });
});

describe("finding 3 — the card root declares its kind, its host and its state", () => {
  const root = () => document.querySelector("[data-run-recommendation-chip-row]");

  it("a HELD row declares recommendation_hold / run_card / held on its own root", async () => {
    holdStateMock.mockImplementation(async () => HELD_THREE);
    await mountCard({ wireRef: "hold-ref-3" });
    await waitFor(() => expect(chips()).toHaveLength(3));

    expect(root()!.getAttribute("data-lifecycle-card")).toBe("recommendation_hold");
    expect(root()!.getAttribute("data-lifecycle-card-host")).toBe("run_card");
    expect(root()!.getAttribute("data-lifecycle-card-state")).toBe("held");
  });

  it("a SETTLED row declares the same kind and host, with the state moved to decided", async () => {
    holdStateMock.mockImplementation(async () => ({
      state: "confirmed",
      skillNames: ["Draft email"],
      decided: [{ skillId: "skill-draft", name: "Draft email", mark: "confirmed" }],
    }));
    await mountCard({ wireRef: null });
    await waitFor(() => expect(chips()).toHaveLength(1));

    expect(root()!.getAttribute("data-lifecycle-card")).toBe("recommendation_hold");
    expect(root()!.getAttribute("data-lifecycle-card-host")).toBe("run_card");
    expect(root()!.getAttribute("data-lifecycle-card-state")).toBe("decided");
  });

  it("the host declared is the host that OPTED IN, not a constant", async () => {
    holdStateMock.mockImplementation(async () => HELD_THREE);
    await mountCard({ wireRef: "hold-ref-3", host: "chat_thread" });
    await waitFor(() => expect(chips()).toHaveLength(3));
    expect(root()!.getAttribute("data-lifecycle-card-host")).toBe("chat_thread");
  });

  it("NEGATIVE CONTROL: with no surface provider the host attribute is ABSENT, never guessed", async () => {
    // The card itself refuses to draw without a declared host, so this can only
    // be reached by rendering the row directly — which is what proves the
    // attribute is read from the provider rather than hardcoded.
    const { RunRecommendationChipRow } = await import("../run-recommendation-chip-row");
    const { container } = render(
      <RunRecommendationChipRow
        runId="run-2841"
        agentPackageName="@cinatra-test/hold-fixture-agent"
        initialRecommendations={[]}
        decision={{
          kind: "confirmed",
          skillNames: ["Draft email"],
          decided: [{ skillId: "skill-draft", name: "Draft email", mark: "confirmed" }],
        }}
      />,
    );
    const el = container.querySelector("[data-run-recommendation-chip-row]")!;
    expect(el.getAttribute("data-lifecycle-card")).toBe("recommendation_hold");
    expect(el.getAttribute("data-lifecycle-card-state")).toBe("decided");
    expect(el.hasAttribute("data-lifecycle-card-host")).toBe(false);
  });

  it("satisfies the CAPTURE CONTRACT's own required anchors for a decided run_card record", async () => {
    // The contract is the other half of finding 3, so it is asked directly
    // rather than transcribed: every anchor it requires for
    // `recommendation-card__run_card__decided` is counted against this DOM the
    // way the capture driver counts it (root scope INCLUDES the root element).
    const { requiredAssertionsFor, CARD_KINDS } = await import(
      "../../../../scripts/ci/lib/capture-record-contract.mjs"
    );
    holdStateMock.mockImplementation(async () => ({
      state: "confirmed",
      skillNames: ["Draft email"],
      decided: [{ skillId: "skill-draft", name: "Draft email", mark: "confirmed" }],
    }));
    await mountCard({ wireRef: null });
    await waitFor(() => expect(chips()).toHaveLength(1));

    const rootSel = CARD_KINDS.recommendation_hold.root;
    const cardRoot = document.querySelector(rootSel);
    expect(cardRoot).not.toBeNull();
    const count = (selector: string, scope: string) =>
      scope === "root"
        ? (cardRoot!.matches(selector) ? 1 : 0) + cardRoot!.querySelectorAll(selector).length
        : document.querySelectorAll(selector).length;

    const { required, forbidden } = requiredAssertionsFor({
      host: "run_card",
      kind: "recommendation_hold",
      state: "decided",
    });
    expect(required.length).toBeGreaterThan(0);
    for (const req of required) {
      expect({ selector: req.selector, count: count(req.selector, req.scope) }).toEqual({
        selector: req.selector,
        count: expect.any(Number),
      });
      expect(count(req.selector, req.scope)).toBeGreaterThanOrEqual(1);
    }
    // …and a decided capture owes the ABSENCE of every decision control.
    for (const f of forbidden) expect(count(f.selector, f.scope)).toBe(0);
  });
});


// ---------------------------------------------------------------------------
// THE BROKER TRANSPORT (cinatra#2790, epic #2784 S9f)
// ---------------------------------------------------------------------------
//
// WHAT WAS UNPINNED, AND WHY IT MATTERED. The slice's whole point is that WHO a
// decision is recorded as is the host's question: a cookie host keeps the
// shipped server actions, and a credential-declaring host posts to the broker
// with its own proof and cookies omitted, because a server action cannot carry
// a credential and would ride the ambient cookie of a same-origin frame. The
// READ half of that had a pin. The DECISION half had none — nothing anywhere in
// the tree pressed a chip on a credential-declaring host — so the row could have
// fallen back to the cookie-bound actions on the widget, which is the exact
// defect the slice exists to remove, and every suite would still have been
// green.
//
// ONE ROW, TWO TRANSPORTS, NEVER TWO ROWS. Each arm below therefore asserts
// BOTH directions: the request that was made, and the road that was NOT taken.
// A card that decided through a server action satisfies "the row settled"; only
// "and the action was never called" tells the two apart.
describe("§V on a credential-declaring host — the broker carries the decision too", () => {
  it("CONFIRM is recorded through the broker, with the host's own proof and no cookie", async () => {
    const broker = installBrokerStub({ hold: () => HELD_THREE });
    try {
      holdStateMock.mockImplementation(async () => HELD_THREE);
      await mountCard({
        wireRef: "hold-ref-3",
        host: "site_widget",
        auth: WIDGET_DECLARATION,
      });
      await waitFor(() => expect(chips()).toHaveLength(3));

      await press("skill-enrich", "confirm");
      await press("skill-draft", "confirm");
      await press("skill-send", "confirm");

      const decisions = await waitFor(() => {
        const found = broker.callsTo(LIFECYCLE_RECOMMENDATION_DECIDE_PATH);
        if (found.length === 0) throw new Error("no decision reached the broker");
        return found;
      });
      // ONE release for the whole row — the named store deviation, unchanged by
      // which transport carried it.
      expect(decisions).toHaveLength(1);
      expect(decisions[0].init.method).toBe("POST");
      expect(decisions[0].headers["X-Cinatra-Widget-User-Token"]).toBe("cwu_x");
      expect(decisions[0].init.credentials).toBe("omit");
      expect(decisions[0].body).toEqual({
        runId: "run-2568",
        decision: "confirm",
        confirmedSkillIds: ["skill-enrich", "skill-draft", "skill-send"],
        promptText: "{}",
        // The hold the decision was taken AGAINST rides with it, so a run that
        // was decided, dispatched and parked again refuses a decision meant for
        // the previous hold instead of applying it to the new one.
        holdRef: "hold-ref-3",
      });

      // …and the cookie-bound roads were not taken.
      expect(confirmMock).not.toHaveBeenCalled();
      expect(skipMock).not.toHaveBeenCalled();
    } finally {
      broker.restore();
    }
  });

  it("SKIP takes the same road — one decision, one transport", async () => {
    const broker = installBrokerStub({ hold: () => HELD_THREE });
    try {
      holdStateMock.mockImplementation(async () => HELD_THREE);
      await mountCard({
        wireRef: "hold-ref-3",
        host: "site_widget",
        auth: WIDGET_DECLARATION,
      });
      await waitFor(() => expect(chips()).toHaveLength(3));

      await press("skill-enrich", "skip");
      await press("skill-draft", "skip");
      await press("skill-send", "skip");

      const decisions = await waitFor(() => {
        const found = broker.callsTo(LIFECYCLE_RECOMMENDATION_DECIDE_PATH);
        if (found.length === 0) throw new Error("no decision reached the broker");
        return found;
      });
      expect(decisions).toHaveLength(1);
      // The same three properties the CONFIRM arm asserts, written out rather
      // than assumed to follow from it: a skip that dropped its proof, or that
      // stopped being a POST, would answer 401 at the real route.
      expect(decisions[0].init.method).toBe("POST");
      expect(decisions[0].headers["X-Cinatra-Widget-User-Token"]).toBe("cwu_x");
      expect(decisions[0].init.credentials).toBe("omit");
      // A row whose every chip was skipped releases through SKIP, not through an
      // empty confirm — an empty selection writes no row and reads back as no
      // decision at all.
      expect(decisions[0].body).toEqual({
        runId: "run-2568",
        decision: "skip",
        holdRef: "hold-ref-3",
      });
      expect(skipMock).not.toHaveBeenCalled();
      expect(confirmMock).not.toHaveBeenCalled();
    } finally {
      broker.restore();
    }
  });

  it("RE-AUTHORIZES on every read and every decision — the card holds no header", async () => {
    // The issue's words: "the broker re-authorizing that run on every read and
    // decision". Structurally that means the proof is built at the moment of the
    // call from the host's declaration, never captured into React state, a prop
    // or a closure that outlives it — otherwise a rotated or revoked credential
    // would keep working for as long as the card stayed mounted.
    //
    // A DECLARATION THAT ROTATES ITS ANSWER IS THE MEASUREMENT, AND TWO
    // DECISIONS ARE WHAT MAKE IT ONE. With a single decision, a submitter that
    // captured its headers ONCE — at the moment the submitter was built, which
    // happens before the first read — would still produce three distinct tokens
    // and pass. So the row decides TWICE through the same mounted submitter: the
    // first release is REFUSED (which leaves the hold live and every chip still
    // pressable, and does NOT re-read, because only a landed decision does), and
    // the second is pressed straight after it. A captured header repeats across
    // those two; a proof built per call cannot.
    let minted = 0;
    const rotating = {
      headers: () => ({ "X-Cinatra-Widget-User-Token": `cwu_${++minted}` }),
      credentials: "omit" as RequestCredentials,
    };
    let decisions = 0;
    const broker = installBrokerStub({
      hold: () => HELD_THREE,
      decide: () => {
        decisions += 1;
        return decisions === 1
          ? { ok: false, error: "Could not record that decision." }
          : { ok: true, dispatched: true };
      },
    });
    try {
      holdStateMock.mockImplementation(async () => HELD_THREE);
      await mountCard({ wireRef: "hold-ref-3", host: "site_widget", auth: rotating });
      await waitFor(() => expect(chips()).toHaveLength(3));

      await press("skill-enrich", "confirm");
      await press("skill-draft", "confirm");
      await press("skill-send", "confirm");
      // The first release is refused: the row stays live, nothing settled.
      await waitFor(() => {
        if (broker.callsTo(LIFECYCLE_RECOMMENDATION_DECIDE_PATH).length < 1) {
          throw new Error("the first decision never reached the broker");
        }
      });
      expect(chips()).toHaveLength(3);

      // Press again — the same mounted card, the same submitter, a second call.
      await press("skill-enrich", "confirm");
      await waitFor(() => {
        if (broker.callsTo(LIFECYCLE_RECOMMENDATION_DECIDE_PATH).length < 2) {
          throw new Error("the retry never reached the broker");
        }
      });

      const sent = broker.callsTo(LIFECYCLE_RECOMMENDATION_DECIDE_PATH);
      expect(sent.length).toBeGreaterThanOrEqual(2);
      // THE ARM'S POINT: two decisions through one submitter, two proofs.
      expect(sent[0].headers["X-Cinatra-Widget-User-Token"]).not.toBe(
        sent[1].headers["X-Cinatra-Widget-User-Token"],
      );

      // And the same property across every call the card made, reads included.
      const proofs = broker.calls.map((c) => c.headers["X-Cinatra-Widget-User-Token"]);
      expect(proofs.length).toBeGreaterThanOrEqual(3);
      expect(new Set(proofs).size).toBe(proofs.length);
      expect(proofs.every((t) => typeof t === "string" && t.startsWith("cwu_"))).toBe(true);
      // Every call omitted cookies. One that did not would be the whole defect.
      expect(broker.calls.every((c) => c.init.credentials === "omit")).toBe(true);
      // The cookie-bound roads were never taken, on either attempt.
      expect(confirmMock).not.toHaveBeenCalled();
      expect(skipMock).not.toHaveBeenCalled();
    } finally {
      broker.restore();
    }
  });

  it("NEGATIVE CONTROL: a cookie host never touches either broker path", async () => {
    // The other half of "the declaration selects the transport". Without this,
    // every arm above would still pass with the card posting to the broker from
    // EVERY host — which would send a first-party surface's decision through a
    // route that answers 401 to anything without a widget credential.
    const broker = installBrokerStub({ hold: () => HELD_THREE });
    try {
      holdStateMock.mockImplementation(async () => HELD_THREE);
      await mountCard({ wireRef: "hold-ref-3", host: "run_card" });
      await waitFor(() => expect(chips()).toHaveLength(3));

      await press("skill-enrich", "confirm");
      await press("skill-draft", "confirm");
      await press("skill-send", "confirm");

      await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
      expect(holdStateMock).toHaveBeenCalled();
      // Not one request left the cookie host. The stub rejects unknown paths, so
      // this is a count of everything the card asked for, not of two paths.
      expect(broker.calls).toHaveLength(0);
    } finally {
      broker.restore();
    }
  });

  it("REPLAY: the held row comes back after a reload, re-read through the broker", async () => {
    // The durable arm for this host. A reload tears the frame down and rebuilds
    // it; the hold is a store row and the card re-derives live state from the
    // run, so what comes back must be what was there — and it must come back
    // through the host's OWN transport, not through a session the reloaded frame
    // still does not have.
    const broker = installBrokerStub({ hold: () => HELD });
    try {
      holdStateMock.mockImplementation(async () => HELD);
      const first = await mountCard({
        wireRef: "hold-ref-1",
        host: "site_widget",
        auth: WIDGET_DECLARATION,
      });
      await waitFor(() => {
        if (!first.container.querySelector("[data-run-recommendation-chip-row]")) {
          throw new Error("no card before the reload");
        }
      });
      const readsBefore = broker.callsTo(LIFECYCLE_RECOMMENDATION_HOLD_PATH).length;
      expect(readsBefore).toBeGreaterThan(0);

      cleanup();

      const second = await mountCard({
        wireRef: "hold-ref-1",
        host: "site_widget",
        auth: WIDGET_DECLARATION,
      });
      const root = await waitFor(() => {
        const found = second.container.querySelector("[data-run-recommendation-chip-row]");
        if (!found) throw new Error("the held row did not come back after the reload");
        return found;
      });
      expect(root.getAttribute("data-lifecycle-card-host")).toBe("site_widget");
      expect(root.getAttribute("data-lifecycle-card-state")).toBe("held");
      expect(root.querySelector('[data-skill-action="confirm"]')).not.toBeNull();
      expect(root.querySelector('[data-skill-action="adjust"]')).not.toBeNull();
      expect(root.querySelector('[data-skill-action="skip"]')).not.toBeNull();
      // The second mount asked the authority for itself — a card that re-drew
      // from a cached answer would prove nothing about a reloaded frame.
      expect(
        broker.callsTo(LIFECYCLE_RECOMMENDATION_HOLD_PATH).length,
      ).toBeGreaterThan(readsBefore);
      expect(holdStateMock).not.toHaveBeenCalled();
    } finally {
      broker.restore();
    }
  });
});
