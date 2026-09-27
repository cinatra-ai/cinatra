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
//   GET /agents/cinatra-ai/list-curator-agent/new
//     -> HTTP/1.1 200 OK, no Location, no run created; the crumb reads
//        "Agents / New" over an empty body, because the bare vendor/package
//        pair carries only `[instanceId]` and `new` is read as one.
//   GET /workspace/agents/cinatra-ai/list-curator-agent/new
//     -> HTTP/1.1 307, location: /workspace/agents/cinatra-ai/list-curator-agent/<fresh run id>
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
