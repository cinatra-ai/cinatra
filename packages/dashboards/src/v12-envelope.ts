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
 *   `EmbeddedDrizzleCubeDashboardGrid` (one renderer), so an agent-created dashboard shows
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
import {
  DashboardConfigV1_1Schema,
  PortletConfigV1_1Schema,
  type DashboardConfigV1_1,
} from "./store/dashboard-config";

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
 * column uses. Deliberately structural-lite
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
 * Read-side resolver for the entity screens. Given a row's stored
 * `config_version` + `config_json` (or `undefined` when the row is absent) and
 * the screen's seed config, return the bare drizzle-cube config the analytics
 * grid mounts:
 *
 *   - row absent → seed.
 *   - apiVersion 1.2 row → unwrap the analytics portlet's `config.dashboard`,
 *     re-validated at PORTLET granularity (cinatra#1736): legacy object-shaped
 *     `query` values normalize to their JSON string, a portlet that still
 *     cannot render is dropped (its siblings survive), and only an unreadable
 *     top-level structure degrades to the seed.
 *   - anything else (non-apiVersion-1.2 version) / unwrap failure → seed.
 *
 * The legacy 1.0/1.1 read path was removed in cinatra#329: all pre-existing rows
 * were migrated to the apiVersion 1.2 envelope (cinatra#327), so a row that is
 * not apiVersion 1.2 can only be a corrupt/stale row — it degrades to the seed.
 */
export function readDcConfigFromRow<T>(
  row: { readonly configVersion: string; readonly configJson: unknown } | undefined,
  seed: T,
): T {
  if (!row) return seed;
  if (row.configVersion !== DASHBOARD_CONFIG_V12_VERSION) return seed;
  const dc = unwrapV12ToDc(row.configJson);
  if (dc === null) return seed;
  // Per-portlet salvage (cinatra#1736): the schema normalizes a legacy
  // object-shaped `query` to its JSON string (pre-fix rows render again), and
  // a portlet that STILL cannot render is dropped instead of swapping the
  // WHOLE dashboard for the seed (one bad portlet must not eat its siblings).
  // Only an unreadable top-level structure degrades to the seed.
  const parsed = parseAnalyticsDashboardForRender(dc);
  return parsed.ok ? (parsed.config as T) : seed;
}


// ─────────────────────────────────────────────────────────────────────────
// cinatra#1736 — legacy-`query` contract enforcement + render salvage.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Normalize a bare drizzle-cube body for PERSISTENCE (cinatra#1736): parse it
 * through the 1.1 schema so the legacy `query` normalizer rewrites
 * object-shaped queries to the JSON string drizzle-cube expects BEFORE the row
 * is stored. An invalid body returns UNCHANGED — the mutation service's
 * registry validation then rejects it with the schema's actionable message
 * (fail closed, never fail silent).
 */
export function normalizeDcBodyForWrite(dc: unknown): unknown {
  const parsed = DashboardConfigV1_1Schema.safeParse(dc);
  return parsed.success ? parsed.data : dc;
}

/**
 * Normalize every analytics portlet's embedded `config.dashboard` inside an
 * apiVersion 1.2 envelope for PERSISTENCE (cinatra#1736) — the
 * envelope-passthrough write branch's counterpart of `normalizeDcBodyForWrite`.
 * Non-analytics portlets and all other envelope fields pass through untouched.
 */
export function normalizeV12AnalyticsForWrite(envelope: unknown): unknown {
  if (!isV12Envelope(envelope)) return envelope;
  const rec = asRecord(envelope)!;
  if (!Array.isArray(rec.portlets)) return envelope;
  const portlets = rec.portlets.map((p) => {
    if (!isAnalyticsPortletRecord(p)) return p;
    const prec = asRecord(p)!;
    const cfg = asRecord(prec.config);
    if (!cfg || !("dashboard" in cfg)) return p;
    return { ...prec, config: { ...cfg, dashboard: normalizeDcBodyForWrite(cfg.dashboard) } };
  });
  return { ...rec, portlets };
}

/** A portlet the render path had to exclude, with a human-readable reason. */
export type BrokenPortletReport = {
  readonly id: string;
  readonly title: string;
  readonly reason: string;
};

export type AnalyticsDashboardRenderParse =
  | {
      readonly ok: true;
      /** The normalized config with only the renderable portlets. */
      readonly config: DashboardConfigV1_1;
      /** Portlets excluded from the grid (empty when everything renders). */
      readonly broken: readonly BrokenPortletReport[];
    }
  | { readonly ok: false; readonly reason: string };

function describePortletParseFailure(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues.map((i) => `${i.path.join(".") || "<portlet>"}: ${i.message}`).join("; ");
}

/**
 * Render-side parse of an analytics portlet's embedded `config.dashboard`
 * (cinatra#1736), at PORTLET granularity so one broken portlet cannot take
 * down its siblings:
 *
 *   - each portlet parses through the 1.1 portlet schema, which NORMALIZES an
 *     object-shaped legacy `query` to its JSON string — this is what makes
 *     pre-fix persisted rows (the #1736 repro) render without a DB backfill;
 *   - a portlet that still fails (e.g. a `query` that is not valid JSON) is
 *     EXCLUDED and reported in `broken` — the caller renders an error state
 *     for it instead of drizzle-cube's indefinite spinner;
 *   - layout entries pointing at excluded portlets are dropped (best effort);
 *   - only an unreadable top-level structure is `ok: false` (all broken).
 */
export function parseAnalyticsDashboardForRender(raw: unknown): AnalyticsDashboardRenderParse {
  const rec = asRecord(raw);
  if (!rec || !Array.isArray(rec.portlets)) {
    return { ok: false, reason: "the embedded dashboard config has no portlets array" };
  }

  const good: unknown[] = [];
  const broken: BrokenPortletReport[] = [];
  for (const p of rec.portlets) {
    const parsed = PortletConfigV1_1Schema.safeParse(p);
    if (parsed.success) {
      good.push(parsed.data);
      continue;
    }
    const prec = asRecord(p);
    broken.push({
      id: typeof prec?.id === "string" ? prec.id : "<unknown>",
      title: typeof prec?.title === "string" ? prec.title : "(untitled portlet)",
      reason: describePortletParseFailure(parsed.error.issues),
    });
  }

  // Best-effort layout cleanup: drop react-grid-layout entries whose `i`
  // references an excluded portlet, so the grid doesn't reserve dead space.
  const brokenIds = new Set(broken.map((b) => b.id));
  const rawLayouts = asRecord(rec.layouts);
  const layouts =
    rawLayouts && brokenIds.size > 0
      ? Object.fromEntries(
          Object.entries(rawLayouts).map(([bp, items]) => [
            bp,
            Array.isArray(items)
              ? items.filter((it) => {
                  const irec = asRecord(it);
                  return !(typeof irec?.i === "string" && brokenIds.has(irec.i));
                })
              : items,
          ]),
        )
      : rec.layouts;

  const rebuilt = DashboardConfigV1_1Schema.safeParse({ ...rec, portlets: good, layouts });
  if (!rebuilt.success) {
    return { ok: false, reason: describePortletParseFailure(rebuilt.error.issues) };
  }
  return { ok: true, config: rebuilt.data, broken };
}
