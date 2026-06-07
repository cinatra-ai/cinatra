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
// ---------------------------------------------------------------------------

/**
 * Parse a scoped npm package name (`@scope/name` or bare `name`) into the
 * `/agents/[vendor]/[packageName]/[instanceId]` URL structure. Verbatim copy
 * of `src/lib/agent-url.ts:buildAgentInstancePath`.
 */
// Exported so service.ts's `emitAgentCreationProgress` can reuse the same
// in-package helper instead of importing the host's `@/lib/agent-url`
// (which would violate the package's no-`@/` rule).
export function buildAgentInstancePath(
  agentPackageName: string,
  instanceId: string,
): string {
  const match = agentPackageName.match(/^@([^/]+)\/(.+)$/);
  if (match) return `/agents/${match[1]}/${match[2]}/${instanceId}`;
  return `/agents/${agentPackageName}/${instanceId}`;
}

/**
 * Resolve the agent-run page href for a background-process notification from
 * the BullMQ job's `data`. Returns the route path on success, or `undefined`
 * for any unresolvable / non-agent / absent input (link-less notification).
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

    return buildAgentInstancePath(packageName, runId);
  } catch {
    // Writer path must never throw into the worker.
    return undefined;
  }
}
