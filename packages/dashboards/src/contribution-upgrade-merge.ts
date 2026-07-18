// Baseline-backed 3-WAY UPGRADE MERGE for dashboardContribution defaults
// (cinatra#1628, S11c / remaining AC2).
//
// AC2 requires that a contribution UPGRADE "update defaults without clobbering
// user customization". The mechanism is a classic 3-way merge with a PERSISTED
// baseline (S11a's `applied_default_json` snapshot column):
//
//   base   = applied_default_json  — the extension default that was LAST applied
//                                     to this row (the merge base / common ancestor).
//   theirs = the NEW sidecar default the upgraded contribution ships.
//   ours   = the row's current config_json  — base + whatever the user customized
//            on top of it.
//
// The merge is keyed on the STABLE portlet identity `instanceId` (never array
// position — a re-ordered default must not look like a rewrite). Per-portlet the
// rule is the standard 3-way resolution, with the tie ALWAYS broken toward the
// USER (never clobber a customization):
//
//   - ours == base (user never touched this portlet) -> take THEIRS (apply the
//     new default; this is the whole point of an upgrade).
//   - ours != base (user customized this portlet)     -> keep OURS, even when
//     theirs also changed (a true conflict resolves to the user; the extension's
//     new default for a user-owned portlet is dropped, reported as a conflict).
//   - portlet only in THEIRS (a brand-new default portlet) -> ADD it.
//   - portlet in base+ours, removed in theirs -> the extension retired it: drop it
//     ONLY when the user left it at the default (ours == base); a user-customized
//     retired portlet is KEPT (dropping it would clobber the customization).
//   - portlet the user DELETED (in base, absent from ours) -> stays deleted (the
//     deletion IS the customization) — never resurrected by theirs.
//   - portlet only in OURS (a user-added optional portlet) -> kept.
//
// Envelope metadata (apiVersion, scopeLevel, any non-`portlets` top-level field)
// is preserved from OURS: an upgrade merges portlet CONTENT only. A scopeLevel /
// apiVersion change is a structural migration, not a content upgrade, and is
// deliberately out of this function's scope (the caller decides whether to run a
// scope migration).
//
// PURE — no store, no I/O. The writer (`upgradeExtensionDashboards`) persists the
// result, re-bases the baseline to `theirs`, and re-validates wiring integrity
// fail-closed.

import { createHash } from "node:crypto";

/** A portlet as stored in a dashboard config — only `instanceId` is load-bearing
 *  here (the merge identity); the rest is compared structurally. */
type PortletLike = { readonly instanceId: string } & Record<string, unknown>;

/** A dashboard config envelope — `portlets` is the merged surface; every other
 *  top-level field is envelope metadata preserved from `ours`. */
export type DashboardConfigLike = { readonly portlets?: readonly unknown[] } & Record<string, unknown>;

/** Per-portlet resolution, for the audit report + tests. */
export type UpgradeMergeReport = {
  /** New default portlets added from theirs. */
  readonly added: string[];
  /** Portlets updated to the new default (user had not customized them). */
  readonly updated: string[];
  /** Portlets the extension retired and the user had not customized — removed. */
  readonly removed: string[];
  /** Portlets kept as the user's customization (never clobbered), incl. true
   *  conflicts where theirs also changed. */
  readonly keptCustomized: string[];
  /** The subset of `keptCustomized` where BOTH sides changed (a true conflict —
   *  the extension's new default was dropped in favor of the user's). */
  readonly conflicts: string[];
};

export type ThreeWayMergeResult = {
  readonly merged: DashboardConfigLike;
  readonly report: UpgradeMergeReport;
  /** True when the merged config is byte-identical to `ours` (nothing to write). */
  readonly unchanged: boolean;
};

/** Canonical JSON with recursively SORTED object keys — a stable serialization
 *  for structural deep-equality + hashing (two configs that differ only in key
 *  order or portlet order hash identically once portlets are keyed by id). */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Stable content hash of an APPLIED-DEFAULT snapshot — the fast change-detector
 * persisted as `applied_default_hash`. Order-insensitive for object keys AND for
 * the `portlets` array (portlets are sorted by `instanceId` before hashing) so a
 * mere re-order of the default is NOT seen as a default change.
 */
export function computeAppliedDefaultHash(config: unknown): string {
  const normalized = normalizeForHash(config);
  return createHash("sha256").update(stableStringify(normalized)).digest("hex");
}

function normalizeForHash(config: unknown): unknown {
  if (!config || typeof config !== "object") return config;
  const c = config as DashboardConfigLike;
  if (!Array.isArray(c.portlets)) return config;
  const portlets = [...c.portlets].sort((a, b) =>
    portletId(a).localeCompare(portletId(b)),
  );
  return { ...c, portlets };
}

function portletId(p: unknown): string {
  return p && typeof p === "object" && typeof (p as PortletLike).instanceId === "string"
    ? (p as PortletLike).instanceId
    : "";
}

/** Index a config's portlets by `instanceId` (dropping any malformed entry with
 *  no string id — a defensive no-op, the config was validated on write). */
function portletMap(config: DashboardConfigLike | undefined): Map<string, PortletLike> {
  const map = new Map<string, PortletLike>();
  for (const raw of config?.portlets ?? []) {
    if (raw && typeof raw === "object" && typeof (raw as PortletLike).instanceId === "string") {
      map.set((raw as PortletLike).instanceId, raw as PortletLike);
    }
  }
  return map;
}

/** Structural deep-equality (order-insensitive on object keys) of two portlets. */
function portletsEqual(a: PortletLike | undefined, b: PortletLike | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return stableStringify(a) === stableStringify(b);
}

/**
 * 3-way merge a contribution's dashboard config on upgrade. `base` is the last
 * applied default (may be `null`/`undefined` — see the writer, which does NOT
 * 3-way merge without a baseline). Returns the merged config, a per-portlet
 * report, and an `unchanged` flag. NEVER throws — a malformed side degrades to
 * an empty portlet set for that side (the writer re-validates the result).
 */
export function threeWayMergeDashboardConfig(input: {
  readonly base: DashboardConfigLike | null | undefined;
  readonly theirs: DashboardConfigLike;
  readonly ours: DashboardConfigLike;
}): ThreeWayMergeResult {
  const base = portletMap(input.base ?? undefined);
  const theirs = portletMap(input.theirs);
  const ours = portletMap(input.ours);

  const added: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];
  const keptCustomized: string[] = [];
  const conflicts: string[] = [];

  // Preserve the ORDER of `ours` (the user's arrangement), then append any
  // brand-new theirs-only portlets in theirs order — a stable, user-first layout.
  const orderedIds: string[] = [];
  const seen = new Set<string>();
  const pushId = (id: string) => {
    if (!seen.has(id)) {
      seen.add(id);
      orderedIds.push(id);
    }
  };
  for (const raw of input.ours.portlets ?? []) {
    const id = portletId(raw);
    if (id) pushId(id);
  }
  for (const raw of input.theirs.portlets ?? []) {
    const id = portletId(raw);
    if (id) pushId(id);
  }

  const mergedPortlets: PortletLike[] = [];
  for (const id of orderedIds) {
    const b = base.get(id);
    const o = ours.get(id);
    const t = theirs.get(id);

    if (o === undefined) {
      // User deleted a former-default portlet (in base, absent from ours) — the
      // deletion is the customization; theirs never resurrects it. (A theirs-only
      // portlet that was never in base is a NEW default -> add it below.)
      if (b === undefined && t !== undefined) {
        mergedPortlets.push(t);
        added.push(id);
      }
      // else: user-deleted a base portlet -> stays deleted (drop t entirely).
      continue;
    }

    // `o` is present.
    if (t === undefined) {
      // Extension retired this portlet. Drop it only if the user left it at the
      // default; a customized retired portlet is kept (never clobber).
      if (b !== undefined && portletsEqual(o, b)) {
        removed.push(id);
        continue;
      }
      mergedPortlets.push(o);
      if (b !== undefined) keptCustomized.push(id);
      continue;
    }

    // Present on both sides (and possibly base).
    if (b !== undefined && portletsEqual(o, b)) {
      // User never touched it -> take the new default.
      mergedPortlets.push(t);
      if (!portletsEqual(o, t)) updated.push(id);
      continue;
    }
    // User customized it (ours != base, or no base) -> keep ours; if theirs ALSO
    // changed the default it is a true conflict (the new default is dropped).
    mergedPortlets.push(o);
    keptCustomized.push(id);
    if (b !== undefined && !portletsEqual(t, b) && !portletsEqual(o, t)) {
      conflicts.push(id);
    }
  }

  // Envelope from OURS; only `portlets` is merged.
  const merged: DashboardConfigLike = { ...input.ours, portlets: mergedPortlets };
  const unchanged = stableStringify(merged) === stableStringify(input.ours);

  return { merged, report: { added, updated, removed, keptCustomized, conflicts }, unchanged };
}
