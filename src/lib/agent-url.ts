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
  return `${normalizeScopeBase(scope)}/agents/${packageSegments(agentPackageName)}/${instanceId}`;
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
// READING THE SCOPE OFF AN ADDRESS (cinatra#2809, per-scope surfaces S3).
//
// Everything above WRITES an address from a scope. This reads one back: given
// the address a surface is standing on, it answers which scope base that
// address belongs to, so a link offered from that surface is minted at the SAME
// scope rather than at a guess.
//
// It is here, in the grammar, because it is the inverse of the prefix rule
// directly above it — the two must agree about what a base is, and a second
// module would be a second opinion (and a new leaf in four locked route
// graphs). Zero imports, exactly like the rest of this leaf.
//
// MEASURED on a development boot with both packages installed, one session,
// both orders, twice: the SCOPELESS launcher does not exist.
//
//   GET /agents/cinatra-ai/list-curator-agent/new?onComplete=list-picker&onCompleteRunId=RUN-ID
//     -> HTTP/1.1 200 OK, no Location, no run created; the crumb reads
//        "Agents / New" over an empty body, because the bare vendor/package
//        pair carries only `[instanceId]` and `new` is read as one.
//   GET /workspace/agents/cinatra-ai/list-curator-agent/new?onComplete=list-picker&onCompleteRunId=RUN-ID
//     -> HTTP/1.1 307, location: /workspace/agents/cinatra-ai/list-curator-agent/<fresh run id>?onComplete=list-picker&onCompleteRunId=RUN-ID
//
// So an address with no scope of its own gets the WORKSPACE base rather than
// the bare road: a launcher that answers nothing is not an offer.
// ---------------------------------------------------------------------------

/** The scope base of the workspace — the floor a scopeless address falls to. */
export const WORKSPACE_SCOPE_BASE = "/workspace";

/**
 * The scope base the given address belongs to: everything in front of the
 * `/agents` segment of the grammar above. An address that names no scope of its
 * own — the bare tree, or a path that is no agent address at all — answers with
 * the workspace base, which is the one scope every reader's Agents surface has.
 */
export function agentPathScopeBase(pathname: string): string {
  if (typeof pathname !== "string") return WORKSPACE_SCOPE_BASE;
  const path = pathname.split("?", 1)[0].split("#", 1)[0];
  const segments = path.split("/").filter((segment) => segment.length > 0);
  const agentsAt = segments.indexOf("agents");
  // -1 = not an agent address; 0 = the bare tree, which has no launcher.
  if (agentsAt <= 0) return WORKSPACE_SCOPE_BASE;
  const base = `/${segments.slice(0, agentsAt).join("/")}`;
  // The base has to survive the same validation a written address applies to
  // it, or the two halves of this grammar would disagree about what a base is.
  return /^(?:\/[^/\s\\]+)+$/.test(base) ? base : WORKSPACE_SCOPE_BASE;
}

// ---------------------------------------------------------------------------
// THE COMPLETION CONTRACT A NEW-RUN LINK CARRIES (cinatra#3358).
//
// A step whose field needs something ANOTHER package produces offers a link to
// that package's new-run route. The run that link starts has to know where to
// go back to once it has produced what was missing, so the address carries the
// contract: the NAME of the step that offered the road, and the ID of the run
// parked at it. The generic new-run launcher reads it off its own query and
// carries it onto the run it creates; the run surface reads it back.
//
// IT LIVES HERE, in the agent-path grammar, because that is what it is — two
// query keys of the `/agents/{vendor}/{package}/{instance}` address and the
// readers that put them on and take them off. It is also why it is NOT a module
// of its own: this leaf has zero imports and every one of the routes that reach
// the launcher already reach this file, so the grammar gains a rule and the
// reachable module graph gains nothing (the route-graph ratchet's own finding is
// that a dynamic import would not have helped — the metric is static
// reachability).
//
// GENERIC BY CONSTRUCTION: a contract is a name plus a run id, and nothing here
// learns which packages are at either end of it. The step's name is the step's
// own; the parked run's address comes from the parked run's own template.
// ---------------------------------------------------------------------------

/** The query key naming the step that offered the road. */
export const COMPLETION_RETURN_NAME_PARAM = "onComplete";
/** The query key carrying the parked run's id. */
export const COMPLETION_RETURN_RUN_PARAM = "onCompleteRunId";

/**
 * The completion contract a new-run link carries: the NAME of the step that
 * offered the road, and the id of the run parked at it.
 */
export type CompletionReturn = { onComplete: string; returnRunId: string };

function firstQueryString(value: string | string[] | undefined): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0].trim() : "";
  return "";
}

/**
 * Read a completion contract out of a screen's own search params. BOTH halves
 * are required: a name with no parked run has nowhere to return to, and a run id
 * with no name is not a contract this grammar recognizes.
 */
export function readCompletionReturn(
  searchParams: Record<string, string | string[] | undefined> | null | undefined,
): CompletionReturn | null {
  if (!searchParams) return null;
  const onComplete = firstQueryString(searchParams[COMPLETION_RETURN_NAME_PARAM]);
  const returnRunId = firstQueryString(searchParams[COMPLETION_RETURN_RUN_PARAM]);
  if (!onComplete || !returnRunId) return null;
  return { onComplete, returnRunId };
}

/**
 * Carry a completion contract onto a path the launcher is about to redirect to,
 * preserving whatever query that path already holds.
 */
/**
 * AN ADDRESS CUT INTO ITS THREE PARTS, the one way this leaf does it.
 *
 * A naive `split("?", 2)` reads a `#fragment?...` as a query and drops
 * everything after a SECOND question mark, so an address carrying a fragment
 * came back with the key inside the fragment (unreadable from the search
 * string) and an address whose own value contained a question mark came back
 * truncated. The fragment is separated FIRST and the query is cut at its FIRST
 * question mark only; the fragment is re-attached last by every writer below.
 */
function splitAddress(path: string): { base: string; existing: string; fragment: string } {
  const hashAt = path.indexOf("#");
  const fragment = hashAt === -1 ? "" : path.slice(hashAt);
  const addressed = hashAt === -1 ? path : path.slice(0, hashAt);
  const queryAt = addressed.indexOf("?");
  return {
    base: queryAt === -1 ? addressed : addressed.slice(0, queryAt),
    existing: queryAt === -1 ? "" : addressed.slice(queryAt + 1),
    fragment,
  };
}

export function withCompletionReturn(path: string, ret: CompletionReturn | null): string {
  if (!ret) return path;
  const { base, existing, fragment } = splitAddress(path);
  const params = new URLSearchParams(existing);
  params.set(COMPLETION_RETURN_NAME_PARAM, ret.onComplete);
  params.set(COMPLETION_RETURN_RUN_PARAM, ret.returnRunId);
  return `${base}?${params.toString()}${fragment}`;
}

/** The query key carrying what the finished run PRODUCED for the step that
 *  offered the road. */
export const COMPLETION_PRODUCED_PARAM = "onCompleteProduced";

/**
 * WHAT THE FINISHED RUN HANDS BACK (cinatra#3358).
 *
 * The contract above carries a reader FORWARD to the run that makes the missing
 * thing. This key carries the thing itself BACK: when the run the road started
 * completes having produced what the parked step was waiting for, its id rides
 * the return address, so the parked step opens with that thing already on offer
 * instead of asking the reader to find it again in a list it has just grown.
 *
 * GENERIC BY CONSTRUCTION, exactly like the two keys above: one query key
 * carrying one opaque id. Nothing here learns what kind of thing it is, which
 * package produced it, or which step is waiting for it — the step's own renderer
 * family decides what to do with what it is handed.
 */
export function withCompletionProduced(
  path: string,
  producedId: string | null | undefined,
): string {
  const id = typeof producedId === "string" ? producedId.trim() : "";
  if (!id) return path;
  // THE FRAGMENT AND THE REST OF THE QUERY SURVIVE — `splitAddress` above is
  // the one rule for that, shared by all three writers of this contract.
  const { base, existing, fragment } = splitAddress(path);
  const params = new URLSearchParams(existing);
  params.set(COMPLETION_PRODUCED_PARAM, id);
  return `${base}?${params.toString()}${fragment}`;
}

/**
 * Read back what a finished run produced, off a search string the parked run's
 * own address carries (`?a=b&...`, with or without the leading `?`). Empty when
 * the address carries none, which is every address that was not reached from a
 * completed run.
 */
export function readCompletionProduced(search: string | null | undefined): string {
  if (!search) return "";
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const value = params.get(COMPLETION_PRODUCED_PARAM);
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The same reading, off a SCREEN'S OWN search params rather than off a search
 * string — the shape a server screen is handed, and the shape
 * `readCompletionReturn` above already reads. A canonical-home redirect must
 * carry this key across with the other two, so the redirect needs this reader.
 */
export function readCompletionProducedParam(
  searchParams: Record<string, string | string[] | undefined> | null | undefined,
): string {
  if (!searchParams) return "";
  return firstQueryString(searchParams[COMPLETION_PRODUCED_PARAM]);
}

/**
 * The href a new-run link carries so the run it starts can come back: the
 * offering step's name plus the parked run's id. A step with no run identity in
 * hand offers the bare road — the link still opens, it just has no return.
 */
export function newRunHrefWithCompletionReturn(
  newRunPath: string,
  onComplete: string,
  parkedRunId: string | null | undefined,
): string {
  const { base, existing, fragment } = splitAddress(newRunPath);
  const params = new URLSearchParams(existing);
  params.set(COMPLETION_RETURN_NAME_PARAM, onComplete);
  const runId = typeof parkedRunId === "string" ? parkedRunId.trim() : "";
  // No identity in hand offers the bare road, and that means DROPPING any run id
  // the address already carried: keeping a stale one would point the return at
  // another run entirely.
  if (runId) params.set(COMPLETION_RETURN_RUN_PARAM, runId);
  else params.delete(COMPLETION_RETURN_RUN_PARAM);
  return `${base}?${params.toString()}${fragment}`;
}
