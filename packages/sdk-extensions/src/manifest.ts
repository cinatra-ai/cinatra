// Per-extension manifest field schema.
//
// STATUS: ABI FROZEN.
//
// These fields live under the `cinatra` key of an extension's package.json.
// `kind`, `apiVersion`, and the dependency fields already ship today; the
// loader/ABI fields below are additive (`serverEntry`, `configSchema`,
// `requestedHostPorts`, `sdkAbiRange`, `migrations`, `uiSurface`).

import type { HostPortName } from "./host-context";
import type { ExtensionDependency } from "./dependencies";

/**
 * UI hot-pluggability classification:
 *  - `schema-config`: the extension declares its config as DATA; the host
 *    renders a generic schema-driven form → hot-pluggable.
 *  - `bundled-react`: bespoke custom setup-page React → NOT hot-pluggable under
 *    App Router (RSC client chunks are build-known); ships in the base image.
 */
export const UI_SURFACE_KINDS = ["schema-config", "bundled-react"] as const;
export type UiSurfaceKind = (typeof UI_SURFACE_KINDS)[number];

/** A declarative, idempotent, extension-owned migration descriptor. */
export type ExtensionMigration = {
  id: string;
  /** Path (within the package) to the migration's declarative spec. */
  path: string;
};

/** The `cinatra` manifest block (additive fields marked). */
export type CinatraManifest = {
  apiVersion: string;
  kind: "agent" | "connector" | "artifact" | "skill" | "workflow";

  // ---- loader / ABI fields (additive) ----
  /** Compiled server entry the loaders dynamically import (`./register`). */
  serverEntry?: string;
  /** JSON-schema describing schema-config UI fields (when uiSurface=schema-config). */
  configSchema?: Record<string, unknown>;
  /** Least-privilege host ports this extension requests (admin-approved). */
  requestedHostPorts?: HostPortName[];
  /** SDK ABI compatibility range this extension was built against. */
  sdkAbiRange?: string;
  /** Declarative extension-owned migrations. */
  migrations?: ExtensionMigration[];
  // ---- self-describing card identity (additive) ----
  /** User-facing card label. Falls back to the host catalog when absent. */
  displayName?: string;
  /**
   * Package-relative path to a small SVG logo asset (e.g. `./logo.svg`). The
   * host's manifest generator sanitizes + inlines it as a bounded data URI;
   * falls back to the host icon map when absent or invalid.
   */
  logo?: string;
  /**
   * Path (within the package, recommended `cinatra/dev-fixtures.json`) to a
   * DECLARATIVE dev-mode fixtures file — demo/sample data the host's dev-only
   * seeder applies into the extension's own `ctx.objects`/`ctx.settings` so a
   * freshly-installed extension is visible on a dev boot. Declarative data only
   * (no SQL/JS/seed function); see `parseDevFixtures` in `./dev-fixtures`.
   */
  devFixtures?: string;
  /** UI hot-pluggability classification. */
  uiSurface?: UiSurfaceKind;
  /**
   * External-MCP-toolbox capability marker. `true` declares that this
   * extension contributes EXTERNAL MCP server tools to the LLM toolbox
   * injection path (`buildExternalMcpServerTools`): the host selects
   * manifest records carrying this marker instead of name-listing
   * extensions. Distinct from `hasMcpModule` (self-MCP capability modules
   * registered on the cinatra MCP server), which is NOT a discriminating
   * external-MCP selector.
   */
  providesExternalMcpToolbox?: boolean;

  // ---- dependency graph (canonical) ----
  /** Canonical cross-kind dependency edges. */
  dependencies?: ExtensionDependency[];

  // ---- legacy dependency shims (normalized into `dependencies`) ----
  /** @deprecated agent→agent map; normalized into `dependencies`. */
  agentDependencies?: Record<string, string>;
  /** @deprecated unused today; normalized into `dependencies`. */
  connectorDependencies?: Record<string, string>;
};

/**
 * The normalized record BOTH loaders produce: the
 * `StaticBundleLoader` (build-time generated manifest) and the future
 * `RuntimePackageLoader` (verified package store) must emit identical records
 * so they cannot drift. This is the metadata + entry-point shape — the loaded
 * `ExtensionModule` (see `register.ts`) is resolved FROM it.
 */
export type NormalizedExtensionRecord = {
  packageName: string;
  scope: string;
  kind: CinatraManifest["kind"];
  version: string | null;
  /** Repo-relative dir in dev; package-store path in prod. */
  sourceDir: string;
  /** Compiled server entry the loader dynamically imports (`./register`). */
  serverEntry: string | null;
  hasOas: boolean;
  hasMcpModule: boolean;
  hasSetupPage: boolean;
  hasSettingsPage: boolean;
  uiSurface: UiSurfaceKind | null;
  /**
   * The declared `cinatra.configSchema` for a `schema-config` connector — the
   * DATA the host renders its setup surface from (model B: no React shipped).
   * Carried on the record so a `schema-config` connector is dispatchable from
   * the static manifest path. `null` for `bundled-react`/no-UI extensions.
   *
   * REQUIRED (must be present, value `Record<string, unknown> | null`) so both
   * loaders emit it on EVERY record and the static manifest type cannot silently
   * drop it — the generator emits `null` (or the parsed schema) for each record.
   */
  configSchema: Record<string, unknown> | null;
  /** Least-privilege host ports (derived/declared; empty until mapped). */
  requestedHostPorts: HostPortName[];
  /**
   * External-MCP-toolbox capability marker (`cinatra.providesExternalMcpToolbox`).
   *
   * REQUIRED (always present, boolean) so both loaders emit it on EVERY record
   * and the static manifest type cannot silently drop it — the generator emits
   * `false` unless the extension declares `true`. The LLM toolbox-injection
   * path selects records by this field; toggling it (or
   * installing/uninstalling the extension) is what changes injection.
   */
  providesExternalMcpToolbox: boolean;
  /**
   * SDK ABI range the extension was built against (`cinatra.sdkAbiRange`), or
   * null when unpinned. The loader's ABI gate consults this (the host computes
   * the compat verdict from it); the field MUST round-trip through both loaders
   * or the gate has nothing to check.
   */
  sdkAbiRange: string | null;
  /** Canonical cross-kind dependency edges (`cinatra.dependencies`; [] when none). */
  dependencies: ExtensionDependency[];
  /**
   * Self-describing card identity. `displayName` is the user-facing
   * label (`cinatra.displayName`); `logo` is a sanitized inline SVG data URI
   * built from the package's `cinatra.logo` asset at manifest-generation time
   * (bounded + script/event/external-ref-stripped). Both null when the package
   * declares neither — the host falls back to its static catalog/icon map. Lets a
   * connector render its own card without a host catalog edit.
   */
  displayName: string | null;
  logo: string | null;
};

export function isUiSurfaceKind(value: unknown): value is UiSurfaceKind {
  return typeof value === "string" && (UI_SURFACE_KINDS as readonly string[]).includes(value);
}
