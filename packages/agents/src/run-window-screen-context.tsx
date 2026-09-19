"use client";

// ---------------------------------------------------------------------------
// THE SCREEN REGISTERS; THE PAGE OWNS THE WINDOW (cinatra#3487).
//
// The maintainer's ruling of 2026-09-14: "THE PROMPT WINDOW IS NEVER PART OF A
// LIFECYCLE SCREEN AND NEVER INSIDE A LIFECYCLE CARD, IN ANY HOST … On the run
// page the prompt window is part of the run page's CHROME: one window owned by
// the page, shown only while the current step's screen holds input or output the
// person can manipulate, never part of that screen's component or markup — and
// it ALWAYS provides the assistant's FULL capabilities, exactly as if no
// lifecycle screen were active; the screen's context (its surface, the run, step
// or gate identity, and how a result is applied) is handed to the window in
// addition, never as a restriction."
//
// SO THIS MODULE IS THE HAND-OVER, AND NOTHING ELSE. A screen publishes what it
// is and what it lends; the page chrome (`run-page-chrome.tsx`) is the only
// module that reads it and the only module that mounts a window. A screen that
// is drawn with no chrome above it — a card inside a chat thread, a card inside
// the third-party island — publishes into nothing and no window appears, which
// is the fail-closed reading the ruling asks for.
//
// WHY A STORE AND NOT PLAIN CONTEXT STATE. What a screen publishes changes on
// nearly every render (the exchange grows, a turn goes out, a gate settles) and
// the lent action is re-created each render by the screens that lend it. A
// context value recomputed from that would re-render the whole subtree on every
// keystroke, and a `setState` keyed on the registration object would not
// terminate at all. The store keeps the LATEST record in a ref — so the action
// the chrome calls is always the screen's current one — and notifies only when
// something the window actually DRAWS has changed.
// ---------------------------------------------------------------------------

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import type { LlmAttachmentRef } from "@cinatra-ai/llm";

import type { RunWindowSurface } from "./run-window-conversation-store";

/**
 * One entry of the window's exchange, in the shape the window draws.
 *
 * DECLARED HERE AND NOT TAKEN FROM THE PANEL, deliberately: the panel module has
 * exactly one importer (E1), so a screen cannot reach even its TYPES without
 * breaking the invariant. The shape is the store's own and the panel accepts it
 * structurally.
 */
export type RunWindowConversationEntry = {
  id: number;
  role: "user" | "assistant";
  content: string;
};

/**
 * WHAT A SCREEN HANDS THE PAGE. Every field is either the screen's IDENTITY or
 * the action it LENDS — never a restriction on what the window may do. There is
 * deliberately no field here for tools, capabilities or intents: the window's
 * world is fixed at the network boundary by the one request builder, which takes
 * no parameter at all (E2).
 */
export type RunWindowScreenRegistration = {
  /** WHICH READING of the one window this screen is — the placeholder's source. */
  surface: RunWindowSurface;
  /** The run the exchange is kept with. */
  runId: string | null;
  /** The step this screen is, where the screen has one. */
  stepId?: string | null;
  /** The gate this screen opens, where the screen opens one. */
  gateRef?: string | null;
  /**
   * HAS THIS SCREEN ANYTHING TO MANIPULATE? The ruling: the window is shown
   * "only while the current step's screen holds input or output the person can
   * manipulate". A screen that has nothing — and a screen whose run would refuse
   * this person's message — publishes `false`, and the page draws no window.
   */
  canManipulate: boolean;
  /** The draft's own key, so an unsent request survives a reload. */
  storageKey: string;
  /** The exchange the screen is showing, oldest first. */
  conversation: RunWindowConversationEntry[];
  /** True while the screen's own turn is out. */
  promptPending: boolean;
  /**
   * HOW A RESULT IS APPLIED — the screen's own action, unchanged. The applying
   * road stays the run and step operations the screens already use; the page
   * calls this and the screen re-reads its state and redraws.
   */
  onSubmit: (prompt: string, attachments?: LlmAttachmentRef[]) => Promise<void>;
  /** Opt-in paperclip, exactly as the screen already opted in. */
  enableAttachments?: boolean;
  /** Closes the overlay when the screen moves to another gate. */
  resetSignal?: unknown;
};

/** The token that identifies ONE screen instance's registration. */
type ScreenToken = { readonly id: symbol };

export type RunWindowScreenStore = {
  /** The registration the page should draw, or null. */
  read(): RunWindowScreenRegistration | null;
  /**
   * A counter that moves ONLY when something the window draws has changed.
   *
   * It exists because the page's chrome subscribes in an effect, and a child's
   * effect runs BEFORE its parent's: the first registration is published while
   * the chrome has no listener yet. `useSyncExternalStore` re-reads this the
   * moment it subscribes, which is exactly the missed-notification case; a
   * hand-rolled subscription silently keeps drawing nothing.
   */
  version(): number;
  /**
   * Record what this screen publishes, and re-decide which record the page
   * draws. Notifies only when something drawn has changed.
   */
  publish(token: ScreenToken, registration: RunWindowScreenRegistration): void;
  /** Withdraw this screen's own record; the page falls back to the others'. */
  retract(token: ScreenToken): void;
  subscribe(listener: () => void): () => void;
};

/**
 * WHAT COUNTS AS A CHANGE THE WINDOW DRAWS. Function identity is deliberately
 * NOT in it: the lent action is read from the record at call time, so a screen
 * that rebuilds its handler every render does not make the window re-render.
 */
function drawnSignature(r: RunWindowScreenRegistration): string {
  return JSON.stringify([
    r.surface,
    r.runId ?? null,
    r.stepId ?? null,
    r.gateRef ?? null,
    r.canManipulate,
    r.storageKey,
    r.promptPending,
    r.enableAttachments ?? false,
    String(r.resetSignal ?? ""),
    r.conversation,
  ]);
}

export function createRunWindowScreenStore(): RunWindowScreenStore {
  // EVERY LIVE REGISTRATION, in publish order (most recently published last).
  // The page draws exactly ONE of them; the rest are kept so that withdrawing
  // the drawn one falls back to what the others published rather than blanking
  // the page.
  const records = new Map<ScreenToken, RunWindowScreenRegistration>();
  let current: RunWindowScreenRegistration | null = null;
  let owner: ScreenToken | null = null;
  let signature: string | null = null;
  let version = 0;
  const listeners = new Set<() => void>();
  const notify = () => {
    version += 1;
    for (const listener of [...listeners]) listener();
  };
  // WHICH REGISTRATION THE PAGE DRAWS — the reader is asked by the screen that
  // has something for them (cinatra#3487, the counted defect of proof round 6).
  //
  // Last-writer-wins was the whole rule here, and React's own effect order made
  // it the wrong one: a child's passive effect runs BEFORE its parent's, so a
  // screen that mounts another screen inside itself publishes LAST. At a marked
  // review gate that outer screen is the run panel, which publishes
  // "nothing to manipulate" for precisely the reading in which it mounts the
  // review card as its own child — and the card, the screen the reader is
  // actually being asked by, had already published the server's yes. The page
  // drew one record, the panel's, and the live page showed no window at all
  // while a reopened page — where the card is the only registrant — showed one.
  //
  // SO THE RULE IS PRECEDENCE, NOT ARRIVAL ORDER: a registration that lends
  // NOTHING never displaces one that lends SOMETHING for the same run, and a
  // screen may always replace its own. Nothing else about the hand-over moves:
  // the record is still one, the window is still the page's, and a screen with
  // nothing to manipulate still draws no window when it is the only one there.
  const select = () => {
    const entries = [...records.entries()];
    let chosen: [ScreenToken, RunWindowScreenRegistration] | null =
      entries.length > 0 ? entries[entries.length - 1] : null;
    if (chosen !== null && !chosen[1].canManipulate) {
      for (let i = entries.length - 2; i >= 0; i -= 1) {
        const entry = entries[i];
        if (entry[1].canManipulate && entry[1].runId === chosen[1].runId) {
          chosen = entry;
          break;
        }
      }
    }
    const nextOwner = chosen === null ? null : chosen[0];
    const nextRecord = chosen === null ? null : chosen[1];
    const next = nextRecord === null ? null : drawnSignature(nextRecord);
    const changed = nextOwner !== owner || next !== signature;
    // ALWAYS taken, even when nothing drawn changed: the record carries the
    // action the chrome calls, and that is the screen's CURRENT one.
    current = nextRecord;
    owner = nextOwner;
    if (changed) {
      signature = next;
      notify();
    }
  };
  return {
    read: () => current,
    version: () => version,
    publish(token, registration) {
      // Re-inserted so this screen's record is the most recent one: a screen
      // may always replace its own, which is what keeps a screen that has just
      // lost what it lends from being held to its own older record.
      records.delete(token);
      records.set(token, registration);
      select();
    },
    retract(token) {
      if (!records.delete(token)) return;
      select();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * The context carries the STORE, never the record: a screen publishing does not
 * change the context value, so nothing below the provider re-renders for it.
 */
export const RunWindowScreenContext = createContext<RunWindowScreenStore | null>(null);

export function RunWindowScreenProvider({
  store,
  children,
}: {
  store: RunWindowScreenStore;
  children: ReactNode;
}) {
  return (
    <RunWindowScreenContext.Provider value={store}>{children}</RunWindowScreenContext.Provider>
  );
}

/**
 * THE SCREEN'S ONE CALL. Publish what this screen is and what it lends; pass
 * `null` while the screen has nothing to register at all.
 *
 * A screen drawn with no chrome above it registers with nothing, which is how a
 * card inside a chat thread or inside the third-party island draws no window
 * without knowing anything about those hosts.
 */
export function useRunWindowScreen(
  registration: RunWindowScreenRegistration | null,
): void {
  const store = useContext(RunWindowScreenContext);
  const token = useMemo<ScreenToken>(() => ({ id: Symbol("run-window-screen") }), []);
  // Published on EVERY render (no dependency list) so the record the page reads
  // is never one render behind the screen it belongs to. The effect closes over
  // THIS render's registration — no ref, so nothing is read or written during
  // render — and the store decides whether anything the window draws changed.
  useEffect(() => {
    if (!store) return;
    if (registration) store.publish(token, registration);
    else store.retract(token);
  });
  // And withdrawn when the screen goes. Only this token's own record is cleared,
  // so a screen leaving after its successor arrived cannot blank the successor,
  // and the page falls back to whatever the screens still there published.
  useEffect(() => {
    if (!store) return;
    return () => store.retract(token);
  }, [store, token]);
}
