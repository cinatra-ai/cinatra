/**
 * Overview portlet-model builders (cinatra#702).
 *
 * The default non-removable "Overview" dashboard (epic #699 / #700) renders an
 * entity's CURRENT summary info AS PORTLETS — identity / metadata + counts —
 * instead of the single `analytics` keystone the operator dashboards use. These
 * pure builders compose an apiVersion 1.2 dashboard envelope from the two RENDER-ONLY
 * summary portlet kinds (`entity-metadata`, `entity-count`) using data the
 * calling surface has ALREADY fetched securely (member counts, identity, …).
 *
 * EPHEMERAL contract (converged with codex): the returned envelope is a RENDER
 * config — a surface (#704/#705/#706) builds it FRESH per request and hands it
 * straight to `<PortletHost>`, so the values are always live. It MUST NOT be
 * persisted: `entity-metadata` / `entity-count` are render-only, so the mutation
 * service rejects any attempt to save a config containing them — this is the
 * structural guarantee that a saved Overview row can never serve a stale or
 * authorization-obsolete summary. The persisted Overview row (from
 * `ensureOverview`) anchors identity + non-removability only.
 *
 * Layer-4 clean: no `drizzle-cube/client` import (these portlets are plain
 * presentation, not the embedded analytics grid).
 */
import {
  DASHBOARD_CONFIG_V12_VERSION,
  type DashboardConfigV12,
  type DashboardScopeLevel,
  type PortletConfigV12,
} from "../../extension/dashboard-config-v12";
import {
  ENTITY_COUNT_PORTLET_KIND,
  ENTITY_METADATA_PORTLET_KIND,
  ENTITY_SUMMARY_PORTLET_VERSION,
} from "../../portlets/kinds";

/** One label/value pair in a summary block. `value` is a string or a finite
 *  number (counts). No `href` — summaries are plain label/value, so there is no
 *  redirect / `javascript:`-URL surface (codex convergence). */
export type SummaryItem = { readonly label: string; readonly value: string | number };

/** A summary block: an optional heading + its items. */
export type OverviewSection = { readonly title?: string; readonly items: readonly SummaryItem[] };

export type EntityOverviewInput = {
  readonly scopeLevel: DashboardScopeLevel;
  /** Identity / metadata block (always present on an Overview). */
  readonly metadata: OverviewSection;
  /** Count-tile block. Omitted (or empty) → no count portlet is emitted. */
  readonly counts?: OverviewSection;
};

function summaryPortlet(
  instanceId: string,
  kind: string,
  section: OverviewSection,
): PortletConfigV12 {
  return {
    instanceId,
    kind,
    version: ENTITY_SUMMARY_PORTLET_VERSION,
    slot: "fixed",
    config: {
      ...(section.title ? { title: section.title } : {}),
      items: section.items.map((it) => ({ label: it.label, value: it.value })),
    },
  };
}

/**
 * Generic composer: a metadata portlet plus an optional count portlet, wrapped
 * in the apiVersion 1.2 envelope at the entity's scope level. The metadata block is
 * always emitted; the count block only when it has at least one item.
 */
export function buildEntityOverviewConfig(input: EntityOverviewInput): DashboardConfigV12 {
  const portlets: PortletConfigV12[] = [
    summaryPortlet("overview-metadata", ENTITY_METADATA_PORTLET_KIND, input.metadata),
  ];
  if (input.counts && input.counts.items.length > 0) {
    portlets.push(summaryPortlet("overview-counts", ENTITY_COUNT_PORTLET_KIND, input.counts));
  }
  return {
    apiVersion: DASHBOARD_CONFIG_V12_VERSION,
    scopeLevel: input.scopeLevel,
    portlets,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Per-entity-type defaults. Each maps the entity's already-fetched summary
// shape → the enumerated Overview blocks (issue #702: project metadata +
// sealed-room counts; team/org identity + member counts). Only the fields the
// surface actually has are rendered — every optional field is skipped when
// absent, never shown blank.
// ─────────────────────────────────────────────────────────────────────────

export type ProjectOverviewSummary = {
  readonly name: string;
  readonly slug?: string;
  /** Opaque project identifier (issue #706 enumerates it in the metadata block). */
  readonly id?: string;
  /** Owner display label (already resolved by the surface — name or id). */
  readonly owner?: string;
  readonly organizationName?: string;
  /** Human visibility label, e.g. "Discoverable" / "Private". */
  readonly visibility?: string;
  readonly createdAt?: string;
  readonly description?: string;
  /** Sealed-room (and any other project) counts the surface computed. */
  readonly counts?: readonly SummaryItem[];
};

/**
 * Project Overview: identity/metadata + sealed-room counts.
 *
 * The metadata block renders the fields issue #706 enumerates —
 * name / slug / id / owner / organization / visibility / created / description —
 * in that canonical order. Every field beyond `name` is OPTIONAL and pushed only
 * when the surface supplied it, so an absent field is skipped, never shown blank
 * (the same "only present fields" rule the generic composer holds).
 */
export function buildProjectOverviewConfig(summary: ProjectOverviewSummary): DashboardConfigV12 {
  const items: SummaryItem[] = [{ label: "Name", value: summary.name }];
  if (summary.slug) items.push({ label: "Slug", value: summary.slug });
  if (summary.id) items.push({ label: "Identifier", value: summary.id });
  if (summary.owner) items.push({ label: "Owner", value: summary.owner });
  if (summary.organizationName) items.push({ label: "Organization", value: summary.organizationName });
  if (summary.visibility) items.push({ label: "Visibility", value: summary.visibility });
  if (summary.createdAt) items.push({ label: "Created", value: summary.createdAt });
  if (summary.description) items.push({ label: "Description", value: summary.description });
  return buildEntityOverviewConfig({
    scopeLevel: "project",
    metadata: { title: "Project", items },
    counts:
      summary.counts && summary.counts.length > 0
        ? { title: "Rooms", items: summary.counts }
        : undefined,
  });
}

export type TeamOverviewSummary = {
  readonly name: string;
  readonly organizationName?: string;
  readonly memberCount: number;
};

/** Team Overview: identity + member count. */
export function buildTeamOverviewConfig(summary: TeamOverviewSummary): DashboardConfigV12 {
  const items: SummaryItem[] = [{ label: "Name", value: summary.name }];
  if (summary.organizationName) items.push({ label: "Organization", value: summary.organizationName });
  return buildEntityOverviewConfig({
    scopeLevel: "team",
    metadata: { title: "Team", items },
    counts: { items: [{ label: "Members", value: summary.memberCount }] },
  });
}

export type OrganizationOverviewSummary = {
  readonly name: string;
  readonly slug?: string;
  readonly memberCount: number;
  readonly teamCount: number;
};

/** Organization Overview: identity + member and team counts. */
export function buildOrganizationOverviewConfig(
  summary: OrganizationOverviewSummary,
): DashboardConfigV12 {
  const items: SummaryItem[] = [{ label: "Name", value: summary.name }];
  if (summary.slug) items.push({ label: "Slug", value: summary.slug });
  return buildEntityOverviewConfig({
    scopeLevel: "organization",
    metadata: { title: "Organization", items },
    counts: {
      items: [
        { label: "Members", value: summary.memberCount },
        { label: "Teams", value: summary.teamCount },
      ],
    },
  });
}
