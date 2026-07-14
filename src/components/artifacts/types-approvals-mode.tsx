import "server-only";
/**
 * §V Types & approvals — the type registry, relocated under the admin side
 * (cinatra#1431, spec design@4c6799db §V; formerly `/data/types`, including its
 * proposed-type approval feed — issue AC: "`/data/types` administration
 * (static + dynamic registry views incl. the proposed-type approval feed) …
 * relocate under the admin side").
 *
 * Three registers, two distinct approval axes:
 *   - STATIC — the built-in row types + artifact-extension descriptors from
 *     the process registry, read-only;
 *   - PROPOSED — dynamic types the classifier proposed but has NOT yet
 *     activated (`status='proposed'`). A proposed type is not offered to the
 *     classifier as a valid target until an admin PROMOTES it to active (the
 *     global type-lifecycle decision), or archives it. This is the relocated
 *     proposed-type approval feed; its Promote/Archive act on the type
 *     LIFECYCLE (`approveDynamicObjectType` / `archiveDynamicObjectType`),
 *     which is a different axis from artifact visibility below;
 *   - DYNAMIC (active) — every ACTIVE dynamic type with its ORG-SCOPED
 *     artifact-visibility approval state (the landed #1433 machinery). A
 *     dynamic type reaches an active registration through promotion here, or
 *     through MCP registration / an install path WITHOUT any approval
 *     (`objects_type_register` mints `status='active'` directly) — that alone
 *     does NOT make its rows artifacts. Artifact visibility is granted only by
 *     the admin Approve action here, which writes the org-scoped approval
 *     RECORD (an org-scoped default claim held by the floor extension —
 *     explicitly NOT a status flip). A row therefore reads Approved (carries
 *     the approval record; joins default-artifact coverage) or Proposed
 *     (active + mintable, but its rows are plain objects). A dedicated claim
 *     makes default coverage dormant while the record persists. Archive here
 *     retires the active type via the same lifecycle action.
 */
import { Braces, FileText, Rows, Sparkles } from "lucide-react";

import {
  objectTypeRegistry,
  readAllDynamicObjectTypes,
  approveDynamicObjectTypeAction,
  archiveDynamicObjectTypeAction,
  type DynamicObjectTypeRecord,
} from "@cinatra-ai/objects";
import { Button } from "@/components/ui/button";
import {
  listDynamicTypeVisibilityReviewRows,
  approvalAwaitsDecision,
  type DynamicTypeVisibilityReviewRow,
} from "@/lib/objects/artifact-visibility-approval";

import { TypesApprovalsApproveButton } from "./types-approvals-approve-button";
import { ArchiveTypeButton } from "./archive-type-button";

export async function TypesApprovalsMode({ orgId }: { orgId: string | null }) {
  const staticTypes = objectTypeRegistry.list();

  // Proposed dynamic types awaiting the admin lifecycle decision (promote to
  // active — which admits the type into the classifier catalog and lets it gain
  // artifact visibility — or archive to dismiss). Oldest first so the longest-
  // waiting proposal surfaces at the top.
  const proposedTypes = (await readAllDynamicObjectTypes())
    .filter((t) => t.status === "proposed")
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  // Every ACTIVE dynamic type with its org approval record (null ⇒ Proposed).
  // Awaiting-decision rows (no record, or a stranded 'reserved' claim) sort
  // first so the admin sees the actionable set at the top.
  const dynamicRows = orgId
    ? await listDynamicTypeVisibilityReviewRows({ orgId })
    : [];
  const sorted = [...dynamicRows].sort((a, b) => {
    const aw = approvalAwaitsDecision(a.approval) ? 0 : 1;
    const bw = approvalAwaitsDecision(b.approval) ? 0 : 1;
    if (aw !== bw) return aw - bw;
    return a.objectTypeId.localeCompare(b.objectTypeId);
  });

  return (
    <div className="flex flex-col gap-6" data-testid="artifacts-types">
      {/* Static register */}
      <section className="rounded-lg border border-line bg-surface-strong p-5">
        <h2 className="mb-1 text-base font-semibold text-foreground">
          Static types
        </h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Built-in row types and artifact-extension descriptors, registered in
          code at startup. Read-only.
        </p>
        {staticTypes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No static types registered.</p>
        ) : (
          <ul className="divide-y divide-line">
            {staticTypes.map((def) => {
              const ns = def.type.match(/^@([\w-]+)\/([\w-]+):/);
              const origin = ns ? `${ns[1]}/${ns[2]}` : "—";
              return (
                <li key={def.type} className="flex items-center gap-3 py-2.5">
                  <span className="w-[280px] shrink-0 truncate font-mono text-xs text-foreground">
                    {def.type}
                  </span>
                  <span className="flex-1 truncate text-xs text-muted-foreground">
                    {origin}
                  </span>
                  <span className="rounded-full border border-line bg-surface-muted px-2 py-0.5 font-mono text-badge-xs text-muted-foreground">
                    {def.category}
                  </span>
                  <FileText
                    aria-hidden
                    className={
                      "size-4 " +
                      (def.renderers?.detail ? "text-foreground" : "text-muted-foreground opacity-40")
                    }
                  />
                  <Rows
                    aria-hidden
                    className={
                      "size-4 " +
                      (def.renderers?.listRow ? "text-foreground" : "text-muted-foreground opacity-40")
                    }
                  />
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Proposed types — the relocated proposed-type approval feed. Promote
          admits the type into the classifier catalog; Archive dismisses it. */}
      <section className="rounded-lg border border-line bg-surface-strong p-5">
        <h2 className="mb-1 text-base font-semibold text-foreground">
          Proposed types
        </h2>
        <p className="mb-4 text-sm text-muted-foreground">
          The classifier proposes a new type when it can&apos;t confidently
          categorize a saved object. A proposed type is NOT offered to the
          classifier until an admin promotes it. Promote to activate it, or
          archive to dismiss it.
        </p>
        {proposedTypes.length === 0 ? (
          <div
            className="flex flex-col items-center gap-2 py-8 text-center"
            data-testid="artifacts-proposed-types"
            data-conformance-id="artifacts-proposed-types"
            data-state="empty"
          >
            <Sparkles aria-hidden className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              No types awaiting promotion.
            </p>
          </div>
        ) : (
          <ul
            className="overflow-hidden rounded-lg border border-line"
            data-testid="artifacts-proposed-types"
            data-conformance-id="artifacts-proposed-types"
          >
            {proposedTypes.map((row, i) => (
              <ProposedTypeRow
                key={row.type}
                row={row}
                isLast={i === proposedTypes.length - 1}
              />
            ))}
          </ul>
        )}
      </section>

      {/* Dynamic register + artifact-visibility approval feed */}
      <section className="rounded-lg border border-line bg-surface-strong p-5">
        <h2 className="mb-1 text-base font-semibold text-foreground">
          Dynamic types &amp; approval feed
        </h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Types registered at runtime (classifier / MCP / install). A type can
          reach an active registration WITHOUT approval — that alone does not
          make its rows artifacts. Approve to write the org-scoped artifact-
          visibility approval record.
        </p>
        {sorted.length === 0 ? (
          <div
            className="flex flex-col items-center gap-2 py-8 text-center"
            data-testid="artifacts-type-approvals"
            data-conformance-id="artifacts-type-approvals"
            data-state="empty"
          >
            <Braces aria-hidden className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No dynamic types yet.</p>
          </div>
        ) : (
          <ul
            className="overflow-hidden rounded-lg border border-line"
            data-testid="artifacts-type-approvals"
            data-conformance-id="artifacts-type-approvals"
          >
            {sorted.map((row, i) => (
              <DynamicTypeRow
                key={row.objectTypeId}
                row={row}
                isLast={i === sorted.length - 1}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function DynamicTypeRow({
  row,
  isLast,
}: {
  row: DynamicTypeVisibilityReviewRow;
  isLast: boolean;
}) {
  // Approved = the approval record is present AND active (not awaiting a
  // decision). Proposed = no record yet, or a stranded 'reserved' record that
  // conveys no coverage — either way the admin still needs to decide.
  const approved = row.approval != null && !approvalAwaitsDecision(row.approval);
  const dormant = approved && row.approval?.status === "dormant";
  return (
    <li
      className={"flex items-center gap-3 px-3.5 py-3" + (isLast ? "" : " border-b border-line")}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-foreground">{row.objectTypeId}</span>
          {approved ? <ApprovedPill /> : <ProposedPill />}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {approved
            ? dormant
              ? "Dynamic · artifact-visible · covered by a dedicated claim (default coverage dormant)"
              : "Dynamic · artifact-visible · covered by default artifact"
            : `Dynamic · registered via ${row.mintedBy ?? "runtime"} · not yet artifact-visible`}
        </p>
      </div>
      <div className="flex flex-none items-center gap-2">
        {approved ? (
          <span className="font-mono text-badge-xs text-muted-foreground">
            approval record set
          </span>
        ) : (
          <TypesApprovalsApproveButton objectTypeId={row.objectTypeId} />
        )}
        {/* Type-lifecycle archive (distinct from artifact visibility): retires
            the active dynamic type, preserved from the former /data/types.
            Confirmed — there is no in-app un-archive. */}
        <ArchiveTypeButton
          objectTypeId={row.objectTypeId}
          action={archiveDynamicObjectTypeAction}
        />
      </div>
    </li>
  );
}

// Proposed-type approval feed row (relocated from /data/types). Promote runs
// the global type-lifecycle promotion (proposed → active); Archive dismisses
// the proposal. Both are a different axis from the artifact-visibility approval
// above (which acts only on already-active types).
function ProposedTypeRow({
  row,
  isLast,
}: {
  row: DynamicObjectTypeRecord;
  isLast: boolean;
}) {
  return (
    <li
      className={
        "flex items-center gap-3 px-3.5 py-3" + (isLast ? "" : " border-b border-line")
      }
    >
      <div className="min-w-0 flex-1">
        <span className="font-mono text-xs text-foreground">{row.type}</span>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {row.inferredName || "—"}
          {row.inferredCategory ? ` · ${row.inferredCategory}` : ""}
          {row.source ? ` · via ${row.source}` : ""}
          {row.confidence ? ` · ${row.confidence} confidence` : ""}
        </p>
      </div>
      <div className="flex flex-none items-center gap-2">
        <form action={approveDynamicObjectTypeAction.bind(null, row.type)}>
          <Button type="submit" size="sm" data-action="promote-type -> active">
            Promote
          </Button>
        </form>
        <ArchiveTypeButton objectTypeId={row.type} action={archiveDynamicObjectTypeAction} />
      </div>
    </li>
  );
}

function ApprovedPill() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-xs font-semibold text-success">
      <span className="size-1.5 rounded-full bg-success" />
      Approved
    </span>
  );
}

function ProposedPill() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-warning/40 bg-warning/15 px-2 py-0.5 text-xs font-semibold text-warning">
      <span className="size-1.5 rounded-full bg-warning" />
      Proposed
    </span>
  );
}
