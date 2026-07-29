/**
 * Content pin for the `/organizations` default seed config (cinatra#1942
 * Decision 6): the main list query defaults to `lifecycle_status = active`.
 *
 * The envelope-shape / registry-validity proof for every seed config
 * (including this one) already lives in the sibling suite
 * `packages/dashboards/src/__tests__/seed-configs-v12.test.ts` — that test
 * wraps the CONFIG AS-IS through `wrapDcAsV12` and only asserts the wrapper
 * shape is valid, so it would pass unchanged whether or not the default
 * filter exists. This file pins the actual query CONTENT so a future edit
 * can't silently drop, rename, or mis-shape the default filter.
 */
import { describe, expect, it } from "vitest";

import { ORGANIZATIONS_DEFAULT_CONFIG } from "../organizations-default";

type OrganizationsAnalysisConfig = {
  readonly query: {
    readonly measures?: readonly string[];
    readonly dimensions?: readonly string[];
    readonly filters?: ReadonlyArray<{
      readonly member: string;
      readonly operator: string;
      readonly values: readonly string[];
    }>;
  };
};

describe("ORGANIZATIONS_DEFAULT_CONFIG (cinatra#1942)", () => {
  const [portlet] = ORGANIZATIONS_DEFAULT_CONFIG.portlets;
  const { query } = portlet.analysisConfig as unknown as OrganizationsAnalysisConfig;

  it("has exactly one portlet backed by the organizations cube", () => {
    expect(ORGANIZATIONS_DEFAULT_CONFIG.portlets).toHaveLength(1);
  });

  it("defaults the main list to lifecycle_status = active (Decision 6)", () => {
    expect(query.filters).toEqual([
      { member: "organizations.lifecycle_status", operator: "equals", values: ["active"] },
    ]);
  });

  it("keeps the pre-existing dimensions/measures unchanged (the filter is additive, not a projection change)", () => {
    expect(query.dimensions).toEqual([
      "organizations.id",
      "organizations.name",
      "organizations.role",
      "organizations.team_names",
    ]);
    expect(query.measures).toEqual(["organizations.member_count"]);
  });
});
