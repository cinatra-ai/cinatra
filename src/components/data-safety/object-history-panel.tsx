import Link from "next/link";
import { format } from "date-fns";
import { History } from "lucide-react";

import { listEventsForObject, isEventRestoreEligible } from "@/lib/object-history";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RestoreVersionButton } from "@/components/data-safety/restore-version-button";

// Per-object history panel — importable into any object detail page.
// Server component; reads via the object-history substrate. The caller
// passes the object's id + the current actor's orgId so the SQL filter
// applies (id-reuse / cross-tenant safety).
export type ObjectHistoryPanelProps = {
  objectId: string;
  orgId: string | null;
  // Cap to keep the panel compact. Detail UI links to the change-set view
  // for the full picture.
  limit?: number;
  // Optional inline title override (defaults to "History").
  title?: string;
  // Per-version restore. When `canRestore` is true (the
  // caller resolved `object.update` for the current actor server-side) the
  // panel renders a "Restore to this version" button on each restore-eligible
  // event that isn't already the current version. Omitted ⇒ no buttons (the
  // button is server-hidden unless authz passed; never a client-side reveal).
  canRestore?: boolean;
  // The object's current version — the latest event is a no-op to restore, so
  // its button is suppressed.
  currentVersion?: number;
};

export function ObjectHistoryPanel(props: ObjectHistoryPanelProps) {
  const events = listEventsForObject(props.objectId, {
    limit: props.limit ?? 20,
    orgId: props.orgId,
  });
  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="size-4 text-muted-foreground" />
          {props.title ?? "History"}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No history captured for this object.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {events.map((event) => (
              <li
                key={event.id}
                className="soft-panel p-3 flex flex-col gap-1"
              >
                <div className="flex items-center gap-2 text-xs">
                  <Badge variant="secondary">{event.operation}</Badge>
                  <span className="text-muted-foreground">
                    v{event.baseVersion ?? "—"} → v{event.resultVersion}
                  </span>
                  <span className="ml-auto text-muted-foreground">
                    {format(new Date(event.createdAt), "PP p")}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">
                  by {event.actorKind ?? "system"}
                  {event.actorId ? ` (${event.actorId.slice(0, 8)})` : ""} ·{" "}
                  <Link
                    href={`/data-safety/change-sets/${event.changeSetId}`}
                    className="text-primary hover:underline"
                  >
                    change-set
                  </Link>
                </div>
                {props.canRestore &&
                props.currentVersion !== undefined &&
                event.resultVersion !== props.currentVersion &&
                isEventRestoreEligible(event).eligible ? (
                  <div className="flex justify-end">
                    <RestoreVersionButton
                      objectId={props.objectId}
                      targetVersion={event.resultVersion}
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
