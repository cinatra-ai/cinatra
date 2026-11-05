/**
 * THE COPIES OF THE LAUNCH-SCOPE RULE AGREE WITH THE ORIGINAL (cinatra#3693).
 *
 * `src/lib/launch-scope-anchor.ts` is the one authority on what a stored anchor
 * means: which version this build vouches for, which kinds carry an id, which
 * id it refuses, and which scope base each kind addresses. Two packages may not
 * import the host's `@/` and so spell parts of that rule again:
 *
 *   - the agent-runs cube, for the `launch_scope` dimension a scope's
 *     Executions tab filters on;
 *   - the notification and run-engine deep-link builders, for the base a
 *     run's address is prefixed with, AND for the one address form that names a
 *     step of the run detail (cinatra#3693, the second fix leg): a review has no
 *     address of its own, so both of them mint `<run>?step=review:<task>`.
 *
 * A copy that drifts is worse than no copy. A run would list in a scope it was
 * never launched from, or a reader would be sent to the wrong scope's road. So
 * the agreement is pinned here, on the same table, the way `launchScopeAnchorBase`
 * pins its own copy of the scope bases.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  LAUNCH_SCOPE_ANCHOR_KINDS,
  LAUNCH_SCOPE_ANCHOR_VERSION,
  launchScopeAnchorBase,
  parseLaunchScopeAnchor,
} from "@/lib/launch-scope-anchor";
import { RUN_STEP_QUERY_KEY, buildAgentInstancePath, buildRunStepPath } from "@/lib/agent-url";
import { runReviewGateStepKey } from "@cinatra-ai/agents/run-surface-rail-step";
import { WORKSPACE_SCOPE_SENTINEL } from "@/lib/assignment-scope";
import {
  AGENT_RUNS_LAUNCH_SCOPE_ANCHOR_VERSION,
  AGENT_RUNS_LAUNCH_SCOPE_ID_KINDS,
  AGENT_RUNS_LAUNCH_SCOPE_WORKSPACE_SENTINEL,
} from "@cinatra-ai/sdk-dashboard/adapters/drizzle-cube";
import {
  buildAgentInstancePath as packageInstancePath,
  launchScopeAnchorBaseCopy,
} from "@cinatra-ai/notifications/server";

describe("the cube's copy of the anchor rule (cinatra#3693)", () => {
  it("vouches for the same anchor version as the decoder", () => {
    expect(AGENT_RUNS_LAUNCH_SCOPE_ANCHOR_VERSION).toBe(LAUNCH_SCOPE_ANCHOR_VERSION);
  });

  it("carries exactly the decoder's id-bearing kinds, every kind but the workspace", () => {
    expect([...AGENT_RUNS_LAUNCH_SCOPE_ID_KINDS]).toEqual(
      LAUNCH_SCOPE_ANCHOR_KINDS.filter((kind) => kind !== "workspace"),
    );
  });

  it("refuses the same reserved id the decoder refuses", () => {
    expect(AGENT_RUNS_LAUNCH_SCOPE_WORKSPACE_SENTINEL).toBe(WORKSPACE_SCOPE_SENTINEL);
  });
});

/**
 * The table both sides are read against. Each row is one stored payload and the
 * base the host says it addresses: `null` for a flat run, which covers the
 * personal anchor and every payload the decoder fails closed on.
 */
const ANCHORS: readonly { readonly name: string; readonly raw: unknown }[] = [
  { name: "a workspace launch", raw: { v: 1, kind: "workspace" } },
  { name: "an organization launch", raw: { v: 1, kind: "organization", id: "o1" } },
  { name: "a team launch", raw: { v: 1, kind: "team", id: "t1" } },
  { name: "a project launch", raw: { v: 1, kind: "project", id: "p1" } },
  { name: "a personal launch", raw: { v: 1, kind: "user", id: "u1" } },
  { name: "an id needing encoding", raw: { v: 1, kind: "organization", id: "o 1/2" } },
  { name: "no anchor at all", raw: null },
  { name: "the JSON text of an anchor", raw: JSON.stringify({ v: 1, kind: "team", id: "t1" }) },
  // Every arm the decoder fails closed on.
  { name: "an unknown version", raw: { v: 2, kind: "organization", id: "o1" } },
  { name: "a version as text", raw: { v: "1", kind: "organization", id: "o1" } },
  { name: "an unknown kind", raw: { v: 1, kind: "galaxy", id: "g1" } },
  { name: "a workspace arm carrying an id", raw: { v: 1, kind: "workspace", id: "o1" } },
  { name: "a workspace arm carrying a null id", raw: { v: 1, kind: "workspace", id: null } },
  { name: "a non-string id", raw: { v: 1, kind: "organization", id: 42 } },
  { name: "a blank id", raw: { v: 1, kind: "organization", id: "   " } },
  { name: "the sentinel as an id", raw: { v: 1, kind: "organization", id: WORKSPACE_SCOPE_SENTINEL } },
  { name: "malformed JSON text", raw: "{not json" },
  { name: "an array", raw: [{ v: 1, kind: "team", id: "t1" }] },
];

describe("the deep-link builders' copy of the base map (cinatra#3693)", () => {
  for (const { name, raw } of ANCHORS) {
    it(`answers the host's own base for ${name}`, () => {
      const expected = launchScopeAnchorBase(parseLaunchScopeAnchor(raw));
      expect(launchScopeAnchorBaseCopy(raw)).toBe(expected);
    });
  }

  it("prefixes the run's address with that base, and leaves a flat run's address alone", () => {
    expect(packageInstancePath("@acme/writer", "R1", { launchScopeAnchor: { v: 1, kind: "team", id: "t1" } })).toBe(
      "/teams/t1/agents/acme/writer/R1",
    );
    expect(packageInstancePath("@acme/writer", "R1", { launchScopeAnchor: { v: 1, kind: "user", id: "u1" } })).toBe(
      "/agents/acme/writer/R1",
    );
    expect(packageInstancePath("@acme/writer", "R1")).toBe("/agents/acme/writer/R1");
  });

  it("writes a repair run's id as the same one encoded segment as the host (cinatra#3080)", () => {
    // A repair run's id carries a colon a path segment must escape. The host's
    // builder and this copy agree on the address, under a scope base and flat.
    const repairRunId = "lifecycle-repair-run:8f1d2a3b-4c5d-6e7f-8091-a2b3c4d5e6f7";
    const anchor = { v: 1, kind: "team", id: "t1" };
    const host = buildAgentInstancePath("@acme/writer", repairRunId, {
      scopeBase: launchScopeAnchorBase(parseLaunchScopeAnchor(anchor)),
    });
    expect(host).toBe(
      "/teams/t1/agents/acme/writer/lifecycle-repair-run%3A8f1d2a3b-4c5d-6e7f-8091-a2b3c4d5e6f7",
    );
    expect(packageInstancePath("@acme/writer", repairRunId, { launchScopeAnchor: anchor })).toBe(host);
    expect(packageInstancePath("@acme/writer", repairRunId)).toBe(
      buildAgentInstancePath("@acme/writer", repairRunId),
    );
  });
});

/**
 * THE RUN ENGINE'S COPY. `packages/agents/src/execution.ts` holds the same rule
 * again, for the same no-`@/` reason and one more: its own header records that
 * the universally-reachable execution path must grow no new first-party module
 * edge, because the route-graph ratchet guards it. Importing the notifications
 * copy would be exactly that edge, so the text is duplicated instead. The two
 * copies are pinned CHARACTER-IDENTICAL here, which is the cheapest way to make
 * a drift in either one fail a test rather than mislead a reviewer.
 */
describe("the run engine's copy is the same text as the notifications copy (cinatra#3693)", () => {
  const ROOT = path.resolve(__dirname, "..", "..", "..");
  const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

  /** The copied block, from its first constant to the end of the function. */
  function copiedRule(source: string): string {
    const start = source.indexOf("/** The anchor version this build vouches for.");
    const end = source.indexOf("export function launchScopeAnchorBaseCopy");
    const tail = source.indexOf("\n}\n", end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, tail + 3);
  }

  it("carries the identical rule in both packages", () => {
    const engine = copiedRule(read("packages/agents/src/execution.ts"));
    const notifications = copiedRule(read("packages/notifications/src/agent-run-href.ts"));
    expect(engine).toBe(notifications);
  });

  it("neither copy imports the host, which is why it is a copy at all", () => {
    for (const rel of [
      "packages/agents/src/execution.ts",
      "packages/notifications/src/agent-run-href.ts",
    ]) {
      expect(read(rel)).not.toMatch(/from "@\/lib\/launch-scope-anchor"/);
    }
  });

  it("the run engine addresses a gate under the run's own home", () => {
    const source = read("packages/agents/src/execution.ts");
    // The anchor reaches the base builder, so the interrupt no longer emits a
    // bare address for a run launched from a scope.
    expect(source).toContain(
      "buildReviewRunBasePath(reviewPackageName, runId, run.launchScopeAnchor)",
    );
  });
});

/**
 * THE ONE ADDRESS FORM FOR "THIS RUN, THIS STEP SELECTED" (cinatra#3693).
 *
 * The drawings give a review no page: "a pending review renders the review gate
 * in the run detail, under the same rail, never as a standalone document", and
 * "there is no review page view outside the run's route". So the address that
 * sends a reader to one review is the RUN's address with the gate's own rail
 * selection named on it. `src/lib/agent-url.ts` is the authority; both packages
 * hold a verbatim copy of the query name and the composer, inside the same
 * copied block the base map is in, so a drift in either one fails above.
 */
describe("the run-step address form (cinatra#3693)", () => {
  const ROOT = path.resolve(__dirname, "..", "..", "..");
  const readSource = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

  it("is one query name and one composer in the host", () => {
    expect(RUN_STEP_QUERY_KEY).toBe("step");
    expect(buildRunStepPath("/teams/t1/agents/acme/writer/R1", "review:task 1")).toBe(
      "/teams/t1/agents/acme/writer/R1?step=review%3Atask%201",
    );
    // The key the rail answers to, and the one the address carries, are one
    // spelling: the address names a selection, it does not invent a second name
    // for it.
    expect(runReviewGateStepKey("task-1")).toBe("review:task-1");
  });

  it("both packages hold the same copy of the name and the composer", () => {
    for (const rel of [
      "packages/agents/src/execution.ts",
      "packages/notifications/src/agent-run-href.ts",
    ]) {
      const source = readSource(rel);
      expect(source, rel).toContain(`const RUN_STEP_QUERY_KEY = "${RUN_STEP_QUERY_KEY}";`);
      expect(source, rel).toContain(
        "return `${runPath}?${RUN_STEP_QUERY_KEY}=${encodeURIComponent(step)}`;",
      );
      expect(source, rel).toContain("return `review:${reviewTaskId}`;");
    }
  });

  it("and no road mints the retired `/review/<taskId>` sub-path any more", () => {
    // What the copies compose at RUN TIME is pinned beside the resolver that
    // composes it, where the store is already stubbed:
    // `src/lib/__tests__/review-links-reach-the-run-3693.test.ts`.
    for (const rel of [
      "packages/agents/src/execution.ts",
      "packages/notifications/src/agent-run-href.ts",
      "src/components/artifacts/console/gate-volume-panel.tsx",
      "src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-page-body.tsx",
    ]) {
      expect(readSource(rel), rel).not.toMatch(/\/review\/\$\{/);
    }
  });
});
