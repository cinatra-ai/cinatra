"use client";

// ---------------------------------------------------------------------------
// THE RUN PAGE'S CHROME, AND THE ONE PROMPT WINDOW IN IT (cinatra#3487).
//
// The maintainer's ruling of 2026-09-14: "On the run page the prompt window is
// part of the run page's CHROME: one window owned by the page, shown only while
// the current step's screen holds input or output the person can manipulate,
// never part of that screen's component or markup — and it ALWAYS provides the
// assistant's FULL capabilities, exactly as if no lifecycle screen were active;
// the screen's context (its surface, the run, step or gate identity, and how a
// result is applied) is handed to the window in addition, never as a
// restriction."
//
// THIS MODULE IS THE ONE IMPORTER OF THE PANEL, and a required check says so
// (E1: `run-window-panel-single-importer.invariant.test.ts`). The five screens
// that used to mount their own window now register with the store this component
// provides; what they hand over is identity and the action they lend, never a
// narrower world.
//
// WHERE THE WINDOW STANDS. Below the screen, in the page's own column — the
// ratified drawing's "Beneath the form the run's prompt window (§IX) sits where
// it always sits — below the scheduler, in the same column"
// (`app-artifact-review.html` §I). The page draws it after its children for
// exactly that reason.
//
// THE PLACEHOLDER NAMES THE STEP THROUGH THE PAGE, NEVER THROUGH THE SCREEN: the
// screen publishes WHICH READING it is and the panel reads the drawing's own
// sentence for that reading out of its own map. No screen supplies wording.
// ---------------------------------------------------------------------------

import {
  useCallback,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { HitlConversationPanel } from "./hitl-conversation-panel";
import {
  RunWindowScreenProvider,
  createRunWindowScreenStore,
} from "./run-window-screen-context";

/**
 * The node the page owns the window in. Named so a rendered test and the
 * design-conformance suite can both read "the window is a child of the page
 * chrome, and never of a lifecycle card".
 */
export const RUN_WINDOW_HOST_ATTRIBUTE = "data-run-window-host";
export const RUN_WINDOW_HOST_VALUE = "page-chrome";

export function RunPageChrome({ children }: { children: ReactNode }) {
  const store = useMemo(() => createRunWindowScreenStore(), []);
  // SUBSCRIBED THROUGH REACT'S OWN PRIMITIVE, not a hand-rolled effect: a
  // child's effect runs before its parent's, so the screen publishes its first
  // registration while a hand-rolled subscription is not yet listening — and
  // the store, which notifies only on a real change, would never mention it
  // again. `useSyncExternalStore` re-reads the version the moment it subscribes.
  useSyncExternalStore(store.subscribe, store.version, store.version);
  const [mount, setMount] = useState<HTMLElement | null>(null);

  const screen = store.read();

  // THE APPLYING ROAD STAYS THE SCREEN'S OWN. The page never decides what a
  // message does; it hands the message to whatever the current screen lent, read
  // at call time so a screen that rebuilt its handler is still the one answering.
  const submit = useCallback(
    async (prompt: string, attachments?: Parameters<
      NonNullable<ReturnType<typeof store.read>>["onSubmit"]
    >[1]) => {
      const current = store.read();
      if (!current) return;
      if (attachments && attachments.length > 0) await current.onSubmit(prompt, attachments);
      else await current.onSubmit(prompt);
    },
    [store],
  );

  return (
    <RunWindowScreenProvider store={store}>
      {children}
      {/* THE PAGE'S OWN NODE, drawn for as long as a screen is registered with
          this chrome — whether or not that screen has anything to manipulate, so
          the column's shape does not move between steps.

          NOT DRAWN AT ALL WHERE NO SCREEN REGISTERED, which is what makes the
          chrome nestable: the run surface's own frame draws a chrome inside its
          detail column (the drawing's "in the same column"), and a page that
          wraps that frame in a chrome of its own contributes nothing — the
          screens register with the nearest one, and the outer one has no record
          and draws no node. */}
      {screen ? (
        <div {...{ [RUN_WINDOW_HOST_ATTRIBUTE]: RUN_WINDOW_HOST_VALUE }} ref={setMount}>
          <HitlConversationPanel
            portalTarget={mount}
            // SHOWN ONLY WHILE THE SCREEN HOLDS SOMETHING TO MANIPULATE. A step
            // whose screen has nothing — and a run that would refuse this
            // person's message — draws no window at all, rather than a control
            // that fails on press.
            visible={!!mount && screen.canManipulate}
            surface={screen.surface}
            conversation={screen.conversation}
            promptPending={screen.promptPending}
            storageKey={screen.storageKey}
            onSubmit={submit}
            {...(screen.enableAttachments ? { enableAttachments: true } : {})}
            {...(screen.resetSignal === undefined ? {} : { resetSignal: screen.resetSignal })}
          />
        </div>
      ) : null}
    </RunWindowScreenProvider>
  );
}
