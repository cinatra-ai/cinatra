// Parses a scoped npm package name (@scope/name or name) into the
// /agents/[vendor]/[packageName]/[instanceId] URL structure.
//
// THE SCOPE BASE IS A PREFIX (cinatra#2809, per-scope surfaces S3).
//
// Every vantage in the product — the workspace, a person's own scope, a
// project, a team, an organization — carries the same Agents surface, and a
// launch made from one of them belongs to it. So the agent routes are the SAME
// routes with the scope's own landing route in front: `/teams/<id>` +
// `/agents/<vendor>/<package>/<instance>`. A PREFIX, never a segment: the
// vendor/package/instance grammar below is untouched, which is why the bare
// `/agents/…` route stays exactly what it was and remains the global entry
// point.
//
// The base arrives as a plain string (`scopeSurfaceBase` in
// `src/lib/scope-surfaces.ts` mints it) rather than as a scope reference, so
// this leaf keeps its zero imports and the route graph gains no edge.
//
// `new` and `settings` are RESERVED below the vendor/package pair: the first is
// the launcher (a fresh run), the second the agent's settings surface at this
// scope. The reservation is on the segment AFTER the pair and nowhere else — a
// package genuinely named `new` addresses fine, because its name is the pair's
// second half, not the instance slot.

/** The launcher's instance segment — a fresh run, not a persisted one. */
export const AGENT_LAUNCH_SEGMENT = "new";

/** The agent's settings surface at the addressed scope. */
export const AGENT_SETTINGS_SEGMENT = "settings";

/** The words no persisted instance id may occupy. */
export const RESERVED_AGENT_INSTANCE_SEGMENTS: readonly string[] = Object.freeze([
  AGENT_LAUNCH_SEGMENT,
  AGENT_SETTINGS_SEGMENT,
]);

export function isReservedAgentInstanceSegment(segment: string): boolean {
  return RESERVED_AGENT_INSTANCE_SEGMENTS.includes(segment);
}

/** Options every builder here takes: the scope this address belongs to. */
export type AgentPathScope = {
  /** The scope's own landing route, e.g. `/teams/t1`. Absent = the bare route. */
  scopeBase?: string | null;
};

/**
 * A scope base is a rooted path with no trailing slash, no empty segment and no
 * whitespace. Validated rather than trusted: a base that ends in a slash or
 * carries a stray one would mint `//agents/…`, which is a protocol-relative URL
 * to another host the moment it reaches an anchor tag.
 */
function normalizeScopeBase(scope: AgentPathScope | undefined): string {
  const base = scope?.scopeBase;
  if (base == null || base === "") {
    if (base === "") throw new Error("agent-url: scope base must not be empty");
    return "";
  }
  if (!/^(?:\/[^/\s\\]+)+$/.test(base)) {
    throw new Error(`agent-url: invalid scope base ${JSON.stringify(base)}`);
  }
  return base;
}

function packageSegments(agentPackageName: string): string {
  const match = agentPackageName.match(/^@([^/]+)\/(.+)$/);
  return match ? `${match[1]}/${match[2]}` : agentPackageName;
}

// cinatra#3080 - THE INSTANCE ID IS A PATH SEGMENT, SO IT IS ENCODED AS ONE.
// Every ordinary run id is a uuid, which encodes to itself, so every link the
// product has ever drawn is byte-identical. A repair run's id is not: it is
// derived from its repair (`lifecycle-repair-run:` plus the repair id) and
// carries a character a path segment must escape, so the link the product built
// for it was not a URL for that run at all. A repair run is a run; the link to
// its page is built the same way as any other run's and is valid for any id.
export function buildAgentInstancePath(
  agentPackageName: string,
  instanceId: string,
  scope?: AgentPathScope,
): string {
  if (isReservedAgentInstanceSegment(instanceId)) {
    throw new Error(
      `agent-url: ${JSON.stringify(instanceId)} is a reserved segment below the vendor/package pair — it is a route of its own, not an instance id`,
    );
  }
  return `${normalizeScopeBase(scope)}/agents/${packageSegments(agentPackageName)}/${encodeURIComponent(instanceId)}`;
}

// cinatra#3080 - AND A PATH SEGMENT IS READ BACK THE WAY IT WAS WRITTEN.
// The router hands a dynamic segment to a page still percent-encoded, so the
// value a page reads out of `params` is the SEGMENT, not the id. Every ordinary
// run id is a uuid, which is byte-identical either way, so the difference was
// invisible until a repair run - whose id carries a colon - opened its own page
// and the run row was looked up under `lifecycle-repair-run%3A...`, which is no
// run at all. This is the inverse of `buildAgentInstancePath`: what that writes
// into a link, this reads back out of the route.
//
// A malformed sequence is NOT an error to raise from a page: it is simply not
// an id any run has, and the caller's own missing-run answer is the right one.
export function readAgentInstanceIdFromSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The LAUNCHER — a fresh run of this agent, at this scope. */
export function buildAgentWorkspacePath(
  agentPackageName: string,
  scope?: AgentPathScope,
): string {
  return `${buildAgentPackageBasePath(agentPackageName, scope)}/${AGENT_LAUNCH_SEGMENT}`;
}

/** The agent's SETTINGS surface at this scope — the href a card's Settings
 *  button targets (the contract #2808's cards compose on). */
export function buildAgentSettingsPath(
  agentPackageName: string,
  scope?: AgentPathScope,
): string {
  return `${buildAgentPackageBasePath(agentPackageName, scope)}/${AGENT_SETTINGS_SEGMENT}`;
}

export function buildAgentPackageBasePath(
  agentPackageName: string,
  scope?: AgentPathScope,
): string {
  return `${normalizeScopeBase(scope)}/agents/${packageSegments(agentPackageName)}`;
}

// ---------------------------------------------------------------------------
// THE RUN'S ADDRESS WITH ONE STEP OPEN (cinatra#3693).
//
// The ratified drawing gives a review no page of its own: "a pending review
// renders the review gate in the run detail, under the same rail, never as a
// standalone document", and "there is no review page view outside the run's
// route". A reader still has to be SENT to a particular review — from a
// notification, from the run engine's own interrupt, from the admin console —
// so the address that does the sending is the RUN's address with the step named
// on it, and never a sub-path of its own.
//
// ONE KEY, DECLARED HERE. The run detail's steps already have names: the rail's
// selection vocabulary (`packages/agents/src/run-surface-rail-step.ts`) spells
// each step as a short key, and the review gate and its audit are two of them.
// So the address carries that key verbatim under one query name rather than
// inventing a second spelling of the same thing.
//
// THE KEY LIVES IN THIS LEAF because the leaf has no imports and every road
// that mints an agent address already reads it. Two packages may not import
// `@/` and hold a verbatim copy of the name instead
// (`packages/agents/src/execution.ts`,
// `packages/notifications/src/agent-run-href.ts`); the agreement is pinned by
// `src/lib/__tests__/launch-scope-copies-agree-3693.test.ts`.
// ---------------------------------------------------------------------------

/** The query name that carries the run detail's open step (cinatra#3693). */
export const RUN_STEP_QUERY_KEY = "step";

/**
 * The run's own address with one step open — the ONE form for "this run, this
 * step selected".
 *
 * `runPath` is a run address as the builders above mint it (scoped or bare);
 * `step` is a rail selection key. The key is percent-encoded, so a key holding
 * a `:` or an id needing encoding survives the round trip.
 */
export function buildRunStepPath(runPath: string, step: string): string {
  return `${runPath}?${RUN_STEP_QUERY_KEY}=${encodeURIComponent(step)}`;
}
