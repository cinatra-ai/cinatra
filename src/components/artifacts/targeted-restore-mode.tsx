import "server-only";
/**
 * §VI targeted restore — the non-admin carve-out (app-artifacts §I carve-out +
 * §VI, design@94cfbcf5). A non-administrator who deep-links an `openRestore`
 * they are authorized to reverse lands HERE: the SINGLE addressed change-set's
 * restore, with its modal auto-opened — never the administrator's cross-
 * workspace Undo browser list.
 *
 * The page loads + authorizes the change-set ONCE
 * (`loadAuthorizedTargetedRestore`) and passes that exact loaded result in, so
 * there is no check-then-reload race: an unauthorized / missing / foreign-org /
 * newly-non-restorable deep link never reaches here (it resolves to the plain
 * Library surface instead). The restore modal's confirm independently re-checks
 * per-object authorization (`restoreChangeSetAction`) — defense-in-depth, and
 * the honest place a mid-session revocation surfaces (an error in the modal,
 * never a dead-end panel).
 *
 * Renders one change-set row identical to the admin browser's (shared
 * `undo-row` helpers) so the surface reads the same; the modal opens on mount.
 */
import { formatDistanceToNow } from "date-fns";

import type { LoadedTargetedRestore } from "@/lib/object-history/restore-eligibility";
import { RestoreModal } from "@/components/data-safety/restore-modal";
import { restoreChangeSetAction } from "@/components/data-safety/restore-change-set-action";
import { buildUndoDiffLines, composeUndoTitle } from "./undo-row";

export function TargetedRestoreMode({
  loaded,
}: {
  loaded: LoadedTargetedRestore;
}) {
  const cs = loaded.changeSet;
  const events = loaded.events;
  const objectIds = new Set(events.map((e) => e.objectId));
  const objectTypes = new Set(events.map((e) => e.objectType));
  const diffLines = buildUndoDiffLines(events);
  const dominantType = objectTypes.size === 1 ? [...objectTypes][0]! : null;
  const title = composeUndoTitle(diffLines, objectIds.size);

  return (
    <ul
      className="overflow-hidden rounded-lg border border-line bg-surface-strong"
      data-testid="artifacts-targeted-restore"
    >
      <li className="flex items-center gap-3 px-3.5 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">
            {title}
            {dominantType ? (
              <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">
                {dominantType}
              </span>
            ) : null}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {cs.openedAt
              ? formatDistanceToNow(new Date(cs.openedAt), { addSuffix: true })
              : "recent change"}
          </p>
        </div>
        <div className="flex-none" data-action="undo -> restored">
          <RestoreModal
            changeSetId={cs.id}
            restorable={cs.restorable}
            restorableReason={cs.restorableReason}
            affectedObjectCount={objectIds.size}
            diffLines={diffLines.map(({ objectId, objectType, description }) => ({
              objectId,
              objectType,
              description,
            }))}
            action={restoreChangeSetAction}
            defaultOpen={cs.restorable}
          />
        </div>
      </li>
    </ul>
  );
}
