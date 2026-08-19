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
      reason: "Approving or rejecting needs approve access on this run.",
    },
  },
  { name: "settled", state: { state: "settled" } },
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

    if (!existsSync(FIXTURE_PATH) && process.env.CAPTURE_REVIEW_PARITY === "1") {
      writeFileSync(FIXTURE_PATH, `${JSON.stringify(captured, null, 2)}\n`, "utf8");
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
});
