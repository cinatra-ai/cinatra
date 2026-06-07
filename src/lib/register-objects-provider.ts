import "server-only";

// ---------------------------------------------------------------------------
// Host-side wiring for the crm-connector's objects-subsystem coupling.
//
// The crm-connector reaches the objects subsystem — the object-type registry,
// the sync-adapter registry, the graphiti episode client, and the `objects_save`
// handler — through the SDK's host-injected `requireObjectsProvider()` DI slot
// rather than importing `@cinatra-ai/objects` by name. This module binds that
// slot at boot.
//
// This file imports ONLY the SDK setter + `@cinatra-ai/objects` LEAF subpaths
// (`/registry`, `/sync-adapters/registry`, `/graphiti-client`, `/mcp-handlers`) —
// `@cinatra-ai/objects` is a host `packages/` package (NOT an extension), so this
// adds NO core→extension edge (host→host binding, the preferred IoC mechanism).
// Subpaths (not the barrel) per packages/objects/AGENTS.md: the barrel re-exports
// `./mcp/handlers` which pulls host-only Next aliases.
//
// The provider is GENERIC — it never names crm or any extension; crm merely
// consumes the slot. Auto-registers on import; src/instrumentation.node.ts imports
// it at boot (before the in-process BullMQ worker is created, so the ctx-less
// projector / pointer-repair worker paths resolve the slot too).
// ---------------------------------------------------------------------------

import { setObjectsProvider } from "@cinatra-ai/sdk-extensions";
import type { ObjectSyncAdapter, ObjectTypeDefinition } from "@cinatra-ai/sdk-extensions";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";
import { objectSyncAdapterRegistry } from "@cinatra-ai/objects/sync-adapters/registry";
import { addEpisode, identityHashToUuid } from "@cinatra-ai/objects/graphiti-client";
import { createObjectsPrimitiveHandlers } from "@cinatra-ai/objects/mcp-handlers";

/**
 * Build the deterministic group id for an org's CRM episodes. Byte-identical to
 * the generic graphiti projector's `groupIdForOrg` — a mismatch would derive a
 * different episode UUID than `markProjected` records.
 */
function groupIdForOrg(orgId: string | null): string {
  return orgId ? `cinatra-org-${orgId}` : "cinatra-default";
}

setObjectsProvider({
  registerObjectType(definition: ObjectTypeDefinition): void {
    // SDK parallel-copy contract → the structurally-identical objects-internal
    // ObjectTypeDefinition (guarded by the objects-contract drift test).
    objectTypeRegistry.register(
      definition as unknown as Parameters<typeof objectTypeRegistry.register>[0],
    );
  },

  registerSyncAdapter(adapter: ObjectSyncAdapter): void {
    objectSyncAdapterRegistry.register(
      adapter as unknown as Parameters<typeof objectSyncAdapterRegistry.register>[0],
    );
  },

  async addGraphitiEpisodeForObject(input) {
    const groupId = groupIdForOrg(input.orgId);
    // Deterministic UUID for Postgres bookkeeping; the episode is created WITHOUT
    // a `uuid` param (Graphiti 0.28.2 mis-interprets `uuid` on add_memory as
    // "re-process existing node").
    const episodeUuid = identityHashToUuid(input.objectId, groupId);
    await addEpisode({
      name: input.name,
      episode_body: input.episodeBody,
      source: "json",
      source_description: input.sourceDescription,
      group_id: groupId,
      ...(input.referenceTime ? { reference_time: input.referenceTime } : {}),
    });
    return { episodeUuid };
  },

  async saveObject(request) {
    // The REAL `objects_save` primitive (classify → identity-resolve → authz →
    // upsert + enqueue Graphiti projection). Built per call. It runs in the
    // caller's ALS frame —
    // `mcpRequestContextStorage` propagates across this await — so the inline
    // request-path actor/run/projectContext fallback resolves; the worker path
    // passes an explicit actor with orgId/userId in `request.actor`.
    const handlers = createObjectsPrimitiveHandlers();
    const result = await handlers.objects_save({
      primitiveName: "objects_save",
      input: { typeHint: request.typeHint, rawData: request.rawData },
      actor: request.actor as never,
      mode: request.mode,
    });
    return result as {
      objectId: string;
      type: string;
      isNew: boolean;
      wasMerged: boolean;
      confidence: number;
      changeSetId: string;
    };
  },
});
