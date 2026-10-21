/** The run-status writer, passed in by a caller already inside the org-write perimeter. */
type GateTransition<A> = (
  runId: string,
  from: "pending_approval" | "running",
  to: "running" | "pending_approval",
  extra: undefined,
  authority: A,
) => Promise<unknown>;

/**
 * Claims a paused run's gate for one resume before anything is recorded or
 * dispatched (cinatra#3745), in lockstep with approveReviewTaskInternal.
 *
 * One conditional write moves the run `pending_approval -> running` — the
 * resume edge, which keeps the execution attempt its step-tool policy is bound
 * to — so the resumed leg's callbacks find the run running under that attempt.
 * A lost claim (`stale_from_status`) means the gate was already answered and
 * returns `{ claimed: false }`: nothing is recorded or sent. `prepare` (minting
 * the leg's run token) runs only after a won claim; if it fails, the gate is
 * put back the way it was found and the error is rethrown. A failure of the
 * dispatch itself is the caller's and does not release the claim (WayFlow may
 * already have taken the message).
 */
export async function claimGateForResume<A, T>(
  transitionRunStatus: GateTransition<A>,
  runId: string,
  authority: A,
  prepare: () => Promise<T>,
): Promise<{ claimed: false } | { claimed: true; value: T }> {
  try {
    await transitionRunStatus(runId, "pending_approval", "running", undefined, authority);
  } catch (claimErr) {
    if ((claimErr as { code?: string } | null)?.code === "stale_from_status") return { claimed: false };
    throw claimErr;
  }
  try {
    return { claimed: true, value: await prepare() };
  } catch (prepareErr) {
    await transitionRunStatus(runId, "running", "pending_approval", undefined, authority).catch((releaseErr) => {
      console.warn(`[claimGateForResume] could not release the gate claim run=${runId}`, releaseErr);
    });
    throw prepareErr;
  }
}
