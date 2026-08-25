"use client";

// ONE controller for every prompt window outside the chat (cinatra#2933,
// lifecycle-b W5b). The five windows — the run page, the step-by-step screen,
// the schedule screen, the armed-trigger tab and the review page — draw one
// window in the ratified drawing, so they share one implementation of what it
// does: read the run's stored exchange on mount, send a turn, show what came
// back. No surface forks this; a surface differs only in the props it passes.

import { useCallback, useEffect, useRef, useState } from "react";

import {
  loadRunWindowConversation,
  sendRunWindowTurn,
  type RunWindowEntry,
} from "./run-window-actions";
import type { RunWindowSurface } from "./run-window-conversation-store";

export type UseRunWindowConversation = {
  /** The stored exchange, oldest first — what the panel draws above the field. */
  entries: RunWindowEntry[];
  /** True while a turn is out. */
  pending: boolean;
  /** Send one message. Resolves when the exchange has been re-read. */
  send: (prompt: string) => Promise<void>;
  /** True once the run's stored exchange has been read on mount. */
  loaded: boolean;
};

/**
 * `runId` absent ⇒ the window has no run to keep a conversation with (the
 * instance-level schedule screen before any run exists). The hook then holds
 * the exchange in memory for the visit and sends nothing — the same window,
 * without the store it has nowhere to write to.
 */
export function useRunWindowConversation(args: {
  runId: string | null | undefined;
  surface: RunWindowSurface;
  boundCard?: { candidateRefs: string[]; focusedRef: string | null };
}): UseRunWindowConversation {
  const { runId, surface } = args;
  const [entries, setEntries] = useState<RunWindowEntry[]>([]);
  const [pending, setPending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // The claim is re-read at send time rather than captured in the callback's
  // closure, so a card that binds after mount still travels with the message.
  const boundCardRef = useRef(args.boundCard);
  boundCardRef.current = args.boundCard;
  // A local id source for the run-less window, which has no stored positions.
  const localIdRef = useRef(0);

  useEffect(() => {
    if (!runId) {
      setLoaded(true);
      return;
    }
    let cancelled = false;
    setLoaded(false);
    void loadRunWindowConversation(runId).then((rows) => {
      if (cancelled) return;
      // The stored exchange IS the state: what a reload shows is what the run
      // holds, never a client-side merge of the two.
      setEntries(rows);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  const send = useCallback(
    async (prompt: string) => {
      const text = prompt.trim();
      if (!text) return;
      if (!runId) {
        // No run, no store: the window still answers nothing on its own, so it
        // shows what was typed and says plainly that it cannot carry it.
        setEntries((prev) => [
          ...prev,
          { id: ++localIdRef.current, role: "user", content: text },
          {
            id: ++localIdRef.current,
            role: "assistant",
            content:
              "This screen has no run yet, so there is nothing to hold a conversation about. Start the run and the window will answer here.",
          },
        ]);
        return;
      }
      setPending(true);
      // The person's own words appear immediately; the server is what makes
      // them durable, and the re-read below replaces this optimistic row with
      // the stored one.
      setEntries((prev) => [
        ...prev,
        { id: prev.length + 1, role: "user", content: text },
      ]);
      try {
        const outcome = await sendRunWindowTurn({
          runId,
          surface,
          prompt: text,
          ...(boundCardRef.current ? { boundCard: boundCardRef.current } : {}),
        });
        if (outcome.ok) {
          setEntries(outcome.entries);
        } else {
          setEntries((prev) => [
            ...prev,
            { id: prev.length + 1, role: "assistant", content: outcome.message },
          ]);
        }
      } finally {
        setPending(false);
      }
    },
    [runId, surface],
  );

  return { entries, pending, send, loaded };
}
