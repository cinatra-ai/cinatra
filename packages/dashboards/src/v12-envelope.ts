/**
 * apiVersion 1.2 envelope helpers (cinatra#326).
 *
 * The dashboards platform persists every NEW operator/agent dashboard as an
 * apiVersion 1.2 config (`DASHBOARD_CONFIG_V12_VERSION`) carrying a single
 * `analytics` portlet whose `config.dashboard` is a WHOLE drizzle-cube
 * `DashboardConfig` (the legacy 1.1 shape). Agents + the entity-screen save
 * actions keep EMITTING the bare drizzle-cube config they already know; the
 * platform owns the apiVersion 1.2 envelope. These pure helpers are the single
 * wrap/unwrap pair + scope mapping the mutation service and the screen loaders
 * share — server-safe, no DB, no React, no drizzle-cube/client import.
 *
 * Why the envelope (not bare 1.1):
 *   `/dashboards/[id]` renders apiVersion 1.2 rows through `PortletHost` →
 *   `AnalyticsPortletView` (one renderer), so an agent-created dashboard shows
 *   its real analytics grid instead of the legacy read-only branch (cinatra#272,
 *   #325 keystone). #326 makes the CREATE/SAVE paths emit that shape.
 *
 * NOT in scope here: #327 (migrating existing 1.0/1.1 rows) — these helpers only
 * shape NEW writes + read back what was written. Existing legacy rows keep their
 * version until the migration lands.
 */
import {
  DASHBOARD_CONFIG_V12_VERSION,
  DASHBOARD_SCOPE_LEVELS,
  type DashboardConfigV12,
  type DashboardScopeLevel,
} from "./extension/dashboard-config-v12";
import {
  ANALYTICS_PORTLET_KIND,
  ANALYTICS_PORTLET_VERSION,
  isAnalyticsPortletKind,
} from "./portlets/kinds";
import { DashboardConfigV1_1Schema } from "./store/dashboard-config";

/** instanceId of the single analytics portlet a wrapped operator/agent dashboard carries. */
export const ANALYTICS_PORTLET_INSTANCE_ID = "analytics" as const;

/**
 * Map a row's `ownerLevel` to the apiVersion 1.2 `scopeLevel`. The four owner
 * levels (`user`/`team`/`organization`/`workspace`) are all valid scopeLevels,
 * so the mapping is identity for them. `project` scopeLevel only arises for
 * project-scoped extension rows (materialized separately), which #326's UI/agent
 * create path never produces. Accepts a raw `string` (the Drizzle row column is
 * typed `string`) and defaults an unrecognized value to `"user"` so a corrupt
 * row can never produce an out-of-enum scopeLevel that fails apiVersion 1.2 validation.
 */
export function ownerLevelToScopeLevel(ownerLevel: string): DashboardScopeLevel {
  return (DASHBOARD_SCOPE_LEVELS as readonly string[]).includes(ownerLevel)
    ? (ownerLevel as DashboardScopeLevel)
    : "user";
}

/** Narrow record helper. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The single rule for "this portlet is THE analytics portlet" — matched by
 * analytics KIND (covering the `cube-dashboard` alias), NOT by instanceId. Used
 * by BOTH `reEnvelopeDcSave` (which slot it replaces) and `unwrapV12ToDc` (which
 * one it reads) so a save→reload round-trip always targets the SAME portlet,
 * even one carrying a non-canonical instanceId.
 */
function isAnalyticsPortletRecord(p: unknown): boolean {
  const rec = asRecord(p);
  return rec !== null && typeof rec.kind === "string" && isAnalyticsPortletKind(rec.kind);
}

/**
 * Is `config` already an apiVersion 1.2 envelope? Discriminated purely by the
 * `apiVersion` literal — the same discriminator the row's `config_version`
 * column and `resolveDashboardRenderKind` use. Deliberately structural-lite
 * (does not deep-validate portlets): callers that need full validation run the
 * registry validator (`assertConfigV12`) separately.
 */
export function isV12Envelope(
  config: unknown,
): config is { apiVersion: string; scopeLevel?: string; portlets?: unknown[] } {
  const rec = asRecord(config);
  return rec !== null && rec.apiVersion === DASHBOARD_CONFIG_V12_VERSION;
}

/** Build the single analytics portlet that wraps a bare DC config. */
function analyticsPortlet(dc: unknown): DashboardConfigV12["portlets"][number] {
  return {
    instanceId: ANALYTICS_PORTLET_INSTANCE_ID,
    kind: ANALYTICS_PORTLET_KIND,
    version: ANALYTICS_PORTLET_VERSION,
    slot: "fixed",
    config: { dashboard: dc },
  } as DashboardConfigV12["portlets"][number];
}

/**
 * Wrap a bare drizzle-cube `DashboardConfig` into a single-analytics-portlet
 * apiVersion 1.2 envelope. The result still has to pass the registry validator
 * at the write site (the mutation service validates AFTER wrapping).
 */
export function wrapDcAsV12(dc: unknown, scopeLevel: DashboardScopeLevel): DashboardConfigV12 {
  return {
    apiVersion: DASHBOARD_CONFIG_V12_VERSION,
    scopeLevel,
    portlets: [analyticsPortlet(dc)],
  } as DashboardConfigV12;
}

/**
 * Re-envelope on save (cinatra#326 §3c). Given the EXISTING persisted config and
 * the next bare DC config, produce the next apiVersion 1.2 envelope:
 *
 *   - existing is apiVersion 1.2 → preserve its `scopeLevel` + EVERY other
 *     portlet, replacing ONLY the analytics portlet's `config.dashboard`
 *     (matched by analytics KIND via the shared `isAnalyticsPortletRecord` rule
 *     — covers the `cube-dashboard` alias AND a non-canonical instanceId, so it
 *     targets the SAME portlet `unwrapV12ToDc` reads back). If no analytics
 *     portlet exists yet, append one (so a future multi-portlet apiVersion 1.2 dashboard
 *     that gains an analytics view doesn't clobber its siblings).
 *   - existing is NOT apiVersion 1.2 (bare/legacy/absent) → fresh wrap at
 *     `fallbackScope`.
 *
 * This keeps the autosave coordinator working on the bare DC config (its dirty
 * baseline) while the platform owns the envelope at the write boundary.
 */
export function reEnvelopeDcSave(
  existingConfig: unknown,
  nextDc: unknown,
  fallbackScope: DashboardScopeLevel,
): DashboardConfigV12 {
  if (!isV12Envelope(existingConfig)) return wrapDcAsV12(nextDc, fallbackScope);
  const env = existingConfig as {
    scopeLevel?: DashboardScopeLevel;
    portlets?: unknown[];
  };
  const scopeLevel = env.scopeLevel ?? fallbackScope;
  const portlets = Array.isArray(env.portlets) ? env.portlets : [];
  let replaced = false;
  const nextPortlets = portlets.map((p) => {
    if (isAnalyticsPortletRecord(p)) {
      replaced = true;
      const rec = asRecord(p)!;
      const prevConfig = asRecord(rec.config) ?? {};
      return { ...rec, config: { ...prevConfig, dashboard: nextDc } };
    }
    return p;
  });
  if (!replaced) nextPortlets.push(analyticsPortlet(nextDc));
  return {
    apiVersion: DASHBOARD_CONFIG_V12_VERSION,
    scopeLevel,
    portlets: nextPortlets,
  } as DashboardConfigV12;
}

/**
 * Unwrap an apiVersion 1.2 analytics envelope back to its embedded bare DC
 * config (`portlets[<analytics>].config.dashboard`). Returns `null` when the
 * config is not an apiVersion 1.2 envelope, has no analytics portlet, or the
 * embedded dashboard is absent — the read-path caller then falls back to its
 * seed (preserving the existing defensive behavior). Matches the analytics KIND
 * (so the `cube-dashboard` alias is handled).
 */
export function unwrapV12ToDc(config: unknown): unknown | null {
  if (!isV12Envelope(config)) return null;
  const rawPortlets = (config as { portlets?: unknown }).portlets;
  // Defensive: a malformed envelope may carry a non-array `portlets`; degrade to
  // null (caller falls back to seed) rather than throwing on `.find`.
  const portlets = Array.isArray(rawPortlets) ? rawPortlets : [];
  const analytics = portlets.find(isAnalyticsPortletRecord);
  const cfg = asRecord(asRecord(analytics)?.config);
  return cfg?.dashboard ?? null;
}

/**
 * Read-side resolver for the entity screens (cinatra#326 §3c). Given a row's
 * stored `config_version` + `config_json` (or `undefined` when the row is
 * absent) and the screen's seed config, return the bare drizzle-cube config the
 * legacy grid mounts:
 *
 *   - row absent → seed.
 *   - apiVersion 1.2 row → unwrap the analytics portlet's `config.dashboard`,
 *     re-validated as a 1.1 DC config (defensive: a corrupt/mislabeled embedded
 *     config degrades to the seed instead of crashing the grid).
 *   - legacy 1.0/1.1 row → `parseDashboardConfig` (unchanged behavior).
 *   - anything else / parse failure → seed.
 *
 * This keeps the 5 entity screens on the legacy drizzle-cube grid (#328 is NOT
 * part of #326) while making the save→reload round-trip show the saved layout
 * rather than snapping back to the seed.
 */
export function readDcConfigFromRow<T>(
  row: { readonly configVersion: string; readonly configJson: unknown } | undefined,
  seed: T,
  parseLegacy: (version: string, payload: unknown) => unknown,
): T {
  if (!row) return seed;
  try {
    if (row.configVersion === DASHBOARD_CONFIG_V12_VERSION) {
      const dc = unwrapV12ToDc(row.configJson);
      if (dc === null) return seed;
      const parsed = DashboardConfigV1_1Schema.safeParse(dc);
      // Return the VALIDATED output (parity with the legacy parseDashboardConfig
      // path), not the raw unwrapped object, so both read paths yield the same
      // normalized config even if the schema gains defaults/coercions.
      return parsed.success ? (parsed.data as T) : seed;
    }
    return parseLegacy(row.configVersion, row.configJson) as T;
  } catch {
    return seed;
  }
}
