// @vitest-environment jsdom
//
// §I INPUT HIERARCHY — THE MID-RUN GATE'S SEND, IN A CONVERSATION (cinatra#3051,
// fix leg 9).
//
// The ratified drawing at the contract's pin, §I, "The rule, wherever a card
// meets a chat box", verbatim:
//
//   "Exactly one primary input is drawn per conversation, and it is the chat
//    box. Any field a card carries is drawn subordinate to it."
//
// and the subordinate treatment it names:
//
//   "No box of its own, no fill, no send. A ruled baseline under a mono label —
//    it reads as a field on the card, not as somewhere to start typing."
//
// THE HOLE THIS CLOSES, which the card's own source named before this file did:
// "a MID-RUN gate, where the card ALREADY draws its own Continue and the
// renderer keeps whatever control it has. Nothing about that screen moves here.
// A mid-run renderer that draws its own send inside the region on a conversation
// host is a §I hole this does not close". The ninth proof round answered a
// mid-run selection step inside the widget, and that is the screen the hole is
// on: the card draws its Continue outside the region AND the renderer draws its
// own send inside it, so the conversation carries two sends and the subordinate
// field reads as somewhere to type — the second primary input the rule exists to
// forbid, drawn directly over the chat box it is supposed to be subordinate to.
//
// So the mid-run send moves the same way the setup send did: on a conversation
// host it is the CARD'S — the card's own Continue, outside the region — and the
// renderer's own submit is not drawn inside it. The run page and the review page
// keep the primary treatment and the renderer's own button exactly as they were.
//
// WHAT IS DELIBERATELY LEFT ALONE, and stated rather than hidden: a GROUPED-SETUP
// form owns ONE submit for the whole form and resolves its own children, so the
// card draws no Continue for it on any host and cannot take the form's over.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";

import type { LifecycleCardHost } from "@cinatra-ai/agent-ui-protocol/renderable-views";

const screenStateMock = vi.fn();
vi.mock("../agent-hitl-screen-actions", () => ({
  getAgentHitlScreenStateAction: (input: { runId: string }) => screenStateMock(input),
}));
vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: async () => ({ connectedApps: [] }),
}));
// THE MOCK HONOURS THE SHIPPED CONTRACT. `approveReviewTask` returns a typed
// `GateSubmitOutcome` (cinatra#3219) — `{ ok: true }` on a landing — and the card
// reads `outcome.ok` to decide whether the answer LANDED. A mock resolving to
// `undefined` makes that read throw, the card correctly classifies the throw as
// a refusal, and a refusal is exactly the case where what the reader typed is
// kept in hand. So a void mock cannot express a landing at all, and the
// clear-on-landing this file exists to prove is never reached. It resolves to
// the shipped shape instead.
const approveMock = vi.fn<(...args: unknown[]) => Promise<{ ok: boolean; error?: string }>>(
  async () => ({ ok: true }),
);
vi.mock("../hitl-actions", () => ({
  approveReviewTask: (...a: unknown[]) => approveMock(...a),
  rejectReviewTask: vi.fn(async () => undefined),
}));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { fieldRendererRegistry } from "../field-renderer-registry";
import { AgentHitlScreenCard } from "../agent-hitl-screen-card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

const RUN_ID = "run-3051-midrun";
const FIELDS_REGION = '[data-conformance-id="hitl-screen-fields"]';
const CONTINUE = '[data-action="submit-hitl-screen"]';

/** A MID-RUN gate — the shape the ninth proof round answered inside the widget:
 *  a selection step, not a setup-loop field and not a grouped-setup form. */
const MID_RUN = {
  state: "asking" as const,
  runId: RUN_ID,
  screenRef: "hitl-screen-ref-3051",
  gate: {
    reviewTaskId: "task-3051-midrun",
    xRenderer: "cinatra.selection:output",
    inputSchema: { type: "object", properties: { choice: { type: "string" } } },
    currentValues: {},
    fieldName: undefined,
  },
};

/** How many times the renderer was told to withhold its own send. */
let hideSubmitSeen: boolean[] = [];

/**
 * A mid-run renderer shaped like the shipped selection screens: a field and its
 * OWN submit, which it draws unless the host withholds it through the shared
 * props contract. Honouring `hideSubmit` is what a shipped renderer does; a
 * renderer that ignored it would draw its button whatever the card asked, which
 * is why the contract half is asserted beside the drawn half below.
 */
function registerMidRunRenderer(): void {
  fieldRendererRegistry.clear();
  fieldRendererRegistry.register({
    id: "@cinatra-ai/test:mid-run-selection",
    priority: 90,
    condition: (_f, _s, ctx) => ctx.xRenderer === MID_RUN.gate.xRenderer,
    renderer: (props: { hideSubmit?: boolean }) => {
      hideSubmitSeen.push(props.hideSubmit === true);
      return (
        <div className="flex flex-col gap-2">
          <label htmlFor="field-choice">Choose one</label>
          <Textarea id="field-choice" />
          {props.hideSubmit === true ? null : (
            <Button type="button" data-testid="renderer-own-send">
              Continue
            </Button>
          )}
        </div>
      );
    },
    credentialSafe: true,
  });
}

const WIDGET_AUTH = {
  headers: () => ({ Authorization: "Bearer cwu_site" }),
  credentials: "omit" as const,
};

const SUBORDINATE_HOSTS: LifecycleCardHost[] = ["chat_thread", "site_widget"];
const PRIMARY_HOSTS: LifecycleCardHost[] = ["run_card", "page_gate_region"];

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  hideSubmitSeen = [];
  registerMidRunRenderer();
  screenStateMock.mockImplementation(async () => MID_RUN);
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(MID_RUN), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
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

function mountOn(host: LifecycleCardHost) {
  const auth = host === "site_widget" ? WIDGET_AUTH : undefined;
  const frame = host === "site_widget" ? { assistant: "a", instanceId: "i" } : undefined;
  return render(
    <LifecycleCardSurfaceProvider host={host} auth={auth} frame={frame}>
      <AgentHitlScreenCard runId={RUN_ID} wireRef="task-3051-midrun" />
    </LifecycleCardSurfaceProvider>,
  );
}

async function regionOn(host: LifecycleCardHost): Promise<HTMLElement> {
  const mounted = mountOn(host);
  await settle();
  return waitFor(() => {
    const found = mounted.container.querySelector<HTMLElement>(FIELDS_REGION);
    if (!found) throw new Error(`no fields region on ${host}`);
    return found;
  });
}

describe("§I — a mid-run gate in a conversation carries no send inside the field", () => {
  it.each(SUBORDINATE_HOSTS)("%s: the region draws nothing to press", async (host) => {
    const region = await regionOn(host);
    expect(
      region.querySelector('[data-testid="renderer-own-send"]'),
      "the renderer's own send, inside the subordinate field",
    ).toBeNull();
    expect(region.querySelector("button"), "any send affordance inside the region").toBeNull();
  });

  it.each(SUBORDINATE_HOSTS)("%s: the card asks the renderer to withhold it", async (host) => {
    await regionOn(host);
    expect(hideSubmitSeen.length, "the renderer was mounted").toBeGreaterThan(0);
    expect(
      hideSubmitSeen.every((seen) => seen === true),
      "every mount of the renderer was told the card owns the send",
    ).toBe(true);
  });

  it.each(SUBORDINATE_HOSTS)("%s: the region says the card owns the send", async (host) => {
    const region = await regionOn(host);
    expect(region.getAttribute("data-send-affordance")).toBe("card");
    expect(region.getAttribute("data-field-presentation")).toBe("subordinate");
  });

  it.each(SUBORDINATE_HOSTS)("%s: exactly one send stands, and it is the card's", async (host) => {
    const mounted = mountOn(host);
    await settle();
    const card = await waitFor(() => {
      const found = mounted.container.querySelector<HTMLElement>(
        '[data-lifecycle-card="agent_hitl_screen"]',
      );
      if (!found) throw new Error(`no card on ${host}`);
      return found;
    });
    expect(card.querySelectorAll(CONTINUE), "the card's own Continue").toHaveLength(1);
    expect(card.querySelectorAll("button"), "every button on the card").toHaveLength(1);
    expect(card.querySelector(CONTINUE)!.closest(FIELDS_REGION), "drawn outside the field").toBeNull();
  });
});

describe("§I — with no chat box to be subordinate to, the renderer keeps its own send", () => {
  it.each(PRIMARY_HOSTS)("%s: the renderer's own control is untouched", async (host) => {
    const region = await regionOn(host);
    expect(
      region.querySelector('[data-testid="renderer-own-send"]'),
      "the page hosts keep the shipped screen exactly as it was",
    ).not.toBeNull();
    expect(region.getAttribute("data-send-affordance"), "no card-owned send here").toBeNull();
    expect(hideSubmitSeen.every((seen) => seen === false)).toBe(true);
  });
});

describe("§I — the answer the card sent is not sent twice", () => {
  // THE MIRROR AND THE BUFFER IT MIRRORS ARE CLEARED TOGETHER. The card's own
  // Continue reads the ref rather than the render's snapshot (a flush's state
  // write is not readable in the same turn), so a landing that cleared only the
  // rendered buffer would leave the ref holding the answer just sent — and the
  // gate's key does not change at the moment it lands, because the card
  // re-reads and the same question can still be on screen for a beat. A second
  // press would then re-send what the reader can see is no longer in the field.
  it("chat_thread: a second press after a landing carries nothing of the first", async () => {
    fieldRendererRegistry.clear();
    fieldRendererRegistry.register({
      id: "@cinatra-ai/test:mid-run-buffers-on-change",
      priority: 95,
      condition: (_f, _s, ctx) => ctx.xRenderer === MID_RUN.gate.xRenderer,
      renderer: (props: { onChange?: (next: unknown) => void | Promise<void> }) => (
        <Button
          type="button"
          data-testid="renderer-types"
          onClick={() => void props.onChange?.({ choice: "the first answer" })}
        >
          type
        </Button>
      ),
      credentialSafe: true,
    });

    const mounted = mountOn("chat_thread");
    await settle();
    const typed = await waitFor(() => {
      const found = mounted.container.querySelector<HTMLElement>('[data-testid="renderer-types"]');
      if (!found) throw new Error("no renderer");
      return found;
    });
    await act(async () => {
      typed.click();
    });
    const press = async () => {
      const button = mounted.container.querySelector<HTMLElement>(CONTINUE)!;
      await act(async () => {
        button.click();
      });
      await settle();
    };

    await press();
    expect(approveMock, "the first press sends what was typed").toHaveBeenCalledTimes(1);
    expect(
      (approveMock.mock.calls[0]![1] as Record<string, unknown>).choice,
    ).toBe("the first answer");

    await press();
    expect(approveMock, "the second press was made").toHaveBeenCalledTimes(2);
    expect(
      (approveMock.mock.calls[1]![1] as Record<string, unknown>).choice,
      "the answer that already landed is not re-sent",
    ).toBeUndefined();
  });

  // AND THE MIRROR IS CLEARED ONLY BY A LANDING. A refusal is the case where the
  // answer must stay in hand: the gate did not take it, so the next press has to
  // carry the same answer again without the reader typing it a second time.
  it("chat_thread: a REFUSED press keeps the answer, and the next press re-sends it", async () => {
    fieldRendererRegistry.clear();
    fieldRendererRegistry.register({
      id: "@cinatra-ai/test:mid-run-buffers-on-change",
      priority: 95,
      condition: (_f, _s, ctx) => ctx.xRenderer === MID_RUN.gate.xRenderer,
      renderer: (props: { onChange?: (next: unknown) => void | Promise<void> }) => (
        <Button
          type="button"
          data-testid="renderer-types"
          onClick={() => void props.onChange?.({ choice: "the first answer" })}
        >
          type
        </Button>
      ),
      credentialSafe: true,
    });

    const mounted = mountOn("chat_thread");
    await settle();
    const typed = await waitFor(() => {
      const found = mounted.container.querySelector<HTMLElement>('[data-testid="renderer-types"]');
      if (!found) throw new Error("no renderer");
      return found;
    });
    await act(async () => {
      typed.click();
    });
    const press = async () => {
      const button = mounted.container.querySelector<HTMLElement>(CONTINUE)!;
      await act(async () => {
        button.click();
      });
      await settle();
    };

    approveMock.mockResolvedValueOnce({
      ok: false,
      error: "This question could not be answered from here.",
    });

    await press();
    expect(approveMock, "the refused press was made").toHaveBeenCalledTimes(1);
    expect(
      (approveMock.mock.calls[0]![1] as Record<string, unknown>).choice,
    ).toBe("the first answer");

    await press();
    expect(approveMock, "the reader could press again").toHaveBeenCalledTimes(2);
    expect(
      (approveMock.mock.calls[1]![1] as Record<string, unknown>).choice,
      "a refusal keeps the answer in hand, so the retry carries it again",
    ).toBe("the first answer");
  });
});
