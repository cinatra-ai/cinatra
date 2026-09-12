"use client";

/**
 * THE RUN ROW, FOR A SURFACE WHOSE ONLY TRANSPORT IS A STREAM THAT CANNOT SPEAK
 * (cinatra#3007, fix leg 9).
 *
 * `resolveRunSurfaceStatus` states the rule this hook exists to serve: a run
 * whose produced output opens a review reaches no terminal status, announces
 * nothing, and leaves the stream's last word at `running` for as long as the
 * park lasts. The conversation's panel already resolves through that rule
 * because it has a tick of its own to read the row with. The run page's stepper
 * has none — it is driven by the stream alone — so it read the stream's word
 * raw, drew a working run for the whole of a park, and the ONE shared
 * review-slot reader it mounts never took a single look: that reader only ever
 * looks under `completed` or the parked status, and this surface never reported
 * either. The eighth graded reading measured the consequence exactly: no run page
 * swapped its review card in, in either run, across 899 s of one-second polls,
 * and the only thing that changed on the page was the run's own step advance.
 *
 * SO THIS IS A ROW READ, AND ONLY FOR THE WINDOW IN WHICH THE STREAM IS MUTE.
 * It is enabled by `runStreamMayBeMute`, so it opens only while the stream's
 * last word is one of the two the stream cannot leave on its own, and it closes
 * the moment the stream speaks a park or a terminal status. It reads the run's
 * OWN seed route, same-origin and cookie-borne, which is the route this page is
 * already served from and the same one the shared reader asks.
 *
 * WHAT IT ANSWERS. The row's status, for the rule above; the row's own PARK; and
 * a count of the looks that actually answered, which is the liveness evidence the
 * shared reader's failure belt is a proxy for. Nothing is derived here: the row's
 * own words are handed on, and every decision about them is taken by the pure
 * resolver and by the reader.
 *
 * WHY THE PARK IS CARRIED TOO (cinatra#3046, fix leg 12). This hook already reads
 * the route that SERVES the park — `reviewGate.producedReviewPark`, minted off
 * the run row the response is about — and threw the field away, keeping only the
 * status. So the run page's only reading of the park was the shared slot
 * reader's, a SECOND read on its own schedule; the conversation's panel has
 * always taken the row's word beside the slot's and ORed the two. The tenth
 * graded reading measured the difference exactly: the conversation landed the
 * review card 4.3 s and 4.7 s after the gate row, and the run page drew no card
 * at all across 567 one-second polls in either palette. Handing the field on
 * costs no request — it is already in the response body being parsed.
 *
 * THE COST, STATED: a run page open on a working or parked run reads one small
 * same-origin route every five seconds. That is the cadence the conversation's
 * own surface already reads the same route on, so it is not a new class of load,
 * and it ends with the run.
 */
import { useEffect, useState } from "react";

import { runStatusIsTerminal } from "./run-surface-status";

/** How often the row is read while the stream cannot say what the run is doing. */
export const RUN_ROW_WATCH_SPACING_MS = 5000;
/**
 * AND EVERY LOOK HAS AN END (convergence). The chain schedules its next look
 * when the last one FINISHES, which is what stops a slow route stacking requests
 * on itself — and is exactly why a look that never finishes would end the chain
 * for the life of the mount and put this page back where the eighth graded
 * reading found it. So a look is given a deadline and abandoned at it.
 */
export const RUN_ROW_WATCH_DEADLINE_MS = 10000;

export type RunRowWatch = {
  /** The run row's own status, or `null` until a look has answered. */
  rowStatus: string | null;
  /** The run row's OWN word on the produced-review park, from the same answer the
   *  status came from. `false` until a look has answered. A look that answers
   *  WITHOUT the field says nothing about the park and leaves the last real
   *  answer standing (convergence): a partial or older body is not evidence that
   *  a park ended, and treating it as one is how this half's evidence used to
   *  disappear under a surface that ORs the two halves. It is reset with the run
   *  it belongs to, so no run inherits another's park. */
  rowProducedReviewPark: boolean;
  /** How many looks have ANSWERED — the surface's evidence its transport works. */
  heardFromRun: number;
};

export function useRunRowWatch(
  runId: string,
  { enabled }: { enabled: boolean },
): RunRowWatch {
  const [rowStatus, setRowStatus] = useState<string | null>(null);
  const [rowProducedReviewPark, setRowProducedReviewPark] = useState(false);
  const [heardFromRun, setHeardFromRun] = useState(0);

  // THE ROW'S WORDS BELONG TO THE RUN THEY WERE READ FOR (convergence). This
  // effect is declared FIRST and keyed on `runId` alone, so a host that swaps
  // one run for another on the same mount starts with no status and no park
  // rather than classifying the new run's first pending approval with the old
  // run's answer.
  useEffect(() => {
    setRowStatus(null);
    setRowProducedReviewPark(false);
  }, [runId]);

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer: number | undefined;
    let inFlight: AbortController | null = null;
    // A CHAIN, NOT AN INTERVAL: the next look is scheduled when the last one is
    // finished, so a slow route cannot stack requests on itself.
    const look = async () => {
      // AND THE CHAIN ENDS WITH THE RUN (convergence). The window this watch is
      // enabled for is named off the STREAM's last word, and a stream stuck at
      // `running` never leaves it — so a run this watch has already seen finish
      // would be read every five seconds for the life of the tab. The row's own
      // terminal word is the end of the matter: nothing after it can change,
      // and the shared reader below keeps its own schedule under `completed`.
      let heardTerminal = false;
      const controller = new AbortController();
      inFlight = controller;
      const deadline = window.setTimeout(
        () => controller.abort(),
        RUN_ROW_WATCH_DEADLINE_MS,
      );
      try {
        const response = await fetch(
          `/api/agents/runs/${encodeURIComponent(runId)}`,
          { cache: "no-store", signal: controller.signal },
        );
        if (response.ok) {
          const data = (await response.json()) as {
            status?: unknown;
            reviewGate?: { producedReviewPark?: unknown };
          };
          if (typeof data.status === "string" && runStatusIsTerminal(data.status)) {
            heardTerminal = true;
          }
          if (!stopped) {
            if (typeof data.status === "string") setRowStatus(data.status);
            // The row's own word, taken WHOLE off the answer that carried the
            // status — the same snapshot, so the two can never disagree about
            // one run. An answer whose body has no gate object says `false`,
            // which is what this surface read before the field was carried.
            // ONLY a boolean is an answer (convergence). `undefined` is a body
            // that did not carry the field — a legacy or partial answer — and
            // the last real answer stands rather than being cleared by it.
            if (typeof data.reviewGate?.producedReviewPark === "boolean") {
              setRowProducedReviewPark(data.reviewGate.producedReviewPark);
            }
            // Bumped on the ANSWER, never on the attempt: it is evidence that
            // this surface's transport works, and a look that failed is not.
            setHeardFromRun((n) => n + 1);
          }
        }
      } catch {
        // The next look tries again. A read that fails — or one abandoned at
        // its deadline — says nothing about the run, so nothing is written and
        // nothing is counted.
      } finally {
        window.clearTimeout(deadline);
        if (inFlight === controller) inFlight = null;
      }
      if (!stopped && !heardTerminal) {
        timer = window.setTimeout(() => void look(), RUN_ROW_WATCH_SPACING_MS);
      }
    };
    void look();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
      // The look in flight is ABANDONED as well as ignored: a remount, a run
      // change or the window closing must not leave a request behind it.
      if (inFlight !== null) inFlight.abort();
    };
  }, [runId, enabled]);

  return { rowStatus, rowProducedReviewPark, heardFromRun };
}
