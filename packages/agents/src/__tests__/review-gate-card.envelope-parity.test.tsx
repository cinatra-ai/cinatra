// @vitest-environment jsdom
//
// The REVIEW CARD RENDER-PARITY suite (epic S9 slice S9c).
//
// S9c replaces the state-only resolve answer with a per-kind envelope
// `{ kind, state, body }`. The review card is the one lifecycle card that is
// already drawn, so the slice owes a proof that its pixels did not move: the
// envelope carries `body: null` for the review kind, and the card must draw
// exactly what it drew before.
//
// HOW THE PROOF WORKS. The fixture below was CAPTURED ON THE PRE-ENVELOPE TREE
// and committed. It holds the card's rendered `innerHTML` for every §IV state on
// every host. This suite re-renders the same matrix and compares byte for byte.
// The ONE line that is allowed to differ between the two trees is
// `resolveResponse` — the wire body the resolve is mocked with — because the
// wire shape is exactly what the slice changes. Every byte of DOM is pinned.
//
// Regenerating the fixture is therefore NOT a normal maintenance step: a diff
// here means the review card's rendering moved, which this slice promised it
// would not.
//
// FOUR ENTRIES WERE REGENERATED ON PURPOSE (cinatra#2852). The §VIII redraw
// replaces the suggestion row — per-suggestion before/after, a two-state toggle
// accepted by default, no strike-through — so the four
// `*/pending-with-suggestions` captures were re-taken against the redrawn
// component and nothing else was touched. Every other entry is still the
// pre-envelope capture, byte for byte, which is what keeps this guard honest:
// the redraw had to move exactly the states that carry suggestions and no
// others, and that is what the regeneration diff showed.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

import type {
  LifecycleCardState,
  LifecycleSuggestion,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
}));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { ReviewGateCard } from "../review-gate-card";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const VIEW = {
  viewType: "artifact_review_gate" as const,
  schemaVersion: 1,
  ref: "ref-parity-001",
};

const WIDGET_AUTH = {
  headers: () => ({ "X-Cinatra-Widget-User-Token": "cwu_user" }),
  credentials: "omit" as const,
};

/**
 * THE ONLY LINE THAT MOVED WITH THE SLICE. Before S9c the resolve answered
 * `{ state }`; it now answers the per-kind envelope. The DOM the card draws from
 * either answer is the same, which is what the fixture pins.
 */
function resolveResponse(state: LifecycleCardState): unknown {
  return { kind: "artifact_review_gate", state, body: null };
}

function mockResolve(state: LifecycleCardState): void {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(resolveResponse(state)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  ) as unknown as typeof fetch;
}

type Host = "chat_thread" | "run_card" | "page_gate_region" | "site_widget";

const HOSTS: Host[] = ["chat_thread", "run_card", "page_gate_region", "site_widget"];

const SUGGESTION: LifecycleSuggestion = {
  id: "sug-1",
  label: "content.body",
  op: "replace",
  message: "Tighten the opening sentence.",
};

const STATES: Array<{ name: string; state: LifecycleCardState }> = [
  { name: "loading", state: { state: "loading" } },
  { name: "pending", state: { state: "pending", canDecide: true, canComment: true } },
  {
    name: "pending-no-comment",
    state: { state: "pending", canDecide: true, canComment: false },
  },
  {
    name: "pending-with-suggestions",
    state: {
      state: "pending",
      canDecide: true,
      canComment: true,
      suggestions: [SUGGESTION],
    },
  },
  {
    name: "restricted",
    state: {
      state: "restricted",
      canDecide: false,
      canComment: true,
      reason: "Continuing or regenerating needs decision access on this run.",
    },
  },
  { name: "settled", state: { state: "settled" } },
  // cinatra#2904 — the settled reading WITH its recorded outcome, enumerated on
  // every host for the same reason the outcome-less one is: the review page is
  // one of the four hosts this matrix walks, and until #2904 the page returned
  // its own blocked panel before this component was mounted at all, so the
  // matrix could not have caught the divergence. These entries are not a
  // pre-envelope capture and do not claim to be — they were recorded against the
  // component on this branch, and what they pin from here on is that the four
  // hosts keep drawing them identically.
  //
  // RE-RECORDED for cinatra#2931 W4, deliberately, because what these three
  // entries pinned had become false: "A resolved gate opens read-only: what was
  // decided, and the reviewed target(s), kept for the run's audit trail" — and
  // the captured DOM held the decision line ALONE, with the reviewed target
  // dropped. The new captures hold the gate header, the target island and the
  // decision line, and no decision control on any of the four hosts. The
  // outcome-less `settled` entry above is untouched: that reading draws the
  // generic panel, as it always did.
  {
    name: "settled-approved",
    state: { state: "settled", outcome: "approved", decidedByName: "Ada Lovelace" },
  },
  {
    name: "settled-rejected",
    state: { state: "settled", outcome: "rejected", decidedByName: "Ada Lovelace" },
  },
  // The decider is optional and its absence is quiet: the card states the
  // outcome alone rather than a dangling "by".
  {
    name: "settled-approved-no-decider",
    state: { state: "settled", outcome: "approved" },
  },
  { name: "advisory", state: { state: "advisory" } },
  { name: "absent", state: { state: "absent" } },
];

const FIXTURE_PATH = path.join(
  __dirname,
  "__fixtures__",
  "review-gate-card-render-parity.json",
);

/** Let the resolve settle without crossing the island's 12s load timeout. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function renderCase(host: Host, state: LifecycleCardState): Promise<string> {
  mockResolve(state);
  const { container } = render(
    <LifecycleCardSurfaceProvider
      host={host}
      auth={host === "site_widget" ? WIDGET_AUTH : undefined}
    >
      <ReviewGateCard view={VIEW} />
    </LifecycleCardSurfaceProvider>,
  );
  await settle();
  const html = container.innerHTML;
  cleanup();
  return html;
}

describe("review card render parity across the resolve envelope", () => {
  it("draws byte-identical DOM for every §IV state on every host", async () => {
    const captured: Record<string, string> = {};
    for (const host of HOSTS) {
      for (const entry of STATES) {
        captured[`${host}/${entry.name}`] = await renderCase(host, entry.state);
      }
    }

    // CAPTURE_REVIEW_PARITY=1 records entries this fixture does not yet hold —
    // a new state added to the matrix above. It NEVER overwrites an entry that
    // is already there: the committed captures are the guard, and a regenerate
    // that could quietly re-take them would be a guard that agrees with whatever
    // the tree currently draws. Regenerating an EXISTING entry is still a
    // deliberate edit to the fixture file.
    if (process.env.CAPTURE_REVIEW_PARITY === "1") {
      const existing: Record<string, string> = existsSync(FIXTURE_PATH)
        ? (JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Record<string, string>)
        : {};
      const merged = { ...captured, ...existing };
      writeFileSync(FIXTURE_PATH, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    }

    const expected = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Record<
      string,
      string
    >;
    expect(Object.keys(captured).sort()).toEqual(Object.keys(expected).sort());
    for (const key of Object.keys(expected)) {
      expect(captured[key], `render parity broke for ${key}`).toBe(expected[key]);
    }
  });

  it("draws NO DOM for the absent state on any host (§IV privacy)", async () => {
    for (const host of HOSTS) {
      expect(await renderCase(host, { state: "absent" })).toBe("");
    }
  });

  // cinatra#2904 — plan §4.4 step 7: "Everyone looking at that run, in any
  // channel, sees the same settled card." The byte comparison above already
  // pins each host against its own capture; this states the claim directly, so a
  // future host that starts drawing its own settled reading fails on the
  // sentence it broke rather than on a fixture diff.
  it("draws the SAME settled card on every host — the review page included", async () => {
    // The frame is the ONE thing a host may change (§IX): the root's class and
    // its host marker are normalized away, exactly as the §IX suite in
    // `review-gate-card.test.tsx` normalizes them for the pending card. What
    // remains is the reading itself, and it must be byte-identical.
    const readingOf = (html: string): string => {
      const holder = document.createElement("div");
      holder.innerHTML = html;
      const root = holder.querySelector('[data-conformance-id="review-gate-card"]');
      if (!root) return "";
      root.removeAttribute("class");
      root.removeAttribute("data-lifecycle-card-host");
      return root.innerHTML;
    };

    for (const outcome of ["approved", "rejected"] as const) {
      const drawn: Record<string, string> = {};
      for (const host of HOSTS) {
        drawn[host] = readingOf(
          await renderCase(host, {
            state: "settled",
            outcome,
            decidedByName: "Ada Lovelace",
          }),
        );
      }
      for (const host of HOSTS) {
        expect(drawn[host], `${host} draws its own settled card`).toBe(
          drawn.chat_thread,
        );
        expect(drawn[host]).toContain(`data-review-outcome="${outcome}"`);
        expect(drawn[host]).toContain("Ada Lovelace");
      }
    }
  });
});
