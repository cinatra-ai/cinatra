import Link from "next/link";
import type { StartedRunRow } from "./visible-started-runs";
export type { StartedRunRow } from "./visible-started-runs";

/** Approved run-page list (#3749), below the existing rail/detail frame.
 * A failed child remains its own run and its link never uses the starter. */
export function RunStartedRuns({ rows }: { rows: readonly StartedRunRow[] }) {
  if (!rows.length) return null;
  return (
    <section data-conformance-id="run-started-runs" data-state="kind:agent" className="mt-4 border-t border-line pt-3">
      <h3 className="mb-2 font-sans text-row-title font-semibold text-foreground">Runs this run started</h3>
      <ul className="m-0 grid list-none gap-2 p-0">
        {rows.map(row => (
          <li key={row.id} data-started-run-id={row.id} className="flex flex-wrap items-baseline gap-3 text-reading">
            <Link href={row.href} data-field="agent-name" data-action="open-started-run" className="text-blue underline underline-offset-[3px]">{row.agentDisplayName}</Link>
            <span data-field="state" data-run-status={row.status} className="text-muted-foreground">{row.status.replaceAll("_", " ").replace(/^./, c => c.toUpperCase())}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
