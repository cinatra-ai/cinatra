/**
 * A SCOPE'S EXECUTIONS VIEW LISTS THE RUNS STARTED IN THAT SCOPE (cinatra#3693).
 *
 *   pnpm --filter @cinatra-ai/dashboards exec vitest run \
 *     src/components/__tests__/scoped-executions-view-3693.test.tsx
 *
 * cinatra#3693's second done-when sentence: "The Executions and Reviews lists
 * are reachable from each scope and list that scope's runs and reviews, or the
 * drawing says where a scope's runs are listed and the product follows it." The
 * drawing: "Executions lists the runs started in that scope, and the
 * workspace's Executions lists every run the viewer may see."
 *
 * A3 (the view half) — under an organization, a team, a project and the
 * personal scope the view's portlets carry a listing filter on the run's launch
 * scope; under the workspace they carry none. The scoped grid is READ-ONLY: a
 * save from it would write the filter into the reader's own layout of the bare
 * Executions tab, which is one row per organization and user.
 */
import React from "react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn(async () => ({ user: { id: "user-1" } })),
  signInRedirectTarget: vi.fn(async () => "/sign-in"),
}));
vi.mock("../../auth/security-context", () => ({
  buildSecurityContextFromSession: () => ({ userId: "user-1", organizationId: "org-1" }),
}));
vi.mock("../../store/db", () => ({
  dashboards: {},
  getDashboardsDb: () => {
    throw new Error("the scoped view reads no saved layout");
  },
}));
vi.mock("../../actions", () => ({ saveAgentsDashboardAction: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (target: string) => {
    throw new Error(`NEXT_REDIRECT:${target}`);
  },
}));
vi.mock("../embedded-drizzle-cube-dashboard-grid", () => ({
  EmbeddedDrizzleCubeDashboardGrid: function GridStub() {
    return null;
  },
}));

import * as seed from "../seed-configs/agents-default";
import * as screen from "../../screens/agents-dashboard";
import { EmbeddedDrizzleCubeDashboardGrid } from "../embedded-drizzle-cube-dashboard-grid";

type Scope =
  | { kind: "workspace" }
  | { kind: "personal" }
  | { kind: "organization" | "team" | "project"; id: string };

type Filter = { member: string; operator: string; values: string[] };
type Config = { portlets: Array<{ analysisConfig: { query: { filters?: Filter[] } } }> };

const buildConfig = (scope: Scope, viewer: string): Config =>
  (seed as unknown as { agentsExecutionsConfigForScope: (s: Scope, v: string) => Config })
    .agentsExecutionsConfigForScope(scope, viewer);

const ScopedBody = (screen as unknown as {
  ScopedAgentsExecutionsBody: (p: { launchScope: Scope }) => Promise<React.ReactElement>;
}).ScopedAgentsExecutionsBody;

const CASES: ReadonlyArray<readonly [Scope, string]> = [
  [{ kind: "organization", id: "o1" }, "organization:o1"],
  [{ kind: "team", id: "t1" }, "team:t1"],
  [{ kind: "project", id: "p1" }, "project:p1"],
  // The personal scope is actor-relative: its runs are anchored to the human
  // who started them, so the viewer's own id names them.
  [{ kind: "personal" }, "user:user-1"],
];

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("A3: the scoped Executions view's listing filter (cinatra#3693)", () => {
  for (const [scope, value] of CASES) {
    it(`${scope.kind} — every portlet lists only runs launched from that scope`, () => {
      const config = buildConfig(scope, "user-1");
      expect(config.portlets.length).toBe(seed.AGENTS_DEFAULT_CONFIG.portlets.length);
      for (const portlet of config.portlets) {
        expect(portlet.analysisConfig.query.filters).toEqual([
          { member: "agent_runs.launch_scope", operator: "equals", values: [value] },
        ]);
      }
    });
  }

  it("workspace — the portlets carry no filter: every run the viewer may see", () => {
    const config = buildConfig({ kind: "workspace" }, "user-1");
    for (const portlet of config.portlets) {
      expect(portlet.analysisConfig.query.filters).toBeUndefined();
    }
  });

  it("never writes the filter into the seed the bare tab mounts", () => {
    buildConfig({ kind: "team", id: "t1" }, "user-1");
    for (const portlet of seed.AGENTS_DEFAULT_CONFIG.portlets) {
      expect((portlet.analysisConfig as { query: { filters?: unknown } }).query.filters).toBeUndefined();
    }
  });

  for (const [scope, value] of [...CASES, [{ kind: "workspace" } as Scope, null] as const]) {
    it(`${scope.kind} — the scoped grid is read-only and carries the scope's filter`, async () => {
      const element = await ScopedBody({ launchScope: scope });
      expect(element.type).toBe(EmbeddedDrizzleCubeDashboardGrid);
      const props = element.props as {
        dashboard: Config;
        editable?: boolean;
        onSave?: unknown;
        pageAnchor?: unknown;
      };
      expect(props.editable ?? false).toBe(false);
      expect(props.onSave).toBeUndefined();
      // No route-scoped toolbar: its actions address the bare Agents tree.
      expect(props.pageAnchor).toBeUndefined();
      for (const portlet of props.dashboard.portlets) {
        expect(portlet.analysisConfig.query.filters?.[0]?.values ?? null).toEqual(
          value === null ? null : [value],
        );
      }
    });
  }
});
