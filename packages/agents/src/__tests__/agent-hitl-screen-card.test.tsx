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
//     values with `approved` — through the SAME review-task action on a cookie
//     host, and through the BROKER SUBMIT on a credential-declaring one, so the
//     widget's Continue acts rather than being drawn inert;
//   · and the cookie-bound action is UNREACHABLE from the widget: a frame that
//     is same-origin to the app must never answer a gate as whoever else is
//     signed in on that browser.

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
const rendererContextMock = vi.fn(async () => ({
  connectedApps: ["gmail"],
  gmailAliases: [{ sendAsEmail: "me@example.com" }],
}));
vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: () => rendererContextMock(),
}));

vi.mock("../hitl-actions", () => ({
  approveReviewTask: (taskId: string, values?: unknown, fieldName?: string) =>
    approveMock(taskId, values, fieldName),
  rejectReviewTask: vi.fn(async () => undefined),
}));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { fieldRendererRegistry } from "../field-renderer-registry";
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

/** A gate whose renderer reaches the server on its OWN cookie — the shape the
 *  card must not mount where there is no session to reach it with. */
const COOKIE_BOUND_ASKING = {
  ...ASKING,
  gate: { ...ASKING.gate, xRenderer: "@cinatra-ai/email-outreach-agent:list-picker" },
};

/** The four hosts the parity ratchet records for this kind. */
const RECORDED_HOSTS: LifecycleCardHost[] = [
  "chat_thread",
  "site_widget",
  "run_card",
  "page_gate_region",
];

/**
 * TWO REGISTRY ENTRIES, so the card's rule is measured rather than the shipped
 * binding table.
 *
 * The card mounts a field renderer without a cookie session only when the
 * resolved entry declares `credentialSafe` — absent means unsafe. Which SHIPPED
 * kinds may declare it is a different question, pinned against their own
 * sources by `hitl-screen-credential-safety.test.ts`. Here the two answers are
 * given directly, so these arms cannot drift with the binding table.
 */
const SAFE_MARKER = "safe-renderer-mounted";
const BOUND_MARKER = "cookie-bound-renderer-mounted";

function registerRendererFixtures(): void {
  fieldRendererRegistry.clear();
  fieldRendererRegistry.register({
    id: "@cinatra-ai/test:session-free",
    priority: 90,
    condition: (_f, _s, ctx) => ctx.xRenderer === ASKING.gate.xRenderer,
    renderer: () => <span>{SAFE_MARKER}</span>,
    credentialSafe: true,
  });
  fieldRendererRegistry.register({
    id: "@cinatra-ai/test:cookie-bound",
    priority: 90,
    // Deliberately an id that does NOT end in the kind it mounts — the shape an
    // id-shaped predicate got wrong, and the reason the answer rides the ENTRY.
    condition: (_f, _s, ctx) => ctx.xRenderer === COOKIE_BOUND_ASKING.gate.xRenderer,
    renderer: () => <span>{BOUND_MARKER}</span>,
  });
}

/** A non-cookie host must declare a credential, or the provider refuses it. */
const WIDGET_AUTH = {
  headers: () => ({ Authorization: "Bearer cwu_site" }),
  credentials: "omit" as const,
};

let originalFetch: typeof globalThis.fetch;
/** Every request the card issued, in order — url + parsed body + init. */
let requests: Array<{ url: string; body: Record<string, unknown>; init: RequestInit }>;
/** What the broker submit route answers. Overridden per arm. */
let submitOutcome: { ok: boolean; error?: string };

beforeEach(() => {
  registerRendererFixtures();
  screenStateMock.mockImplementation(async () => ASKING);
  approveMock.mockClear();
  originalFetch = globalThis.fetch;
  requests = [];
  submitOutcome = { ok: true };
  // The BROKER arm: a credential-declaring host reads AND answers through the
  // routes rather than the cookie action, so the widget's server has to answer
  // both — the read from the SAME state the cookie arm resolves, so neither arm
  // is fed a different truth, and the submit with the route's own outcome body.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    } catch {
      body = {};
    }
    requests.push({ url, body, init: init ?? {} });
    if (url.endsWith("/hitl-screen/submit")) {
      return new Response(JSON.stringify({ outcome: submitOutcome }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(ASKING), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  fieldRendererRegistry.clear();
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

  it("is ENABLED on the site widget, exactly as it is in the app", async () => {
    const mounted = mountOn("site_widget");
    await settle();
    const button = await waitFor(() => {
      const found = mounted.container.querySelector<HTMLButtonElement>(
        '[data-action="submit-hitl-screen"]',
      );
      if (!found) throw new Error("no Continue");
      return found;
    });
    // The platform rule for this surface: through the widget a person
    // authenticates to Cinatra and has the SAME rights they have inside it. The
    // control acts because the reader's own credential can carry the answer.
    expect(button.disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The widget's answer — through the reader's OWN credential
// ---------------------------------------------------------------------------

describe("the broker submit", () => {
  async function pressContinueOn(host: LifecycleCardHost) {
    const mounted = mountOn(host);
    await settle();
    const button = await waitFor(() => {
      const found = mounted.container.querySelector<HTMLButtonElement>(
        '[data-action="submit-hitl-screen"]',
      );
      if (!found) throw new Error("no Continue");
      return found;
    });
    await act(async () => {
      button.click();
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
    await settle();
    return mounted;
  }

  it("the widget posts the SAME answer, addressed by the run AND the gate", async () => {
    await pressContinueOn("site_widget");
    const submits = requests.filter((r) => r.url.endsWith("/hitl-screen/submit"));
    expect(submits, "the widget's Continue issued no broker submit").toHaveLength(1);
    const [submit] = submits;
    expect(submit.url).toBe("/api/lifecycle-views/hitl-screen/submit");
    expect(submit.init.method).toBe("POST");
    // The run the transcript names AND the gate the card was drawing — the
    // server re-derives the run's own gate and refuses a mismatch.
    expect(submit.body.runId).toBe(RUN_ID);
    expect(submit.body.reviewTaskId).toBe(ASKING.gate.reviewTaskId);
    // The SAME answer the run panel submits: the buffered values with the
    // approval envelope on top.
    const values = submit.body.values as Record<string, unknown>;
    expect(values.approved).toBe(true);
    expect(typeof values.approvedAt).toBe("string");
  });

  it("carries the reader's own credential and NO ambient cookie", async () => {
    await pressContinueOn("site_widget");
    const submit = requests.find((r) => r.url.endsWith("/hitl-screen/submit"))!;
    const headers = submit.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer cwu_site");
    // THE LOAD-BEARING HALF. The embed frame is same-origin to the app, so a
    // request that sent cookies would let an ambient Cinatra session belonging
    // to whoever else uses this browser answer the gate.
    expect(submit.init.credentials).toBe("omit");
  });

  it("the AMBIENT-COOKIE action is never reached from the widget", async () => {
    // The negative that matters most: not "the broker was used" but "the cookie
    // door was not". A card that called both would still pass the arm above.
    await pressContinueOn("site_widget");
    expect(approveMock, "the widget reached the cookie-bound server action").not.toHaveBeenCalled();
  });

  it("a COOKIE host keeps the server action and issues no broker submit", async () => {
    await pressContinueOn("run_card");
    expect(approveMock).toHaveBeenCalledTimes(1);
    expect(requests.filter((r) => r.url.endsWith("/hitl-screen/submit"))).toHaveLength(0);
  });

  it("after the answer lands the card RE-READS its state and settles", async () => {
    await pressContinueOn("site_widget");
    const reads = requests.filter((r) => r.url === "/api/lifecycle-views/hitl-screen");
    // The mount read, and the re-read the landed submit triggers.
    expect(reads.length).toBeGreaterThanOrEqual(2);
    expect(reads[reads.length - 1].body.runId).toBe(RUN_ID);
  });

  it("a REFUSED answer leaves the screen exactly as it was", async () => {
    submitOutcome = { ok: false, error: "This question could not be answered from here." };
    const mounted = await pressContinueOn("site_widget");
    // The card is still there, still asking, and the Continue is live again —
    // the reader's answer is still in hand rather than silently discarded.
    const root = mounted.container.querySelector<HTMLElement>(
      '[data-lifecycle-card="agent_hitl_screen"]',
    );
    expect(root).not.toBeNull();
    expect(root!.getAttribute("data-lifecycle-card-state")).toBe("asking");
    const button = mounted.container.querySelector<HTMLButtonElement>(
      '[data-action="submit-hitl-screen"]',
    );
    expect(button!.disabled).toBe(false);
    // AND THE CARD RE-READ ANYWAY. The commonest reason a submit is refused is
    // that the gate was already answered somewhere else — so a refusal is a
    // moment the truth may have changed, and the card settles on the truth
    // rather than on the outcome of one request.
    const reads = requests.filter((r) => r.url === "/api/lifecycle-views/hitl-screen");
    expect(reads.length).toBeGreaterThanOrEqual(2);
  });

  it("a renderer that talks on its OWN cookie is NOT mounted on the widget", async () => {
    // The hazard: the card's read and submit omit cookies, but a field renderer
    // that calls its own server action does not — and the embed frame is
    // same-origin to the app, so that action answers as whoever else is signed
    // in on this browser. The card refuses to mount those renderers here.
    screenStateMock.mockImplementation(async () => COOKIE_BOUND_ASKING);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, body: {}, init: init ?? {} });
      if (url.endsWith("/hitl-screen/submit")) {
        return new Response(JSON.stringify({ outcome: submitOutcome }), { status: 200 });
      }
      return new Response(JSON.stringify(COOKIE_BOUND_ASKING), { status: 200 });
    }) as unknown as typeof fetch;

    const mounted = mountOn("site_widget");
    await settle();
    const root = await waitFor(() => {
      const found = mounted.container.querySelector<HTMLElement>(
        '[data-lifecycle-card="agent_hitl_screen"]',
      );
      if (!found) throw new Error("no card root");
      return found;
    });
    // The card and its fields region are STILL DRAWN — the identity a capture is
    // graded on survives the containment.
    const fields = root.querySelector<HTMLElement>('[data-conformance-id="hitl-screen-fields"]');
    expect(fields, "the fields region was dropped, not just its renderer").not.toBeNull();
    // …and the renderer that would have reached the server on the ambient
    // cookie is NOT in it, so it never issues its request.
    expect(fields!.textContent).not.toContain(BOUND_MARKER);
    // …and nothing can be submitted for it either, in EITHER of the two shapes
    // this gate class takes: a mid-run gate draws the outer Continue and it is
    // withheld; a setup-loop gate submits on the renderer's own change, and
    // with no renderer there is no change to submit and no Continue at all.
    const button = root.querySelector<HTMLButtonElement>('[data-action="submit-hitl-screen"]');
    expect(button === null || button.disabled, "a value could still be submitted").toBe(true);
    expect(approveMock).not.toHaveBeenCalled();
    expect(requests.filter((r) => r.url.endsWith("/hitl-screen/submit"))).toHaveLength(0);
  });

  it("the SAME gate keeps its renderer on a cookie host", async () => {
    // The containment is about the ABSENCE of a session, not about the kind of
    // gate: on the run page the renderer's own action is the reader's own
    // session, which is exactly what it has always been.
    screenStateMock.mockImplementation(async () => COOKIE_BOUND_ASKING);
    const mounted = mountOn("run_card");
    await settle();
    const fields = await waitFor(() => {
      const found = mounted.container.querySelector<HTMLElement>(
        '[data-conformance-id="hitl-screen-fields"]',
      );
      if (!found) throw new Error("no fields region");
      return found;
    });
    expect(fields.textContent).toContain(BOUND_MARKER);
  });

  it("a COOKIE host hands the renderer the reader's CONNECTED ACCOUNTS", async () => {
    // The regression this closes: inside a conversation the run panel stands
    // DOWN in favour of this card, and the panel is what used to load the
    // reader's connected sending accounts. A shipped condition — the Gmail
    // sender picker — matches only when those are present, so without the card
    // loading them a signed-in reader with Gmail connected would be handed the
    // plain schema fallback instead of their alias picker.
    let seen: Record<string, unknown> | null = null;
    fieldRendererRegistry.clear();
    fieldRendererRegistry.register({
      id: "@cinatra-ai/test:context-probe",
      priority: 90,
      condition: (_f, _s, ctx) => ctx.xRenderer === ASKING.gate.xRenderer,
      renderer: (props) => {
        seen = props.context as unknown as Record<string, unknown>;
        return <span>{SAFE_MARKER}</span>;
      },
      credentialSafe: true,
    });

    mountOn("chat_thread");
    await settle();
    await waitFor(() => {
      if (!seen || !(seen as { connectedApps?: string[] }).connectedApps?.length) {
        throw new Error("the renderer never saw the loaded context");
      }
    });
    expect(rendererContextMock).toHaveBeenCalled();
    expect((seen as unknown as { connectedApps: string[] }).connectedApps).toEqual(["gmail"]);
    expect(
      (seen as unknown as { gmailAliases?: unknown[] }).gmailAliases,
    ).toHaveLength(1);
  });

  it("the WIDGET never calls that cookie-bound loader, and sees no connectivity", async () => {
    // The other half, and the reason the loader is host-gated: the action is
    // cookie-bound, so calling it from a frame that is same-origin to the app
    // would answer with whoever else is signed in on that browser's connected
    // accounts. The widget's renderer is handed the honest empty list instead,
    // which makes a connectivity-gated renderer decline rather than draw
    // against connectivity this surface cannot prove.
    let seen: Record<string, unknown> | null = null;
    fieldRendererRegistry.clear();
    fieldRendererRegistry.register({
      id: "@cinatra-ai/test:context-probe",
      priority: 90,
      condition: (_f, _s, ctx) => ctx.xRenderer === ASKING.gate.xRenderer,
      renderer: (props) => {
        seen = props.context as unknown as Record<string, unknown>;
        return <span>{SAFE_MARKER}</span>;
      },
      credentialSafe: true,
    });

    mountOn("site_widget");
    await settle();
    await waitFor(() => {
      if (!seen) throw new Error("the renderer never mounted");
    });
    expect(rendererContextMock, "the widget reached a cookie-bound loader").not.toHaveBeenCalled();
    expect((seen as unknown as { connectedApps: string[] }).connectedApps).toEqual([]);
  });

  it("a SESSION-FREE renderer IS mounted on the widget", async () => {
    // The containment is not a blanket refusal: a renderer that reaches no
    // server action of its own and re-enters no registry is drawn there, which
    // is what makes the widget's screen the same screen.
    const mounted = mountOn("site_widget");
    await settle();
    const fields = await waitFor(() => {
      const found = mounted.container.querySelector<HTMLElement>(
        '[data-conformance-id="hitl-screen-fields"]',
      );
      if (!found) throw new Error("no fields region");
      return found;
    });
    expect(fields.textContent).toContain(SAFE_MARKER);
  });

  it("resolves against the REAL shipped registry without throwing, on every host", async () => {
    // THE FIXTURE-ONLY BLIND SPOT (convergence). The arms above clear the
    // registry and install two entries, so they measure the card's RULE and
    // cannot see what the SHIPPED conditions do to the context this card hands
    // them. The registry evaluates conditions by PRIORITY, so a high-priority
    // condition runs for every gate — and one of them reads
    // `context.connectedApps` before anything narrows to its own renderer. A
    // context missing it threw on the way to an unrelated gate's renderer, and
    // an `as` assertion hid that from the compiler.
    //
    // So this arm drives the REAL table: registered exactly as the app
    // registers it, and mounted on every host the ratchet records.
    const { ensureDefaultFieldRenderersRegistered } = await import(
      "../register-default-renderers"
    );
    fieldRendererRegistry.clear();
    ensureDefaultFieldRenderersRegistered();
    expect(
      fieldRendererRegistry.list().length,
      "the shipped registry registered nothing — this arm would prove nothing",
    ).toBeGreaterThan(0);

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
      expect(
        root.querySelector('[data-conformance-id="hitl-screen-fields"]'),
        `${host} lost its fields region against the real registry`,
      ).not.toBeNull();
      cleanup();
    }
  });

  it("a frame whose credential the provider REFUSED draws no card and answers nothing", async () => {
    // The binding is what makes the answer this person's answer. A widget
    // declaration the provider rejected — a dropped `auth` prop, a credential
    // that is not `credentials: "omit"` — declares NO host at all, so there is
    // no card, no read and no submit. That is the fail-closed shape, and it is
    // what stands between a same-origin frame and the ambient cookie.
    const mounted = render(
      <LifecycleCardSurfaceProvider
        host="site_widget"
        auth={{ headers: () => ({}), credentials: "include" }}
        frame={{ assistant: "a", instanceId: "i" }}
      >
        <AgentHitlScreenCard runId={RUN_ID} wireRef="task-2930" />
      </LifecycleCardSurfaceProvider>,
    );
    await settle();
    expect(
      mounted.container.querySelector('[data-lifecycle-card="agent_hitl_screen"]'),
    ).toBeNull();
    expect(requests).toHaveLength(0);
    expect(approveMock).not.toHaveBeenCalled();
  });
});
