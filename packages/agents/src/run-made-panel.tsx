import Link from "next/link";
import {
  RUN_MADE_PANEL_TITLE,
  buildRunArtifactList,
  runArtifactListSummary,
  type RunArtifactRecord,
} from "./run-artifact-list";

// ---------------------------------------------------------------------------
// "What this run made" — the panel of the rail's last entry (cinatra#3029, epic
// #3023 W5; Agents Lifecycle (C) §6 step 6, and the ratified drawing's section
// on the run's last step).
//
// The reading and every row are built by the PURE model in `./run-artifact-list`
// (fixture-pinned in `__tests__/run-artifact-list.test.ts`); this file is the
// drawing of that model and holds no reading of its own. A row is a POINTER —
// title, the type that owns it, the revision the run filed or read, and the
// control that opens it on its own page.
// ---------------------------------------------------------------------------

export function RunMadePanel({ records }: { records: readonly RunArtifactRecord[] }) {
  const list = buildRunArtifactList(records, (id) => `/artifacts/${encodeURIComponent(id)}`);
  return (
    <section
      aria-label={RUN_MADE_PANEL_TITLE}
      className="rounded-lg border border-border bg-card p-4"
    >
      <h3 className="text-sm font-semibold text-foreground">{RUN_MADE_PANEL_TITLE}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{runArtifactListSummary(list)}</p>
      {list.kind === "rows" ? (
        <ul className="mt-3 flex flex-col gap-2">
          {list.rows.map((row) => (
            <li
              key={row.key}
              className="flex items-start justify-between gap-3 rounded-md border border-border/60 px-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium text-foreground">{row.title}</span>
                  <span className="rounded border border-border px-1.5 py-0.5 text-badge-xs text-muted-foreground">
                    {row.typeBadge}
                  </span>
                  {row.usedMark ? (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-badge-xs text-muted-foreground">
                      Used
                    </span>
                  ) : null}
                </div>
                <div className="mt-0.5 truncate font-mono text-badge-xs text-muted-foreground">
                  {row.detail}
                </div>
              </div>
              <Link
                href={row.href}
                className="shrink-0 text-sm font-medium text-primary underline-offset-4 hover:underline"
              >
                {row.openLabel}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
