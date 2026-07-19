import "server-only";
/**
 * Type definitions inventory — the data source for the Artifacts console's
 * Type definitions tab (cinatra#1786, spec design@923fa0d8 §IV; epic #1785).
 *
 * The Type definitions tab is the GLOBAL type registry: every type every
 * installed artifact extension defines, alphabetical across all extensions —
 * one workspace-wide registry, never scoped to a single extension. A type
 * exists only because an installed artifact extension DEFINES it (exactly one
 * definer per type, epic #1785), and any extension that needs it declares the
 * definer as a DEPENDENCY. Each row therefore names:
 *   - Type      — the display name (humanized local part of the type id, per
 *                 the issue's ratified derivation) over the raw type id;
 *   - Defined by — the one defining extension (its humanized package label);
 *   - Used by    — the installed extensions that declared the definer as a
 *                 dependency (humanized labels, alphabetical), or none.
 *
 * The provenance comes from TWO already-landed surfaces, never a new backend:
 * the process-global object-type registry's `definerOf` provenance getter
 * (which package defined each type), and the installed-extension canonical
 * store's declared dependency edges (which extensions depend on that definer).
 * The derivation is a PURE reshape (`deriveTypeDefinitionRows`) so it is
 * unit-testable without a registry or a DB; the server loader only gathers the
 * two inputs. Read-only inventory — record inspection only, no mutation.
 */
import type { ExtensionDependency } from "@cinatra-ai/extensions/canonical-types";

// ---------------------------------------------------------------------------
// Presentation helpers (pure)
// ---------------------------------------------------------------------------

/**
 * The Type column display name: the humanized LOCAL PART of the type id (the
 * segment after the `:` namespace separator), per the ratified derivation
 * (issue #1786 — "humanized local part, e.g. 'Case' from `@acme/support:case`").
 * Separators become spaces and the first letter is capitalized (sentence case):
 * `@acme/support:case` → "Case", `@cinatra-ai/email:draft` → "Draft",
 * `@x/y:post-draft` → "Post draft".
 */
export function humanizeTypeLocalPart(typeId: string): string {
  const local = typeId.includes(":")
    ? typeId.slice(typeId.lastIndexOf(":") + 1)
    : typeId;
  const spaced = local.replace(/[-_]+/g, " ").trim();
  if (!spaced) return typeId;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The extension label for the Defined by / Used by columns: the humanized
 * package name (scope stripped, per-word title-cased) — the SAME derivation the
 * library surface renders for its extension labels. `@cinatra-ai/email` →
 * "Email", `@cinatra-ai/prospect-lists` → "Prospect Lists". A version/local
 * suffix (`:local`, `@1.2.0`) is dropped before humanizing.
 */
export function humanizeExtensionPackage(packageName: string): string {
  const afterScope = packageName.includes("/")
    ? packageName.slice(packageName.indexOf("/") + 1)
    : packageName;
  const base = afterScope.split(":")[0]?.split("@")[0] ?? afterScope;
  const words = base.split(/[-_]+/).filter(Boolean);
  if (words.length === 0) return packageName;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// ---------------------------------------------------------------------------
// Row model + pure derivation
// ---------------------------------------------------------------------------

/** One row of the Type definitions tab. */
export type TypeDefinitionRow = {
  typeId: string;
  /** Humanized local part — the primary label. */
  displayName: string;
  /** The defining package (raw), or null for a provenance-less host built-in. */
  definedByPackage: string | null;
  /** The defining extension's humanized label ("—" when provenance-less). */
  definedByLabel: string;
  /** Humanized labels of the installed extensions that depend on the definer. */
  usedByLabels: string[];
};

export type DeriveTypeDefinitionsInput = {
  /** Every artifact type the registry knows, with its defining package. */
  types: ReadonlyArray<{ typeId: string; definer: string | null }>;
  /** Installed extensions with their declared dependency edges. */
  installed: ReadonlyArray<{
    packageName: string;
    dependencies: readonly Pick<ExtensionDependency, "packageName">[];
  }>;
};

/**
 * PURE reshape: fold the registry's type→definer provenance and the installed
 * extensions' dependency edges into the alphabetical Type definitions rows.
 *
 * "Used by" for a type defined by package P = every installed extension (other
 * than P itself) whose manifest declares an edge on P. Deduplicated + humanized
 * + alphabetically ordered so the surface is stable. Rows are ordered by
 * display name (then type id, to break ties deterministically).
 */
export function deriveTypeDefinitionRows(
  input: DeriveTypeDefinitionsInput,
): TypeDefinitionRow[] {
  // Index: definer package → the set of installed packages that depend on it.
  const dependentsByDefiner = new Map<string, Set<string>>();
  for (const ext of input.installed) {
    for (const dep of ext.dependencies) {
      if (dep.packageName === ext.packageName) continue; // never self
      let set = dependentsByDefiner.get(dep.packageName);
      if (!set) {
        set = new Set<string>();
        dependentsByDefiner.set(dep.packageName, set);
      }
      set.add(ext.packageName);
    }
  }

  const rows: TypeDefinitionRow[] = input.types.map(({ typeId, definer }) => {
    const dependents = definer ? dependentsByDefiner.get(definer) : undefined;
    const usedByLabels = dependents
      ? Array.from(dependents)
          .map(humanizeExtensionPackage)
          .sort((a, b) => a.localeCompare(b))
      : [];
    return {
      typeId,
      displayName: humanizeTypeLocalPart(typeId),
      definedByPackage: definer,
      definedByLabel: definer ? humanizeExtensionPackage(definer) : "—",
      usedByLabels,
    };
  });

  rows.sort(
    (a, b) =>
      a.displayName.localeCompare(b.displayName) ||
      a.typeId.localeCompare(b.typeId),
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Server loader — gathers the two real inputs
// ---------------------------------------------------------------------------

/**
 * Load the Type definitions rows from the live surfaces: the object-type
 * registry (every artifact type + its defining package) and the installed
 * extensions' declared dependency edges. Alphabetical across all extensions.
 *
 * `organizationId` scopes the installed-extension read to the acting org (plus
 * the platform-owned NULL-org rows are read separately and merged) so "Used by"
 * reflects what is actually installed for this workspace.
 */
export async function loadTypeDefinitionRows(
  organizationId: string | null,
): Promise<TypeDefinitionRow[]> {
  const [{ objectTypeRegistry }, { listInstalledExtensions }] = await Promise.all([
    import("@cinatra-ai/objects"),
    import("@cinatra-ai/extensions/canonical-store"),
  ]);

  const types = objectTypeRegistry.listArtifacts().map((def) => ({
    typeId: def.type,
    definer: objectTypeRegistry.definerOf(def.type),
  }));

  // Installed extensions for this org PLUS the platform-owned (NULL-org) rows —
  // both can define artifact types / declare dependencies for the workspace.
  const [orgRows, platformRows] = await Promise.all([
    organizationId !== null
      ? listInstalledExtensions({ organizationId })
      : Promise.resolve([]),
    listInstalledExtensions({ organizationId: null }),
  ]);
  const byPackage = new Map<
    string,
    { packageName: string; dependencies: readonly Pick<ExtensionDependency, "packageName">[] }
  >();
  for (const ext of [...platformRows, ...orgRows]) {
    // De-dup on package name; the org row (last write) wins over a platform row.
    byPackage.set(ext.packageName, {
      packageName: ext.packageName,
      dependencies: ext.dependencies ?? [],
    });
  }

  return deriveTypeDefinitionRows({
    types,
    installed: Array.from(byPackage.values()),
  });
}
