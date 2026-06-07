import "server-only";

import {
  createInProcessPrimitiveTransport,
  invokePrimitive,
  type PrimitiveActorContext,
  type PrimitiveTransport,
} from "@cinatra-ai/mcp-client";
import { createObjectsPrimitiveHandlers } from "../handlers";

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
    save: (inp: { rawData: Record<string, unknown>; typeHint?: string; parentId?: string }) =>
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
  };
}
