import "server-only";
/**
 * §IV Raw objects — the administrator-gated full objects browser (cinatra#1431,
 * spec design@4c6799db §IV). The former `/data` browse semantics, unchanged,
 * now a mode of `/artifacts`: EVERY objects row, including the non-artifact
 * internals that never become artifacts (send attempts, sender config, run
 * bookkeeping). A dense table — object type, owner / visibility (the canonical
 * `user|team|organization|workspace` × `private|team|organization|public`
 * column model), source, canonical version, updated — scrolling inside its own
 * container.
 *
 * This component renders ONLY after the surface has confirmed the caller is an
 * administrator (the authorization boundary is server-side in the page); a
 * non-admin never reaches it and never triggers this query — they get the
 * inline not-authorized panel instead (§I/§IV).
 */
import { formatDistanceToNow } from "date-fns";

import type { ActorContext } from "@/lib/authz/actor-context";
import { listObjectsByFilter, type ObjectRecord } from "@/lib/objects-store";

export function RawObjectsMode({
  orgId,
  actor,
  typeFilter,
  query,
}: {
  orgId: string | null;
  actor: ActorContext;
  typeFilter?: string;
  query?: string;
}) {
  let rows: ObjectRecord[];
  try {
    rows = listObjectsByFilter(
      { orgId, type: typeFilter && typeFilter !== "__all__" ? typeFilter : undefined, limit: 200 },
      actor,
    );
  } catch {
    return <RawErrorState />;
  }

  const q = (query ?? "").trim().toLowerCase();
  // Raw rows carry no top-level name (it lives inside `data`); the browser
  // filters by the raw object type id, matching its single identity column.
  const filtered = q
    ? rows.filter((r) => r.type.toLowerCase().includes(q))
    : rows;

  return (
    <div
      className="overflow-hidden rounded-lg border border-line bg-surface-strong"
      data-testid="artifacts-raw-table"
      data-conformance-id="artifacts-raw-table"
      data-state={filtered.length === 0 ? "empty" : undefined}
    >
      {filtered.length === 0 ? (
        <div className="px-5 py-10 text-center text-sm text-muted-foreground">
          No objects match. Every stored object — including non-artifact
          internals — appears here.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-0 text-xs">
            <thead>
              <tr>
                {["Object type", "Owner / visibility", "Source", "Ver.", "Updated"].map(
                  (h) => (
                    <th
                      key={h}
                      className="border-b border-line bg-surface px-3.5 py-2.5 text-left font-mono text-badge-2xs font-bold uppercase tracking-kicker text-muted-foreground"
                    >
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody className="font-mono">
              {filtered.map((r, i) => (
                <tr key={r.id}>
                  <RawCell last={i === filtered.length - 1} className="text-foreground">
                    {r.type}
                  </RawCell>
                  <RawCell last={i === filtered.length - 1} className="text-muted-foreground">
                    {r.ownerLevel} · {r.visibility}
                  </RawCell>
                  <RawCell last={i === filtered.length - 1} className="text-muted-foreground">
                    {r.source ?? "—"}
                  </RawCell>
                  <RawCell last={i === filtered.length - 1} className="text-muted-foreground">
                    {r.version}
                  </RawCell>
                  <RawCell last={i === filtered.length - 1} className="text-muted-foreground">
                    {r.updatedAt
                      ? formatDistanceToNow(new Date(r.updatedAt), { addSuffix: true })
                      : "—"}
                  </RawCell>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RawCell({
  children,
  last,
  className,
}: {
  children: React.ReactNode;
  last: boolean;
  className?: string;
}) {
  return (
    <td
      className={
        "px-3.5 py-2.5" + (last ? "" : " border-b border-line") + (className ? ` ${className}` : "")
      }
    >
      {children}
    </td>
  );
}

function RawErrorState() {
  return (
    <div
      className="rounded-lg border border-line bg-surface-strong px-5 py-10 text-center text-sm text-muted-foreground"
      data-testid="artifacts-raw-table"
      data-conformance-id="artifacts-raw-table"
      data-state="error"
    >
      Couldn&apos;t load the objects browser.
    </div>
  );
}
