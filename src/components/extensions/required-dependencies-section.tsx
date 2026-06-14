// Pre-install "A requires B, C" surface (cinatra #209 item 2, surface 1).
//
// Renders the package manifest's REAL dependency edges (parsed via
// `parseManifestDependencyEdges` at the call site, shaped by
// `summarizeRequiredDependencies`) so an operator sees what an install will
// pull in BEFORE they commit. The auto-installed deps are exactly the
// dependencies-first set the install saga installs; peer/optional edges are
// surfaced separately because they are NOT auto-installed.
//
// Server component (no interactivity) — shadcn primitives + semantic tokens
// only, matching the other RegistryEntryDetailSections panels.

import { PackagePlusIcon } from "lucide-react";
import { extensionKindEmblem } from "@/components/extension-kind-emblem";
import type { ExtensionEmblemKind } from "@/components/extension-kind-emblem";
import { Badge } from "@/components/ui/badge";
import type { RequiredDependenciesSummary, RequiredDependencyRow } from "@/lib/extension-dependency-ux";

function emblemKind(kind: RequiredDependencyRow["kind"]): ExtensionEmblemKind {
  return kind ?? "unknown";
}

function DependencyRow({ row }: { row: RequiredDependencyRow }) {
  return (
    <li
      className="flex items-center gap-2 text-sm text-foreground"
      data-testid="required-dependency-row"
      data-relationship={row.relationship}
    >
      <span className="text-muted-foreground" aria-hidden>
        {extensionKindEmblem(emblemKind(row.kind), "size-4")}
      </span>
      <code className="font-mono">{row.packageName}</code>
      <span className="text-xs text-muted-foreground">{row.constraint}</span>
    </li>
  );
}

/**
 * Render the requires surface for one package. Returns null when the package
 * declares no dependency edges at all (no empty pane). Driven entirely by the
 * REAL manifest edges the caller parsed.
 */
export function RequiredDependenciesSection({
  summary,
}: {
  summary: RequiredDependenciesSummary;
}) {
  if (!summary.hasAny) return null;

  return (
    <section className="soft-panel rounded-card px-6 py-5" data-testid="required-dependencies-section">
      <h2 className="text-sm font-semibold text-foreground mb-1 flex items-center gap-2">
        <PackagePlusIcon className="size-4 text-muted-foreground" aria-hidden />
        Requires
      </h2>

      {summary.autoInstalled.length > 0 && (
        <div className="mt-3">
          <p className="text-xs text-muted-foreground mb-2">
            Installing this also installs its required dependencies automatically:
          </p>
          <ul className="flex flex-col gap-1.5">
            {summary.autoInstalled.map((row) => (
              <DependencyRow key={row.packageName} row={row} />
            ))}
          </ul>
        </div>
      )}

      {summary.peer.length > 0 && (
        <div className="mt-4">
          <p className="text-xs text-muted-foreground mb-2 flex items-center gap-2">
            Expects these to be installed separately (not installed for you):
            <Badge variant="outline" className="rounded-chip">
              peer
            </Badge>
          </p>
          <ul className="flex flex-col gap-1.5">
            {summary.peer.map((row) => (
              <DependencyRow key={row.packageName} row={row} />
            ))}
          </ul>
        </div>
      )}

      {summary.optional.length > 0 && (
        <div className="mt-4">
          <p className="text-xs text-muted-foreground mb-2 flex items-center gap-2">
            Works without these, with reduced capability:
            <Badge variant="outline" className="rounded-chip">
              optional
            </Badge>
          </p>
          <ul className="flex flex-col gap-1.5">
            {summary.optional.map((row) => (
              <DependencyRow key={row.packageName} row={row} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
