// ---------------------------------------------------------------------------
// installed-extensions-list / installed-extensions-filter conformance fixture
// (cinatra#986).
//
// LIVE-DB data path (the cinatra#986 mandate — never weakened to static
// fixtures): the rows below are read through the REAL canonical
// `listInstalledExtensions()` store read from the ephemeral CI Postgres,
// where ../seed/route.ts provisioned them through the REAL lifecycle
// primitive. The kind / lifecycle-status / version / CARDINALITY bindings all
// come from the live rows; the status filter is the REAL URL-driven
// server-side mechanism (ExtensionsTabSelect writes ?tab=, this server
// component re-renders from it — exactly like RegistryCatalogScreen).
//
// Substitutions, documented per the #985 doctrine (only the bound
// non-data machinery is substituted):
//   - session/actor visibility scoping (requireAuthSession +
//     resolveExtensionDiscoveryContext) is bypassed — the harness route is
//     CI-only and the namespace filter scopes rows instead; visibility is
//     auth, not a data binding under conformance.
//   - display hydration (displayName/description/vendor) maps from the seed
//     kit: the real screen hydrates these from per-kind native descriptors
//     (build-time catalogs/registries), which are code, not seedable data.
//     The §VI card presentation itself is the REAL InstalledExtensionCard.
// ---------------------------------------------------------------------------

import { listInstalledExtensions } from "@cinatra-ai/extensions/canonical-store";
import type { InstalledExtension } from "@cinatra-ai/extensions/canonical-types";
import {
  ActiveEmptyState,
  AllEmptyState,
  ArchivedEmptyState,
  LockedEmptyState,
} from "@cinatra-ai/extensions/screens/installed-empty-states";

import { Button } from "@/components/ui/button";
import { Toolbar, ToolbarGroup } from "@/components/ui/toolbar";
import { ExtensionsTabSelect } from "@/components/extensions/extensions-tab-select";
import type { InstalledTabValue } from "@/components/extensions/installed-tab-model";
import {
  InstalledExtensionCard,
  InstalledStatusIndicator,
} from "@/components/extensions/installed-extension-card";
import {
  extensionKindEmblem,
  type ExtensionEmblemKind,
} from "@/components/extension-kind-emblem";
import { deriveExtensionAccent } from "@/lib/extension-accent";
import { resolveVendorPresentation } from "@/lib/vendor-presentation";

import {
  SEEDED_INSTALLED_EXTENSIONS,
  seededPackagePrefix,
  type SeededInstalledExtension,
} from "../seed-data";

/** Stable render order — mirrors RegistryCatalogScreen's KIND_ORDER + name sort. */
const KIND_ORDER = ["agent", "skill", "connector", "artifact"] as const;

function seedFor(runId: string, row: InstalledExtension): SeededInstalledExtension | null {
  const base = row.packageName.slice(seededPackagePrefix(runId).length);
  return SEEDED_INSTALLED_EXTENSIONS.find((seed) => seed.base === base) ?? null;
}

function sortRows(rows: InstalledExtension[], runId: string): InstalledExtension[] {
  return [...rows].sort((a, b) => {
    const kindDelta =
      KIND_ORDER.indexOf(a.kind as (typeof KIND_ORDER)[number]) -
      KIND_ORDER.indexOf(b.kind as (typeof KIND_ORDER)[number]);
    if (kindDelta !== 0) return kindDelta;
    const nameA = seedFor(runId, a)?.displayName ?? a.packageName;
    const nameB = seedFor(runId, b)?.displayName ?? b.packageName;
    return nameA.localeCompare(nameB);
  });
}

function renderCard(runId: string, row: InstalledExtension, isArchived: boolean) {
  const seed = seedFor(runId, row);
  const version = row.source.type === "verdaccio" ? `v${row.source.version}` : null;
  return (
    <InstalledExtensionCard
      key={row.id}
      name={seed?.displayName ?? row.packageName}
      accentColor={deriveExtensionAccent(row.packageName)}
      emblem={extensionKindEmblem(row.kind as ExtensionEmblemKind)}
      kindIcon={extensionKindEmblem(row.kind as ExtensionEmblemKind, "size-3.5")}
      kindLabel={seed?.kindLabel ?? row.kind}
      vendor={resolveVendorPresentation(
        { name: seed?.vendor },
        { surface: "installed-extensions-fixture", ref: row.packageName },
      )}
      description={seed?.description ?? null}
      version={version}
      status={<InstalledStatusIndicator status={row.status} />}
      actions={
        <>
          <Button
            size="sm"
            variant={isArchived ? "secondary" : "default"}
            className={isArchived ? "text-muted-foreground" : undefined}
            disabled
            title="Seeded harness — Settings targets are covered on the real screen"
          >
            Settings
          </Button>
          <Button type="button" variant={isArchived ? "ghost" : "link"} size="sm">
            More details
          </Button>
        </>
      }
      archived={isArchived}
    />
  );
}

export async function InstalledExtensionsFixture({
  runId,
  tab,
}: {
  runId: string;
  tab: InstalledTabValue;
}) {
  let allRows: InstalledExtension[];
  try {
    allRows = await listInstalledExtensions();
  } catch (err) {
    // No reachable canonical store (e.g. a local `pnpm dev` without a DB).
    // Render an explicit, assert-distinct failure panel so the DB-backed
    // surfaces fail with a diagnosable reason while the dataless surfaces on
    // this page keep working.
    return (
      <div
        data-testid="installed-extensions-store-unreachable"
        className="soft-panel rounded-card p-6 text-sm text-muted-foreground"
      >
        canonical installed_extension store unreachable:{" "}
        {err instanceof Error ? err.message : String(err)}
      </div>
    );
  }

  const prefix = seededPackagePrefix(runId);
  const namespaceRows = allRows.filter((row) => row.packageName.startsWith(prefix));
  // Clean status partition (cinatra#1571): All = any status; Locked/Archived =
  // exactly that status; Active = truly-active only (locked rows now have their
  // OWN view). Mirrors RegistryCatalogScreen's partition against the live rows.
  const rows = sortRows(
    namespaceRows.filter((row) =>
      tab === "all"
        ? true
        : tab === "locked"
          ? row.status === "locked"
          : tab === "archived"
            ? row.status === "archived"
            : row.status === "active",
    ),
    runId,
  );

  // A second, ALWAYS-EMPTY namespace ("<runId>-none" is never provisioned)
  // drives the surface's `empty` state variant through the same read path.
  const emptyNamespaceRows = allRows.filter((row) =>
    row.packageName.startsWith(seededPackagePrefix(`${runId}-none`)),
  );

  return (
    <div className="flex flex-col gap-6">
      <div data-surface-id="installed-extensions-filter">
        <Toolbar aria-label="Extensions filters">
          <ToolbarGroup>
            {/* The REAL URL-driven status filter control; basePath keeps the
                run namespace in the URL it pushes. */}
            <ExtensionsTabSelect
              value={tab}
              basePath={`/design-fixtures/conformance/seeded?run=${runId}`}
            />
          </ToolbarGroup>
        </Toolbar>
      </div>

      <div data-surface-id="installed-extensions-list" data-variant="populated" data-tab={tab}>
        {rows.length === 0 ? (
          tab === "all" ? (
            <AllEmptyState />
          ) : tab === "locked" ? (
            <LockedEmptyState />
          ) : tab === "archived" ? (
            <ArchivedEmptyState />
          ) : (
            <ActiveEmptyState />
          )
        ) : (
          <div className="grid gap-3">
            {/* isArchived is per-row (row.status) so the mixed All view greys
                only its archived rows. */}
            {rows.map((row) => renderCard(runId, row, row.status === "archived"))}
          </div>
        )}
      </div>

      <div data-surface-id="installed-extensions-list" data-variant="empty">
        {emptyNamespaceRows.length === 0 ? (
          <ActiveEmptyState />
        ) : (
          <div className="grid gap-3">
            {emptyNamespaceRows.map((row) => renderCard(runId, row, false))}
          </div>
        )}
      </div>
    </div>
  );
}
