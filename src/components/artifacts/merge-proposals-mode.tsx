import "server-only";
/**
 * Merge proposals — enrichment-agent proposals awaiting review, relocated under
 * the /artifacts admin side (cinatra#1431). NOT in the pinned spec
 * (design@4c6799db §V/§VI are silent on merge-proposals); relocated here from
 * the deleted `/data-safety/merge-proposals` route so §VII can remove
 * `/data-safety` without silently dropping the feature. Tracked by a spec-delta
 * follow-up recorded on the PR.
 *
 * This component renders only after the surface has confirmed the caller is an
 * administrator (the authorization boundary is server-side in the page); the
 * detail route + the approve/reject actions independently re-check per-object
 * `object.update` authorization (defense-in-depth).
 */
import Link from "next/link";
import { format } from "date-fns";
import { GitMerge } from "lucide-react";

import { listPendingMergeProposals } from "@/lib/object-history";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from "@/components/ui/empty";

export function MergeProposalsMode({ orgId }: { orgId: string | null }) {
  const items = orgId ? listPendingMergeProposals({ orgId, limit: 100 }) : [];

  if (items.length === 0) {
    return (
      <Empty data-testid="artifacts-merge-proposals" data-state="empty">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <GitMerge aria-hidden />
          </EmptyMedia>
          <EmptyDescription>No pending merge proposals.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div
      className="overflow-hidden rounded-lg border border-line bg-surface-strong"
      data-testid="artifacts-merge-proposals"
    >
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0 text-xs">
          <thead>
            <tr>
              {["Proposal", "Object", "Source", "Base version", "Created"].map((h) => (
                <th
                  key={h}
                  className="border-b border-line bg-surface px-3.5 py-2.5 text-left font-mono text-badge-2xs font-bold uppercase tracking-kicker text-muted-foreground"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((p, i) => {
              const last = i === items.length - 1;
              const cell = "px-3.5 py-2.5" + (last ? "" : " border-b border-line");
              return (
                <tr key={p.id}>
                  <td className={cell}>
                    <Link
                      href={`/artifacts/merge-proposals/${p.id}`}
                      className="font-mono text-xs text-primary hover:underline"
                    >
                      {p.id.slice(0, 16)}…
                    </Link>
                  </td>
                  <td className={cell}>
                    <span className="font-mono text-xs">{p.objectId.slice(0, 12)}…</span>
                    <span className="ml-1 text-muted-foreground">{p.objectType}</span>
                  </td>
                  <td className={cell}>
                    <Badge variant="secondary">{p.sourceKind}</Badge>
                  </td>
                  <td className={cell + " text-muted-foreground"}>v{p.baseVersion}</td>
                  <td className={cell + " text-muted-foreground"}>
                    {format(new Date(p.createdAt), "PP p")}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
