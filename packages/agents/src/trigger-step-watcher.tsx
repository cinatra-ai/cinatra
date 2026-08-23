"use client";

// ---------------------------------------------------------------------------
// The live run page follows the run into its trigger step (cinatra#2952).
//
// WHY THIS EXISTS. Which panel the run detail draws is a SERVER decision
// (`runDetailPanelKind` in instance-screens.tsx): a run on `pending_trigger`
// with no trigger row owes the scheduling step, and gets it. But the person who
// just answered the setup gate is looking at a page that was rendered while the
// run was still `pending_approval`, and the panel drawing that gate is a client
// component that stays mounted across the transition. Nothing re-renders the
// server tree, so the settled setup card stays on screen with its submit stuck
// on "Submitting…" — and its only control re-submits an approval the server now
// refuses. That is the reported defect, and reloading the page is not a step a
// person should have to know about.
//
// WHY NOT THE RUN STREAM. `useAgUiRunStream` reports `running`,
// `pending_approval` and the terminal states only — `pending_trigger` is never
// an AG-UI event, so a panel bound to that stream cannot see this transition at
// all. The run's own REST row is the only place it shows up.
//
// WHAT IT COSTS, AND FOR HOW LONG. One `GET /api/agents/runs/<id>` at a time —
// never a second queued behind a slow one — every two seconds, and only while
// the transition is still possible: the screen enables it on
// `runMayReachTriggerStep` (instance-screens.tsx), which is the setup branch of
// a run that can still reach `pending_trigger` and owes the step. It fires
// `router.refresh()` ONCE and then stands down; the refresh re-renders the
// screen onto the trigger branch, which does not mount it. Unmounting clears the
// interval and aborts the read in flight.
//
// The `agentic` branch has carried the same responsibility since cinatra#580
// through `SetupCompletionWatcher`, which routes to /trigger instead; that path
// is untouched here.
// ---------------------------------------------------------------------------

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

const POLL_INTERVAL_MS = 2_000;

export function TriggerStepWatcher({
  runId,
  enabled,
}: {
  runId: string;
  /** Mount-time gate: the run is on the setup branch and owes its trigger step. */
  enabled: boolean;
}) {
  const router = useRouter();
  const firedRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let inFlight = false;
    let intervalId = 0;
    const controller = new AbortController();
    const stop = () => window.clearInterval(intervalId);

    intervalId = window.setInterval(() => {
      if (firedRef.current) {
        stop();
        return;
      }
      // ONE read at a time. A slow answer must not queue a second request
      // behind it every two seconds.
      if (inFlight) return;
      inFlight = true;
      fetch(`/api/agents/runs/${encodeURIComponent(runId)}`, {
        cache: "no-store",
        signal: controller.signal,
      })
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error("not ok"))))
        .then((data: { status?: string }) => {
          if (cancelled || firedRef.current) return;
          if (data.status !== "pending_trigger") return;
          firedRef.current = true;
          stop();
          router.refresh();
        })
        // Transient failure (or the abort below): the next tick retries. A
        // watcher that cannot read the run must never take the page down.
        .catch(() => {})
        .finally(() => {
          inFlight = false;
        });
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      stop();
      controller.abort();
    };
  }, [runId, enabled, router]);

  return null;
}
