/**
 * THE REGISTRY-SIDE ROW SHAPES, AS THEIR OWN SLICE (cinatra#3046, fix leg 15).
 *
 * A vertical slice lifted out of `store.ts` whole and unchanged: the six record
 * and input types for `agent_registry_entries` and the two tables that hang off
 * it (share bindings, forks). They are plain row shapes — no query, no schema
 * import, no dependency on anything else in the store — which is exactly what
 * makes them liftable, and `store.ts` keeps re-exporting every one of them, so
 * no caller learns a new import path.
 *
 * WHY IT MOVED. The file-size ratchet holds `store.ts` at a ceiling that may
 * only ever be LOWERED. This change adds one field to `AgentRunRecord` (the
 * produced-review park's own column), which pushed the file past that ceiling.
 * The gate's own instruction is the road taken here: extract a thin facade plus
 * a vertical slice and lower the ceiling, never raise it.
 */

// ---------------------------------------------------------------------------
// Domain types — agent_registry_entries
// ---------------------------------------------------------------------------

export type RegistryEntryRecord = {
  id: string;
  templateId: string;
  versionId: string;
  orgId: string;
  publishedBy: string;
  semver: string;
  title: string;
  description: string | null;
  toolAccess: string[];          // parsed from JSON on read
  riskLevel: string;
  hasApprovalGates: boolean;
  changelog: string | null;
  status: string;
  createdAt: Date;
};

export type CreateRegistryEntryInput = Omit<RegistryEntryRecord, "id" | "createdAt" | "toolAccess"> & {
  toolAccess: string[];           // store serializes to JSON
};

export type ShareBindingRecord = {
  id: string;
  registryEntryId: string;
  subjectType: string;
  subjectId: string;
  canView: boolean;
  canRun: boolean;
  canEditDraft: boolean;
  canPublish: boolean;
  canApprove: boolean;
  grantedBy: string;
  createdAt: Date;
};

export type CreateShareBindingInput = Omit<ShareBindingRecord, "id" | "createdAt">;

export type AgentForkRecord = {
  id: string;
  registryEntryId: string;
  forkedTemplateId: string;
  forkedBy: string;
  createdAt: Date;
};

export type CreateAgentForkInput = Omit<AgentForkRecord, "id" | "createdAt">;
