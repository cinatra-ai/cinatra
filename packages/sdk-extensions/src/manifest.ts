// Per-extension manifest field schema.
//
// STATUS: ABI FROZEN.
//
// These fields live under the `cinatra` key of an extension's package.json.
// `kind`, `apiVersion`, and the dependency fields already ship today; the
// loader/ABI fields below are additive (`serverEntry`, `configSchema`,
// `requestedHostPorts`, `sdkAbiRange`, `migrationsDir`, `uiSurface`).

import type { HostPortName } from "./host-context";
import type { ExtensionDependency } from "./dependencies";
import type { ConsumedPrimitive } from "./consumes";

/**
 * UI hot-pluggability classification (narrowed per cinatra#782 — the connector
 * itself hot-installs + server-activates in BOTH cases; this classifies only the
 * CONFIG UI surface):
 *  - `schema-config`: the extension declares its config as DATA; the host renders
 *    a generic schema-driven form from that data → the config UI is fully
 *    hot-configurable at runtime (no rebuild).
 *  - `bundled-react`: the extension ships a bespoke custom setup-page React
 *    component. Only that custom config PAGE is base-image-bound — its RSC client
 *    chunks are build-known, so it resolves solely from the base image and the
 *    installer surfaces a "requires rebuild" state for it (see
 *    `requiresRebuildState`). The connector still hot-installs + activates.
 */
export const UI_SURFACE_KINDS = ["schema-config", "bundled-react"] as const;
export type UiSurfaceKind = (typeof UI_SURFACE_KINDS)[number];

/**
 * Generator-owned presence classification (cinatra#7) — assigned by
 * `scripts/extensions/generate-extension-manifest.mjs` on every emitted record
 * and loader-map entry, never inferred from source shape:
 *
 *  - `"required"`       — member of the host-owned `cinatra.systemExtensions`
 *    locked set (root package.json). Its generated loaders import UNGUARDED:
 *    absence fails loudly (build error / thrown import), exactly like today.
 *    Deliberately keyed on `systemExtensions`, NOT on
 *    `cinatra.requiredExtensions` (the prod-acquisition bootable set) — keying
 *    on the acquisition set would be circular for the planned
 *    33→systemExtensions shrink (cinatra#7).
 *  - `"guardedOptional"` — every other extension. Its generated loaders route
 *    through the standardized degraded-result guard
 *    (`src/lib/extension-load-guard.ts`): post-build absence of the target
 *    module resolves to a degraded `absent` result the consuming surface
 *    degrades on per entry (never a crashed aggregate surface).
 *
 * Downstream gates MUST key on this classification only and treat a missing
 * or unknown value as `"required"` (fail-closed).
 */
export const EXTENSION_RESOLUTIONS = ["required", "guardedOptional"] as const;
export type ExtensionResolution = (typeof EXTENSION_RESOLUTIONS)[number];

/**
 * Self-declared connector vendor identity (#12 connector vendor-identity
 * end-state; vendor identity is self-declared per the nango-system-contract ruling).
 *
 * Vendor identity lives WITH the connector — a `kind:"connector"` extension
 * declares its own vendor key + display name here, in its own manifest. The SDK
 * owns NO authoritative vendor roster (Cinatra is an open connector
 * marketplace); the `key` is the OPEN `ConnectorVendorKey` SHAPE (any string,
 * not a frozen union). Authoritative validation — key SHAPE conformance,
 * name/key ownership + uniqueness across the catalog, and provider mapping —
 * is performed at the MARKETPLACE PUBLISH GATE (the Cinatra marketplace
 * service), never in the SDK and never at the host loader (which has no
 * cross-connector roster to check against).
 */
export type ConnectorVendorIdentity = {
  /**
   * The connector's vendor key — the OPEN `ConnectorVendorKey` shape (any
   * non-empty string, e.g. `"github"`, `"acme-crm"`). NOT validated against an
   * SDK roster; the publish gate owns uniqueness + ownership.
   */
  key: string;
  /** User-facing vendor display name (e.g. `"GitHub"`, `"Acme CRM"`). */
  name: string;
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
  /**
   * RETIRED (#118): the legacy declarative JSON-DSL migration descriptors.
   * Declaring `cinatra.migrations` is rejected fail-closed at install
   * preflight, boot, and hot-activate — use `migrationsDir`.
   */
  migrations?: never;
  /**
   * Package-relative directory of STANDARD node-pg-migrate migration modules
   * (`ext_<scope>_<pkg>__NNNN_<short-description>.mjs`, ESM `up(pgm)`/`down(pgm)`).
   * The HOST runs them — only for `trusted-signed` installs — through the shared
   * runner into the shared `pgmigrations` ledger (#115/#118).
   */
  migrationsDir?: string;
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
  /**
   * Self-declared connector vendor identity (#12). A `kind:"connector"`
   * extension declares its OWN vendor key + name here — the SDK owns no vendor
   * roster (open marketplace). The marketplace publish gate (separate repo)
   * verifies shape, name/key ownership + uniqueness, and provider mapping;
   * the host loader carries it through unvalidated. Absent for non-connector
   * kinds and for connectors that have not yet adopted self-declared identity.
   */
  vendor?: ConnectorVendorIdentity;
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

  /**
   * Structured declared-CONSUMED primitives (engineering#422). The machine-
   * readable used-primitive set the closure VALIDATOR resolves (primitive →
   * owning package via the ownership registry) and diffs against
   * `dependencies` to catch UNDER-declaration — an extension that uses a
   * cross-extension primitive it never declared an edge for. Additive; absent
   * means "not yet adopted" (the validator falls back to no structured-usage
   * signal for that package, never an under-declaration claim). See
   * `./consumes`.
   */
  consumes?: ConsumedPrimitive[];

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
  /**
   * Self-declared connector vendor identity (`cinatra.vendor`, #12), or null
   * when the package declares none (non-connector kinds, or connectors that
   * have not adopted self-declared identity). OPTIONAL on the type (the record
   * shape is ABI-frozen, so the field is strictly additive); the manifest
   * generator emits it on every record (`null` when absent). The SDK/host carry
   * it through UNVALIDATED — vendor-identity validation (shape, name/key
   * ownership + uniqueness, provider mapping) is the marketplace publish gate's
   * job (separate repo), not the loader's.
   */
  vendor?: ConnectorVendorIdentity | null;
  /**
   * Generator-owned presence classification (see `ExtensionResolution`).
   * OPTIONAL on the type (the record shape is ABI-frozen, so the field is
   * strictly additive); the manifest generator emits it on EVERY record.
   * Consumers and downstream gates MUST treat a missing or unknown value as
   * `"required"` (fail-closed).
   */
  resolution?: ExtensionResolution;
};

export function isUiSurfaceKind(value: unknown): value is UiSurfaceKind {
  return typeof value === "string" && (UI_SURFACE_KINDS as readonly string[]).includes(value);
}
