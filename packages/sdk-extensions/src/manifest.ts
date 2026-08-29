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
import type { DashboardContributionManifest } from "./dashboard-contribution-contract";

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
 * Self-declared vendor identity (#12 connector vendor-identity end-state;
 * vendor identity is self-declared per the nango-system-contract ruling).
 *
 * Vendor identity lives WITH the extension — a `kind:"connector"` extension
 * declares its own vendor key + display name here, in its own manifest, and a
 * `kind:"artifact"` extension may declare the same shape for its installed-card
 * byline (see `cinatra.vendor` on `CinatraManifest`). The SDK owns NO
 * authoritative vendor roster (Cinatra is an open connector marketplace); the
 * `key` is the OPEN `ConnectorVendorKey` SHAPE (any string, not a frozen
 * union). Authoritative validation — key SHAPE conformance, name/key ownership
 * + uniqueness across the catalog, and provider mapping — is performed at the
 * MARKETPLACE PUBLISH GATE (the Cinatra marketplace service), never in the SDK
 * and never at the host loader (which has no cross-vendor roster to check
 * against).
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
  kind: "agent" | "connector" | "artifact" | "skill";

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
  /**
   * The tables this extension OWNS (cinatra#3031, epic #3023 W7; plan (C)
   * enablers 0.23/0.24) — name, columns, indexes and the organisation column.
   *
   * The HOST creates them, not the migration: at install the declaration is
   * compiled into CREATE TABLE / CREATE INDEX under the derived prefix
   * `ext_<scope>_<slug>_` and granted to a database role of the extension's
   * own, so `migrationsDir` ships DATA migrations only and a statement that
   * touches another table, another extension's table or the ledger is refused
   * by the database itself. A declaration that breaks the 63-byte identifier
   * limit, names a column type outside the closed vocabulary, or omits its
   * organisation column is refused at install PREFLIGHT, before anything runs.
   * See `./declared-tables`.
   */
  declaredTables?: DeclaredTableDeclaration[];
  // ---- self-describing card identity (additive) ----
  /** User-facing card label. Falls back to the host catalog when absent. */
  displayName?: string;
  /**
   * Package-relative path to a small SVG logo asset (e.g. `./logo.svg`). The
   * host's manifest generator sanitizes + inlines it as a bounded data URI;
   * falls back to the host icon map when absent.
   *
   * CROSS-KIND (cinatra#2469, maintainer decision 2026-08-06: "every extension
   * kind must be able to self-define `cinatra.logo`"). It is not a connector
   * key: the generator's gate + emission and the host card chain have always
   * been kind-agnostic, and the artifact kind's closed allowlist
   * (`ARTIFACT_ALLOWED_CINATRA_KEYS` in `./artifact-contract`) now admits it
   * too — the same reconciliation `displayName` and `vendor` already had.
   *
   * FAIL-CLOSED, not best-effort: DECLARING a logo that does not resolve to a
   * readable, in-package, symlink-contained `.svg` the SVG sanitizer accepts is
   * a BUILD ERROR with a named reason (`validateDeclaredLogo`), for every kind
   * — it never degrades silently to the fallback chain. NOT declaring one is
   * the documented default and stays completely clean.
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
   * Package-relative path to an IMPERATIVE dev-mode provisioning hook module
   * (recommended `./src/dev-setup`) exposing `runDevSetup(ctx)` — see
   * `ExtensionDevSetupModule` in `./dev-setup`. On a dev boot the host's
   * dev-only orchestration shell imports + invokes it IDEMPOTENTLY to wire the
   * connector's OWN local docker fixture (mint a credential, register an
   * instance row, push a widget config) through host services resolved on the
   * hook context — core owns the shell, the connector owns its provisioning.
   * Dev-only, localhost-only, soft-fail; NOT part of the frozen `register(ctx)`
   * ABI. Distinct from `devFixtures` (DECLARATIVE data). cinatra#976 (epic #978
   * wave W-D).
   */
  devSetup?: string;
  /**
   * Self-declared vendor identity (#12). A `kind:"connector"` extension
   * declares its OWN vendor key + name here — the SDK owns no vendor roster
   * (open marketplace). The marketplace publish gate (separate repo) verifies
   * shape, name/key ownership + uniqueness, and provider mapping; the host
   * loader carries it through unvalidated.
   *
   * PRESENTATION-metadata, not connector-only: the installed-card byline
   * (`{Kind} by {Vendor}`, cinatra#948 §VI / #1570) reads `vendor.name`
   * kind-agnostically, so a `kind:"artifact"` extension may also declare it
   * to render its byline (the artifact allowlist admits `vendor` for exactly
   * this reason — see `ARTIFACT_ALLOWED_CINATRA_KEYS` in `./artifact-contract`).
   * Absent for extensions that have not adopted self-declared identity.
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

  /**
   * Manifest-declared env-override layer (cinatra#982): a map from a
   * process-environment variable NAME the host process reads to the
   * settings/secrets KEY it overrides — e.g.
   * `{"NANGO_SERVER_URL": "settings:serverUrl", "NANGO_SECRET_KEY": "secrets:secretKey"}`.
   * The HOST's `settings`/`secrets` port implementation serves this key
   * env-first-else-DB. Core stays vendor-free: the env-var NAMES live here, in
   * the extension's own manifest, never in core.
   *
   * SECURITY GUARD (validated host-side by `./env-overrides`, never trusted
   * unvalidated): a marketplace extension may claim only a NAMESPACED env key
   * (`CINATRA_EXT_<PKG>_*`, derived from its own package name); a legacy
   * (non-namespaced) name is honored only for a `resolution: "required"`
   * system extension. Carried UNVALIDATED as DATA on the generated record —
   * see `NormalizedExtensionRecord.envOverrides`.
   */
  envOverrides?: Record<string, string>;

  /**
   * Versioned dashboard-contribution claim (cinatra#1628, S11a; re-homed to the
   * artifact kind by cinatra#1896 / epic #1883). Authored on `kind:"artifact"`
   * ONLY — the sole carrier that re-homes extension-shipped dashboards off the
   * removed `kind:"workflow"` install path (the `agent` carrier the claim first
   * landed on is retired). A meaning pack that ships a ready-made dashboard is an
   * artifact extension (a required dep on the generic `@cinatra-ai/dashboard-artifact`
   * base + its own type claim). IDENTITY + versioning + adoption; the dashboard
   * CONTENT stays in the existing `cinatra/dashboard.json` sidecar. Carried
   * through UNVALIDATED as DATA (the same discipline as `accessConfig`/`envOverrides`);
   * the host validates it fail-closed + field-tolerantly via
   * `parseDashboardContribution` (the sdk-extensions leaf) at consumption — see
   * `NormalizedExtensionRecord.dashboardContribution`. (`dashboardContribution` is
   * admitted into `ARTIFACT_ALLOWED_CINATRA_KEYS` so the artifact bridge does not
   * reject an artifact manifest that declares it.)
   */
  dashboardContribution?: DashboardContributionManifest;

  /**
   * Execution-plane declarations (exec-plane S3, cinatra#1708; epic #1705).
   * `execution.environment` is the L1 DECLARED ENVIRONMENT — the packages an
   * agent's runs require (see `ExecutionEnvironmentSpec` in
   * `./execution-environment`): the trusted builder turns it into an
   * immutable, content-addressed L1 layer every same-recipe run mounts.
   * AGENT-ONLY (`kind:"agent"`): any other kind's declaration is never
   * carried onto a record (see `resolveExecutionEnvironmentClaim`). Carried
   * UNVALIDATED as DATA on the generated record
   * (`NormalizedExtensionRecord.executionEnvironment`); consumers validate
   * fail-closed via `parseExecutionEnvironment` — which, unlike the
   * field-tolerant claims, REJECTS unknown keys/malformed entries outright
   * (a build recipe must never silently drop a declared package). Env edits
   * inherit the agent's existing review path (epic D8): packaged agents =
   * extension review/lock choreography.
   */
  execution?: {
    environment?: Record<string, unknown>;
  };

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
  // A NEWLY-declared/authored extension is one of the four canonical kinds
  // (`CinatraManifest["kind"]`); the kind gate + host handler reject
  // kind:"workflow" fail-closed. The normalized RECORD additionally tolerates
  // the legacy "workflow" kind ONLY so the generated static manifest can still
  // represent the two workflow dev-extensions (blog-content-workflow,
  // major-release-workflow) that remain in the dev-extension universe until
  // they are retired in #1035 Slice G. No new workflow package can enter here.
  kind: CinatraManifest["kind"] | "workflow";
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
   * Self-declared vendor identity (`cinatra.vendor`, #12), or null when the
   * package declares none (any kind that has not adopted self-declared
   * identity). Declared by connectors AND by artifacts (the installed-card
   * `{Kind} by {Vendor}` byline reads it kind-agnostically). OPTIONAL on the
   * type (the record shape is ABI-frozen, so the field is strictly additive);
   * the manifest generator emits it on every record (`null` when absent). The
   * SDK/host carry it through UNVALIDATED — vendor-identity validation (shape,
   * name/key ownership + uniqueness, provider mapping) is the marketplace
   * publish gate's job (separate repo), not the loader's.
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
  /**
   * RAW parsed `cinatra/config.json` pass-through for `kind:"connector"`
   * records (cinatra#951 — the connector access-scoping declaration), or
   * null when the package ships none / for non-connector kinds. OPTIONAL on
   * the type (strictly additive); the manifest generator emits it on EVERY
   * record. Carried UNVALIDATED as data: the host resolves + validates it
   * fail-closed through `./access-config` at registration/materialize and
   * caches the resolved declaration on the registration record — a consumer
   * must never trust this field without that validation.
   */
  accessConfig?: Record<string, unknown> | null;
  /**
   * RAW `cinatra.envOverrides` pass-through (cinatra#982), or `null` when the
   * package declares none. OPTIONAL on the type (strictly additive); the
   * manifest generator emits it on EVERY record. Carried UNVALIDATED as data —
   * the host validates it fail-closed (namespaced-vs-legacy security guard,
   * keyed on `resolution`) via `./env-overrides` at ctx-build time; a consumer
   * must never trust this field without that validation.
   */
  envOverrides?: Record<string, string> | null;
  /**
   * RAW `cinatra.dashboardContribution` pass-through (cinatra#1628, S11a; re-homed
   * to the artifact kind by cinatra#1896 / epic #1883), or `null` when the package
   * declares none / for a non-`artifact` kind (the sole allowlisted carrier — the
   * generator gates emission on `kind:"artifact"`). OPTIONAL on the type (strictly
   * additive; the record shape is ABI-frozen). Carried UNVALIDATED as data — the
   * host validates it fail-closed + field-tolerantly via `parseDashboardContribution`
   * (the sdk-extensions leaf) at consumption (the reader-gate liveness oracle + the
   * S11b reconciler); a consumer must never trust this field without that
   * validation.
   */
  dashboardContribution?: Record<string, unknown> | null;
  /**
   * RAW `cinatra.execution.environment` pass-through (exec-plane S3,
   * cinatra#1708), or `null` when the package declares none / for a
   * non-`agent` kind (the sole allowlisted carrier — see
   * `resolveExecutionEnvironmentClaim` in `./execution-environment`).
   * OPTIONAL on the type (strictly additive; the record shape is ABI-frozen);
   * the manifest generator emits it on EVERY record. Carried UNVALIDATED as
   * data — the execution plane validates it FAIL-CLOSED via
   * `parseExecutionEnvironment` before any build (unknown keys / malformed
   * entries reject the declaration outright); a consumer must never trust
   * this field without that validation. The runtime loader
   * (`recordFromManifest`) carries the same field with the same agent-kind
   * gate so both loader paths round-trip identically.
   */
  executionEnvironment?: Record<string, unknown> | null;
};

export function isUiSurfaceKind(value: unknown): value is UiSurfaceKind {
  return typeof value === "string" && (UI_SURFACE_KINDS as readonly string[]).includes(value);
}

// ===========================================================================
// EXTENSION-OWNED TABLES (cinatra#3031, epic #3023 W7; plan (C) 0.23/0.24).
//
// Here rather than in a module of its own, deliberately: plan (C) §8.1 names
// THIS file as where the declared-tables field lands, and the manifest is
// already reachable from four route-graph-ratcheted routes whose ceilings may
// only ever shrink — a sibling module would have grown all four by one for a
// contract that belongs beside the field that carries it.
// ===========================================================================
// The DECLARED-TABLES contract: what an extension owns in the database, and
// under which name (cinatra#3031, epic #3023 W7; plan (C) enablers 0.23/0.24).
//
// WHY THIS MODULE EXISTS. An extension can create a table today and cannot
// read it: `cinatra.migrationsDir` runs arbitrary statements under the host's
// own credential, the `ext_` prefix is a convention nothing derives, and the
// database's 63-byte identifier limit is checked nowhere. Enabler 0.23 makes
// the OWNERSHIP explicit — "an extension declares the tables it owns in its
// manifest — name, columns, indexes, the organisation column — and ships only
// data migrations beside them" — and enabler 0.24 makes the NAME derived once:
// "`ext_`, then the extension's scope and slug lowercased with every character
// outside letters, digits and underscore replaced by an underscore, joined and
// terminated by underscores".
//
// This module is the SDK's leaf half of that: pure derivation and pure
// validation, no database, no host import. The HOST creates the tables from
// what this module returns (`src/lib/extension-declared-tables.ts`); the
// migration never does. A declaration that breaks the identifier limit, names
// a column type outside the closed vocabulary, or omits its organisation
// column is REFUSED AT PREFLIGHT, before anything runs — a refusal here costs
// an install, a refusal later would cost a half-created schema.
//
// NO FREE SQL ANYWHERE. Column types and defaults are closed vocabularies, not
// pass-through strings: the declaration is data the host compiles into DDL, so
// admitting an arbitrary type string would admit arbitrary SQL into a CREATE
// TABLE the host executes under its own credential.

/** Enabler 0.24, call 3: the one prefix every extension-owned name carries. */
export const EXTENSION_TABLE_PREFIX = "ext_";

/**
 * PostgreSQL's identifier limit (`NAMEDATALEN - 1`). A longer name is not an
 * error in Postgres — it is silently TRUNCATED, which is worse: two declared
 * tables can collapse onto one physical table. So the limit is checked here
 * and a declaration that breaks it is refused.
 */
export const PG_IDENTIFIER_MAX_BYTES = 63;

/** The closed column-type vocabulary a declaration may name. */
export const DECLARED_COLUMN_TYPES = [
  "text",
  "uuid",
  "boolean",
  "integer",
  "bigint",
  "numeric",
  "jsonb",
  "timestamptz",
] as const;
export type DeclaredColumnType = (typeof DECLARED_COLUMN_TYPES)[number];

/** The closed default vocabulary. Anything else is free SQL and is refused. */
export const DECLARED_COLUMN_DEFAULTS = ["now()", "gen_random_uuid()", "false", "true"] as const;
export type DeclaredColumnDefault = (typeof DECLARED_COLUMN_DEFAULTS)[number];

export type DeclaredColumn = {
  name: string;
  type: DeclaredColumnType;
  notNull: boolean;
  primaryKey: boolean;
  default: DeclaredColumnDefault | null;
};

export type DeclaredIndex = {
  /** Declaration-local name; the physical name carries the prefix. */
  name: string;
  columns: string[];
  unique: boolean;
};

export type DeclaredTable = {
  /** Declaration-local name; the physical name carries the prefix. */
  name: string;
  /** The column carrying the organisation every row is bound to. */
  organizationColumn: string;
  columns: DeclaredColumn[];
  indexes: DeclaredIndex[];
};

/** A declaration-local identifier: lowercase, starts with a letter. */
const LOCAL_IDENT_RE = /^[a-z][a-z0-9_]*$/;

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The normalisation of enabler 0.24: lowercase, then every character outside
 * letters, digits and underscore becomes an underscore.
 */
export function normalizeExtensionNameSegment(segment: string): string {
  return segment.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

function splitScopedPackageName(packageName: string): { scope: string; slug: string } {
  const m = /^@([^/]+)\/([^/]+)$/.exec(String(packageName ?? ""));
  if (!m || m[1] === undefined || m[2] === undefined || m[1] === "" || m[2] === "") {
    throw new Error(
      `[declared-tables] cannot derive a table prefix for package "${packageName}" — ` +
        `extension-owned tables require a scoped package name (@scope/name)`,
    );
  }
  return { scope: m[1], slug: m[2] };
}

/**
 * Enabler 0.24's prefix, derived once: `ext_` + scope + `_` + slug + `_`.
 * `@cinatra-ai/blog-pipeline-agent` -> `ext_cinatra_ai_blog_pipeline_agent_`.
 */
export function extensionTablePrefix(packageName: string): string {
  const { scope, slug } = splitScopedPackageName(packageName);
  return `${EXTENSION_TABLE_PREFIX}${normalizeExtensionNameSegment(scope)}_${normalizeExtensionNameSegment(slug)}_`;
}

/**
 * The database role an extension's own statements run under (enabler 0.23).
 * The prefix without its terminating underscore, so the role reads as the
 * extension's name and can never collide with one of its tables.
 */
export function extensionDatabaseRoleName(packageName: string): string {
  const prefix = extensionTablePrefix(packageName);
  const role = prefix.slice(0, -1);
  if (byteLength(role) > PG_IDENTIFIER_MAX_BYTES) {
    throw new Error(
      `[declared-tables] the database role "${role}" derived for ${packageName} is ` +
        `${byteLength(role)} bytes, over PostgreSQL's ${PG_IDENTIFIER_MAX_BYTES}-byte identifier limit`,
    );
  }
  return role;
}

/** The physical table name: the prefix plus the declared name. */
export function declaredTablePhysicalName(packageName: string, tableName: string): string {
  const physical = `${extensionTablePrefix(packageName)}${tableName}`;
  assertIdentifierFits(physical, `table "${tableName}" of ${packageName}`);
  return physical;
}

/** The physical index name: the prefix plus the declared index name. */
export function declaredIndexPhysicalName(packageName: string, indexName: string): string {
  const physical = `${extensionTablePrefix(packageName)}${indexName}`;
  assertIdentifierFits(physical, `index "${indexName}" of ${packageName}`);
  return physical;
}

function assertIdentifierFits(physical: string, what: string): void {
  const bytes = byteLength(physical);
  if (bytes > PG_IDENTIFIER_MAX_BYTES) {
    throw new Error(
      `[declared-tables] the derived identifier "${physical}" for ${what} is ${bytes} bytes, ` +
        `over PostgreSQL's ${PG_IDENTIFIER_MAX_BYTES}-byte identifier limit — PostgreSQL would ` +
        `TRUNCATE it, so the declaration is refused instead`,
    );
  }
}

function parseColumn(raw: unknown, where: string): DeclaredColumn {
  if (!isPlainObject(raw)) throw new Error(`[declared-tables] ${where}: each column must be an object`);
  const name = raw.name;
  if (typeof name !== "string" || !LOCAL_IDENT_RE.test(name)) {
    throw new Error(
      `[declared-tables] ${where}: column name ${JSON.stringify(name)} must match ${LOCAL_IDENT_RE}`,
    );
  }
  // A column name carries no prefix, so it is the identifier PostgreSQL sees.
  // Two columns sharing their first 63 bytes would both TRUNCATE to the same
  // identifier and the CREATE TABLE would fail halfway through the host's own
  // DDL — the same silent truncation the table and index names are refused for.
  if (byteLength(name) > PG_IDENTIFIER_MAX_BYTES) {
    throw new Error(
      `[declared-tables] ${where}: column name "${name}" is ${byteLength(name)} bytes, over ` +
        `PostgreSQL's ${PG_IDENTIFIER_MAX_BYTES}-byte identifier limit — PostgreSQL would ` +
        `TRUNCATE it, so the declaration is refused instead`,
    );
  }
  const type = raw.type;
  if (typeof type !== "string" || !(DECLARED_COLUMN_TYPES as readonly string[]).includes(type)) {
    throw new Error(
      `[declared-tables] ${where}: column "${name}" declares type ${JSON.stringify(type)}, ` +
        `which is outside the closed vocabulary (${DECLARED_COLUMN_TYPES.join(", ")})`,
    );
  }
  const def = raw.default;
  if (def !== undefined && def !== null) {
    if (typeof def !== "string" || !(DECLARED_COLUMN_DEFAULTS as readonly string[]).includes(def)) {
      throw new Error(
        `[declared-tables] ${where}: column "${name}" declares default ${JSON.stringify(def)}, ` +
          `which is outside the closed vocabulary (${DECLARED_COLUMN_DEFAULTS.join(", ")}) — a ` +
          `declaration is data the host compiles into DDL, never free SQL`,
      );
    }
  }
  return {
    name,
    type: type as DeclaredColumnType,
    notNull: raw.notNull === true,
    primaryKey: raw.primaryKey === true,
    default: (def as DeclaredColumnDefault | undefined) ?? null,
  };
}

function parseIndex(raw: unknown, columnNames: Set<string>, where: string): DeclaredIndex {
  if (!isPlainObject(raw)) throw new Error(`[declared-tables] ${where}: each index must be an object`);
  const name = raw.name;
  if (typeof name !== "string" || !LOCAL_IDENT_RE.test(name)) {
    throw new Error(
      `[declared-tables] ${where}: index name ${JSON.stringify(name)} must match ${LOCAL_IDENT_RE}`,
    );
  }
  const columns = raw.columns;
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error(`[declared-tables] ${where}: index "${name}" must name at least one column`);
  }
  const cols: string[] = [];
  for (const c of columns) {
    if (typeof c !== "string" || !columnNames.has(c)) {
      throw new Error(
        `[declared-tables] ${where}: index "${name}" names ${JSON.stringify(c)}, which the table does not declare`,
      );
    }
    cols.push(c);
  }
  return { name, columns: cols, unique: raw.unique === true };
}

/**
 * Parse and validate `cinatra.declaredTables` for one package. Fail-closed:
 * every refusal names what broke and why, and NOTHING is created for a package
 * whose declaration does not parse.
 *
 * `undefined` (the common case — an extension that owns no table) parses to an
 * empty list, never to an error.
 */
export function parseDeclaredTables(raw: unknown, packageName: string): DeclaredTable[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`[declared-tables] ${packageName}: cinatra.declaredTables must be an array`);
  }
  // Derivation first: a package whose prefix or role cannot be derived owns no
  // namespace to put a table in, and must not reach the per-table checks.
  extensionDatabaseRoleName(packageName);

  const out: DeclaredTable[] = [];
  const seenTables = new Set<string>();
  const seenIndexes = new Set<string>();
  for (const entry of raw) {
    if (!isPlainObject(entry)) {
      throw new Error(`[declared-tables] ${packageName}: each declared table must be an object`);
    }
    const name = entry.name;
    if (typeof name !== "string" || !LOCAL_IDENT_RE.test(name)) {
      throw new Error(
        `[declared-tables] ${packageName}: table name ${JSON.stringify(name)} must match ${LOCAL_IDENT_RE}`,
      );
    }
    if (seenTables.has(name)) {
      throw new Error(`[declared-tables] ${packageName}: table "${name}" is declared twice`);
    }
    seenTables.add(name);
    const where = `${packageName} table "${name}"`;

    const rawColumns = entry.columns;
    if (!Array.isArray(rawColumns) || rawColumns.length === 0) {
      throw new Error(`[declared-tables] ${where}: must declare at least one column`);
    }
    const columns: DeclaredColumn[] = [];
    const columnNames = new Set<string>();
    for (const c of rawColumns) {
      const col = parseColumn(c, where);
      if (columnNames.has(col.name)) {
        throw new Error(`[declared-tables] ${where}: column "${col.name}" is declared twice`);
      }
      columnNames.add(col.name);
      columns.push(col);
    }

    const organizationColumn = entry.organizationColumn;
    if (typeof organizationColumn !== "string" || !columnNames.has(organizationColumn)) {
      throw new Error(
        `[declared-tables] ${where}: organizationColumn ${JSON.stringify(organizationColumn)} must name ` +
          `one of the table's own columns — every row an extension owns is bound to an organisation`,
      );
    }
    const orgCol = columns.find((c) => c.name === organizationColumn);
    if (!orgCol || orgCol.type !== "text" || !orgCol.notNull) {
      throw new Error(
        `[declared-tables] ${where}: the organisation column "${organizationColumn}" must be declared ` +
          `\`text\` and \`notNull: true\` — a nullable organisation is a row outside every tenant`,
      );
    }

    const rawIndexes = entry.indexes;
    const indexes: DeclaredIndex[] = [];
    if (rawIndexes !== undefined && rawIndexes !== null) {
      if (!Array.isArray(rawIndexes)) {
        throw new Error(`[declared-tables] ${where}: indexes must be an array`);
      }
      for (const i of rawIndexes) {
        const idx = parseIndex(i, columnNames, where);
        if (seenIndexes.has(idx.name)) {
          throw new Error(`[declared-tables] ${packageName}: index "${idx.name}" is declared twice`);
        }
        seenIndexes.add(idx.name);
        indexes.push(idx);
      }
    }

    // The identifier limit, checked BEFORE anything runs (enabler 0.23).
    declaredTablePhysicalName(packageName, name);
    for (const idx of indexes) declaredIndexPhysicalName(packageName, idx.name);

    out.push({ name, organizationColumn, columns, indexes });
  }
  return out;
}

/**
 * The collision refusal of enabler 0.23: "the install also refuses an extension
 * whose derived prefix collides with an installed extension's, since two names
 * can normalise to one" (`@a-b/c` and `@a_b/c` both normalise to `ext_a_b_c_`).
 *
 * Compares against the packages already installed; the SAME package name is
 * never a collision with itself (a reinstall/upgrade is not a new owner).
 */
export function assertNoDeclaredTablePrefixCollision(
  packageName: string,
  installedPackageNames: readonly string[],
): void {
  const prefix = extensionTablePrefix(packageName);
  for (const other of installedPackageNames) {
    if (other === packageName) continue;
    let otherPrefix: string;
    try {
      otherPrefix = extensionTablePrefix(other);
    } catch {
      continue; // an unscoped/legacy name owns no prefix and cannot collide
    }
    if (otherPrefix === prefix) {
      throw new Error(
        `[declared-tables] ${packageName}: its derived table prefix "${prefix}" collides with the ` +
          `installed extension "${other}" — two package names normalise to one prefix, so the ` +
          `install is refused rather than letting one extension reach the other's tables`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// The AUTHORED shape — what an extension writes in its manifest, before the
// parser fills the defaults. Kept separate from `DeclaredTable` so the manifest
// type stays honest about what is optional to write.
// ---------------------------------------------------------------------------

export type DeclaredColumnDeclaration = {
  name: string;
  type: DeclaredColumnType;
  notNull?: boolean;
  primaryKey?: boolean;
  default?: DeclaredColumnDefault | null;
};

export type DeclaredIndexDeclaration = {
  name: string;
  columns: string[];
  unique?: boolean;
};

export type DeclaredTableDeclaration = {
  name: string;
  organizationColumn: string;
  columns: DeclaredColumnDeclaration[];
  indexes?: DeclaredIndexDeclaration[];
};
