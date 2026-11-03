// @vitest-environment jsdom
/**
 * cinatra#3380 — THE MOUNTED CARD KEEPS WHAT ITS RENDERER WRITES, FOR ONE GATE.
 *
 * The neighbouring file renders the Continue alone with a fixed buffer. This one
 * mounts the whole card, with a renderer of the pipeline idea step's shape:
 *
 *   - a renderer that writes its answer from a layout effect when it mounts (a
 *     list with nothing to pick answers with a no-pick value) keeps that write:
 *     the card's own gate-change effect runs after it and must not wipe it, or
 *     the Continue is held with nothing to press;
 *   - a later gate on the same renderer, with another review task, mounts a new
 *     renderer and starts with nothing;
 *   - a submit still in flight when that later gate arrives clears only its own
 *     gate's buffer when it lands, never what the later renderer wrote;
 *   - the same on the broker door, where a credential host reads and answers
 *     through the routes;
 *   - a setup press whose gate changes during its flush stops: it submits nothing,
 *     and what that flush hands over is no answer to the later gate;
 *   - the same when the gate leaves the screen during the flush (the run is no
 *     longer asking): nothing is sent;
 *   - a write from a renderer whose gate has left the screen is no answer: the
 *     gate that comes back is still held;
 *   - a gate with a presentation hint gets a new dispatch renderer for each gate.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const screenStateMock = vi.fn();
vi.mock("../agent-hitl-screen-actions", () => ({
  getAgentHitlScreenStateAction: (input: { runId: string }) => screenStateMock(input),
}));

const approveMock = vi.fn<
  (taskId: string, values?: unknown, fieldName?: string) => Promise<unknown>
>(async () => ({ ok: true }));
vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: async () => ({
    connectedApps: [],
    gmailAliases: [],
  }),
}));

vi.mock("../hitl-actions", () => ({
  approveReviewTask: (taskId: string, values?: unknown, fieldName?: string) =>
    approveMock(taskId, values, fieldName),
  rejectReviewTask: vi.fn(async () => undefined),
}));

import { Button } from "@/components/ui/button";
import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { fieldRendererRegistry } from "../field-renderer-registry";
import { AgentHitlScreenCard, type AgentHitlScreenCarry } from "../agent-hitl-screen-card";

const RUN_ID = "run-3380";
const X_RENDERER = "@cinatra-test/pick-agent:output";
const PICKED_JSON = JSON.stringify({ artifactId: "a-2" });
const NO_PICK_JSON = JSON.stringify({ noPick: true });
/** The `onChange` each mounted pick renderer was given, in mount order. */
const pickMounts: Array<(next: unknown) => unknown> = [];

function asking(reviewTaskId: string, ideas: unknown[]) {
  return {
    state: "asking" as const,
    runId: RUN_ID,
    screenRef: "hitl-screen-ref-3380",
    gate: {
      reviewTaskId,
      xRenderer: X_RENDERER,
      inputSchema: {
        type: "object",
        properties: { selectedIdeaJson: { type: "string", "x-required": true } },
      },
      currentValues: { ideas },
      fieldName: undefined,
    },
  };
}

function PickRenderer({
  onChange,
  value,
}: {
  onChange: (next: unknown) => unknown;
  value?: unknown;
}) {
  const [picked, setPicked] = React.useState(false);
  const ideas = (value as { ideas?: unknown } | null)?.ideas;
  const emptyOffer = Array.isArray(ideas) && ideas.length === 0;
  React.useLayoutEffect(() => {
    pickMounts.push(onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  React.useLayoutEffect(() => {
    if (emptyOffer) void onChange({ selectedIdeaJson: NO_PICK_JSON, userResponse: NO_PICK_JSON });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emptyOffer]);
  return (
    <Button
      type="button"
      data-testid="pick-row"
      data-picked={picked ? "yes" : "no"}
      onClick={() => {
        setPicked(true);
        void onChange({ selectedIdeaJson: PICKED_JSON, userResponse: PICKED_JSON });
      }}
    >
      Idea two
    </Button>
  );
}

type Box = { current: AgentHitlScreenCarry | null };

/** A gate drawn through the generic dispatch renderer (a presentation hint). */
function hintAsking(reviewTaskId: string) {
  const screen = asking(reviewTaskId, []);
  return {
    ...screen,
    gate: {
      ...screen.gate,
      currentValues: {
        presentation: {
          type: "card_list",
          title: "Review ideas",
          items: [{ title: "Idea one", description: "First" }],
        },
      },
    },
  };
}

const SETUP_X_RENDERER = "@cinatra-test/setup-agent:topic";
const flushOfFirstGate = { current: Promise.resolve() as Promise<unknown> };
/** Called by the later gate's field from its layout effect when it mounts. */
const onLaterFieldMount: { current: null | (() => void) } = { current: null };

function setupAsking(reviewTaskId: string, fieldName: string) {
  return {
    state: "asking" as const,
    runId: RUN_ID,
    screenRef: "hitl-screen-ref-3380",
    gate: {
      reviewTaskId,
      xRenderer: SETUP_X_RENDERER,
      inputSchema: { type: "string" },
      currentValues: {},
      fieldName,
    },
  };
}

// The first gate's field hands its words over through a flush that can take its
// time. The later gate's field stages as it is typed in, and registers no flush.
function SetupRenderer({
  fieldName,
  onChange,
  registerFlush,
}: {
  fieldName: string;
  onChange: (next: unknown) => unknown;
  registerFlush?: (fn: () => Promise<void>) => void;
}) {
  const words = "words of " + fieldName;
  React.useLayoutEffect(() => {
    if (fieldName === "later") onLaterFieldMount.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  React.useEffect(() => {
    if (fieldName !== "first") return;
    registerFlush?.(async () => {
      await flushOfFirstGate.current;
      await onChange(words);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Button type="button" data-testid="type-words" onClick={() => void onChange(words)}>
      Type
    </Button>
  );
}

const WIDGET_AUTH = {
  headers: () => ({ Authorization: "Bearer cwu_site" }),
  credentials: "omit" as const,
};

function widgetCard(wireRef: string, carrier: Box) {
  return (
    <LifecycleCardSurfaceProvider
      host="site_widget"
      auth={WIDGET_AUTH}
      frame={{ assistant: "a", instanceId: "i" }}
    >
      <AgentHitlScreenCard runId={RUN_ID} wireRef={wireRef} carrier={carrier} />
    </LifecycleCardSurfaceProvider>
  );
}

function card(wireRef: string, carrier?: Box) {
  return (
    <LifecycleCardSurfaceProvider host="chat_thread">
      <AgentHitlScreenCard runId={RUN_ID} wireRef={wireRef} carrier={carrier} />
    </LifecycleCardSurfaceProvider>
  );
}

type Deferred = {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

function deferred(): Deferred {
  let resolve!: Deferred["resolve"];
  let reject!: Deferred["reject"];
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    await Promise.resolve();
  });
}

function cardContinue(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('[data-action="submit-hitl-screen"]');
}

function pickRow(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('[data-testid="pick-row"]');
}

beforeEach(() => {
  fieldRendererRegistry.clear();
  fieldRendererRegistry.register({
    id: "@cinatra-test/pick-agent:pick",
    priority: 90,
    condition: (_f, _s, ctx) => ctx.xRenderer === X_RENDERER,
    renderer: PickRenderer as never,
    credentialSafe: true,
  });
  fieldRendererRegistry.register({
    id: "@cinatra-test/setup-agent:topic",
    priority: 90,
    condition: (_f, _s, ctx) => ctx.xRenderer === SETUP_X_RENDERER,
    renderer: SetupRenderer as never,
    credentialSafe: true,
  });
  approveMock.mockClear();
  pickMounts.length = 0;
  onLaterFieldMount.current = null;
});

afterEach(() => {
  cleanup();
  fieldRendererRegistry.clear();
  vi.clearAllMocks();
});

describe("AgentHitlScreenCard — what its renderer writes (cinatra#3380)", () => {
  it("keeps a write made when the renderer mounts: a list with nothing to pick is answered, and the Continue sends that answer", async () => {
    screenStateMock.mockImplementation(async () => asking("task-empty", []));
    render(card("task-empty"));
    await settle();

    await waitFor(() => expect(cardContinue()).not.toBeNull());
    await settle();
    expect(cardContinue()!.disabled).toBe(false);

    await act(async () => {
      fireEvent.click(cardContinue()!);
      await Promise.resolve();
    });
    await waitFor(() => expect(approveMock).toHaveBeenCalledTimes(1));
    const [taskId, values] = approveMock.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(taskId).toBe("task-empty");
    expect(values.selectedIdeaJson).toBe(NO_PICK_JSON);
  });

  it("starts a later gate on the same renderer with nothing: a new renderer, the Continue held again, and the later pick sent for the later gate", async () => {
    screenStateMock.mockImplementation(async () => asking("task-first", [{ id: "a" }]));
    const mounted = render(card("task-first"));
    await settle();

    await waitFor(() => expect(pickRow()).not.toBeNull());
    expect(cardContinue()!.disabled).toBe(true);
    await act(async () => {
      fireEvent.click(pickRow()!);
      await Promise.resolve();
    });
    await waitFor(() => expect(cardContinue()!.disabled).toBe(false));

    screenStateMock.mockImplementation(async () => asking("task-next", [{ id: "a" }]));
    mounted.rerender(card("task-next"));
    await settle();

    await waitFor(() => expect(cardContinue()!.disabled).toBe(true));
    expect(pickRow()!.getAttribute("data-picked")).toBe("no");

    await act(async () => {
      fireEvent.click(pickRow()!);
      await Promise.resolve();
    });
    await waitFor(() => expect(cardContinue()!.disabled).toBe(false));
    await act(async () => {
      fireEvent.click(cardContinue()!);
      await Promise.resolve();
    });
    await waitFor(() => expect(approveMock).toHaveBeenCalledTimes(1));
    const [taskId, values] = approveMock.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(taskId).toBe("task-next");
    expect(values.selectedIdeaJson).toBe(PICKED_JSON);
  });

  const LANDINGS: Array<[string, (d: Deferred) => void]> = [
    ["an accepted answer", (d) => d.resolve({ ok: true })],
    ["a gate no longer pending", (d) => d.resolve({ ok: false, blocked: "no-longer-pending" })],
    ["an already resolved refusal", (d) => d.reject(new Error("Review task already resolved"))],
  ];

  it.each(LANDINGS)(
    "keeps what a later gate's renderer wrote when the earlier submit lands after it: %s",
    async (_name, land) => {
      const box: Box = { current: null };
      const inFlight = deferred();
      screenStateMock.mockImplementation(async () => asking("task-first", [{ id: "a" }]));
      const mounted = render(card("task-first", box));
      await settle();
      await waitFor(() => expect(pickRow()).not.toBeNull());
      await act(async () => {
        fireEvent.click(pickRow()!);
        await Promise.resolve();
      });
      await waitFor(() => expect(cardContinue()!.disabled).toBe(false));

      approveMock.mockImplementationOnce(() => inFlight.promise);
      await act(async () => {
        fireEvent.click(cardContinue()!);
        await Promise.resolve();
      });
      await waitFor(() => expect(approveMock).toHaveBeenCalledTimes(1));

      screenStateMock.mockImplementation(async () => asking("task-empty", []));
      mounted.rerender(card("task-empty", box));
      await settle();
      await waitFor(() =>
        expect(box.current?.buffered.selectedIdeaJson).toBe(NO_PICK_JSON),
      );

      await act(async () => {
        land(inFlight);
        await Promise.resolve();
      });
      await settle();

      expect(box.current?.gateKey).toContain("task-empty");
      expect(box.current?.buffered.selectedIdeaJson).toBe(NO_PICK_JSON);
      await waitFor(() => expect(cardContinue()!.disabled).toBe(false));
      await act(async () => {
        fireEvent.click(cardContinue()!);
        await Promise.resolve();
      });
      await waitFor(() => expect(approveMock).toHaveBeenCalledTimes(2));
      const [taskId, values] = approveMock.mock.calls[1] as unknown as [
        string,
        Record<string, unknown>,
      ];
      expect(taskId).toBe("task-empty");
      expect(values.selectedIdeaJson).toBe(NO_PICK_JSON);
    },
  );

  it("clears its own gate's buffer when the submit lands on that gate, and keeps it on a refusal", async () => {
    const box: Box = { current: null };
    screenStateMock.mockImplementation(async () => asking("task-first", [{ id: "a" }]));
    render(card("task-first", box));
    await settle();
    await waitFor(() => expect(pickRow()).not.toBeNull());
    await act(async () => {
      fireEvent.click(pickRow()!);
      await Promise.resolve();
    });
    await waitFor(() => expect(cardContinue()!.disabled).toBe(false));

    approveMock.mockImplementationOnce(async () => ({ ok: false, blocked: "other" }));
    await act(async () => {
      fireEvent.click(cardContinue()!);
      await Promise.resolve();
    });
    await settle();
    await waitFor(() => expect(cardContinue()!.disabled).toBe(false));
    expect(box.current?.buffered.selectedIdeaJson).toBe(PICKED_JSON);

    await act(async () => {
      fireEvent.click(cardContinue()!);
      await Promise.resolve();
    });
    await settle();
    await waitFor(() => expect(cardContinue()!.disabled).toBe(true));
    expect(box.current?.buffered.selectedIdeaJson).toBeUndefined();
  });

  it("stops a setup press whose gate changes during its flush: nothing is sent, and the later gate takes only its own answer", async () => {
    const flush = deferred();
    flushOfFirstGate.current = flush.promise;
    screenStateMock.mockImplementation(async () => setupAsking("setup-first", "first"));
    const mounted = render(card("setup-first"));
    await settle();
    await waitFor(() => expect(cardContinue()).not.toBeNull());

    await act(async () => {
      fireEvent.click(cardContinue()!);
      await Promise.resolve();
    });

    screenStateMock.mockImplementation(async () => setupAsking("setup-later", "later"));
    mounted.rerender(card("setup-later"));
    await settle();

    // The later gate is answered while the first press is still flushing.
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="type-words"]')!);
      await Promise.resolve();
    });

    await act(async () => {
      flush.resolve(undefined);
      await Promise.resolve();
    });
    await settle();
    expect(approveMock).not.toHaveBeenCalled();

    await waitFor(() => expect(cardContinue()!.disabled).toBe(false));
    await act(async () => {
      fireEvent.click(cardContinue()!);
      await Promise.resolve();
    });
    await waitFor(() => expect(approveMock).toHaveBeenCalledTimes(1));
    const [taskId, values, fieldName] = approveMock.mock.calls[0] as unknown as [
      string,
      unknown,
      string | undefined,
    ];
    expect(taskId).toBe("setup-later");
    expect(fieldName).toBe("later");
    expect(JSON.stringify(values)).toContain("words of later");
    expect(JSON.stringify(values)).not.toContain("words of first");
  });

  it("keeps what a later gate's renderer wrote when the earlier submit lands after it on the broker door", async () => {
    const original = globalThis.fetch;
    const box: Box = { current: null };
    const inFlight = deferred();
    let screen: unknown = asking("task-first", [{ id: "a" }]);
    const submits: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const json = (v: unknown) =>
        new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.endsWith("/hitl-screen/submit")) {
        submits.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return submits.length === 1 ? (inFlight.promise as Promise<Response>) : json({ outcome: { ok: true } });
      }
      return json(screen);
    }) as unknown as typeof fetch;
    try {
      const mounted = render(widgetCard("task-first", box));
      await settle();
      await waitFor(() => expect(pickRow()).not.toBeNull());
      await act(async () => {
        fireEvent.click(pickRow()!);
        await Promise.resolve();
      });
      await waitFor(() => expect(cardContinue()!.disabled).toBe(false));
      await act(async () => {
        fireEvent.click(cardContinue()!);
        await Promise.resolve();
      });
      await waitFor(() => expect(submits).toHaveLength(1));

      screen = asking("task-empty", []);
      mounted.rerender(widgetCard("task-empty", box));
      await settle();
      await waitFor(() => expect(box.current?.buffered.selectedIdeaJson).toBe(NO_PICK_JSON));

      await act(async () => {
        inFlight.resolve(
          new Response(JSON.stringify({ outcome: { ok: true } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
        await Promise.resolve();
      });
      await settle();

      expect(box.current?.gateKey).toContain("task-empty");
      expect(box.current?.buffered.selectedIdeaJson).toBe(NO_PICK_JSON);
      await waitFor(() => expect(cardContinue()!.disabled).toBe(false));
      await act(async () => {
        fireEvent.click(cardContinue()!);
        await Promise.resolve();
      });
      await waitFor(() => expect(submits).toHaveLength(2));
      expect(submits[1].reviewTaskId).toBe("task-empty");
      expect((submits[1].values as Record<string, unknown>).selectedIdeaJson).toBe(NO_PICK_JSON);
      expect(approveMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("stops a setup press whose flush answers in the moment the next gate is committed, before the card's effects run", async () => {
    const flush = deferred();
    flushOfFirstGate.current = flush.promise;
    // The first gate's flush answers from inside the commit of the later gate:
    // its continuation runs before that commit's passive effects.
    onLaterFieldMount.current = () => flush.resolve(undefined);
    screenStateMock.mockImplementation(async () => setupAsking("setup-first", "first"));
    const mounted = render(card("setup-first"));
    await settle();
    await waitFor(() => expect(cardContinue()).not.toBeNull());
    await act(async () => {
      fireEvent.click(cardContinue()!);
      await Promise.resolve();
    });

    const laterRead = deferred();
    screenStateMock.mockImplementation(() => laterRead.promise);
    mounted.rerender(card("setup-later"));

    // The later gate arrives from the card's own read, outside act, so React
    // commits it in one task and runs its passive effects in a later one.
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const was = env.IS_REACT_ACT_ENVIRONMENT;
    env.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      laterRead.resolve(setupAsking("setup-later", "later"));
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      env.IS_REACT_ACT_ENVIRONMENT = was;
    }
    await settle();

    expect(document.querySelector('[data-testid="type-words"]')).not.toBeNull();
    expect(approveMock).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="type-words"]')!);
      await Promise.resolve();
    });
    await waitFor(() => expect(cardContinue()!.disabled).toBe(false));
    await act(async () => {
      fireEvent.click(cardContinue()!);
      await Promise.resolve();
    });
    await waitFor(() => expect(approveMock).toHaveBeenCalledTimes(1));
    const [taskId, values] = approveMock.mock.calls[0] as unknown as [string, unknown];
    expect(taskId).toBe("setup-later");
    expect(JSON.stringify(values)).toContain("words of later");
    expect(JSON.stringify(values)).not.toContain("words of first");
  });

  it("ignores a write from a renderer that has been replaced: the later gate keeps what its own renderer wrote", async () => {
    const box: Box = { current: null };
    screenStateMock.mockImplementation(async () => asking("task-first", [{ id: "a" }]));
    const mounted = render(card("task-first", box));
    await settle();
    await waitFor(() => expect(pickRow()).not.toBeNull());

    screenStateMock.mockImplementation(async () => asking("task-empty", []));
    mounted.rerender(card("task-empty", box));
    await settle();
    await waitFor(() => expect(box.current?.buffered.selectedIdeaJson).toBe(NO_PICK_JSON));
    expect(pickMounts).toHaveLength(2);

    // The first gate's renderer, already replaced, writes after an await.
    await act(async () => {
      void pickMounts[0]({ selectedIdeaJson: PICKED_JSON, userResponse: PICKED_JSON });
      await Promise.resolve();
    });
    await settle();

    expect(box.current?.gateKey).toContain("task-empty");
    expect(box.current?.buffered.selectedIdeaJson).toBe(NO_PICK_JSON);
    await waitFor(() => expect(cardContinue()!.disabled).toBe(false));
    await act(async () => {
      fireEvent.click(cardContinue()!);
      await Promise.resolve();
    });
    await waitFor(() => expect(approveMock).toHaveBeenCalledTimes(1));
    const [taskId, values] = approveMock.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(taskId).toBe("task-empty");
    expect(values.selectedIdeaJson).toBe(NO_PICK_JSON);
  });

  // cinatra#3380: no gate on screen is recorded too.
  it("stops a setup press whose gate leaves the screen during its flush: nothing is sent", async () => {
    const flush = deferred();
    flushOfFirstGate.current = flush.promise;
    screenStateMock.mockImplementation(async () => setupAsking("setup-first", "first"));
    const mounted = render(card("setup-first"));
    await settle();
    await waitFor(() => expect(cardContinue()).not.toBeNull());

    await act(async () => {
      fireEvent.click(cardContinue()!);
      await Promise.resolve();
    });

    // The gate is answered on another surface: the run is no longer asking.
    screenStateMock.mockImplementation(async () => ({ state: "none" }));
    mounted.rerender(card("setup-answered"));
    await settle();
    await waitFor(() => expect(cardContinue()).toBeNull());

    await act(async () => {
      flush.resolve(undefined);
      await Promise.resolve();
    });
    await settle();
    expect(approveMock).not.toHaveBeenCalled();
  });

  it("ignores a write from a renderer whose gate has left the screen: the gate that comes back is still held", async () => {
    const box: Box = { current: null };
    screenStateMock.mockImplementation(async () => asking("task-first", [{ id: "a" }]));
    const mounted = render(card("task-first", box));
    await settle();
    await waitFor(() => expect(pickRow()).not.toBeNull());
    expect(cardContinue()!.disabled).toBe(true);
    const earlierOnChange = pickMounts[pickMounts.length - 1]!;

    screenStateMock.mockImplementation(async () => ({ state: "none" }));
    mounted.rerender(card("task-gone", box));
    await settle();
    await waitFor(() => expect(pickRow()).toBeNull());

    // The renderer of the gate that left writes after an await.
    await act(async () => {
      void earlierOnChange({ selectedIdeaJson: PICKED_JSON, userResponse: PICKED_JSON });
      await Promise.resolve();
    });
    await settle();
    expect(box.current?.buffered.selectedIdeaJson).toBeUndefined();

    screenStateMock.mockImplementation(async () => asking("task-first", [{ id: "a" }]));
    mounted.rerender(card("task-first-again", box));
    await settle();
    await waitFor(() => expect(pickRow()).not.toBeNull());
    expect(cardContinue()!.disabled).toBe(true);
    expect(approveMock).not.toHaveBeenCalled();
  });

  // cinatra#3380: every gate gets a new renderer.
  it("mounts a new presentation-hint renderer for a later gate with the same hint type", async () => {
    const hintSection = () =>
      Array.from(document.querySelectorAll("h3"))
        .find((h) => h.textContent === "Review ideas")
        ?.closest("section") ?? null;
    screenStateMock.mockImplementation(async () => hintAsking("task-hint-first"));
    const mounted = render(card("task-hint-first"));
    await settle();
    await waitFor(() => expect(hintSection()).not.toBeNull());
    const earlier = hintSection();

    screenStateMock.mockImplementation(async () => hintAsking("task-hint-next"));
    mounted.rerender(card("task-hint-next"));
    await settle();
    await waitFor(() => expect(earlier!.isConnected).toBe(false));
    expect(hintSection()).not.toBeNull();
    expect(hintSection()).not.toBe(earlier);
  });
});
