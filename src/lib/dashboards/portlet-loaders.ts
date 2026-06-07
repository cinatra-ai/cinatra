"use server";

// Server-side portlet data loaders (the scope-leakage enforcement point).
// Scope is ALWAYS derived from the session via resolvePortletAuthz(); these
// signatures take ONLY config/selection (typeId, parentId, objectId) — NEVER a
// caller-supplied orgId/projectId. Reads go through the objects store scoped by
// the session org, then EVERY row is gated by enforceResourceAccess (per-row,
// like the canonical objects_list). Client portlet components call these
// (never the MCP/store directly).
import { listObjectsByFilter, getObjectById, type ObjectRecord } from "@/lib/objects-store";
import { listArtifacts, getArtifact } from "@/lib/artifacts/artifact-service";
import { listEventsForObject } from "@/lib/object-history/eligibility";
import { readWorkflow, listWorkflows } from "@cinatra-ai/workflows/store";
import { enforceResourceAccess } from "@/lib/authz/enforce-resource-access";
import { resolvePortletAuthz, objectResourceCheck, canReadObject, type PortletAuthz } from "@/lib/dashboards/portlet-authz";

export type PortletObjectSummary = { id: string; label: string };
export type PortletObjectDetail = { id: string; label: string; type: string; fields: Array<{ key: string; value: string }> };

function labelOf(row: Pick<ObjectRecord, "id" | "data">): string {
  const d = (row.data ?? {}) as Record<string, unknown>;
  for (const k of ["title", "name", "label"]) {
    if (typeof d[k] === "string" && (d[k] as string).length > 0) return d[k] as string;
  }
  return row.id;
}

/** PORT-02 object-list loader. Lists objects of `typeId` in the SESSION org,
 *  optionally filtered to children of `parentId`, then per-row read-gated. */
export async function loadObjectListPortlet(args: {
  typeId: string;
  parentId?: string | null;
  // When true the portlet HAS a parentId binding — an unresolved (null) parent
  // means "no parent selected yet" → return EMPTY (never broaden to all rows).
  // When false/absent there is no parent binding (top-level list → list all).
  requireParent?: boolean;
  limit?: number;
}): Promise<PortletObjectSummary[]> {
  const authz = await resolvePortletAuthz();
  if (!authz.orgId) return [];
  if (args.requireParent && (args.parentId === null || args.parentId === undefined)) return [];
  const rows = listObjectsByFilter({ orgId: authz.orgId, type: args.typeId, limit: args.limit ?? 200 });
  const scoped = args.parentId ? rows.filter((r) => r.parentId === args.parentId) : rows;
  // Per-row read authz (mirrors canonical objects_list — fetch then filter).
  const gated = await Promise.all(scoped.map(async (r) => ((await canReadObject(r, authz)) ? r : null)));
  return gated.filter((r): r is ObjectRecord => r !== null).map((r) => ({ id: r.id, label: labelOf(r) }));
}

/** PORT-03 object-detail loader. Reads one object (session-scoped) + gates read. */
export async function loadObjectDetailPortlet(args: { objectId: string }): Promise<PortletObjectDetail | null> {
  const authz = await resolvePortletAuthz();
  if (!authz.orgId) return null;
  const row = getObjectById(args.objectId, { orgId: authz.orgId });
  if (!row) return null;
  try {
    await enforceResourceAccess(objectResourceCheck(row), authz.primitiveActor, "object.read", authz.roleHints);
  } catch {
    return null;
  }
  const d = (row.data ?? {}) as Record<string, unknown>;
  const fields = Object.entries(d)
    .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    .slice(0, 12)
    .map(([key, v]) => ({ key, value: String(v) }));
  return { id: row.id, label: labelOf(row), type: row.type, fields };
}

/** PORT-04 artifact-list loader. Lists artifact rows eligible for
 *  `extensionPackageName` in the SESSION org via the canonical (actor-scoped)
 *  artifacts service. */
export async function loadArtifactListPortlet(args: {
  extensionPackageName: string;
  limit?: number;
}): Promise<PortletObjectSummary[]> {
  const authz = await resolvePortletAuthz();
  if (!authz.orgId) return [];
  const summaries = listArtifacts({
    orgId: authz.orgId,
    actor: authz.actorContext,
    limit: args.limit ?? 200,
    extensionPackageName: args.extensionPackageName,
  });
  return summaries.map((s) => ({ id: s.artifactId, label: s.title ?? s.artifactId }));
}

// ---------------------------------------------------------------------------
// PORT-07 artifact-version-history — read-only ref-swap timeline for a parent
// object's `parentObjectField`. Returns only events that CHANGED that field
// (plus the create event) so the config key is load-bearing.
// ---------------------------------------------------------------------------
export type PortletHistoryEvent = {
  changeSetId: string;
  operation: string;
  createdAt: string;
  actorKind: string | null;
  /** The parent-object field's value AFTER this event (the ref at this point). */
  fieldValue: string | null;
};

export async function loadObjectVersionHistoryPortlet(args: {
  objectId: string;
  parentObjectField: string;
}): Promise<PortletHistoryEvent[]> {
  const authz = await resolvePortletAuthz();
  if (!authz.orgId) return [];
  const row = getObjectById(args.objectId, { orgId: authz.orgId });
  if (!row) return [];
  try {
    await enforceResourceAccess(objectResourceCheck(row), authz.primitiveActor, "object.read", authz.roleHints);
  } catch {
    return [];
  }
  const field = args.parentObjectField;
  // Object fields live under the CanonicalSnapshot's `payload.data` (the snapshot
  // wraps the full row payload), NOT at the snapshot root.
  const refOf = (snap: { payload?: Record<string, unknown> } | null): string | null => {
    const data = (snap?.payload?.data ?? null) as Record<string, unknown> | null;
    const v = data?.[field];
    return typeof v === "string" ? v : v == null ? null : String(v);
  };
  return listEventsForObject(args.objectId, { orgId: authz.orgId, limit: 100 })
    // Only events that CHANGED the field. create is included iff the field went
    // from absent/null to a value (null !== value); unchanged updates drop out.
    .filter((e) => refOf(e.beforeSnapshot) !== refOf(e.afterSnapshot))
    .map((e) => ({
      changeSetId: e.changeSetId,
      operation: e.operation,
      createdAt: e.createdAt,
      actorKind: e.actorKind,
      fieldValue: refOf(e.afterSnapshot),
    }));
}

// ---------------------------------------------------------------------------
// PORT-10 workflow-status — read-only status summary. single mode (workflowId)
// returns the workflow + its tasks; list mode (projectId) returns the project's
// workflows. Scope: org match REQUIRED; project-scoped rows require the actor to
// hold a project read grant (or org_owner/org_admin), never broadened.
// ---------------------------------------------------------------------------
function canReadWorkflowScope(row: { orgId: string; projectId: string | null }, authz: PortletAuthz): boolean {
  if (!authz.orgId || row.orgId !== authz.orgId) return false;
  if (!row.projectId) return true;
  const role = authz.roleHints?.orgRole;
  if (role === "org_owner" || role === "org_admin") return true;
  const grants = authz.actorContext?.projectGrants ?? [];
  const projectIds = authz.actorContext?.projectIds ?? [];
  return grants.some((g) => g.projectId === row.projectId) || projectIds.includes(row.projectId);
}

export type PortletWorkflowTask = {
  key: string;
  title: string;
  status: string;
  plannedStartUtc: string | null;
  plannedEndUtc: string | null;
  actualStartUtc: string | null;
  actualEndUtc: string | null;
};
export type PortletWorkflowSingle = {
  mode: "single";
  workflowId: string;
  name: string;
  status: string;
  tasks: PortletWorkflowTask[];
};
export type PortletWorkflowSummary = { workflowId: string; name: string; status: string };
export type PortletWorkflowList = { mode: "list"; workflows: PortletWorkflowSummary[] };

export async function loadWorkflowStatusSingle(args: { workflowId: string }): Promise<PortletWorkflowSingle | null> {
  const authz = await resolvePortletAuthz();
  if (!authz.orgId) return null;
  const res = await readWorkflow(args.workflowId);
  if (!res) return null;
  if (!canReadWorkflowScope({ orgId: res.workflow.orgId, projectId: res.workflow.projectId }, authz)) return null;
  return {
    mode: "single",
    workflowId: res.workflow.id,
    name: res.workflow.name,
    status: res.workflow.status,
    tasks: res.tasks.map((t) => ({
      key: t.key,
      title: t.title,
      status: t.status,
      plannedStartUtc: t.plannedStartUtc?.toISOString() ?? null,
      plannedEndUtc: t.plannedEndUtc?.toISOString() ?? null,
      actualStartUtc: t.actualStartUtc?.toISOString() ?? null,
      actualEndUtc: t.actualEndUtc?.toISOString() ?? null,
    })),
  };
}

export async function loadWorkflowStatusList(args: { projectId: string }): Promise<PortletWorkflowList> {
  const authz = await resolvePortletAuthz();
  if (!authz.orgId) return { mode: "list", workflows: [] };
  // Verify project read access first — never broaden to the whole org.
  if (!canReadWorkflowScope({ orgId: authz.orgId, projectId: args.projectId }, authz)) {
    return { mode: "list", workflows: [] };
  }
  const rows = await listWorkflows({ orgId: authz.orgId, projectId: args.projectId });
  return { mode: "list", workflows: rows.map((w) => ({ workflowId: w.id, name: w.name, status: w.status })) };
}

// ---------------------------------------------------------------------------
// PORT-06 artifact-edit-binary-prompt — read-only baseline preview. Interactive
// prompt-driven regeneration is deferred (the concrete binary-generation
// primitive is blog-specific). Returns the parent object's CURRENT artifact
// (read-gated) so the portlet renders a real baseline.
// ---------------------------------------------------------------------------
export type PortletArtifactBaseline = { artifactId: string; title: string | null; mime: string };

export async function loadArtifactBaselinePortlet(args: {
  objectId: string;
  parentObjectField: string;
}): Promise<PortletArtifactBaseline | null> {
  const authz = await resolvePortletAuthz();
  if (!authz.orgId || !authz.actorContext) return null;
  const row = getObjectById(args.objectId, { orgId: authz.orgId });
  if (!row) return null;
  try {
    await enforceResourceAccess(objectResourceCheck(row), authz.primitiveActor, "object.read", authz.roleHints);
  } catch {
    return null;
  }
  const data = (row.data ?? {}) as Record<string, unknown>;
  const artifactId = typeof data[args.parentObjectField] === "string" ? (data[args.parentObjectField] as string) : null;
  if (!artifactId) return null;
  const current = getArtifact({ artifactId, orgId: authz.orgId, actor: authz.actorContext });
  if (!current) return null;
  return { artifactId: current.artifactId, title: current.title, mime: current.mime };
}
