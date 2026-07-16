import { beforeAll, describe, expect, it } from "vitest";

import {
  buildEntityOverviewConfig,
  buildOrganizationOverviewConfig,
  buildProjectOverviewConfig,
  buildTeamOverviewConfig,
} from "../components/seed-configs/overview-config";
import {
  DASHBOARD_CONFIG_V12_VERSION,
  validateDashboardConfigV12,
} from "../extension/dashboard-config-v12";
import {
  ENTITY_COUNT_PORTLET_KIND,
  ENTITY_METADATA_PORTLET_KIND,
  registerCorePortletKinds,
} from "../portlets/kinds";
import { getPortletKindDescriptor, isRenderOnlyPortletKind } from "../portlets/registry";
import { materializeExtensionTemplate } from "../mutation-service";
import type { DashboardActor } from "../permissions";

beforeAll(() => registerCorePortletKinds());

/** Structural + registry validation with the REAL descriptor lookup — proves the
 *  built envelope references registered kinds and is well-formed apiVersion 1.2. */
function assertValidV12(config: unknown) {
  const res = validateDashboardConfigV12(config, { getPortletKind: getPortletKindDescriptor });
  expect(res.ok, JSON.stringify(res)).toBe(true);
}

describe("Overview portlet-model builders (cinatra#702)", () => {
  it("the generic composer emits a metadata portlet, and a count portlet only when counts are present", () => {
    const metaOnly = buildEntityOverviewConfig({
      scopeLevel: "project",
      metadata: { title: "Project", items: [{ label: "Name", value: "Apollo" }] },
    });
    expect(metaOnly.apiVersion).toBe(DASHBOARD_CONFIG_V12_VERSION);
    expect(metaOnly.scopeLevel).toBe("project");
    expect(metaOnly.portlets.map((p) => p.kind)).toEqual([ENTITY_METADATA_PORTLET_KIND]);
    assertValidV12(metaOnly);

    const withCounts = buildEntityOverviewConfig({
      scopeLevel: "team",
      metadata: { items: [{ label: "Name", value: "Platform" }] },
      counts: { items: [{ label: "Members", value: 5 }] },
    });
    expect(withCounts.portlets.map((p) => p.kind)).toEqual([
      ENTITY_METADATA_PORTLET_KIND,
      ENTITY_COUNT_PORTLET_KIND,
    ]);
    // an empty counts block emits no count portlet.
    const emptyCounts = buildEntityOverviewConfig({
      scopeLevel: "team",
      metadata: { items: [{ label: "Name", value: "Platform" }] },
      counts: { items: [] },
    });
    expect(emptyCounts.portlets).toHaveLength(1);
  });

  it("project Overview: metadata (only present fields) + sealed-room counts", () => {
    const cfg = buildProjectOverviewConfig({
      name: "Apollo",
      slug: "apollo",
      organizationName: "Acme",
      createdAt: "2026-07-15",
      counts: [{ label: "Sealed rooms", value: 3 }],
    });
    expect(cfg.scopeLevel).toBe("project");
    assertValidV12(cfg);
    const meta = cfg.portlets.find((p) => p.kind === ENTITY_METADATA_PORTLET_KIND)!;
    expect(meta.config.items).toEqual([
      { label: "Name", value: "Apollo" },
      { label: "Slug", value: "apollo" },
      { label: "Organization", value: "Acme" },
      { label: "Created", value: "2026-07-15" },
    ]);
    const counts = cfg.portlets.find((p) => p.kind === ENTITY_COUNT_PORTLET_KIND)!;
    expect(counts.config.items).toEqual([{ label: "Sealed rooms", value: 3 }]);

    // Optional fields absent → skipped, never rendered blank; no counts portlet.
    const minimal = buildProjectOverviewConfig({ name: "Bare" });
    expect(minimal.portlets.map((p) => p.kind)).toEqual([ENTITY_METADATA_PORTLET_KIND]);
    expect((minimal.portlets[0].config.items as unknown[]).length).toBe(1);
    assertValidV12(minimal);
  });

  it("project Overview: the full #706 metadata field set renders in canonical order", () => {
    const cfg = buildProjectOverviewConfig({
      name: "Apollo",
      slug: "apollo",
      id: "proj_123",
      owner: "Jane Doe",
      organizationName: "Acme",
      visibility: "Private",
      createdAt: "2026-07-15",
      description: "Launch pad.",
      counts: [
        { label: "Objects", value: 4 },
        { label: "Agent runs", value: 2 },
        { label: "Chat threads", value: 1 },
      ],
    });
    assertValidV12(cfg);
    const meta = cfg.portlets.find((p) => p.kind === ENTITY_METADATA_PORTLET_KIND)!;
    // name / slug / id / owner / organization / visibility / created / description.
    expect(meta.config.items).toEqual([
      { label: "Name", value: "Apollo" },
      { label: "Slug", value: "apollo" },
      { label: "Identifier", value: "proj_123" },
      { label: "Owner", value: "Jane Doe" },
      { label: "Organization", value: "Acme" },
      { label: "Visibility", value: "Private" },
      { label: "Created", value: "2026-07-15" },
      { label: "Description", value: "Launch pad." },
    ]);
    const counts = cfg.portlets.find((p) => p.kind === ENTITY_COUNT_PORTLET_KIND)!;
    expect(counts.config.items).toEqual([
      { label: "Objects", value: 4 },
      { label: "Agent runs", value: 2 },
      { label: "Chat threads", value: 1 },
    ]);
  });

  it("team Overview: identity + member count", () => {
    const cfg = buildTeamOverviewConfig({ name: "Platform", organizationName: "Acme", memberCount: 12 });
    expect(cfg.scopeLevel).toBe("team");
    assertValidV12(cfg);
    expect(cfg.portlets.find((p) => p.kind === ENTITY_COUNT_PORTLET_KIND)!.config.items).toEqual([
      { label: "Members", value: 12 },
    ]);
  });

  it("organization Overview: identity + member and team counts", () => {
    const cfg = buildOrganizationOverviewConfig({ name: "Acme", slug: "acme", memberCount: 40, teamCount: 6 });
    expect(cfg.scopeLevel).toBe("organization");
    assertValidV12(cfg);
    expect(cfg.portlets.find((p) => p.kind === ENTITY_COUNT_PORTLET_KIND)!.config.items).toEqual([
      { label: "Members", value: 40 },
      { label: "Teams", value: 6 },
    ]);
  });

  it("every portlet a builder emits is render-only (the ephemeral contract)", () => {
    const configs = [
      buildProjectOverviewConfig({ name: "P", counts: [{ label: "Rooms", value: 1 }] }),
      buildTeamOverviewConfig({ name: "T", memberCount: 1 }),
      buildOrganizationOverviewConfig({ name: "O", memberCount: 1, teamCount: 1 }),
    ];
    for (const cfg of configs) {
      for (const p of cfg.portlets) {
        expect(isRenderOnlyPortletKind(p.kind, p.version), `${p.kind} render-only`).toBe(true);
      }
    }
  });
});

// The persist guard (converged with codex): a summary envelope is EPHEMERAL and
// must never reach a dashboard row, so the write-path validator rejects it. We
// prove it through the real persist entrypoint, which validates BEFORE any DB
// access (so this needs no database).
describe("render-only kinds cannot be persisted (cinatra#702)", () => {
  const actor: DashboardActor = { userId: "u-1", organizationId: "org-1", teamIds: [] };

  it("materializeExtensionTemplate rejects a config carrying a render-only summary portlet", async () => {
    await expect(
      materializeExtensionTemplate(undefined, {
        extensionId: "@acme/x",
        organizationId: "org-1",
        config: buildTeamOverviewConfig({ name: "Platform", memberCount: 3 }),
        scope: { ownerLevel: "user", ownerId: "u-1" },
        actor,
      }),
    ).rejects.toThrow(/render-only/);
  });
});
