"use client";

/**
 * THE CURATOR RUN'S HALF OF THE `?onComplete` RETURN CONTRACT (cinatra#3369,
 * acceptance item 2).
 *
 * Mounted by the run screen ONLY for a run whose address carries
 * `?onComplete=list-picker` -- a run the list picker's "Build a list with AI"
 * CTA launched. It draws nothing. Its whole job is the sentence beside that CTA:
 * "on completion they return to this picker with the new listId pre-selected".
 *
 * It watches the run it is mounted on, and when that run REACHES `completed` it
 * leaves the finish in the same-origin store the picker's own tab reads
 * (`list-picker-renderer.tsx`). The operator comes back to that tab and finds the
 * list they just built on offer and selected.
 *
 * `failed` and `stopped` end the watch and hand nothing back: a curator run
 * that did not finish built no list, and a picker that re-selected on one would
 * be telling the operator a list exists because a run ended.
 *
 * THE WATCH IS `SetupCompletionWatcher`'s POLLING FALLBACK, deliberately and
 * only that. That watcher is this page's established way of noticing a run
 * changing status from the client, and its poll of `/api/agents/runs/<id>` is
 * the arm that does not depend on the AG-UI stream being enabled for the
 * template. This one reuses the road and none of the navigation: it never
 * routes, so it can never compete with the redirects that watcher owns.
 *
 * It fires ONCE. The poll stops at the first terminal reading, and a run that
 * was already `completed` when the page was opened hands back on mount -- the
 * operator who reloads the finished curator run still returns to a picker that
 * knows.
 */

import { useEffect, useRef } from "react";
// The picker owns this contract and is where it is stated: the same module
// reads the finish back. Imported from there rather than from a leaf of its own
// because the picker is already inside every locked route's module graph while
// a new leaf would not be -- see the hand-back section of that file.
import {
  listPickerReturnStore,
  publishListPickerReturn,
} from "./list-picker-renderer";

/** Same cadence as the run page's existing status poll. */
const POLL_INTERVAL_MS = 800;

export type ListPickerReturnWatcherProps = {
  /** The curator run this page is drawing. */
  runId: string;
  /** Its status at the server render, so a finished run hands back at once. */
  initialStatus: string;
};

export function ListPickerReturnWatcher({
  runId,
  initialStatus,
}: ListPickerReturnWatcherProps) {
  const handedBackRef = useRef(false);

  useEffect(() => {
    // A new run is a new watch: the fire-once latch belongs to the run this
    // effect is watching, not to the component instance the screen reused.
    handedBackRef.current = false;
    let cancelled = false;
    let interval: number | null = null;

    const stop = () => {
      if (interval !== null) {
        window.clearInterval(interval);
        interval = null;
      }
    };

    const handBack = () => {
      if (handedBackRef.current) return;
      handedBackRef.current = true;
      stop();
      // The store is taken through the guarded accessor: `window.localStorage`
      // throws on the getter itself where site data is blocked, and a curator
      // run that cannot hand back must still finish normally.
      publishListPickerReturn(listPickerReturnStore(), { runId, at: Date.now() });
    };

    /** true once the run can change status no more. */
    const settle = (status: string | undefined): boolean => {
      if (status === "completed") {
        handBack();
        return true;
      }
      return status === "failed" || status === "stopped";
    };

    if (settle(initialStatus)) return;

    interval = window.setInterval(() => {
      if (cancelled) {
        stop();
        return;
      }
      fetch(`/api/agents/runs/${encodeURIComponent(runId)}`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("run read failed"))))
        .then((data: { status?: string }) => {
          if (cancelled) return;
          if (settle(data.status)) stop();
        })
        .catch(() => {
          // A single unreadable poll is not an answer about the run. The next
          // tick asks again; nothing is handed back on a read that failed.
        });
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      stop();
    };
  }, [runId, initialStatus]);

  return null;
}
