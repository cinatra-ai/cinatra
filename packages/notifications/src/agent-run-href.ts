// ---------------------------------------------------------------------------
// Canonical agent-run deep-link resolver for background-process notifications.
//
// Maps a BullMQ job's `data.runId` to the agent-run page path
// `/agents/{vendor}/{pkg}/{runId}`. Used by the notification writer hooks in
// src/lib/background-jobs.ts (notifyJobStarted / notifyJobLifecycle) so a
// running OR terminal background-process notification deep-links to the run.
//
// CANONICAL resolution (do NOT change): the path is built from
// run.templateId -> template.packageName -> buildAgentInstancePath. It is
// NEVER derived from a slug carried in jobData (a stale or parent slug would
// open the wrong agent shell) and NEVER from job.id (BullMQ ids are
// inconsistent: bare runId, `agent-builder-${runId}`,
// `resume-${reviewTaskId}`, or A2A auto-assigned).
//
// Non-agent jobs (blog-post-*, skill-*, litellm-pricing-sync) carry no
// `data.runId` -> this returns undefined -> the notification is link-less,
// exactly as before (no behavior change for those jobs).
//
// Defensive: the whole body is wrapped in try/catch returning undefined. The
// worker writer path must never throw into the BullMQ worker.
//
// `@cinatra-ai/agents` is a package dependency (declared in
// packages/notifications/package.json). The path-builder below is a
// verbatim copy of the host's pure `src/lib/agent-url.ts`
// `buildAgentInstancePath` — duplicated here (4 lines, zero deps) so the
// package does not import `@/` (the package boundary forbids host `@/`
// imports; an adapter for a trivial pure string fn would be over-injection).
//
// THE RUN'S OWN HOME, NOT THE BARE ROAD (cinatra#3693). A run launched from a
// scope lives under that scope's base, and the drawing makes Notifications the
// road to a review: "a review is reached from the Notifications page of every
// scope … and opens in place on its run page." So the address minted here
// reads the run's immutable launch-scope anchor and prefixes the base it names.
// A run with no anchor keeps the bare address, unchanged.
//
// That means a SECOND verbatim copy, of the host's `launchScopeAnchorBase` and
// of the decoder that feeds it (`parseLaunchScopeAnchor`), for the same
// no-`@/` reason. The decoder's FAIL-CLOSED rule is copied with it: an unknown
// version, a kind outside the union, a workspace arm that carries an `id` key
// at all, a non-string id, and an empty or sentinel id each read as UNANCHORED
// and keep the bare address. A copy that drifts would send a reader to the
// wrong scope's road, so the agreement with the host's originals is pinned by
// `src/lib/__tests__/launch-scope-copies-agree-3693.test.ts`.
// ---------------------------------------------------------------------------

/** The anchor version this build vouches for. Copy of
 *  `LAUNCH_SCOPE_ANCHOR_VERSION`. */
const LAUNCH_SCOPE_ANCHOR_VERSION = 1;

/** The reserved id no scope may use. Copy of `WORKSPACE_SCOPE_SENTINEL`. */
const WORKSPACE_SCOPE_SENTINEL = "__workspace__";

/** The query name that carries the run detail's open step. Copy of
 *  `RUN_STEP_QUERY_KEY`. */
const RUN_STEP_QUERY_KEY = "step";

/**
 * THE RUN'S ADDRESS WITH ONE STEP OPEN, which is what a review's address IS
 * (cinatra#3693). Verbatim copy of `src/lib/agent-url.ts`'s `buildRunStepPath`.
 *
 * The ratified drawing gives a review no page: "a pending review renders the
 * review gate in the run detail, under the same rail, never as a standalone
 * document", and "there is no review page view outside the run's route". So a
 * reader sent to one review is sent to the RUN, with the gate's own rail
 * selection named on the address, and the run detail opens there on first
 * render.
 */
function buildRunStepPathCopy(runPath: string, step: string): string {
  return `${runPath}?${RUN_STEP_QUERY_KEY}=${encodeURIComponent(step)}`;
}

/** The rail's selection key for one of a run's review gates. Copy of
 *  `runReviewGateStepKey` (`packages/agents/src/run-surface-rail-step.ts`). */
function runReviewGateStepKeyCopy(reviewTaskId: string): string {
  return `review:${reviewTaskId}`;
}

/** The scope base each anchor kind addresses. Copy of
 *  `launchScopeAnchorBase`'s four-kind map. The `user` kind is FLAT BY DESIGN:
 *  `/personal` means "mine" to whoever reads it, so it is not an address. */
const LAUNCH_SCOPE_ANCHOR_BASE: Readonly<Record<string, ((id: string) => string) | null>> = {
  workspace: () => "/workspace",
  organization: (id) => `/organizations/${encodeURIComponent(id)}`,
  team: (id) => `/teams/${encodeURIComponent(id)}`,
  project: (id) => `/projects/${encodeURIComponent(id)}`,
  user: null,
};

/**
 * The scope base a stored anchor addresses, or `null` for a flat run. That is
 * both the personal anchor's answer and the answer for every payload this
 * build cannot vouch for. Verbatim copy of the host's
 * `launchScopeAnchorBase(parseLaunchScopeAnchor(raw))`, decoder included.
 *
 * Exported for the agreement test only; every caller here goes through
 * `buildAgentInstancePath`.
 */
export function launchScopeAnchorBaseCopy(raw: unknown): string | null {
  if (raw == null) return null;
  let value: unknown = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (obj.v !== LAUNCH_SCOPE_ANCHOR_VERSION) return null;
  if (typeof obj.kind !== "string") return null;
  if (!Object.prototype.hasOwnProperty.call(LAUNCH_SCOPE_ANCHOR_BASE, obj.kind)) return null;
  const base = LAUNCH_SCOPE_ANCHOR_BASE[obj.kind];
  if (obj.kind === "workspace") {
    // The union's workspace arm has NO `id` field, so a payload that carries
    // the key at all, `null` included, is one no mint can have produced.
    return Object.prototype.hasOwnProperty.call(obj, "id") ? null : base!("");
  }
  if (typeof obj.id !== "string") return null;
  const id = obj.id.trim();
  if (id.length === 0 || id === WORKSPACE_SCOPE_SENTINEL) return null;
  return base ? base(id) : null;
}

/**
 * Parse a scoped npm package name (`@scope/name` or bare `name`) into the
 * `/agents/[vendor]/[packageName]/[instanceId]` URL structure, under the base
 * the run's launch-scope anchor names (cinatra#3693). Verbatim copy of
 * `src/lib/agent-url.ts:buildAgentInstancePath`, whose `scopeBase` is a plain
 * prefix in exactly the same way.
 */
// Exported so service.ts's `emitAgentCreationProgress` can reuse the same
// in-package helper instead of importing the host's `@/lib/agent-url`
// (which would violate the package's no-`@/` rule).
// cinatra#3080 - THE INSTANCE ID IS A PATH SEGMENT, SO IT IS ENCODED AS ONE.
// Every ordinary run id is a uuid, which encodes to itself, so every link the
// product has ever drawn is byte-identical. A repair run's id is not: it is
// derived from its repair (`lifecycle-repair-run:` plus the repair id) and
// carries a character a path segment must escape, so the link the product built
// for it was not a URL for that run at all.
export function buildAgentInstancePath(
  agentPackageName: string,
  instanceId: string,
  opts?: { readonly launchScopeAnchor?: unknown },
): string {
  const base = launchScopeAnchorBaseCopy(opts?.launchScopeAnchor) ?? "";
  const segment = encodeURIComponent(instanceId);
  const match = agentPackageName.match(/^@([^/]+)\/(.+)$/);
  if (match) return `${base}/agents/${match[1]}/${match[2]}/${segment}`;
  return `${base}/agents/${agentPackageName}/${segment}`;
}

/**
 * Resolve the agent-run page href for a background-process notification from
 * the BullMQ job's `data`. Returns the route path on success, or `undefined`
 * for any unresolvable / non-agent / absent input (link-less notification).
 *
 * A `reviewTaskId` beside the run id names ONE of the run's review gates
 * (cinatra#3693), and the href then carries that gate's own rail selection: the
 * drawing makes Notifications the road to a review, and "a review is reached
 * from the Notifications page of every scope … and opens in place on its run
 * page". Absent, the href is the run page with no step named, which is exactly
 * what it has always been.
 *
 * `readAgentRunById` is called with the runId ONLY (no actor argument) so the
 * auth gate inside the store function is skipped — correct for the worker
 * writer path which has no session. It only reads templateId / packageName to
 * build a path string; it does not return run data to any caller.
 */
export async function resolveAgentRunHref(
  jobData: unknown,
): Promise<string | undefined> {
  try {
    if (!jobData || typeof jobData !== "object") return undefined;
    const runId = (jobData as Record<string, unknown>).runId;
    if (typeof runId !== "string" || runId.trim().length === 0) {
      return undefined;
    }

    const { readAgentRunById, readAgentTemplateById } = await import(
      "@cinatra-ai/agents"
    );

    // No actor argument -> the store function's `if (actor)` access-gate
    // block is bypassed (worker has no session).
    const run = await readAgentRunById(runId);
    if (!run) return undefined;

    const template = await readAgentTemplateById(run.templateId);
    if (!template) return undefined;

    // AgentTemplateRecord.packageName is `string | null | undefined` — must
    // NOT throw or build a malformed "/agents//R1" path.
    const packageName =
      typeof template.packageName === "string"
        ? template.packageName.trim()
        : "";
    if (packageName.length === 0) return undefined;

    // Under the run's own scope base, when its anchor names one.
    const runPath = buildAgentInstancePath(packageName, runId, {
      launchScopeAnchor: (run as { launchScopeAnchor?: unknown }).launchScopeAnchor,
    });
    // AND ON THE GATE THE NOTIFICATION IS ABOUT, WHERE IT NAMES ONE
    // (cinatra#3693). Read from the job data the caller passes, never from the
    // job id: a BullMQ id spells a review task as `resume-${reviewTaskId}` on one
    // path and not at all on another, and a guessed gate would open the wrong
    // one. A blank or non-string value is no gate and keeps the run's own
    // address.
    const reviewTaskId = (jobData as Record<string, unknown>).reviewTaskId;
    if (typeof reviewTaskId !== "string" || reviewTaskId.trim().length === 0) {
      return runPath;
    }
    return buildRunStepPathCopy(runPath, runReviewGateStepKeyCopy(reviewTaskId.trim()));
  } catch {
    // Writer path must never throw into the worker.
    return undefined;
  }
}
