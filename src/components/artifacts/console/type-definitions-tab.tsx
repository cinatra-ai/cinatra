import "server-only";
/**
 * Type definitions tab — the Artifacts console's global type registry
 * (cinatra#1786, spec design@923fa0d8 §IV). Every type every installed artifact
 * extension defines, alphabetical across all extensions. Columns: Type (display
 * name over the raw type id) · Defined by (the one defining extension) · Used by
 * (installed extensions that declared the definer as a dependency). Read-only
 * inventory — record inspection only, no actions.
 */
import { loadTypeDefinitionRows } from "@/lib/artifacts/type-definitions-inventory";

export async function TypeDefinitionsTab({ orgId }: { orgId: string | null }) {
  let rows: Awaited<ReturnType<typeof loadTypeDefinitionRows>>;
  try {
    rows = await loadTypeDefinitionRows(orgId);
  } catch {
    return <TypeDefinitionsErrorState />;
  }

  if (rows.length === 0) return <TypeDefinitionsEmptyState />;

  return (
    <div
      className="overflow-hidden rounded-lg border border-line bg-surface-strong"
      data-testid="artifacts-type-definitions"
      data-conformance-id="artifacts-type-definitions"
    >
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0 text-xs">
          <thead>
            <tr>
              {["Type", "Defined by", "Used by"].map((h) => (
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
            {rows.map((r, i) => {
              const last = i === rows.length - 1;
              return (
                <tr key={r.typeId} data-testid="artifacts-type-definition-row">
                  <Cell last={last}>
                    <div className="flex flex-col">
                      <span className="text-sm font-semibold text-foreground">
                        {r.displayName}
                      </span>
                      <span className="font-mono text-badge-xs text-muted-foreground">
                        {r.typeId}
                      </span>
                    </div>
                  </Cell>
                  <Cell last={last} className="align-middle text-foreground">
                    {r.definedByLabel}
                  </Cell>
                  <Cell last={last} className="align-middle text-muted-foreground">
                    {r.usedByLabels.length > 0 ? r.usedByLabels.join(", ") : "—"}
                  </Cell>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Cell({
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
        "px-3.5 py-3" + (last ? "" : " border-b border-line") + (className ? ` ${className}` : "")
      }
    >
      {children}
    </td>
  );
}

function TypeDefinitionsEmptyState() {
  return (
    <div
      className="rounded-lg border border-line bg-surface-strong px-5 py-10 text-center text-sm text-muted-foreground"
      data-testid="artifacts-type-definitions"
      data-conformance-id="artifacts-type-definitions"
      data-state="empty"
    >
      No artifact extension defines a type yet.
    </div>
  );
}

function TypeDefinitionsErrorState() {
  return (
    <div
      className="rounded-lg border border-line bg-surface-strong px-5 py-10 text-center text-sm text-muted-foreground"
      data-testid="artifacts-type-definitions"
      data-conformance-id="artifacts-type-definitions"
      data-state="error"
    >
      Couldn&apos;t load the type registry.
    </div>
  );
}
