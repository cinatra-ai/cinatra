// @vitest-environment jsdom
/**
 * THE WIDGET TRANSCRIPT CARRIES THE CARDS (cinatra#2826, epic #2784 S9m).
 *
 * WHAT WAS WRONG. The widget's lifecycle proof mounted `LifecycleCard` directly
 * under a hand-written provider (`lifecycle-card-widget-host.test.tsx`). That
 * measures a component, not a surface: it steps over the embed's conversation
 * column entirely, so a widget whose transcript stopped projecting cards would
 * have kept it green. "The widget renders the full lifecycle card set" was, in
 * evidence terms, a claim about a fixture.
 *
 * WHAT THIS DOES INSTEAD. Every kind's carriage is put through the REAL widget
 * arm of the ONE shared conversation column — the same component `/chat` mounts,
 * with the embed's host adapters, its broker transport and its lifecycle
 * declaration (`conversation-column-harness`, the arm `embed-assistant-client`
 * composes) — and the card is read off the rendered transcript:
 *
 *   1. THE THREE DATA_PART KINDS draw inside the widget transcript, and the
 *      request that authorized each one carried the surface's OWN broker proof
 *      with cookies OMITTED. Both halves matter: a card drawn from an ambient
 *      cookie on a same-origin frame is the forbidden fallback, not parity.
 *   2. PARITY IS A COMPARISON OF RENDERS. The same transcript is run through the
 *      `/chat` arm, and the two surfaces must produce the same kinds — measured
 *      from DOM on both sides rather than from a list either arm could edit.
 *   3. THE RECOMMENDATION ROW is consumed as an OBSERVATION. Its widget mount is
 *      owed by S9f (#2790) and the ratchet says so; this suite measures the real
 *      widget arm and asserts the observed-unmounted set is exactly what the
 *      ratchet owes, so the day S9f lands the row must be struck or CI goes red.
 *      The refusal that causes it is pinned beside it as a live discriminator.
 *   4. A DENIAL IS STILL NO DOM, and a MIS-WIRED widget declaration issues no
 *      resolve at all — the negative controls that make a green run evidence.
 *
 * LOCAL NOTE: this suite runs under the chat package's own vitest config.
 *
 *   pnpm --filter @cinatra-ai/chat exec vitest run \
 *     src/__tests__/widget-transcript-carriage.test.tsx
 */

import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- the graphs a mounted column reaches that belong to the server ----------
// Replaced exactly as the sibling transcript suites replace them, and for the
// same stated reason: their graphs reach the server runtime, so without these
// the column does not mount at all. What stays REAL is everything measured here
// — the transcript, the host declaration, the registry dispatch and the cards.

vi.mock("lucide-react", () => {
  const StubIcon: React.FC = () => null;
  return new Proxy({} as Record<string, React.FC>, {
    get: (_t, prop) => {
      if (prop === "__esModule") return true;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      return StubIcon;
    },
    has: () => true,
    ownKeys: () => ["Check", "ChevronDown", "default"],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: StubIcon }),
  });
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/chat",
  useSearchParams: () => new URLSearchParams(),
}));

const holdStateMock = vi.fn(async () => ({ state: "none" }) as Record<string, unknown>);
vi.mock("../../../agents/src/run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: () => holdStateMock(),
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
}));

vi.mock("../../../agents/src/server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
  getSkillsForAgentAction: vi.fn(async () => []),
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({})),
  confirmRunSkillSelectionAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../pending-call-actions", () => ({
  listPendingToolConfirmations: async () => ({ rows: [] }),
  decidePendingToolCall: async () => ({ ok: true }),
}));
vi.mock("../undo-actions", () => ({
  recentUndoableChangeSetForRunAction: async () => ({ changeSetId: null }),
}));
vi.mock("@/components/data-safety/undo-toast", () => ({
  undoDeepLink: (id: string) => `/objects?undo=${id}`,
}));
// The inline run card is the AG-UI run panel, whose graph reaches the server
// runtime. The stand-in declares the SAME host the shipped panel declares, so a
// card found inside it is still recognisable as a run-card mount rather than a
// conversation one.
vi.mock("../inline-agent-run-card", () => ({
  InlineAgentRunCard: ({ runId }: { runId: string }) => (
    <div data-lifecycle-card-host="run_card" data-inline-run-card={runId} />
  ),
}));

import {
  LIFECYCLE_CARD_KINDS,
  LIFECYCLE_DATA_PART_VIEW_TYPES,
  lifecycleViewTypesForHost,
  type LifecycleCardKind,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";
import { LifecycleCardSurfaceProvider } from "../../../agents/src/lifecycle-card-runtime";
import { RecommendationHoldCard } from "../../../agents/src/run-recommendation-chip-row";
import { LIFECYCLE_HOST_PARITY_RATCHET } from "@/lib/lifecycle/lifecycle-host-parity-ratchet";
import {
  LIFECYCLE_RESOLVE_ANSWERS,
  WIDGET_LIFECYCLE_SURFACE,
  installWidgetServiceStub,
  lifecycleDataPartTranscript,
  lifecycleHeldTranscript,
  mountRefusedSurface,
  mountSurface,
  type SurfaceName,
} from "./conversation-column-harness";

// Some Node builds expose a global `localStorage` that SHADOWS jsdom's and
// throws on use, which the composer's prompt field reads on mount.
if (typeof window !== "undefined" && typeof window.localStorage?.getItem !== "function") {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

const RESOLVE_PATH = "/api/lifecycle-views/resolve";

let widgetStub: ReturnType<typeof installWidgetServiceStub> | null = null;

function installStub(options: Parameters<typeof installWidgetServiceStub>[0] = {}) {
  widgetStub = installWidgetServiceStub({
    lifecycle: (viewType) => LIFECYCLE_RESOLVE_ANSWERS.pending(viewType),
    ...options,
  });
  return widgetStub;
}

/** Let the cards' own mount resolves settle before anything is measured. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** The surface root of a mounted arm — everything is measured inside it. */
function surfaceRoot(container: HTMLElement, surface: SurfaceName): HTMLElement {
  const root = container.querySelector<HTMLElement>(`[data-parity-surface="${surface}"]`);
  if (!root) throw new Error(`the ${surface} surface did not mount`);
  return root;
}

/** The resolve calls the mounted arm really issued, in order. */
function resolveCalls() {
  return (widgetStub?.calls ?? []).filter((c) => c.url === RESOLVE_PATH);
}

function requestedViewTypes(): string[] {
  return resolveCalls()
    .map((c) => {
      try {
        return String(JSON.parse(String(c.init.body ?? "{}")).viewType ?? "");
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}

/**
 * Mount one kind's carriage on one arm and report what the transcript drew.
 *
 * The DATA_PART kinds ride the turn's renderable views; `recommendation_hold` is
 * an INTERRUPT whose chat carriage is the held dispatch turn, so its transcript
 * is the durable `agent_run` part. Each kind is therefore carried the way the
 * product carries it, not the way that is convenient to assert.
 */
async function mountKind(surface: SurfaceName, kind: LifecycleCardKind) {
  const messages =
    kind === "recommendation_hold"
      ? lifecycleHeldTranscript()
      : lifecycleDataPartTranscript(kind, `ref-${kind}`);
  const mounted = await mountSurface(surface, { messages });
  await settle();
  return { mounted, root: surfaceRoot(mounted.container, surface) };
}

/** Which lifecycle card roots a mounted surface really drew. */
function drawnKinds(root: HTMLElement): LifecycleCardKind[] {
  const drawn = new Set<LifecycleCardKind>();
  for (const el of Array.from(root.querySelectorAll("[data-lifecycle-card]"))) {
    // A card inside the inline run card's subtree is a run_card mount; it is not
    // this surface's carriage and must not be counted as one.
    if (el.closest('[data-lifecycle-card-host="run_card"]') !== null) continue;
    const kind = el.getAttribute("data-lifecycle-card");
    if (kind && (LIFECYCLE_CARD_KINDS as readonly string[]).includes(kind)) {
      drawn.add(kind as LifecycleCardKind);
    }
  }
  return [...drawn].sort();
}

beforeEach(() => {
  holdStateMock.mockImplementation(async () => ({ state: "none" }));
});

afterEach(() => {
  cleanup();
  widgetStub?.restore();
  widgetStub = null;
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. The DATA_PART kinds, through the REAL embed column
// ---------------------------------------------------------------------------

describe("the widget transcript draws every DATA_PART kind", () => {
  for (const kind of LIFECYCLE_DATA_PART_VIEW_TYPES) {
    it(`draws "${kind}" inside the widget's conversation list`, async () => {
      installStub();
      const { root } = await mountKind("widget", kind);
      const list = root.querySelector("[data-conversation-list]");
      expect(list, "the widget mounted the shared conversation list").not.toBeNull();
      const card = list!.querySelector(`[data-lifecycle-card="${kind}"]`);
      expect(card, `the widget transcript drew no ${kind} card`).not.toBeNull();
    });

    it(`authorizes "${kind}" with the broker proof and NO cookie`, async () => {
      installStub();
      await mountKind("widget", kind);
      const call = resolveCalls().find(
        (c) => String(c.init.body ?? "").includes(`"${kind}"`),
      );
      expect(call, `no resolve was issued for ${kind}`).toBeDefined();
      expect(call!.init.credentials).toBe("omit");
      expect(call!.init.headers).toMatchObject({
        Authorization: "Bearer cit_site",
        "X-Cinatra-Widget-User-Token": "cwu_user",
        "X-Cinatra-Widget-Origin": "https://blog.example.com",
      });
    });
  }

  it("declares `site_widget` on the card root the transcript drew", async () => {
    installStub();
    const { root } = await mountKind("widget", "artifact_review_gate");
    const card = root.querySelector('[data-lifecycle-card="artifact_review_gate"]');
    expect(card?.getAttribute("data-lifecycle-card-host")).toBe("site_widget");
  });

  it("asks the server about EVERY data-part kind it carries — nothing is dropped", async () => {
    installStub();
    for (const kind of LIFECYCLE_DATA_PART_VIEW_TYPES) {
      await mountKind("widget", kind);
      cleanup();
    }
    expect([...new Set(requestedViewTypes())].sort()).toEqual(
      [...LIFECYCLE_DATA_PART_VIEW_TYPES].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Parity as a comparison of RENDERS, not of lists
// ---------------------------------------------------------------------------

describe("the two arms of the one column draw the same kinds", () => {
  it("the widget draws exactly what `/chat` draws from the same transcript", async () => {
    const drawnOn = async (surface: SurfaceName) => {
      const seen = new Set<LifecycleCardKind>();
      for (const kind of LIFECYCLE_DATA_PART_VIEW_TYPES) {
        installStub();
        const { root } = await mountKind(surface, kind);
        for (const drawn of drawnKinds(root)) seen.add(drawn);
        cleanup();
        widgetStub?.restore();
        widgetStub = null;
      }
      return [...seen].sort();
    };
    const widget = await drawnOn("widget");
    const chat = await drawnOn("chat");
    expect(widget.length, "neither arm drew anything — the comparison is vacuous").toBeGreaterThan(0);
    expect(widget).toEqual(chat);
  });

  it("`/chat`'s own resolve stays a same-origin COOKIE request — the seam is additive", async () => {
    installStub();
    await mountKind("chat", "artifact_review_gate");
    const call = resolveCalls()[0];
    expect(call, "the chat arm issued no resolve").toBeDefined();
    expect(call!.init.credentials).toBe("same-origin");
    expect(call!.init.headers).toEqual({ "Content-Type": "application/json" });
  });

  it("the DECLARED per-host view list is not the evidence — it cannot tell the hosts apart", () => {
    // `lifecycleViewTypesForHost` answers the same three kinds for every host and
    // ignores its argument entirely. It is pinned here as the thing this suite
    // replaces: a render-observed parity claim must not be derivable from it.
    expect(lifecycleViewTypesForHost("site_widget")).toEqual(
      lifecycleViewTypesForHost("run_card"),
    );
  });
});

// ---------------------------------------------------------------------------
// 3. The recommendation row — consumed as an observation, ratcheted
// ---------------------------------------------------------------------------

describe("the recommendation hold on the widget arm", () => {
  it("the widget's OWED kinds are exactly the ones its transcript does not draw", async () => {
    const owed = LIFECYCLE_CARD_KINDS.filter((kind) =>
      LIFECYCLE_HOST_PARITY_RATCHET[kind].owed.some((cell) => cell.host === "site_widget"),
    ).sort();

    const unmounted: LifecycleCardKind[] = [];
    for (const kind of LIFECYCLE_CARD_KINDS) {
      installStub();
      if (kind === "recommendation_hold") {
        holdStateMock.mockImplementation(async () => ({
          state: "held",
          agentPackageName: "@cinatra-ai/proof-agent",
          promptText: "{}",
          recommendations: [
            { skillId: "skill-a", skillRevisionId: "rev-a", recommended: true, name: "Skill A" },
          ],
          holdRef: "hold-ref-2826",
        }));
      }
      const { root } = await mountKind("widget", kind);
      if (!drawnKinds(root).includes(kind)) unmounted.push(kind);
      cleanup();
      widgetStub?.restore();
      widgetStub = null;
    }
    expect(unmounted.sort()).toEqual(owed);
  });

  it("the REFUSAL behind that row is live: the real card draws nothing under the widget declaration", async () => {
    holdStateMock.mockImplementation(async () => ({
      state: "held",
      agentPackageName: "@cinatra-ai/proof-agent",
      promptText: "{}",
      recommendations: [
        { skillId: "skill-a", skillRevisionId: "rev-a", recommended: true, name: "Skill A" },
      ],
      holdRef: "hold-ref-2826",
    }));
    const widget = render(
      <LifecycleCardSurfaceProvider {...WIDGET_LIFECYCLE_SURFACE}>
        <RecommendationHoldCard runId="run-2826" agentPackageName="@cinatra-ai/proof-agent" />
      </LifecycleCardSurfaceProvider>,
    );
    await settle();
    expect(widget.container.innerHTML).toBe("");
    cleanup();

    // NEGATIVE CONTROL — the same card, the same state, a cookie host: it draws.
    // Without this, "nothing rendered" would be indistinguishable from a fixture
    // that never had anything to render.
    const cookie = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <RecommendationHoldCard runId="run-2826" agentPackageName="@cinatra-ai/proof-agent" />
      </LifecycleCardSurfaceProvider>,
    );
    await settle();
    expect(cookie.container.querySelector('[data-conformance-id="run-chip-row"]')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. The negative controls
// ---------------------------------------------------------------------------

describe("a denial draws nothing, and a mis-wired widget asks nothing", () => {
  it("an `absent` resolve leaves the widget transcript with no card DOM", async () => {
    installStub({ lifecycle: (viewType) => LIFECYCLE_RESOLVE_ANSWERS.absent(viewType) });
    const { root } = await mountKind("widget", "artifact_review_gate");
    expect(resolveCalls().length, "the card never asked").toBeGreaterThan(0);
    expect(root.querySelector("[data-lifecycle-card]")).toBeNull();
  });

  it("a REFUSED resolve (401 — the token expired) leaves no card DOM", async () => {
    installStub({ unauthorized: [RESOLVE_PATH] });
    const { root } = await mountKind("widget", "artifact_review_gate");
    expect(resolveCalls().length).toBeGreaterThan(0);
    expect(root.querySelector("[data-lifecycle-card]")).toBeNull();
  });

  it("a widget declaration with NO credential issues no resolve at all", async () => {
    installStub();
    const mounted = await mountRefusedSurface({
      messages: lifecycleDataPartTranscript("artifact_review_gate", "ref-refused"),
    });
    await settle();
    expect(resolveCalls()).toEqual([]);
    expect(mounted.container.querySelector("[data-lifecycle-card]")).toBeNull();
  });
});
