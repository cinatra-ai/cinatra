// MutationResult<T> contract.
//
// The canonical return shape for write server actions in the data-safety
// surface. Carries the `changeSetId` produced by the canonical history-aware
// writer through to the client so the action's caller can offer an inline
// "Undo" (deep-linking to /data-safety/change-sets/[id]?openRestore=1).
//
// Defined once here so that rollout across primary write surfaces is a
// checklist, not a redefinition.
export type MutationResult<T = unknown> =
  | { ok: true; data?: T; changeSetId?: string; objectId?: string }
  | { ok: false; error: string; details?: Record<string, unknown> };
