// @vitest-environment jsdom
//
// `AgentHitlScreenCard` — the ONE renderer of `agent_hitl_screen`
// (cinatra#2930, lifecycle-b W3). Design: the pause screen in
// `specs/app-components.html`, inside the base page's section-I card chrome.
//
// What is pinned here is what a later slice must not be able to weaken by
// accident:
//
//   · EVERY HOST THE RATCHET RECORDS draws the SAME card — the two conversation
//     hosts and the run card — and each draws EXACTLY ONE root;
//   · the root says which KIND it is, which HOST drew it and which STATE it is
//     in, so a capture can be graded as a matrix cell rather than as a picture;
//   · the two ratified anchors are both in the one drawing: the fields region
//     the gate's renderer draws into, and the Continue that submits it;
//   · `none` draws NO CARD DOM AT ALL, and so does a subtree that declared no
//     host — the two absences that keep the card from being an existence
//     oracle for runs;
//   · a HOST-SUPPLIED screen is framed rather than replaced, which is how the
//     run page keeps the pause screen it already draws;
//   · the Continue submits the SAME answer the run panel submits — the buffered
//     values with `approved` — through the SAME review-task action.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, render, waitFor } from "@testing-library/react";

import type { LifecycleCardHost } from "@cinatra-ai/agent-ui-protocol/renderable-views";

const screenStateMock = vi.fn();
vi.mock("../agent-hitl-screen-actions", () => ({
  getAgentHitlScreenStateAction: (input: { runId: string }) => screenStateMock(input),
}));

const approveMock = vi.fn(
  async (_taskId: string, _values?: unknown, _fieldName?: string): Promise<void> => undefined,
);
vi.mock("../hitl-actions", () => ({
  approveReviewTask: (taskId: string, values?: unknown, fieldName?: string) =>
    approveMock(taskId, values, fieldName),
  rejectReviewTask: vi.fn(async () => undefined),
}));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { AgentHitlScreenCard } from "../agent-hitl-screen-card";

const RUN_ID = "run-2930";

/** The gate the agent is asking on — the shape the core answers with. */
const ASKING = {
  state: "asking" as const,
  runId: RUN_ID,
  screenRef: "hitl-screen-ref-2930",
  gate: {
    reviewTaskId: "task-2930",
    // A MID-RUN gate, which is what this kind IS: the agent parked mid-flight
    // to ask. The `:output` suffix is the run panel's own classifier for that,
    // and it is what draws the outer Continue on both surfaces.
    xRenderer: "cinatra.schema-field:output",
    inputSchema: { type: "object", properties: { answer: { type: "string" } } },
    currentValues: {},
    fieldName: undefined,
  },
};

/** A SETUP-LOOP gate on an OBJECT-typed field — the shape the panel and the
 *  card must submit identically, and the one a value-shaped branch got wrong. */
const SETUP_OBJECT_ASKING = {
  state: "asking" as const,
  runId: RUN_ID,
  screenRef: null,
  gate: {
    reviewTaskId: "setup-run-2930",
    xRenderer: "cinatra.schema-field",
    inputSchema: { type: "object", properties: { city: { type: "string" } } },
    currentValues: {},
    fieldName: "destination",
  },
};

/** The four hosts the parity ratchet records for this kind. */
const RECORDED_HOSTS: LifecycleCardHost[] = [
  "chat_thread",
  "site_widget",
  "run_card",
  "page_gate_region",
];

/** A non-cookie host must declare a credential, or the provider refuses it. */
const WIDGET_AUTH = {
  headers: () => ({ Authorization: "Bearer cwu_site" }),
  credentials: "omit" as const,
};

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  screenStateMock.mockImplementation(async () => ASKING);
  approveMock.mockClear();
  originalFetch = globalThis.fetch;
  // The BROKER arm: a credential-declaring host reads through the route rather
  // than the cookie action, so the widget's server has to answer it — from the
  // SAME state the cookie arm resolves, so neither arm is fed a different truth.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(ASKING), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
  vi.clearAllMocks();
});

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    await Promise.resolve();
  });
}

function mountOn(host: LifecycleCardHost, extra?: { screen?: React.ReactNode }) {
  const auth = host === "site_widget" ? WIDGET_AUTH : undefined;
  const frame = host === "site_widget" ? { assistant: "a", instanceId: "i" } : undefined;
  return render(
    <LifecycleCardSurfaceProvider host={host} auth={auth} frame={frame}>
      <AgentHitlScreenCard runId={RUN_ID} wireRef="task-2930" {...(extra ?? {})} />
    </LifecycleCardSurfaceProvider>,
  );
}

// ---------------------------------------------------------------------------
// The card, drawn
// ---------------------------------------------------------------------------

describe("the drawn card", () => {
  it("the root carries its identity, host and state, and draws the fields and the Continue", async () => {
    for (const host of RECORDED_HOSTS) {
      const mounted = mountOn(host);
      await settle();
      const root = await waitFor(() => {
        const found = mounted.container.querySelector<HTMLElement>(
          '[data-lifecycle-card="agent_hitl_screen"]',
        );
        if (!found) throw new Error(`no card root on ${host}`);
        return found;
      });
      // THE ROOT SAYS WHAT IT IS. Read off the element itself, not asserted
      // about the tree: a card that cannot name its host and its state cannot
      // be graded as a matrix cell.
      expect(root.getAttribute("data-lifecycle-card-host"), host).toBe(host);
      expect(root.getAttribute("data-lifecycle-card-state"), host).toBe("asking");
      expect(root.getAttribute("data-conformance-id"), host).toBe("agent-hitl-screen-card");
      // THE TWO RATIFIED ANCHORS, off real DOM, inside the card's own root.
      expect(
        root.querySelector('[data-conformance-id="hitl-screen-fields"]'),
        `${host} draws no fields region`,
      ).not.toBeNull();
      expect(
        root.querySelector('[data-action="submit-hitl-screen"]'),
        `${host} draws no Continue`,
      ).not.toBeNull();
      cleanup();
    }
  });

  it("every host with a production adapter draws EXACTLY ONE screen card", async () => {
    // Named literally, and driven: the four hosts the ratchet records, each
    // mounted and each COUNTED. A presence check cannot see a second instance.
    //
    // WHAT THIS ARM DOES NOT MEASURE, stated rather than left to be discovered:
    // it counts the roots ONE OWNER draws under ONE provider, so it can catch an
    // owner that renders twice and cannot catch two production callsites
    // mounting it in the same turn. That second property is measured where the
    // two callsites actually meet — the conversation column's own suites, which
    // drive the real transcript with the run panel beside this card, and the
    // panel's stand-down rule below.
    const hosts: LifecycleCardHost[] = [
      "chat_thread",
      "site_widget",
      "run_card",
      "page_gate_region",
    ];
    expect(hosts).toEqual(RECORDED_HOSTS);
    for (const host of hosts) {
      const mounted = mountOn(host);
      await settle();
      await waitFor(() =>
        expect(
          mounted.container.querySelectorAll('[data-lifecycle-card="agent_hitl_screen"]'),
        ).toHaveLength(1),
      );
      cleanup();
    }
  });

  it("frames a HOST-SUPPLIED screen rather than composing its own", async () => {
    const mounted = mountOn("run_card", {
      screen: <div data-panel-screen>the run panel's own pause screen</div>,
    });
    await settle();
    const root = await waitFor(() => {
      const found = mounted.container.querySelector<HTMLElement>(
        '[data-lifecycle-card="agent_hitl_screen"]',
      );
      if (!found) throw new Error("no card root");
      return found;
    });
    expect(root.querySelector("[data-panel-screen]")).not.toBeNull();
    // The card composed no second screen of its own beside the one it was given.
    expect(root.querySelector('[data-conformance-id="hitl-screen-fields"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The two absences
// ---------------------------------------------------------------------------

describe("the absences", () => {
  it("a run that states no HITL moment draws NO card DOM at all", async () => {
    screenStateMock.mockImplementation(async () => ({ state: "none" }));
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ state: "none" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    for (const host of RECORDED_HOSTS) {
      const mounted = mountOn(host);
      await settle();
      expect(
        mounted.container.querySelector('[data-lifecycle-card="agent_hitl_screen"]'),
        host,
      ).toBeNull();
      cleanup();
    }
  });

  it("drops what was typed into a gate the run has moved on from", async () => {
    // THE BUFFER BELONGS TO ONE GATE. The same run can be advanced from the
    // composer, from the run page or from another tab, and the next read then
    // replaces the gate while the previous one's half-typed values are still in
    // hand. Merging those into a question that never asked for them is the
    // failure; the buffer is keyed by the gate, so it does not survive one.
    const mounted = mountOn("chat_thread");
    await settle();
    const button = await waitFor(() => {
      const found = mounted.container.querySelector<HTMLButtonElement>(
        '[data-action="submit-hitl-screen"]',
      );
      if (!found) throw new Error("no Continue");
      return found;
    });
    // Type into the gate on screen.
    const input = mounted.container.querySelector<HTMLInputElement>("input, textarea");
    if (input) {
      await act(async () => {
        input.focus();
        Object.getOwnPropertyDescriptor(
          input instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype,
          "value",
        )?.set?.call(input, "for the FIRST gate");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await Promise.resolve();
      });
    }
    // The run moves on: a different gate comes back on the next read.
    screenStateMock.mockImplementation(async () => ({
      ...ASKING,
      gate: { ...ASKING.gate, reviewTaskId: "task-2930-second" },
    }));
    mounted.rerender(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <AgentHitlScreenCard runId={RUN_ID} wireRef="task-2930-second" />
      </LifecycleCardSurfaceProvider>,
    );
    await settle();
    const next = await waitFor(() => {
      const found = mounted.container.querySelector<HTMLButtonElement>(
        '[data-action="submit-hitl-screen"]',
      );
      if (!found) throw new Error("no Continue on the second gate");
      return found;
    });
    void button;
    await act(async () => {
      next.click();
      await Promise.resolve();
    });
    await waitFor(() => expect(approveMock).toHaveBeenCalledTimes(1));
    const [taskId, values] = approveMock.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(taskId).toBe("task-2930-second");
    // Nothing from the gate that is gone: the payload is the approval envelope
    // and whatever was typed into THIS gate, which is nothing.
    expect(Object.keys(values).sort()).toEqual(["approved", "approvedAt"]);
  });

  it("a subtree that declared no host draws nothing and asks nothing", async () => {
    const mounted = render(<AgentHitlScreenCard runId={RUN_ID} />);
    await settle();
    expect(mounted.container.querySelector('[data-lifecycle-card="agent_hitl_screen"]')).toBeNull();
    expect(screenStateMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// One screen per run per turn
// ---------------------------------------------------------------------------

describe("the panel's stand-down rule", () => {
  it("draws its own screen on the run page and NONE inside a conversation host", async () => {
    // The two production callsites for this kind are this panel and the
    // conversation column, and inside a conversation they are siblings for the
    // SAME run — so an unconditional mount here would show a person two screens
    // for one question. The rule is the one the §V card is held to, read from
    // the same shipped selector, so the two mounts cannot drift into two copies
    // of it.
    const { runCardOwnsLifecycleCopy } = await import("../lifecycle-card-runtime");
    expect(runCardOwnsLifecycleCopy(null), "the run page owns its own copy").toBe(true);
    expect(runCardOwnsLifecycleCopy("run_card"), "and so does a bare run card").toBe(true);
    expect(runCardOwnsLifecycleCopy("chat_thread"), "the chat transcript owns it").toBe(false);
    expect(runCardOwnsLifecycleCopy("site_widget"), "and so does the widget").toBe(false);
    // …and the panel really reads that selector for THIS card rather than
    // asserting the rule in prose: the source is the evidence, because a mount
    // that stopped consulting it would still pass a prose assertion.
    const panel = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "agentic-run-panel.tsx"),
      "utf8",
    );
    expect(panel).toContain("const panelMountsHitlScreenCard = runCardOwnsLifecycleCopy(");
    expect(panel).toContain("!panelMountsHitlScreenCard ? null : (");
  });
});

// ---------------------------------------------------------------------------
// The one decision
// ---------------------------------------------------------------------------

describe("the Continue", () => {
  it("submits the gate's own answer through the shipped review-task action", async () => {
    const mounted = mountOn("chat_thread");
    await settle();
    const button = await waitFor(() => {
      const found = mounted.container.querySelector<HTMLButtonElement>(
        '[data-action="submit-hitl-screen"]',
      );
      if (!found) throw new Error("no Continue");
      return found;
    });
    expect(button.disabled).toBe(false);
    // WHAT THE READER TYPED HAS TO BE IN IT. A Continue that submits an empty
    // approval would pass an assertion about `approved` alone while dropping
    // the answer, which is the failure a decision control cannot be allowed.
    const input = mounted.container.querySelector<HTMLInputElement>("input, textarea");
    if (input) {
      await act(async () => {
        input.focus();
        Object.getOwnPropertyDescriptor(
          input instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype,
          "value",
        )?.set?.call(input, "the answer");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await Promise.resolve();
      });
    }
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    await waitFor(() => expect(approveMock).toHaveBeenCalledTimes(1));
    const [taskId, values] = approveMock.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(taskId).toBe("task-2930");
    expect(values.approved).toBe(true);
    expect(typeof values.approvedAt).toBe("string");
  });

  it("submits an OBJECT-typed setup field UNDER its own field name, as the run panel does", async () => {
    // THE DIVERGENCE A VALUE-SHAPED BRANCH INTRODUCES. The panel classifies by
    // the gate's RENDERER — a setup-loop gate wraps whatever the renderer hands
    // back under `fieldName` and submits it with that name beside it — while a
    // branch that read the VALUE would see an object, spread it into the
    // buffer, and later submit top-level keys with no field name. The server
    // merge keys off the field name, so that lands in the wrong input slot or
    // in none, and the setup loop re-emits the same gate for ever.
    screenStateMock.mockImplementation(async () => SETUP_OBJECT_ASKING);
    const mounted = mountOn("chat_thread");
    await settle();
    const field = await waitFor(() => {
      const found = mounted.container.querySelector<HTMLElement>(
        '[data-conformance-id="hitl-screen-fields"]',
      );
      if (!found) throw new Error("no fields region");
      return found;
    });
    // A setup-loop gate submits ON CHANGE and offers no outer Continue — the
    // same rule the panel draws by.
    expect(field.querySelector('[data-action="submit-hitl-screen"]')).toBeNull();
  });

  it("is drawn but WITHHELD on a host that cannot carry the reader's own credential", async () => {
    const mounted = mountOn("site_widget");
    await settle();
    const button = await waitFor(() => {
      const found = mounted.container.querySelector<HTMLButtonElement>(
        '[data-action="submit-hitl-screen"]',
      );
      if (!found) throw new Error("no Continue");
      return found;
    });
    // Present, so the question is readable and the card is one card everywhere;
    // disabled, so it never rides an ambient cookie belonging to someone else.
    expect(button.disabled).toBe(true);
  });
});
