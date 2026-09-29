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

// ---------------------------------------------------------------------------
// THE WARM THAT ALSO SEES WHAT WAS INSTALLED AT RUNTIME (cinatra#3204).
//
// `registerAllObjectTypes()` above bridges `kind:"artifact"` packages from ONE
// root: `<cwd>/extensions`, the git-native authoring tree. A pack the operator
// installed at runtime — whether its bytes came from the registry or were
// supplied on the upload road — is materialized into the unified
// content-addressed store instead, so the warm above registers none of them.
// Its declared object type therefore reaches the artifacts area's meaning
// picker only in a process that ALSO ran the boot phase or performed the
// install itself; in any other process the picker offers the built-ins alone,
// and an uploaded object is filed under its format base type with the declared
// type nowhere on offer.
//
// The store road already has an owner: `rescanArtifactBridgeFromStore`, which
// reads `package.json` only (it never imports package code) and is FAIL-CLOSED
// against the canonical store — a store dir registers only when the package's
// canonical row is live and its trusted install anchor resolves, so a
// torn-down or anchor-refused pack is never resurrected. This warm drives THAT
// authority rather than walking the store a second time with weaker rules, so
// discovery and the durable gate can never diverge.
//
// ASYNC and separate from the synchronous warm on purpose: the authority reads
// the database, which the sync reader gates above cannot await. Callers that
// can await it — the artifacts area's own server actions — get the full
// picture; the sync gates keep exactly the behaviour they had.
//
// Guarded to ONE rescan per process, and only a SUCCESSFUL one sets the guard:
// a failed rescan (database not ready, store not mounted) must not pin an
// incomplete registry for the life of the process, so the next call retries.
// ---------------------------------------------------------------------------

let _storeReady = false;
let _storeInFlight: Promise<void> | null = null;

/**
 * Warm the object-type registry INCLUDING the packages installed at runtime, so
 * an installed artifact pack's declared type is offered by the artifacts area.
 * Best-effort: a rescan failure degrades to the bundled/authoring types (the
 * boot rescan stays the durable path) and never turns a read into an error.
 */
export async function ensureArtifactTypesRegisteredWithStore(): Promise<void> {
  ensureArtifactTypesRegistered();
  if (_storeReady) return;
  if (!_storeInFlight) {
    _storeInFlight = (async () => {
      const { rescanArtifactBridgeFromStore } = await import(
        "@/lib/extension-artifact-bridge-rescan"
      );
      await rescanArtifactBridgeFromStore();
      _storeReady = true;
    })().catch((err) => {
      console.warn(
        "[artifacts] store rescan during the registry warm failed — offering the " +
          "bundled artifact types only (will retry):",
        err instanceof Error ? err.message : err,
      );
    }).finally(() => {
      _storeInFlight = null;
    });
  }
  await _storeInFlight;
}
