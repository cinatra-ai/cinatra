/**
 * The workspace Overview's render config (cinatra#2811, per-scope surfaces S5).
 *
 * The issue's sentence: "`buildWorkspaceOverviewConfig`: instance display name +
 * namespace from `instance_identity` (non-secret fields only; never the
 * instance UUID) + viewer-filtered counts over the epic's normative
 * `WorkspaceVantage`." This file pins the PURE half: the envelope's shape at the
 * workspace scope level, the two identity fields and nothing else, and the
 * three counts. The host half (which identity fields are read, and the counts
 * over the vantage builder) is pinned beside the host reader.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { buildWorkspaceOverviewConfig } from "../components/seed-configs/overview-config";
import { validateDashboardConfigV12 } from "../extension/dashboard-config-v12";
import {
  ENTITY_COUNT_PORTLET_KIND,
  ENTITY_METADATA_PORTLET_KIND,
  registerCorePortletKinds,
} from "../portlets/kinds";
import { getPortletKindDescriptor } from "../portlets/registry";

beforeAll(() => registerCorePortletKinds());

describe("buildWorkspaceOverviewConfig", () => {
  it("renders the instance's display name and namespace plus the three vantage counts, at the workspace level", () => {
    const cfg = buildWorkspaceOverviewConfig({
      instanceName: "Northwind Cinatra",
      namespace: "northwind",
      organizationCount: 2,
      teamCount: 3,
      projectCount: 4,
    });
    expect(cfg.scopeLevel).toBe("workspace");
    const res = validateDashboardConfigV12(cfg, { getPortletKind: getPortletKindDescriptor });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const meta = cfg.portlets.find((p) => p.kind === ENTITY_METADATA_PORTLET_KIND)!;
    expect(meta.config.title).toBe("Workspace");
    expect(meta.config.items).toEqual([
      { label: "Name", value: "Northwind Cinatra" },
      { label: "Namespace", value: "northwind" },
    ]);
    const counts = cfg.portlets.find((p) => p.kind === ENTITY_COUNT_PORTLET_KIND)!;
    expect(counts.config.items).toEqual([
      { label: "Organizations", value: 2 },
      { label: "Teams", value: 3 },
      { label: "Projects", value: 4 },
    ]);
  });

  it("skips an absent identity field instead of rendering it blank, and names the scope itself", () => {
    const cfg = buildWorkspaceOverviewConfig({
      organizationCount: 0,
      teamCount: 0,
      projectCount: 0,
    });
    const meta = cfg.portlets.find((p) => p.kind === ENTITY_METADATA_PORTLET_KIND)!;
    expect(meta.config.items).toEqual([{ label: "Name", value: "Workspace" }]);
    // Zero counts are still facts about the viewer's vantage, so they render.
    const counts = cfg.portlets.find((p) => p.kind === ENTITY_COUNT_PORTLET_KIND)!;
    expect(counts.config.items).toEqual([
      { label: "Organizations", value: 0 },
      { label: "Teams", value: 0 },
      { label: "Projects", value: 0 },
    ]);
  });

  it("carries nothing beyond the summary it was handed (no identifier field exists on the input)", () => {
    const cfg = buildWorkspaceOverviewConfig({
      instanceName: "N",
      namespace: "n",
      organizationCount: 1,
      teamCount: 0,
      projectCount: 0,
      // A caller that leaks an identifier into the summary still cannot get it
      // rendered: the builder reads named fields only.
      ...({ instanceId: "3f1c2d4e-0000-4000-8000-000000000000" } as object),
    } as Parameters<typeof buildWorkspaceOverviewConfig>[0]);
    expect(JSON.stringify(cfg)).not.toContain("3f1c2d4e");
  });
});
