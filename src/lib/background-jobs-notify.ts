// Leaf module: job-lifecycle notification helpers.
//
// Extracted from `background-jobs.ts` (cinatra#2039 S1 ratchet slice) so the
// thin runtime module stays under its file-size ceiling. These helpers are the
// BullMQ worker.on('active' | 'completed' | 'failed') notification splices: they
// resolve a recipient via the policy in
// packages/notifications/src/recipient-policy.ts and fan out to per-user rows.
//
// Every path is DEFENSIVE — any thrown error is swallowed and logged; helper
// failures must never kill the worker. The @cinatra-ai/notifications/server
// writers stay behind DYNAMIC imports so the notifications module is not pulled
// into the worker boot graph until a notification is actually emitted (the same
// property the inlined versions had). This module has no module-level runtime
// deps beyond that dynamic import + console.

// ---------------------------------------------------------------------------
// Notify on job lifecycle.
//
// Called from the BullMQ worker.on('completed' | 'failed') hooks. Resolves a
// recipient via the policy in packages/notifications/src/recipient-policy.ts and
// fans out to per-user rows. Defensive in every direction: any thrown error
// is swallowed; helper failures must never kill the worker.
// ---------------------------------------------------------------------------
export async function notifyJobLifecycle(
  job:
    | { id?: string | number | null; name?: string; data?: unknown }
    | undefined,
  err: unknown,
  status: "completed" | "failed",
): Promise<void> {
  try {
    const {
      getRecipientForJob,
      createNotificationForRecipient,
      resolveAgentRunHref,
    } = await import("@cinatra-ai/notifications/server");
    const recipient = getRecipientForJob({
      jobName: job?.name,
      jobData: job?.data,
      status,
    });
    if (!recipient) return;

    // Resolve the agent-run deep-link from job.data BEFORE the INSERT. The
    // LISTEN/NOTIFY trigger is AFTER INSERT only and the dedupe index is ON
    // CONFLICT DO NOTHING (first write wins, no UPDATE/repair path) — the href
    // must be correct on this first terminal insert. Resolver returns
    // undefined for non-agent jobs (link-less, unchanged).
    const href = await resolveAgentRunHref(job?.data);

    const isError = status === "failed";
    const title = isError
      ? `${prettyJobName(job?.name)} failed`
      : `${prettyJobName(job?.name)} completed`;
    const body = isError ? errorToBody(err) : "Background job finished.";
    await createNotificationForRecipient(recipient, {
      title,
      body,
      kind: isError ? "error" : "success",
      href,
      sourceJobId: job?.id != null ? String(job.id) : undefined,
      sourceJobName: job?.name,
    });
  } catch (notifyErr) {
    console.warn(
      "[background-jobs] notifyJobLifecycle skipped:",
      notifyErr instanceof Error ? notifyErr.message : notifyErr,
    );
  }
}

// ---------------------------------------------------------------------------
// Notify on job start (BullMQ worker.on("active")).
//
// Inserts an `info`-kind, auto-read notification row carrying
// `metadata.progress.status = "running"`. The flyout's In-progress tab
// renders this row with a spinner; once `notifyJobLifecycle` fires for the
// same `sourceJobId` (different `kind`, dedupe-safe per the partial unique
// index), `collapseByJobId` in the client replaces the running row with
// the terminal one.
//
// active fires on every "picked by worker" event, including BullMQ retries
// and waiting-children re-entry. The partial idx makes that idempotent: the
// second running insert for the same (user, jobId, kind="info") is a no-op
// via ON CONFLICT DO NOTHING.
// ---------------------------------------------------------------------------
export async function notifyJobStarted(
  job: { id?: string | number | null; name?: string; data?: unknown } | undefined,
): Promise<void> {
  try {
    if (!job?.id || !job?.name) return;
    const {
      getRecipientForJob,
      createBackgroundProgressNotification,
      resolveAgentRunHref,
    } = await import("@cinatra-ai/notifications/server");
    const recipient = getRecipientForJob({
      jobName: job.name,
      jobData: job.data,
      status: "started",
    });
    if (!recipient) return;
    // Resolve the agent-run deep-link from job.data and set it inline on the
    // running INSERT (worker.on("active") fires before the dispatcher;
    // resolution is awaited so the href is present on the first — and only —
    // running row, since ON CONFLICT DO NOTHING means there is no later repair
    // path). Non-agent jobs resolve to undefined -> link-less, unchanged.
    const href = await resolveAgentRunHref(job.data);
    await createBackgroundProgressNotification({
      recipient,
      jobId: String(job.id),
      jobName: job.name,
      title: `${prettyJobName(job.name)} in progress`,
      body: "Started.",
      href,
    });
  } catch (notifyErr) {
    console.warn(
      "[background-jobs] notifyJobStarted skipped:",
      notifyErr instanceof Error ? notifyErr.message : notifyErr,
    );
  }
}

function prettyJobName(name: string | undefined): string {
  if (!name) return "Background job";
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function errorToBody(err: unknown): string {
  if (err instanceof Error) return err.message || err.name || "Unknown error";
  if (typeof err === "string") return err;
  return "Unknown error";
}
