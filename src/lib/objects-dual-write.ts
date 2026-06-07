import "server-only";
import { upsertObject, deleteObject, deleteObjectsByParentId, type UpsertObjectInput } from "@/lib/objects-store";

// ---------------------------------------------------------------------------
// These helpers must remain real object shadow writers.
// ---------------------------------------------------------------------------
//
// Blog store callsites should not use these helpers when they would re-type
// canonical rows back to `@cinatra-ai/asset-blog:*`. Agent store callsites do
// rely on them for agent-template projection and cleanup, so stubbing these
// helpers would silently drop agent object projections.
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget shadow-write into the cinatra.objects table.
 *
 * Wraps {@link upsertObject} in a try/catch. Errors are logged with a
 * grep-able prefix and swallowed — the primary store write (dedicated
 * table) has already committed and is authoritative.
 *
 * Synchronous because upsertObject uses the postgres-sync worker-thread
 * bridge. Never `await` this — there is no promise to await.
 */
export function shadowUpsertObject(input: UpsertObjectInput): void {
  try {
    upsertObject(input);
  } catch (error) {
    console.error(
      `[objects:shadow-write] type=${input.type} id=${input.id ?? "(auto)"} failed:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * Bulk convenience. One bad row does not stop the rest — each upsert is
 * independently try/catched via {@link shadowUpsertObject}.
 */
export function shadowUpsertObjects(inputs: readonly UpsertObjectInput[]): void {
  for (const input of inputs) {
    shadowUpsertObject(input);
  }
}

export function shadowDeleteObject(id: string): void {
  try {
    deleteObject(id);
  } catch (error) {
    console.error(
      `[objects:shadow-delete] id=${id} failed:`,
      error instanceof Error ? error.message : error,
    );
  }
}

export function shadowDeleteObjectsByParentId(parentId: string): void {
  try {
    deleteObjectsByParentId(parentId);
  } catch (error) {
    console.error(
      `[objects:shadow-delete] parentId=${parentId} failed:`,
      error instanceof Error ? error.message : error,
    );
  }
}
