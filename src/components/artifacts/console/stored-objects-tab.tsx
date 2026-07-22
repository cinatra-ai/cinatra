import "server-only";
/**
 * Stored objects tab — the Artifacts console's global stored-object inventory
 * (cinatra#1786, spec design@923fa0d8 §IV). Every stored object of every
 * artifact extension: a display-name row over a mono meta line (type id ·
 * object id · version · updated), with an entity-named scope label at the row's
 * right edge. Read-only inventory — record inspection only, no actions.
 */
import { formatDistanceToNow } from "date-fns";

import type { ActorContext } from "@/lib/authz/actor-context";
import { loadStoredArtifactObjects } from "@/lib/artifacts/stored-objects-inventory";
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";

/** Shorten a long opaque id for the mono meta line ("obj_2a4e…"). */
function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

export async function StoredObjectsTab({
  orgId,
  actor,
}: {
  orgId: string | null;
  actor?: ActorContext;
}) {
  let rows: Awaited<ReturnType<typeof loadStoredArtifactObjects>>;
  try {
    rows = await loadStoredArtifactObjects({ orgId, actor });
  } catch {
    return <StoredObjectsErrorState />;
  }

  if (rows.length === 0) return <StoredObjectsEmptyState />;

  return (
    <ul
      className="overflow-hidden rounded-lg border border-line bg-surface-strong"
      data-testid="artifacts-stored-objects"
      data-conformance-id="artifacts-stored-objects"
    >
      {rows.map((r, i) => (
        <li
          key={r.objectId}
          data-testid="artifacts-stored-object-row"
          className={
            "flex items-center gap-3 px-3.5 py-3" +
            (i === rows.length - 1 ? "" : " border-b border-line")
          }
        >
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-foreground">
              {r.displayName}
            </p>
            <p className="mt-0.5 font-mono text-badge-xs text-muted-foreground">
              {r.typeId} · {shortId(r.objectId)} · v{r.version} ·{" "}
              {r.updatedAt
                ? `updated ${formatDistanceToNow(new Date(r.updatedAt), { addSuffix: true })}`
                : "updated recently"}
            </p>
          </div>
          <span
            className="flex-none rounded-full border border-line bg-surface-muted px-2.5 py-0.5 text-xs text-foreground"
            data-testid="artifacts-stored-object-scope"
          >
            {r.scopeLabel}
          </span>
        </li>
      ))}
    </ul>
  );
}

function StoredObjectsEmptyState() {
  return (
    <Empty
      data-testid="artifacts-stored-objects"
      data-conformance-id="artifacts-stored-objects"
      data-state="empty"
    >
      <EmptyHeader>
        <EmptyDescription>No objects are stored yet.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function StoredObjectsErrorState() {
  return (
    <div
      className="rounded-lg border border-line bg-surface-strong px-5 py-10 text-center text-sm text-muted-foreground"
      data-testid="artifacts-stored-objects"
      data-conformance-id="artifacts-stored-objects"
      data-state="error"
    >
      Couldn&apos;t load the stored-object inventory.
    </div>
  );
}
