import "server-only";

import {
  createInProcessPrimitiveTransport,
  invokePrimitive,
  type PrimitiveActorContext,
  type PrimitiveTransport,
} from "@cinatra-ai/mcp-client";
import { createObjectsPrimitiveHandlers } from "../handlers";
import type { MemoryRecallResponse } from "../schemas";

export type DeterministicObjectsClient = ReturnType<typeof createDeterministicObjectsClient>;

export function createDeterministicObjectsClient(input: {
  actor: PrimitiveActorContext;
  transport?: PrimitiveTransport;
}) {
  const transport =
    input.transport ?? createInProcessPrimitiveTransport(createObjectsPrimitiveHandlers());

  function invoke<TOutput>(primitiveName: string, primitiveInput: unknown) {
    return invokePrimitive<unknown, TOutput>(transport, {
      primitiveName,
      input: primitiveInput,
      actor: input.actor,
      mode: "deterministic",
    });
  }

  return {
    save: (inp: {
      rawData: Record<string, unknown>;
      typeHint?: string;
      parentId?: string;
      // Ownership + project fields, at PARITY with `objectsSaveSchema`
      // (cinatra#1377). None of them is a grant: the handler re-derives the
      // ownership defaults and re-authorizes every supplied value against the
      // caller's own actor — an in-process caller reaches exactly the same
      // gates an external MCP caller does.
      ownerLevel?: "user" | "team" | "organization" | "workspace";
      ownerId?: string;
      visibility?: "private" | "team" | "organization" | "public";
      // Explicit project binding, three-state and keyed on PRESENCE: omit for
      // ambient inheritance, `null` for a substrate write, an id to bind.
      // Declared `?: string | null` so an explicit `null` is expressible while
      // omission stays distinct.
      projectId?: string | null;
    }) =>
      // changeSetId surfaced so create actions can offer Undo.
      invoke<{ objectId: string; type: string; isNew: boolean; wasMerged: boolean; confidence: number; changeSetId?: string }>(
        "objects_save",
        inp,
      ),
    list: (
      inp: {
        type?: string;
        category?: string;
        query?: string;
        cursor?: string;
        limit?: number;
        // Expose the run + project filters the objects_list schema already supports
        // (objectsListSchema.runId / .projectId), so canonical run-scoped reads no
        // longer need raw SQL.
        runId?: string;
        projectId?: string | null;
        // cinatra#1456: indexed data.* correlation filters (objectsListSchema
        // .dataEquals) — the thread/campaign/contact query seam reads through
        // this so the canonical per-row object.read authz still applies.
        dataEquals?: ReadonlyArray<{
          key: "threadId" | "campaignId" | "contactId" | "connectorId";
          value: string;
        }>;
      } = {},
    ) => invoke<{ items: unknown[]; nextCursor: string | null }>("objects_list", inp),
    get: (objectId: string) => invoke<unknown | null>("objects_get", { objectId }),
    update: (inp: { objectId: string; data: Record<string, unknown> }) =>
      // changeSetId is OPTIONAL: the data-upsert path returns it; the
      // project-move-only path returns { ok: true } with no change-set.
      invoke<{ ok: true; changeSetId?: string }>("objects_update", inp),
    delete: (objectId: string) => invoke<{ ok: true; changeSetId?: string }>("objects_delete", { objectId }),
    classify: (inp: { rawData: Record<string, unknown>; typeHint?: string }) =>
      invoke<unknown>("objects_classify", inp),
    typesList: () =>
      invoke<{ types: Array<{ type: string; category: string; description: string }> }>(
        "objects_types_list",
        {},
      ),
    // cinatra#1380 (epic #1373) — shared-memory recall. An in-process caller
    // reaches EXACTLY the gates an external MCP caller does: the same strict
    // schema parse, the same server-derived lane entitlement, the same
    // sealed-room gate and the same per-row `object.read` probe. There is
    // deliberately NO lane / group_ids / orgId parameter here either: exposing
    // one on the in-process client would be a second door into the thing the
    // wire schema exists to close.
    //
    // `mode` is on the return type because callers must branch on it:
    // "degraded-recent" items are recent memory rows in the caller's scope,
    // NOT an answer to the query.
    //
    // `projectId` SEALS the recall to that project (project rows only); the
    // ambient lanes the search covers are relevance context, not results. See
    // the field's note in `schemas.memoryRecallSchema`.
    memoryRecall: (inp: {
      query: string;
      kind?: string;
      projectId?: string | null;
      limit?: number;
    }) =>
      // DERIVED from the response schema, never restated. A hand-written copy
      // of this shape drifted the moment the handler grew a field: it still
      // declared `meta` as `{ semanticSearch: string; fallback: string }` after
      // `meta.responseCeiling` shipped, so a typed caller could not see the
      // row-drop signal without a cast, and the two members it did declare were
      // absent from the ceiling answer it typed. `MemoryRecallResponse` is the
      // discriminated union the handler parses through, so narrowing on `mode`
      // here gives a caller exactly the ordering and the `meta` its branch can
      // actually carry.
      invoke<MemoryRecallResponse>("memory_recall", inp),
  };
}
