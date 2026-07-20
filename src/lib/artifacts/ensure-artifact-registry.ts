import "server-only";
import { registerAllObjectTypes } from "@/lib/register-all-object-types";

// ---------------------------------------------------------------------------
// Registry warm for the type-driven artifact reader gates (epic #1785 wave A4).
//
// The reader gates (artifact-read serve, context-resolver, context-selection-
// finalize, the stored-objects inventory, the run_context_selections coherence
// check) admit a row when `objects.type` is a registered isArtifact PACK type,
// read at query-build time from the in-process `objectTypeRegistry`. But the
// UI / MCP / serve read paths do NOT transitively trigger boot registration, so
// in a fresh process the registry can be EMPTY (see artifact-service's
// `ensureArtifactRegistry`) — which would strand every pack-typed row (serve
// 404, context-resolve miss). This shared, once-per-process guarded warm makes
// the read paths see every installed artifact type. Idempotent: the registrar
// is replace-by-id, so a repeat call is a no-op beyond the guard.
// ---------------------------------------------------------------------------

let _ready = false;

/** Warm the object-type registry once per process so the type-driven artifact
 *  reader gates see every installed isArtifact pack type. Safe to call on any
 *  read path; the guard makes repeats free. */
export function ensureArtifactTypesRegistered(): void {
  if (_ready) return;
  registerAllObjectTypes();
  _ready = true;
}
