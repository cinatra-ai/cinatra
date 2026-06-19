// cinatra#327 (design §4b/§4c, Q2): every dashboard seed-config converts to a
// VALID apiVersion-1.2 analytics envelope.
//
// The 6 seed-configs (agents/artifacts/organizations/projects/teams-default +
// the two entity-detail builders) stay authored as bare drizzle-cube
// `DashboardConfig`s — the entity screens consume them via
// `readDcConfigFromRow(row, <DC seed>)`, which reads the apiVersion-1.2 envelope
// back at the load boundary (ONE wrap site, design
// §4b recommendation + Q2). "No 1.0/1.1 seeds remain" is therefore satisfied
// because no seed is ever PERSISTED as 1.1 — the first save (and the one-time
// migration core__0006) writes apiVersion 1.2.
//
// This test is the #327 acceptance proof that "the seed conversion produces
// valid apiVersion 1.2": it wraps each seed via the SAME helper the create/save path uses
// (`wrapDcAsV12`, the EXACT shape core__0006 produces in SQL) and asserts the
// result passes the SAME registry validation the mutation service's
// `assertConfigV12` runs at the real write site — structural + kind-existence
// (`validateDashboardConfigV12`) AND the analytics kind's deep `config.dashboard`
// validation (`validatePortletConfig`). If any seed produced an invalid apiVersion-1.2
// envelope, the migrated row (or a first save) would be rejected by the
// registry — this guards against that.
import { describe, expect, it } from "vitest";

import { wrapDcAsV12 } from "../v12-envelope";
import {
  DASHBOARD_SCOPE_LEVELS,
  validateDashboardConfigV12,
  type DashboardScopeLevel,
} from "../extension/dashboard-config-v12";
import { registerCorePortletKinds } from "../portlets/kinds";
import {
  getPortletKindDescriptor,
  validatePortletConfig,
  __resetPortletRegistryForTests,
} from "../portlets/registry";

import { AGENTS_DEFAULT_CONFIG } from "../components/seed-configs/agents-default";
import { ARTIFACTS_DEFAULT_CONFIG } from "../components/seed-configs/artifacts-default";
import { ORGANIZATIONS_DEFAULT_CONFIG } from "../components/seed-configs/organizations-default";
import { PROJECTS_DEFAULT_CONFIG } from "../components/seed-configs/projects-default";
import { TEAMS_DEFAULT_CONFIG } from "../components/seed-configs/teams-default";
import {
  buildTeamDetailConfig,
  buildOrganizationDetailConfig,
} from "../components/seed-configs/entity-detail-config";

/** Every seed DC config + a representative scopeLevel for each. */
const SEEDS: ReadonlyArray<{ name: string; dc: unknown; scope: DashboardScopeLevel }> = [
  { name: "agents-default", dc: AGENTS_DEFAULT_CONFIG, scope: "user" },
  { name: "artifacts-default", dc: ARTIFACTS_DEFAULT_CONFIG, scope: "user" },
  { name: "organizations-default", dc: ORGANIZATIONS_DEFAULT_CONFIG, scope: "organization" },
  { name: "projects-default", dc: PROJECTS_DEFAULT_CONFIG, scope: "user" },
  { name: "teams-default", dc: TEAMS_DEFAULT_CONFIG, scope: "team" },
  { name: "entity-detail (team)", dc: buildTeamDetailConfig("team-123"), scope: "team" },
  { name: "entity-detail (organization)", dc: buildOrganizationDetailConfig("org-123"), scope: "organization" },
];

/**
 * Mirror of mutation-service.ts::assertConfigV12 — the precise registry
 * validation an apiVersion-1.2 config must pass at the write site (and that a migrated
 * core__0006 row must satisfy). Returns the collected error strings ([] = ok).
 */
function registryErrors(config: unknown): string[] {
  registerCorePortletKinds();
  const res = validateDashboardConfigV12(config, { getPortletKind: getPortletKindDescriptor });
  if (!res.ok) return res.errors;
  const errors: string[] = [];
  for (const p of res.config.portlets) {
    for (const e of validatePortletConfig(p.kind, p.version, {
      config: p.config,
      inputs: p.inputs,
      outputs: p.outputs,
    })) {
      errors.push(`portlet "${p.instanceId}": ${e.message}`);
    }
  }
  return errors;
}

describe("seed-config apiVersion-1.2 conversion (cinatra#327)", () => {
  it("registers the analytics kind the wrapped seeds reference", () => {
    __resetPortletRegistryForTests();
    registerCorePortletKinds();
    expect(getPortletKindDescriptor("analytics", "1.0.0")).toBeDefined();
  });

  for (const { name, dc, scope } of SEEDS) {
    describe(name, () => {
      const env = wrapDcAsV12(dc, scope);

      it("wraps into the canonical single-analytics-portlet apiVersion-1.2 envelope (the core__0006 shape)", () => {
        expect(env.apiVersion).toBe("v1.2");
        expect(env.scopeLevel).toBe(scope);
        expect(env.portlets).toHaveLength(1);
        const [p] = env.portlets;
        // EXACTLY the migration's envelope: instanceId/kind 'analytics',
        // version '1.0.0', fixed slot, the whole DC config at config.dashboard.
        expect(p).toMatchObject({
          instanceId: "analytics",
          kind: "analytics",
          version: "1.0.0",
          slot: "fixed",
          config: { dashboard: dc },
        });
        // .strict() portlet — no stray keys beyond the canonical set.
        expect(Object.keys(p).sort()).toEqual(["config", "instanceId", "kind", "slot", "version"]);
      });

      it("passes the registry validator the mutation service / migration target uses", () => {
        expect(registryErrors(env)).toEqual([]);
      });
    });
  }

  it("every representative scope is a real apiVersion-1.2 scopeLevel", () => {
    for (const { scope } of SEEDS) {
      expect((DASHBOARD_SCOPE_LEVELS as readonly string[]).includes(scope)).toBe(true);
    }
  });
});
