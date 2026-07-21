// THE canonical-URL derivation for a dashboard row (cinatra#1738, owner ruling
// D2 — nested-route ancestry: an entity dashboard lives under its scope's
// route so the URL carries the ancestry). Single source of truth: the detail
// routes, the flat-route redirect, and any future listing surface (#1897/B4
// scope collections) derive from HERE rather than re-inventing the mapping.
// NULL/unknown anchors (personal, workspace, legacy unanchored rows) fall back
// to the flat route, which remains their canonical address.

type CanonicalPathRow = {
  readonly id: string;
  readonly entityType: string | null;
  readonly entityId: string | null;
};

export function canonicalDashboardPath(row: CanonicalPathRow): string {
  const id = encodeURIComponent(row.id);
  if (row.entityId) {
    if (row.entityType === "team") {
      return `/teams/${encodeURIComponent(row.entityId)}/dashboards/${id}`;
    }
    if (row.entityType === "organization") {
      return `/organizations/${encodeURIComponent(row.entityId)}/dashboards/${id}`;
    }
  }
  return `/dashboards/${id}`;
}
