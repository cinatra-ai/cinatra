// @vitest-environment jsdom
/**
 * THE PAGE'S ONE WINDOW AT ITS EDGES (cinatra#3487, unit T, cases 2-4).
 *
 * The run page chrome hands every message to whatever the current screen lent,
 * read at call time (`run-page-chrome.tsx`), and the screens hand over their
 * records through the store of `run-window-screen-context.tsx`. These cases pin
 * the three edges the main suites do not reach:
 *
 *   (2) a second screen publishes while a message is out: the message in flight
 *       stays with the screen it was handed to, the chrome waits for that
 *       screen's own answer, and only the NEXT message goes to the new screen;
 *   (3) a send that arrives when no screen lends anything any more (the screen
 *       left, withdrew its record, or has nothing to manipulate) calls nothing
 *       and does not throw;
 *   (4) a screen that unmounts retracts only its own record: the page falls
 *       back to what the screens still there published, a screen that leaves
 *       after its successor arrived cannot blank the successor, and the page
 *       node goes when the last screen goes.
 *
 * The two invariant tests of the run window are not touched by this file.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/run-page-chrome-submit-edges-3487.test.tsx
 */
import React, { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";

/** The window's own send and sentence, captured from the field the one panel renders. */
const field = vi.hoisted(() => ({
  submit: null as null | ((value: string) => Promise<void>),
  placeholder: null as null | string,
}));

vi.mock("@cinatra-ai/sdk-ui", () => ({
  PromptField: ({
    onSubmit,
    placeholder,
  }: {
    onSubmit: (value: string) => Promise<void>;
    placeholder?: string;
  }) => {
    field.submit = onSubmit;
    field.placeholder = placeholder ?? null;
    return <div data-testid="unit-t-prompt-field">{placeholder}</div>;
  },
}));

import { RunPageChrome } from "../run-page-chrome";
import {
  createRunWindowScreenStore,
  useRunWindowScreen,
  type RunWindowScreenRegistration,
} from "../run-window-screen-context";

afterEach(cleanup);
beforeEach(() => {
  field.submit = null;
  field.placeholder = null;
});

const CHROME = '[data-run-window-host="page-chrome"]';
const FIELD = '[data-testid="unit-t-prompt-field"]';
const RUN_PAGE_SENTENCE = "fill the fields above";
const SCHEDULE_SENTENCE = "set the schedule above";

function registration(
  over: Partial<RunWindowScreenRegistration> = {},
): RunWindowScreenRegistration {
  return {
    surface: "run-page",
    runId: "run-unit-t",
    canManipulate: true,
    storageKey: "draft-unit-t",
    conversation: [],
    promptPending: false,
    onSubmit: vi.fn(async () => {}),
    ...over,
  };
}

/** A screen double: it registers exactly the record it is handed, nothing more. */
function Screen({ record }: { record: RunWindowScreenRegistration | null }) {
  useRunWindowScreen(record);
  return <div data-testid="unit-t-screen" />;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function sentenceIs(container: HTMLElement, text: string) {
  await waitFor(() => {
    expect(container.querySelectorAll(FIELD)).toHaveLength(1);
    expect(field.placeholder ?? "").toContain(text);
  });
}

describe("3487 unit T (2): a second writer during an in-flight submit", () => {
  it("the message in flight stays with its screen, the chrome waits for it, and the next goes to the new screen", async () => {
    const first = deferred();
    const a = registration({ onSubmit: vi.fn(() => first.promise) });
    const b = registration({
      surface: "schedule",
      storageKey: "draft-unit-t-b",
      onSubmit: vi.fn(async () => {}),
    });
    const { container, rerender } = render(
      <RunPageChrome>
        <Screen record={a} />
      </RunPageChrome>,
    );
    await sentenceIs(container, RUN_PAGE_SENTENCE);

    let settled = false;
    let inFlight: Promise<void> = Promise.resolve();
    await act(async () => {
      inFlight = field.submit!("the first message").then(() => {
        settled = true;
      });
    });
    expect(a.onSubmit).toHaveBeenCalledTimes(1);
    expect(a.onSubmit).toHaveBeenCalledWith("the first message");

    // The second writer arrives while the first message is still out.
    rerender(
      <RunPageChrome>
        <Screen record={a} />
        <Screen record={b} />
      </RunPageChrome>,
    );
    await sentenceIs(container, SCHEDULE_SENTENCE);
    expect(settled).toBe(false);
    expect(b.onSubmit).not.toHaveBeenCalled();

    await act(async () => {
      first.resolve();
      await inFlight;
    });
    expect(settled).toBe(true);
    expect(a.onSubmit).toHaveBeenCalledTimes(1);
    expect(b.onSubmit).not.toHaveBeenCalled();

    await act(async () => {
      await field.submit!("the second message");
    });
    expect(b.onSubmit).toHaveBeenCalledTimes(1);
    expect(b.onSubmit).toHaveBeenCalledWith("the second message");
    expect(a.onSubmit).toHaveBeenCalledTimes(1);
  });

  it("the same screen republishing its pending turn does not send the message again", async () => {
    const first = deferred();
    const onSubmit = vi.fn(() => first.promise);
    const a = registration({ onSubmit });
    const { container, rerender } = render(
      <RunPageChrome>
        <Screen record={a} />
      </RunPageChrome>,
    );
    await sentenceIs(container, RUN_PAGE_SENTENCE);
    let inFlight: Promise<void> = Promise.resolve();
    await act(async () => {
      inFlight = field.submit!("one message");
    });
    rerender(
      <RunPageChrome>
        <Screen record={{ ...a, promptPending: true }} />
      </RunPageChrome>,
    );
    await act(async () => {
      first.resolve();
      await inFlight;
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll(FIELD)).toHaveLength(1);
  });
});

describe("3487 unit T (3): the chrome's submit with no current screen", () => {
  it.each([
    ["the screen unmounted", () => <div data-testid="unit-t-no-screen" />],
    ["the screen withdrew its record", () => <Screen record={null} />],
  ])("%s: a retained send calls nothing and does not throw", async (_label, after) => {
    const a = registration();
    const { container, rerender } = render(
      <RunPageChrome>
        <Screen record={a} />
      </RunPageChrome>,
    );
    await sentenceIs(container, RUN_PAGE_SENTENCE);
    const retained = field.submit!;

    rerender(<RunPageChrome>{after()}</RunPageChrome>);
    await waitFor(() => expect(container.querySelector(CHROME)).toBeNull());
    expect(container.querySelectorAll(FIELD)).toHaveLength(0);

    let outcome: unknown = "not reached";
    await act(async () => {
      outcome = await retained("typed after the screen left");
    });
    expect(outcome).toBeUndefined();
    expect(a.onSubmit).not.toHaveBeenCalled();
  });

  it("a screen that now has nothing to manipulate: a retained send reaches neither its old nor its new action", async () => {
    const a = registration();
    const lendsNothing = registration({ canManipulate: false, onSubmit: vi.fn(async () => {}) });
    const { container, rerender } = render(
      <RunPageChrome>
        <Screen record={a} />
      </RunPageChrome>,
    );
    await sentenceIs(container, RUN_PAGE_SENTENCE);
    const retained = field.submit!;

    rerender(
      <RunPageChrome>
        <Screen record={lendsNothing} />
      </RunPageChrome>,
    );
    await waitFor(() => expect(container.querySelectorAll(FIELD)).toHaveLength(0));
    // The page's node stays, so the column does not move; only the window goes.
    expect(container.querySelector(CHROME)).not.toBeNull();

    await act(async () => {
      await retained("typed after the step closed");
    });
    expect(a.onSubmit).not.toHaveBeenCalled();
    expect(lendsNothing.onSubmit).not.toHaveBeenCalled();
  });
});

describe("3487 unit T (4): the retraction on unmount", () => {
  it("the later screen unmounts: the page falls back to the earlier screen's window and action", async () => {
    const a = registration();
    const b = registration({ surface: "schedule", storageKey: "draft-unit-t-b" });
    const { container, rerender } = render(
      <RunPageChrome>
        <Screen record={a} />
        <Screen record={b} />
      </RunPageChrome>,
    );
    await sentenceIs(container, SCHEDULE_SENTENCE);

    rerender(
      <RunPageChrome>
        <Screen record={a} />
      </RunPageChrome>,
    );
    await sentenceIs(container, RUN_PAGE_SENTENCE);
    await act(async () => {
      await field.submit!("after the later screen left");
    });
    expect(a.onSubmit).toHaveBeenCalledWith("after the later screen left");
    expect(b.onSubmit).not.toHaveBeenCalled();
  });

  it("the earlier screen unmounts after its successor arrived: the successor keeps the window", async () => {
    const a = registration();
    const b = registration({ surface: "schedule", storageKey: "draft-unit-t-b" });
    const { container, rerender } = render(
      <RunPageChrome>
        <Screen key="a" record={a} />
        <Screen key="b" record={b} />
      </RunPageChrome>,
    );
    await sentenceIs(container, SCHEDULE_SENTENCE);

    rerender(
      <RunPageChrome>
        <Screen key="b" record={b} />
      </RunPageChrome>,
    );
    await sentenceIs(container, SCHEDULE_SENTENCE);
    await act(async () => {
      await field.submit!("after the earlier screen left");
    });
    expect(b.onSubmit).toHaveBeenCalledWith("after the earlier screen left");
    expect(a.onSubmit).not.toHaveBeenCalled();
  });

  it("the last screen unmounts: the page node goes with it", async () => {
    const { container, rerender } = render(
      <RunPageChrome>
        <Screen record={registration()} />
      </RunPageChrome>,
    );
    await sentenceIs(container, RUN_PAGE_SENTENCE);
    rerender(<RunPageChrome>{null}</RunPageChrome>);
    await waitFor(() => expect(container.querySelector(CHROME)).toBeNull());
    expect(container.querySelectorAll(FIELD)).toHaveLength(0);
  });

  it("under StrictMode's unmount and remount the screen's record is published again", async () => {
    const a = registration();
    const { container } = render(
      <StrictMode>
        <RunPageChrome>
          <Screen record={a} />
        </RunPageChrome>
      </StrictMode>,
    );
    await sentenceIs(container, RUN_PAGE_SENTENCE);
    expect(container.querySelectorAll(CHROME)).toHaveLength(1);
    await act(async () => {
      await field.submit!("after the strict remount");
    });
    expect(a.onSubmit).toHaveBeenCalledTimes(1);
  });

  it("the store: a retraction touches only its own record and is idempotent", () => {
    const store = createRunWindowScreenStore();
    const a = { id: Symbol("a") };
    const b = { id: Symbol("b") };
    const stranger = { id: Symbol("never-published") };
    const recordA = registration();
    const recordB = registration({ surface: "schedule" });
    store.publish(a, recordA);
    store.publish(b, recordB);
    expect(store.read()).toBe(recordB);

    const before = store.version();
    store.retract(stranger);
    expect(store.version()).toBe(before);
    expect(store.read()).toBe(recordB);

    store.retract(a);
    expect(store.read()).toBe(recordB);
    expect(store.version()).toBe(before);

    store.retract(b);
    expect(store.read()).toBeNull();
    const afterLast = store.version();
    expect(afterLast).toBeGreaterThan(before);
    store.retract(b);
    expect(store.version()).toBe(afterLast);
    expect(store.read()).toBeNull();
  });
});
