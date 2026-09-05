// ---------------------------------------------------------------------------
// THE SCOPED ROUTE SHELLS' RESOLVER (cinatra#2809, per-scope surfaces S3).
//
// Under every scope base — `/workspace`, `/personal`, `/organizations/<id>`,
// `/teams/<id>`, `/projects/<id>` — the same two surfaces answer: the agents
// tree and the assistants tree. They are mounted as ONE catch-all per base
// rather than as a copy of the whole route tree per base: five copies of eight
// directories is five places for the grammar to drift, and the grammar is the
// contract #2808's cards compose on.
//
// A PURE resolver, so what those shells resolve TO is unit-testable without a
// render: the shell reads its segments, asks here, and hands the answer to the
// SAME renderer the bare route uses. Nothing here reads, authorizes, or knows
// about React.
//
// THE RESERVED WORDS live BELOW the vendor/package pair — `new` is the
// launcher, `settings` the agent's settings surface at this scope. Below, and
// nowhere else: a package genuinely named `new` occupies the pair's second
// half, and its launcher is `…/acme/new/new`, which is exactly right.
// ---------------------------------------------------------------------------

import { AGENT_LAUNCH_SEGMENT, AGENT_SETTINGS_SEGMENT } from "@/lib/agent-url";

/** A segment is valid when non-empty and slash/whitespace-free — the same rule
 *  the chat codec applies, so the two trees cannot disagree about a path. */
function isSegment(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\s/]/.test(value);
}

function clean(
  segments: readonly (string | undefined)[] | undefined,
): string[] | null {
  if (!segments) return null;
  const segs = segments.filter((s): s is string => s !== undefined);
  if (segs.length !== segments.length) return null;
  return segs.every(isSegment) ? segs : null;
}

export type ScopedAgentRoute =
  /** `<base>/agents/<vendor>/<package>/new` — a FRESH run at this scope. */
  | { kind: "launch"; vendor: string; packageName: string; agentId: string }
  /** `<base>/agents/<vendor>/<package>/settings` — the settings SHELL. */
  | { kind: "settings"; vendor: string; packageName: string; agentId: string }
  /** `<base>/agents/<vendor>/<package>/<instance>[/<sub-route>…]`. */
  | {
      kind: "instance";
      vendor: string;
      packageName: string;
      agentId: string;
      instanceId: string;
      rest: string[];
    }
  /** Every shape with no page: the bare tab, the vendor container, a too-long
   *  tail, a malformed segment. The shell calls `notFound()`. */
  | { kind: "not-found" };

/** Resolve the segments BELOW `<scope-base>/agents`. */
export function resolveScopedAgentRoute(
  segments: readonly (string | undefined)[] | undefined,
): ScopedAgentRoute {
  const segs = clean(segments);
  // 0 = the scope's Agents TAB, which is its own page (cinatra#2807).
  // 1 = the vendor, a routing container with no page.
  // 2 = the vendor/package pair, which has no index page either.
  if (!segs || segs.length < 3) return { kind: "not-found" };
  const [vendor, packageName, third, ...rest] = segs;
  const agentId = `${vendor}/${packageName}`;
  if (third === AGENT_LAUNCH_SEGMENT || third === AGENT_SETTINGS_SEGMENT) {
    // Neither reserved surface has anything below it.
    if (rest.length > 0) return { kind: "not-found" };
    return third === AGENT_LAUNCH_SEGMENT
      ? { kind: "launch", vendor, packageName, agentId }
      : { kind: "settings", vendor, packageName, agentId };
  }
  return { kind: "instance", vendor, packageName, agentId, instanceId: third, rest };
}

export type ScopedAssistantRoute =
  /** `<base>/assistants/<vendor>/<slug>/settings` — the settings SHELL. */
  | { kind: "settings"; vendor: string; slug: string; assistantPackageName: string }
  /**
   * Every conversation shape, with the scope base ALREADY split off: the
   * segments below the mount are exactly what the `/chat` codec has always
   * parsed, which is why the scoped view can hand them to the same renderer
   * instead of re-deriving the grammar.
   */
  | { kind: "chat"; slug: string[] }
  | { kind: "not-found" };

/** Resolve the segments BELOW `<scope-base>/assistants`. */
export function resolveScopedAssistantRoute(
  segments: readonly (string | undefined)[] | undefined,
): ScopedAssistantRoute {
  const segs = clean(segments);
  // 0 = the scope's Assistants TAB (its own page); 1 = the vendor alone.
  if (!segs || segs.length < 2) return { kind: "not-found" };
  // The codec's longest legal shape is vendor/slug/instance/titleSlug.
  if (segs.length > 4) return { kind: "not-found" };
  const [vendor, slug] = segs;
  if (segs.length === 3 && segs[2] === AGENT_SETTINGS_SEGMENT) {
    return {
      kind: "settings",
      vendor,
      slug,
      assistantPackageName: `@${vendor}/${slug}`,
    };
  }
  return { kind: "chat", slug: segs };
}
