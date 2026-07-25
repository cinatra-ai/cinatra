import { ScanSearch, ArrowRight } from "lucide-react";
import Link from "next/link";

/**
 * The S4 post-change VERIFICATION view (cinatra#2042, re-anchored 2026-07-25) —
 * mounted on the run-embedded review surface, reached from the run rail's "Core
 * analysis" entry (`?view=verification`). It shows the before/after FIELD-LEVEL
 * diff between the reviewed (base) and repaired revisions, the verdict, and the
 * advisory comments the core lanes attached — all chrome labeled **"Core
 * analysis"** so no output implies a broader inspection than occurred (the
 * provenance principle; the diff shows exactly the fields that were inspected).
 *
 * CMS visual before/after arrives with S6's capture pipeline — out of scope here.
 */
export interface VerificationViewFieldDiff {
  field: string;
  before?: string;
  after?: string;
}

export interface VerificationAdvisoryComment {
  id: string;
  authorKind: string;
  body: string;
}

export interface VerificationViewProps {
  outcome: string;
  reviewedRevisionId: string;
  repairedRevisionId: string;
  fieldDiff: VerificationViewFieldDiff[];
  scopePaths: string[];
  advisoryComments: VerificationAdvisoryComment[];
  /** Link back to the review gate this analysis annotates. */
  gateHref: string;
}

const OUTCOME_COPY: Record<string, { label: string; tone: string }> = {
  verified: { label: "Verified", tone: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700" },
  drifted: { label: "Out-of-scope drift", tone: "border-amber-500/40 bg-amber-500/10 text-amber-700" },
  unmet: { label: "Findings not met", tone: "border-rose-500/40 bg-rose-500/10 text-rose-700" },
};

export function VerificationView({
  outcome,
  reviewedRevisionId,
  repairedRevisionId,
  fieldDiff,
  scopePaths,
  advisoryComments,
  gateHref,
}: VerificationViewProps) {
  const oc = OUTCOME_COPY[outcome] ?? { label: outcome, tone: "border-line bg-surface-muted text-muted-foreground" };
  const scope = new Set(scopePaths);
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4" data-conformance-id="run-surface" data-surface="verification">
      {/* Header — chrome labeled "Core analysis". */}
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="grid size-[30px] flex-none place-items-center rounded-lg bg-mustard-ink/15 text-mustard-ink">
          <ScanSearch aria-hidden="true" className="size-4" />
        </span>
        <span className="font-sans text-sm font-bold text-foreground" data-verification-chrome="Core analysis">
          Core analysis
        </span>
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${oc.tone}`} data-verification-outcome={outcome}>
          {oc.label}
        </span>
      </div>

      <p className="max-w-[72ch] text-xs leading-relaxed text-muted-foreground">
        Post-change verification of the repaired revision against the reviewed one. The
        before/after below shows exactly the fields that were inspected — nothing more.
      </p>

      {/* The immutable revision pins. */}
      <div className="flex flex-wrap items-center gap-2 font-mono text-badge-2xs text-muted-foreground">
        <span title="reviewed revision">{reviewedRevisionId}</span>
        <ArrowRight aria-hidden="true" className="size-3" />
        <span title="repaired revision">{repairedRevisionId}</span>
      </div>

      {/* Before/after FIELD-LEVEL diff (the content_change_proposal precedent). */}
      <div className="overflow-x-auto rounded-panel border border-line" data-verification-field-diff="">
        {fieldDiff.length === 0 ? (
          <p className="px-4 py-6 text-xs text-muted-foreground">
            No field-level changes were projected for this revision (a type-aware content
            projection surfaces field diffs; a visual before/after for CMS targets arrives with S6).
          </p>
        ) : (
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-line text-badge-2xs uppercase tracking-widest text-muted-foreground">
                <th className="px-3 py-2 font-medium">Field</th>
                <th className="px-3 py-2 font-medium">Before</th>
                <th className="px-3 py-2 font-medium">After</th>
              </tr>
            </thead>
            <tbody>
              {fieldDiff.map((f) => {
                const inScope = scope.has(f.field);
                return (
                  <tr key={f.field} className="border-b border-line/60 align-top" data-diff-field={f.field} data-diff-in-scope={inScope ? "true" : "false"}>
                    <td className="px-3 py-2 font-mono text-foreground">
                      {f.field}
                      {!inScope ? (
                        <span className="ms-1.5 rounded-chip bg-amber-500/15 px-1.5 py-0.5 text-badge-2xs uppercase tracking-wide text-amber-700">
                          out of scope
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground line-through decoration-rose-400/60">{f.before ?? "—"}</td>
                    <td className="px-3 py-2 text-foreground">{f.after ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Advisory comments (the S0 attach/list seam; core lanes are its first writers). */}
      <div className="flex flex-col gap-2" data-verification-advisory="">
        <span className="font-mono text-badge-2xs uppercase tracking-widest text-muted-foreground">
          Advisory comments
        </span>
        {advisoryComments.length === 0 ? (
          <p className="text-xs text-muted-foreground">No advisory comments on this analysis.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {advisoryComments.map((c) => (
              <li key={c.id} className="rounded-panel border border-line bg-surface-muted px-3 py-2 text-xs" data-advisory-comment={c.id}>
                <span className="font-mono text-badge-2xs uppercase tracking-wide text-muted-foreground">{c.authorKind}</span>
                <p className="mt-1 text-foreground">{c.body}</p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <Link href={gateHref} className="text-xs font-medium text-mustard-ink underline-offset-2 hover:underline" data-verification-back-to-gate="">
          Back to the review gate
        </Link>
      </div>
    </div>
  );
}
