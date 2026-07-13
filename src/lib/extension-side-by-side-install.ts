import "server-only";

// SIDE-BY-SIDE version installer (cinatra#1040 S3).
//
// Realizes an `action:"install-side-by-side"` dependency-plan member: the
// disjoint-dependents conflict class on the NON-GATEKEPT path (the
// admissible-range intersection is empty — the installed default is older and
// at least one live dependent's edge refuses the pin), where neither
// dedupe-upward nor the hard refusal can serve every dependent. The new
// version installs as its own NON-DEFAULT canonical row THROUGH THE REAL
// INSTALL PIPELINE (materialize → gates → version-scoped journal → provenance
// → finalize → resolved edges), STORAGE-LEVEL ONLY:
//
//   - the canonical row is created `isDefault:false` — the DEFAULT row keeps
//     every global-name surface (registries, mounts, MCP names, the `current`
//     digest mirror, the trust-gate anchor);
//   - the journal ops live in the (package, org, VERSION) namespace
//     (core__0022), so the finalize supersession can never demote the default
//     install's anchor;
//   - NO in-process activation and NO native-handler run-surface projection
//     run — versioned runtime activation ((packageName, version) loader
//     anchors + default re-election) is the S4 slice. Until S4, the row
//     serves storage/closure semantics only: the write-time edge resolver
//     binds new dependents' edges to it and the closure gates validate them.
//
// SHARED-STATE DISCIPLINE (codex-converged): this path mutates NOTHING that
// the default install owns EXCEPT the host-migration ledger, which is a shared
// append-only per-package namespace whose ordering is owned elsewhere.
//   - Host MIGRATIONS (cinatra#1040 S5): a side-by-side version MAY declare
//     `cinatra.migrationsDir`; the S3 DECLARES_MIGRATIONS refusal is LIFTED.
//     Application is deferred to the loader's ordered cross-version UNION
//     (`applyMigrationUnionForTrustedRecords`) at boot/activation — install
//     preflight only VALIDATES (and its `true` return still lets the pipeline
//     trust gate reject an UNSIGNED declarer before finalize).
//   - Host-port grants + capability-OWNERSHIP grants (cinatra#1391 S6): the
//     injected `grantUnion` hooks ENABLE the non-refusing per-scope UNION on
//     BOTH axes — ownership as a declaration-only capsule with survivor-check
//     revoke, PORTS as a prior-state capsule (the grant is ONE shared
//     per-(package, org) row) whose restore is HASH-GUARDED against the
//     recomputed survivor union, reconciled through direct failure, batch
//     compensation, boot recovery, and orphan GC. Their ABSENCE keeps the S3
//     refusals (PORTS_NOT_COVERED / DECLARES_OWNERSHIP_KEYS) — fail-closed.
//     A grown ports union pends the shared grant; the union-aware re-approval
//     surface (extension-host-port-grant-review + the approvals source) makes
//     that operable.
// The compensation inverse (`uninstallExtensionVersionSideBySide`) is therefore a
// pure version-scoped teardown: delete the non-default row (lifecycle
// primitive, dependent-bound-edge + default-row guards), terminalize its
// version-scoped journal op. Store digest dirs are left to the retention GC.
//
// GATEKEPT FENCE: the planner emits side-by-side ONLY when `closure === null`;
// this module additionally REFUSES when gatekept install is enabled at
// execution time, so an environment flip between planning and execution can
// never route a side-by-side member through the gatekept world (ratified
// Option-B contract; #1296 untouched).

import { randomUUID } from "node:crypto";
import type { ExtensionStoreKind } from "@/lib/extension-package-store-core";
// TYPES from the ledger module (already in the install route graph); the runtime
// capsule module is reached ONLY via dynamic import (route-graph-ratchet).
import type {
  SideBySideGrantCapsule,
  SideBySidePortsPriorState,
} from "@/lib/extension-install-batch-ops";

/**
 * Grant-UNION hooks a caller (the dependency-batch saga) injects to ENABLE the
 * non-refusing per-scope union (cinatra#1040 S6 / cinatra#1391): the
 * capability-OWNERSHIP per-key union AND the host-PORTS union. Their presence
 * lifts the S3 `DECLARES_OWNERSHIP_KEYS` + `PORTS_NOT_COVERED` refusals; their
 * ABSENCE keeps both (fail-closed — a side-by-side install must never mutate a
 * shared grant without a durable capsule to reconcile it on teardown).
 */
export type SideBySideGrantUnionHooks = {
  /** Persist the capsule DURABLY (idempotent; the installer passes the full
   * MERGED capsule on each capture event, and the `portsPrior` prior-state part
   * is first-capture-wins inside the merge). Production: the batch ledger
   * member's `grantCapsule` (JSONB). The capsule records WHAT this version
   * declared (+ the ports grant's prior state), so a later batch-compensation /
   * boot-recovery teardown can reconcile the shared grants even when this
   * version's store is gone. */
  persistCapsule: (capsule: SideBySideGrantCapsule) => Promise<void>;
  /** Read the ownership keys declared by the CURRENTLY-finalized siblings
   * (excluding `excludeVersion`) — the survivor set the teardown/unwind consults.
   * Defaults to the real fs+db reader (`defaultReadSurvivorOwnershipKeys`);
   * injected in tests. */
  readSurvivorOwnershipKeys?: (excludeVersion: string) => Promise<Set<string>>;
  /** Read the host ports declared by the CURRENTLY-finalized siblings
   * (excluding `excludeVersion`), journal-gated (cinatra#1391). Defaults to
   * `defaultReadSiblingDeclaredHostPorts`; injected in tests. */
  readSiblingDeclaredPorts?: (excludeVersion: string) => Promise<string[]>;
};

/**
 * DEFAULT survivor reader: the union of widget-auth token ownership keys the
 * CURRENTLY-finalized `active|locked` siblings (excluding `excludeVersion`, and
 * the platform/org scope of `orgId`) declare, read from each sibling's
 * integrity-verified (digest-bound) materialized store manifest. A sibling
 * without a resolvable `activeDigest` store contributes NO keys — the
 * fail-closed direction (an un-verifiable declarer never keeps a key alive).
 */
export async function defaultReadSurvivorOwnershipKeys(
  packageName: string,
  orgId: string | null,
  excludeVersion: string,
): Promise<Set<string>> {
  const { readInstalledExtensionsByPackageName } = await import(
    "@cinatra-ai/extensions/canonical-store"
  );
  const { readWidgetAuthTokenKeysFromStore } = await import(
    "@/lib/extension-capability-ownership-grants"
  );
  const { storeDigestDirV2 } = await import("@/lib/extension-package-store-core");
  const { resolveExtensionDataRoot } = await import("@/lib/extension-data-root");
  const rows = await readInstalledExtensionsByPackageName(packageName);
  const siblings = rows.filter(
    (r) =>
      (r.status === "active" || r.status === "locked") &&
      (r.organizationId ?? null) === orgId &&
      (r.version ?? null) !== excludeVersion,
  );
  const dataRoot = resolveExtensionDataRoot();
  const keys = new Set<string>();
  for (const s of siblings) {
    const digest = (s.source as { activeDigest?: string } | null)?.activeDigest;
    if (!digest) continue; // no digest-bound verified store → cannot attribute keys (fail closed)
    let storeDir: string;
    try {
      storeDir = storeDigestDirV2(dataRoot, s.kind as ExtensionStoreKind, packageName, digest);
    } catch {
      continue;
    }
    try {
      for (const k of await readWidgetAuthTokenKeysFromStore(storeDir)) keys.add(k);
    } catch {
      // an unreadable sibling store contributes no keys (fail closed)
    }
  }
  return keys;
}

/**
 * The ownership keys the TORN-DOWN version itself declared, read LIVE from its
 * own integrity-verified store manifest. The teardown fallback when no durable
 * capsule is present (an EXPLICIT uninstall of a committed version whose capsule
 * was released on batch finalize) — the version's digest dir outlives the row
 * teardown (left to the retention GC), so its declaration is still readable.
 * Absent digest / unreadable store → [] (nothing to reconcile).
 */
async function readTornDownVersionDeclaredKeys(
  packageName: string,
  row: { kind: string; source: unknown },
): Promise<string[]> {
  const digest = (row.source as { activeDigest?: string } | null)?.activeDigest;
  if (!digest) return [];
  try {
    const { storeDigestDirV2 } = await import("@/lib/extension-package-store-core");
    const { resolveExtensionDataRoot } = await import("@/lib/extension-data-root");
    const { readWidgetAuthTokenKeysFromStore } = await import(
      "@/lib/extension-capability-ownership-grants"
    );
    const storeDir = storeDigestDirV2(
      resolveExtensionDataRoot(),
      row.kind as ExtensionStoreKind,
      packageName,
      digest,
    );
    return await readWidgetAuthTokenKeysFromStore(storeDir);
  } catch {
    return [];
  }
}

/**
 * JOURNAL-GATED sibling host-port reader (cinatra#1391 ports axis): the union
 * of `cinatra.requestedHostPorts` the CURRENTLY-finalized `active|locked`
 * siblings at the exact scope declare (excluding `excludeVersion` when given),
 * each read from a store dir bound through the SAME digest rule the runtime
 * trust gate uses — a FINALIZED journal op for the row's namespace (the
 * versionless anchor for the default row; the version-scoped op for a
 * non-default sibling) cross-checked against the row's `source.activeDigest`
 * via `selectActiveDigest` (cinatra#792). A row whose journal is not finalized,
 * whose digest binding fails closed, or whose store is unreadable contributes
 * NO ports (an un-verifiable declarer never keeps a port in the union). The
 * still-installing placeholder row is digest-less by construction and is
 * therefore always excluded. Sorted/de-duped. Reused by the install-time union,
 * the teardown survivor recompute, AND the re-approval surface's recompute —
 * ONE algorithm, never three.
 */
export async function defaultReadSiblingDeclaredHostPorts(
  packageName: string,
  orgId: string | null,
  excludeVersion: string | null,
): Promise<string[]> {
  const { readInstalledExtensionsByPackageName } = await import(
    "@cinatra-ai/extensions/canonical-store"
  );
  const { readInstallOp, readInstallOpForVersion } = await import(
    "@/lib/extension-install-ops"
  );
  const { selectActiveDigest } = await import("@/lib/extension-install-anchor");
  const { readRequestedHostPortsFromStore } = await import(
    "@/lib/extension-host-port-grants"
  );
  const { storeDigestDirV2 } = await import("@/lib/extension-package-store-core");
  const { resolveExtensionDataRoot } = await import("@/lib/extension-data-root");
  const rows = await readInstalledExtensionsByPackageName(packageName);
  const siblings = rows.filter(
    (r) =>
      (r.status === "active" || r.status === "locked") &&
      (r.organizationId ?? null) === orgId &&
      (excludeVersion === null || (r.version ?? null) !== excludeVersion),
  );
  const dataRoot = resolveExtensionDataRoot();
  const ports = new Set<string>();
  for (const s of siblings) {
    try {
      // Journal gate: the DEFAULT row anchors in the versionless namespace; a
      // non-default sibling in its own (package, org, version) namespace.
      const op =
        s.isDefault !== false
          ? await readInstallOp(packageName, orgId)
          : s.version
            ? await readInstallOpForVersion(packageName, orgId, s.version)
            : null;
      if (op?.phase !== "finalized") continue; // no finalized anchor → no ports (fail closed)
      const sel = selectActiveDigest({
        activeDigest: (s.source as { activeDigest?: string } | null)?.activeDigest ?? null,
        journalDigest: (op as { digest?: string | null }).digest ?? null,
      });
      if (!sel.ok || !sel.digest) continue; // unbound/contradicted digest → no ports (fail closed)
      const dir = storeDigestDirV2(dataRoot, s.kind as ExtensionStoreKind, packageName, sel.digest);
      for (const p of await readRequestedHostPortsFromStore(dir)) ports.add(p);
    } catch {
      // an unreadable sibling contributes no ports (fail closed)
    }
  }
  return Array.from(ports).sort();
}

/**
 * The host ports the TORN-DOWN version itself declared, read LIVE from its own
 * digest-bound store manifest — the teardown TRIGGER fallback when no capsule
 * carries `declaredPorts` (an EXPLICIT uninstall of a committed version whose
 * capsule was released on batch finalize). Trigger-only: the reconcile always
 * RECOMPUTES the survivor union; over-triggering is idempotent, so this read is
 * digest-dir-bound but not journal-gated (the version's own journal op was just
 * terminalized by the teardown). Absent digest / unreadable store → [].
 */
async function readTornDownVersionDeclaredPorts(
  packageName: string,
  row: { kind: string; source: unknown },
): Promise<string[]> {
  const digest = (row.source as { activeDigest?: string } | null)?.activeDigest;
  if (!digest) return [];
  try {
    const { storeDigestDirV2 } = await import("@/lib/extension-package-store-core");
    const { resolveExtensionDataRoot } = await import("@/lib/extension-data-root");
    const { readRequestedHostPortsFromStore } = await import(
      "@/lib/extension-host-port-grants"
    );
    const storeDir = storeDigestDirV2(
      resolveExtensionDataRoot(),
      row.kind as ExtensionStoreKind,
      packageName,
      digest,
    );
    return await readRequestedHostPortsFromStore(storeDir);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Ownership DECLARATION CAPSULE helpers (cinatra#1040 S6). Kept INLINE in this
// module (not a separate file) so no NEW module enters a locked route's
// reachable graph via the dynamic `await import` chain (route-graph-ratchet
// follows `import("…")`). Declaration-only: the capsule records WHAT the removed
// version declared, never a prior grant state — teardown reconciles by SURVIVOR
// CHECK + REVOKE (never a restore), which closes a non-LIFO resurrection hole
// (A introduces+approves K, B captures it, A removed while B survives, then B
// removed would re-pin K with no live declarer). The mutual-survivor race is
// closed by the per-package install lock, which serializes ALL install/teardown
// of ANY version of a package (the survivor set is read under it, after the
// version's row is gone). The capsule TYPE lives in `extension-install-batch-ops`
// (the ledger that stores it, already in the route graph).

/** Build a capsule from a version's declared token keys (sorted/de-duped so a
 * retry captures a stable payload). Returns null when the version declared no
 * ownership keys — nothing to reconcile, so no capsule is persisted. */
export function buildSideBySideGrantCapsule(
  declaredTokenKeys: readonly string[],
): SideBySideGrantCapsule | null {
  const keys = Array.from(new Set(declaredTokenKeys.map((k) => String(k)))).sort();
  if (keys.length === 0) return null;
  return { v: 1, declaredTokenKeys: keys };
}

/** Narrow an untrusted JSONB value (a ledger member's `grantCapsule`) to a
 * capsule, or null. Tolerant of legacy/absent rows (null/undefined → null) and
 * shape drift (garbage → null, never a throw). The ports-axis fields
 * (cinatra#1391) are OPTIONAL v:1 extensions: an ownership-only capsule parses
 * unchanged; a malformed ports part is DROPPED (the reconcile then runs on the
 * live-recomputed survivor union alone) without discarding the ownership part. */
export function parseSideBySideGrantCapsule(value: unknown): SideBySideGrantCapsule | null {
  if (!value || typeof value !== "object") return null;
  const v = value as {
    v?: unknown;
    declaredTokenKeys?: unknown;
    declaredPorts?: unknown;
    portsPrior?: unknown;
  };
  if (v.v !== 1) return null;
  if (!Array.isArray(v.declaredTokenKeys)) return null;
  const keys = Array.from(
    new Set(v.declaredTokenKeys.filter((k): k is string => typeof k === "string")),
  ).sort();
  const ports = Array.isArray(v.declaredPorts)
    ? Array.from(new Set(v.declaredPorts.filter((p): p is string => typeof p === "string"))).sort()
    : undefined;
  const portsPrior = parsePortsPriorState(v.portsPrior);
  return {
    v: 1,
    declaredTokenKeys: keys,
    ...(ports !== undefined ? { declaredPorts: ports } : {}),
    ...(portsPrior ? { portsPrior } : {}),
  };
}

/** Narrow an untrusted `portsPrior` payload; garbage → null (never a throw). */
function parsePortsPriorState(value: unknown): SideBySidePortsPriorState | null {
  if (!value || typeof value !== "object") return null;
  const p = value as {
    exists?: unknown;
    status?: unknown;
    approvedPorts?: unknown;
    requestedPortsHash?: unknown;
    approvedBy?: unknown;
  };
  if (typeof p.exists !== "boolean") return null;
  if (!p.exists) return { exists: false };
  if (p.status !== "pending" && p.status !== "approved" && p.status !== "revoked") return null;
  if (!Array.isArray(p.approvedPorts)) return null;
  if (typeof p.requestedPortsHash !== "string" || p.requestedPortsHash.length === 0) return null;
  if (p.approvedBy !== null && typeof p.approvedBy !== "string") return null;
  return {
    exists: true,
    status: p.status,
    approvedPorts: Array.from(
      new Set(p.approvedPorts.filter((x): x is string => typeof x === "string")),
    ).sort(),
    requestedPortsHash: p.requestedPortsHash,
    approvedBy: (p.approvedBy ?? null) as string | null,
  };
}

/**
 * Merge a capture event into the (possibly existing) capsule. The install path
 * fires up to TWO capture events per member — the ownership declared-keys read
 * and the ports prior-state capture — in pipeline order; each event persists
 * the full MERGED capsule so the durable ledger value is always a superset of
 * what has been mutated so far. `portsPrior` is FIRST-CAPTURE-WINS: a captured
 * prior grant state is never overwritten by a later event (the later state is
 * post-mutation, not prior). Returns null when nothing needs a capsule.
 */
export function mergeSideBySideGrantCapsule(
  existing: SideBySideGrantCapsule | null,
  patch: {
    declaredTokenKeys?: readonly string[];
    declaredPorts?: readonly string[];
    portsPrior?: SideBySidePortsPriorState | null;
  },
): SideBySideGrantCapsule | null {
  const keys = Array.from(
    new Set((patch.declaredTokenKeys ?? existing?.declaredTokenKeys ?? []).map((k) => String(k))),
  ).sort();
  const portsInput = patch.declaredPorts ?? existing?.declaredPorts;
  const ports =
    portsInput !== undefined
      ? Array.from(new Set(portsInput.map((p) => String(p)))).sort()
      : undefined;
  const portsPrior = existing?.portsPrior ?? patch.portsPrior ?? null;
  if (keys.length === 0 && (ports === undefined || ports.length === 0) && !portsPrior) return null;
  return {
    v: 1,
    declaredTokenKeys: keys,
    ...(ports !== undefined ? { declaredPorts: ports } : {}),
    ...(portsPrior ? { portsPrior } : {}),
  };
}

/**
 * Reconcile the shared ownership grants when a side-by-side version is torn down
 * (direct-failure / batch-compensation / boot-recovery). PURE orchestration over
 * INJECTED functions — no grant-store/fs/db access of its own.
 *
 * For each key the removed version declared: if a SURVIVING finalized sibling
 * still declares it (`survivorKeys`) LEAVE it (still owned); else REVOKE it
 * (fail-closed — no live declarer). Never restores a prior approval. Best-effort
 * + isolated per key: a revoke failure routes to `onFailure` and never masks the
 * teardown. PRECONDITION: the caller holds `withInstallLock(packageName)` and
 * `survivorKeys` was read UNDER that lock AFTER this version's row was removed.
 */
export async function reconcileSideBySideOwnershipOnTeardown(args: {
  packageName: string;
  orgId: string | null;
  declaredTokenKeys: readonly string[];
  survivorKeys: ReadonlySet<string>;
  revokeOwnershipGrant: (input: {
    packageName: string;
    orgId: string | null;
    tokenConfigKey: string;
  }) => Promise<void>;
  onFailure: (tokenConfigKey: string, error: unknown) => void;
}): Promise<{ revoked: string[]; kept: string[] }> {
  const revoked: string[] = [];
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const tokenConfigKey of args.declaredTokenKeys) {
    if (seen.has(tokenConfigKey)) continue;
    seen.add(tokenConfigKey);
    if (args.survivorKeys.has(tokenConfigKey)) {
      kept.push(tokenConfigKey); // a live sibling still declares it — never revoke
      continue;
    }
    try {
      await args.revokeOwnershipGrant({
        packageName: args.packageName,
        orgId: args.orgId,
        tokenConfigKey,
      });
      revoked.push(tokenConfigKey);
    } catch (e) {
      args.onFailure(tokenConfigKey, e);
    }
  }
  return { revoked, kept };
}

/** What `reconcileSideBySidePortsOnTeardown` did (evidence for logs/tests). */
export type PortsReconcileAction =
  | "noop"
  | "restored-prior"
  | "restored-prior-narrowed"
  | "narrowed-current"
  | "kept-revoked"
  | "reset-pending";

/**
 * Reconcile the SHARED host-port grant when a side-by-side version is torn down
 * (direct failure / batch compensation / boot recovery / explicit uninstall).
 * PURE orchestration over INJECTED functions — no grant-store/fs/db access of
 * its own. PRECONDITION: the caller holds `withInstallLock(packageName)` and
 * `survivorPorts` was recomputed UNDER that lock AFTER this version's row was
 * removed (journal-gated digest-bound reads — `defaultReadSiblingDeclaredHostPorts`).
 *
 * Decision ladder (codex round-0/round-1 order — an admin REVOKE, then the
 * newest settled-consistent state, then restore-before-reset; a teardown RETRY
 * can never clobber a newer admin decision, and a restored `approved` row always
 * COVERS the survivor union — an approved row that under-covers survivors would
 * be invisible to the pending-only review surface):
 *  0. current `revoked` → keep it revoked (hash corrected). FIRST, before any
 *     restore — an explicit admin revoke is NEVER silently un-revoked by a
 *     teardown, even if a stale captured `approved` prior hashes to the
 *     survivors (codex round-1: the ordering hole a prior-first ladder had);
 *  1. current `approved` AND hash == survivor hash → NO-OP (settled-consistent).
 *     A `pending` row at the survivor hash is NOT settled (conveys no ports) —
 *     it falls through so branches 2-4 may recover an approval;
 *  2. captured prior hash == survivor hash → EXACT restore (the LIFO/common
 *     case: recovers the default's prior grant; the hash guard closes the
 *     non-LIFO resurrection hole — a stale capture never restores);
 *  3. prior `approved` and its approved set COVERS the survivor union →
 *     restore a NARROWED approved survivor set (least-privilege shrink of an
 *     admin-approved superset; grants nothing new);
 *  4. current `approved` and its approved set COVERS the survivor union →
 *     narrow the current approval in place (same shrink, newer approver);
 *  5. current already requests exactly the survivors (pending) with no approval
 *     to restore → NO-OP (idempotent; never re-write an already-correct request);
 *  6. else → re-record the survivor union (resets to `pending` with the
 *     corrected hash; the re-approval surface picks it up).
 */
export async function reconcileSideBySidePortsOnTeardown(args: {
  packageName: string;
  orgId: string | null;
  /** The capsule's captured prior grant state (null = none captured/present). */
  portsPrior: SideBySidePortsPriorState | null;
  /** The RECOMPUTED survivor union (journal-gated, post-removal, under lock). */
  survivorPorts: readonly string[];
  computeHash: (ports: readonly string[]) => string;
  readGrantForScope: () => Promise<{
    status: string;
    approvedPorts: string[];
    requestedPortsHash: string;
    approvedBy: string | null;
  } | null>;
  restoreGrant: (input: {
    status: "pending" | "approved" | "revoked";
    approvedPorts: string[];
    requestedPortsHash: string;
    approvedBy: string | null;
  }) => Promise<void>;
  recordRequestedGrant: (ports: string[]) => Promise<void>;
}): Promise<{ action: PortsReconcileAction }> {
  const survivors = Array.from(new Set(args.survivorPorts.map((p) => String(p)))).sort();
  const survivorHash = args.computeHash(survivors);
  const covers = (approved: readonly string[]): boolean => {
    const set = new Set(approved);
    return survivors.every((p) => set.has(p));
  };
  const current = await args.readGrantForScope();
  const prior = args.portsPrior;

  // 0. An explicit admin REVOKE is the NEWEST authoritative state and is NEVER
  //    un-revoked by a teardown — this MUST precede every restore branch, or a
  //    stale captured `approved` prior (branch 2) that happens to hash to the
  //    survivor union would silently resurrect a privilege an admin removed
  //    (codex round-0 finding). Kept revoked, hash corrected to the survivors.
  if (current && current.status === "revoked") {
    if (current.requestedPortsHash === survivorHash) return { action: "noop" };
    await args.restoreGrant({
      status: "revoked",
      approvedPorts: [],
      requestedPortsHash: survivorHash,
      approvedBy: current.approvedBy,
    });
    return { action: "kept-revoked" };
  }

  // 1. Already SETTLED-consistent: an APPROVED row at exactly the survivors —
  //    newest good state, never touch. (A PENDING row at the survivor hash is
  //    NOT settled — it conveys no ports — so it falls through to the restore
  //    ladder below, which may recover an approval; codex round-0 finding.)
  if (current && current.status === "approved" && current.requestedPortsHash === survivorHash) {
    return { action: "noop" };
  }
  // No row and nothing left to request → nothing to reconcile.
  if (!current && survivors.length === 0 && !(prior && prior.exists)) return { action: "noop" };

  // 2. Exact prior restore — hash-guarded against the recomputed survivors.
  if (
    prior &&
    prior.exists &&
    prior.requestedPortsHash === survivorHash &&
    prior.status !== undefined
  ) {
    await args.restoreGrant({
      status: prior.status,
      approvedPorts: [...(prior.approvedPorts ?? [])],
      requestedPortsHash: prior.requestedPortsHash,
      approvedBy: prior.approvedBy ?? null,
    });
    return { action: "restored-prior" };
  }

  // 3. Prior approval covers the survivors → restore narrowed to exactly them.
  if (
    prior &&
    prior.exists &&
    prior.status === "approved" &&
    covers(prior.approvedPorts ?? [])
  ) {
    await args.restoreGrant({
      status: "approved",
      approvedPorts: survivors,
      requestedPortsHash: survivorHash,
      approvedBy: prior.approvedBy ?? null,
    });
    return { action: "restored-prior-narrowed" };
  }

  // 4. Current approval covers the survivors → narrow it in place.
  if (current && current.status === "approved" && covers(current.approvedPorts)) {
    await args.restoreGrant({
      status: "approved",
      approvedPorts: survivors,
      requestedPortsHash: survivorHash,
      approvedBy: current.approvedBy,
    });
    return { action: "narrowed-current" };
  }

  // 5. Current already REQUESTS exactly the survivors (a pending row) and no
  //    approval could be restored above — leave it (idempotent; a teardown
  //    RETRY never re-writes an already-correct pending request).
  if (current && current.requestedPortsHash === survivorHash) return { action: "noop" };

  // 6. Correct to pending at the survivor union (fail closed; reviewable).
  await args.recordRequestedGrant(survivors);
  return { action: "reset-pending" };
}

export class SideBySideInstallError extends Error {
  constructor(
    public readonly code:
      | "GATEKEPT_PATH"
      | "UNSUPPORTED_KIND"
      | "REQUIRED_IN_PROD"
      | "INVALID_VERSION"
      | "NO_DEFAULT_SIBLING"
      | "DEFAULT_NOT_ANCHORED"
      | "HOST_PIN_VIOLATION"
      | "DECLARES_MIGRATIONS"
      | "DECLARES_OWNERSHIP_KEYS"
      | "PORTS_NOT_COVERED",
    message: string,
  ) {
    super(message);
    this.name = "SideBySideInstallError";
  }
}

const SUPPORTED_KINDS: ReadonlySet<string> = new Set(["agent", "skill", "connector", "artifact"]);

/**
 * Install `packageName@version` SIDE BY SIDE as a non-default canonical row.
 * Idempotent: an existing finalized non-default row at the exact (scope,
 * version) returns immediately; a broken (non-finalized) prior attempt is
 * retried through the pipeline against the same row. Runs under the
 * per-package install lock.
 */
export async function installExtensionVersionSideBySide(input: {
  packageName: string;
  /** Exact pin (never a range/dist-tag — the planner resolved it). */
  version: string;
  /** Planner-resolved kind (dispatch typeId). */
  typeId: string;
  orgId: string | null;
  actorUserId?: string | null;
  /** cinatra#1040 S6: inject to ENABLE the capability-ownership grant union
   * (durable capsule + survivor-aware unwind). Absent → the S3
   * DECLARES_OWNERSHIP_KEYS refusal stands. */
  grantUnion?: SideBySideGrantUnionHooks;
}): Promise<{ rowId: string }> {
  const { withInstallLock } = await import("@cinatra-ai/agents");
  return withInstallLock(input.packageName, () => runLocked(input));
}

async function runLocked(input: {
  packageName: string;
  version: string;
  typeId: string;
  orgId: string | null;
  actorUserId?: string | null;
  grantUnion?: SideBySideGrantUnionHooks;
}): Promise<{ rowId: string }> {
  const { packageName, version, typeId, orgId } = input;

  // ---- MUTATION-FREE PREFLIGHT --------------------------------------------
  const { isGatekeptInstallEnabled } = await import("@/lib/gatekept-install");
  if (isGatekeptInstallEnabled()) {
    throw new SideBySideInstallError(
      "GATEKEPT_PATH",
      `side-by-side install of ${packageName}@${version} refused — gatekept install is enabled ` +
        `and the gatekept path keeps the hard installed-version-conflict refusal (ratified ` +
        `Option-B contract). The planner only emits side-by-side members on the non-gatekept ` +
        `path; reaching this refusal means the environment flipped between planning and execution.`,
    );
  }
  if (!SUPPORTED_KINDS.has(typeId)) {
    throw new SideBySideInstallError(
      "UNSUPPORTED_KIND",
      `side-by-side install of ${packageName}@${version} refused — kind "${typeId}" is not ` +
        `supported for storage-level side-by-side in this slice (the workflow kind's install is ` +
        `saga-owned and creates workflow-native state).`,
    );
  }
  const { isExactVersion } = await import("@cinatra-ai/registries");
  if (version === "0.0.0" || !isExactVersion(version)) {
    // '0.0.0' is the legacy/default journal namespace (core__0022 backfill
    // floor) — a side-by-side install there would collide with the default
    // install's anchor supersession.
    throw new SideBySideInstallError(
      "INVALID_VERSION",
      `side-by-side install of ${packageName}@"${version}" refused — the version must be a ` +
        `concrete exact version (and never the '0.0.0' legacy journal namespace).`,
    );
  }
  const { isPackageRequiredInProd, checkRequiredExtensionVersionPin } = await import(
    "@cinatra-ai/extensions/required-in-prod"
  );
  if (isPackageRequiredInProd(packageName)) {
    throw new SideBySideInstallError(
      "REQUIRED_IN_PROD",
      `side-by-side install of ${packageName}@${version} refused — required-in-prod packages ` +
        `are host-lock-pinned (a second live version is out of scope for this slice).`,
    );
  }
  const pin = checkRequiredExtensionVersionPin({ packageName, version, op: "install" });
  if (!pin.ok) throw new SideBySideInstallError("HOST_PIN_VIOLATION", pin.reason);

  const { readInstalledExtensionsByPackageName } = await import(
    "@cinatra-ai/extensions/canonical-store"
  );
  const rows = await readInstalledExtensionsByPackageName(packageName);
  const scopeRows = rows.filter(
    (r) =>
      (r.status === "active" || r.status === "locked") && (r.organizationId ?? null) === orgId,
  );
  const defaults = scopeRows.filter((r) => r.isDefault !== false);
  if (defaults.length !== 1) {
    throw new SideBySideInstallError(
      "NO_DEFAULT_SIBLING",
      `side-by-side install of ${packageName}@${version} refused — expected exactly one live ` +
        `DEFAULT row in scope (found ${defaults.length}); a side-by-side version only exists ` +
        `NEXT TO a healthy default install.`,
    );
  }
  // The default must be journal-anchored (finalized) — a broken default is a
  // retry/repair concern for the package-scoped path, not a side-by-side base.
  const { readInstallOp, readInstallOpForVersion, advanceInstallOpPhase } = await import(
    "@/lib/extension-install-ops"
  );
  const defaultOp = await readInstallOp(packageName, orgId);
  if (defaultOp?.phase !== "finalized") {
    throw new SideBySideInstallError(
      "DEFAULT_NOT_ANCHORED",
      `side-by-side install of ${packageName}@${version} refused — the default install's ` +
        `journal is not finalized (${defaultOp?.phase ?? "no journal row"}); repair or re-install ` +
        `the default first.`,
    );
  }

  // ---- IDEMPOTENCE / BROKEN-ATTEMPT RETRY ---------------------------------
  const existing = scopeRows.find(
    (r) => r.isDefault === false && (r.version ?? null) === version,
  );
  const existingOp = existing
    ? await readInstallOpForVersion(packageName, orgId, version)
    : null;
  if (existing && existingOp?.phase === "finalized") {
    return { rowId: existing.id }; // already installed side-by-side at this pin
  }

  // ---- PLACEHOLDER ROW (non-default; retried broken attempts reuse theirs) -
  const { installExtensionManifest, deleteSideBySideVersionRow } = await import(
    "@cinatra-ai/extensions/lifecycle-primitive"
  );
  let rowId: string;
  let createdThisAttempt = false;
  if (existing) {
    rowId = existing.id;
  } else {
    rowId = `iext_${randomUUID().slice(0, 12)}`;
    createdThisAttempt = true;
    await installExtensionManifest(
      {
        id: rowId,
        packageName,
        ownerLevel: orgId ? "organization" : "platform",
        ownerId: orgId,
        organizationId: orgId,
        kind: typeId as never,
        source: {
          type: "verdaccio",
          registryUrl: "http://localhost:4873",
          packageName,
          version,
          integrity: "dispatcher-install",
        },
        requiredInProd: false,
        // SEED ONLY: the real manifest edges land at the pipeline's finalize
        // seam (row-bound persistDependencyEdges) with write-time resolution.
        dependencies: [],
        manifestHash: null,
        status: "active",
        version,
        isDefault: false,
      },
      {
        actor: { source: "runtime-installer", ...(input.actorUserId ? { userId: input.actorUserId } : {}) },
        reason: `side-by-side install @ ${version} (cinatra#1040 S3)`,
      },
    );
  }

  // ---- REAL PIPELINE, ROW-BOUND + VERSION-SCOPED --------------------------
  // cinatra#1391 ports axis: armed INSIDE the ports-union mutation path (BEFORE
  // the grant write is awaited — the write may commit and then reject); the
  // catch below runs it to restore the shared grant on DIRECT failure, still
  // under this install's per-package lock. (Holder object: the assignment
  // happens inside a deps closure, which TS flow analysis cannot track.)
  const portsFailure: { restore: (() => Promise<void>) | null } = { restore: null };
  try {
    const { installExtensionFromRegistry, makeDefaultInstallPipelineDeps } = await import(
      "@/lib/extension-install-pipeline"
    );
    const { makeCanonicalRowInstallDeps } = await import(
      "@/lib/extension-install-canonical-row-deps"
    );
    const { beginInstallOp } = await import("@/lib/extension-install-ops");
    const base = await makeDefaultInstallPipelineDeps();

    // ---- cinatra#1040 S6 / cinatra#1391: shared-grant UNIONs ----------------
    // Injected `grantUnion` ENABLES the non-refusing unions on BOTH axes —
    // capability-OWNERSHIP (per-key, declaration capsule + survivor-aware
    // unwind) and host-PORTS (one shared row, prior-state capsule + hash-guarded
    // reconcile); its ABSENCE keeps the S3 DECLARES_OWNERSHIP_KEYS +
    // PORTS_NOT_COVERED refusals.
    const grantUnion = input.grantUnion;
    let survivorKeysCache: Promise<Set<string>> | null = null;
    const readSurvivorKeys = (): Promise<Set<string>> =>
      (survivorKeysCache ??= (
        grantUnion?.readSurvivorOwnershipKeys ??
        ((v: string) => defaultReadSurvivorOwnershipKeys(packageName, orgId, v))
      )(version));
    const readSiblingPorts = (): Promise<string[]> =>
      (
        grantUnion?.readSiblingDeclaredPorts ??
        ((v: string) => defaultReadSiblingDeclaredHostPorts(packageName, orgId, v))
      )(version);
    // MERGED capsule accumulation: up to two capture events (ownership keys,
    // ports prior state) persist the full merged capsule each time — the
    // durable ledger value is always a superset of what has been mutated so
    // far; `portsPrior` is first-capture-wins inside the merge.
    let capsuleAcc: SideBySideGrantCapsule | null = null;
    const persistMergedCapsule = async (
      patch: Parameters<typeof mergeSideBySideGrantCapsule>[1],
    ): Promise<void> => {
      if (!grantUnion) return;
      const merged = mergeSideBySideGrantCapsule(capsuleAcc, patch);
      if (!merged) return;
      capsuleAcc = merged;
      await grantUnion.persistCapsule(merged);
    };
    const ownershipUnionDeps: Partial<typeof base> = grantUnion
      ? {
          // RECORD the per-key union via base's REAL recorder (left untouched
          // here): an unchanged key stays approved, a genuinely-new key pends.
          // SUPPRESS auto-approve — a side-by-side declarer never auto-becomes
          // an approved credential-store owner.
          approveOwnershipGrant: async () => undefined,
          // DEFER the coupled widget-metadata axis to the serving follow-up: a
          // side-by-side version serves NO runtime surface pre-S7, so its
          // metadata grant is not recorded here and its unwind is inert.
          recordWidgetStreamMetadataGrant: async () => undefined,
          restoreWidgetStreamMetadataGrant: async () => undefined,
          deleteUnapprovedWidgetStreamMetadataGrant: async () => undefined,
          // NEVER restore a prior ownership approval on unwind (round-1
          // resurrection hole; a fresh side-by-side install captures none).
          restoreOwnershipGrant: async () => undefined,
          // Capture the DECLARATION CAPSULE the moment the pipeline reads the
          // declared keys — DURABLE, BEFORE any recordRequestedOwnershipGrant.
          // Persists the MERGED capsule (the ports axis may capture too).
          readWidgetAuthTokenKeys: async (storeDir) => {
            const keys = base.readWidgetAuthTokenKeys
              ? await base.readWidgetAuthTokenKeys(storeDir)
              : [];
            if (keys.length > 0) await persistMergedCapsule({ declaredTokenKeys: keys });
            return keys;
          },
          // SURVIVOR-AWARE revoke: the pipeline's fresh-install unwind
          // (DIRECT-FAILURE path) calls this per declared key — revoke ONLY when
          // no surviving finalized sibling still declares it (else the shared
          // key is still owned). Runs under the install's per-package lock.
          revokeOwnershipGrant: async (g) => {
            const survivors = await readSurvivorKeys();
            if (survivors.has(g.tokenConfigKey)) return;
            if (base.revokeOwnershipGrant) await base.revokeOwnershipGrant(g);
          },
        }
      : {
          // S3 refusal preserved: no durable capsule sink → never mutate the
          // shared ownership grant from a non-default install.
          recordRequestedOwnershipGrant: async (g) => {
            throw new SideBySideInstallError(
              "DECLARES_OWNERSHIP_KEYS",
              `side-by-side install of ${g.packageName}@${version} refused — it declares ` +
                `widget-auth token ownership ("${g.tokenConfigKey}"), which is package-scoped ` +
                `shared state; enabling the ownership union requires the durable capsule sink.`,
            );
          },
        };

    const deps: typeof base = {
      ...base,
      // Canonical-row reads/writes bound to THE NEW ROW; the package-scoped
      // `current` digest mirror stays owned by the default version.
      ...makeCanonicalRowInstallDeps({
        provenanceRegistryUrl: (requestUrl) => requestUrl,
        boundRowId: rowId,
        mirrorCurrentDigest: false,
      }),
      // Version-scoped journal namespace (core__0022): begin writes the real
      // pin; the finalize supersession demotes only ops of the SAME version;
      // the prior-op read observes only this version's namespace (fresh-install
      // semantics — never the default's anchor).
      beginInstallOp: (b) => beginInstallOp({ ...b, version }).then(() => undefined),
      readInstallOp: (pkg, oid) => readInstallOpForVersion(pkg, oid, version),
      // SHARED-STATE DISCIPLINE: host-port grants are ONE row per (package,
      // org), shared with the default install. cinatra#1391: with `grantUnion`
      // injected the S3 refusal LIFTS into the per-scope UNION — capture the
      // prior grant state into the DURABLE capsule, then record the union
      // through the REAL recorder (unchanged hash keeps the approval; a grown
      // union pends for the union-aware re-approval surface; finalize proceeds
      // with the grant pending — fail-closed, no runtime port is conveyed
      // until re-approval). Without hooks the S3 refusal stands.
      recordRequestedGrant: grantUnion
        ? async (g) => {
            if (g.requestedPorts.length === 0) return; // no ports axis → no shared-grant mutation
            const { computeRequestedPortsHash } = await import(
              "@/lib/extension-host-port-grants"
            );
            const siblingPorts = await readSiblingPorts();
            const union = Array.from(
              new Set([...siblingPorts, ...g.requestedPorts.map((p) => String(p))]),
            ).sort();
            const prior = await base.readGrantForScope(g.packageName, g.orgId);
            if (prior && prior.requestedPortsHash === computeRequestedPortsHash(union)) {
              return; // union already recorded (covered) — no mutation, no capture
            }
            const priorState: SideBySidePortsPriorState = prior
              ? {
                  exists: true,
                  status: prior.status as "pending" | "approved" | "revoked",
                  approvedPorts: [...prior.approvedPorts].sort(),
                  requestedPortsHash: prior.requestedPortsHash,
                  approvedBy: prior.approvedBy ?? null,
                }
              : { exists: false };
            // DURABLE capture BEFORE the mutation; the restore hook is armed
            // BEFORE the write is awaited (the statement may commit and then
            // reject — the catch must treat it as mutated either way).
            await persistMergedCapsule({
              declaredPorts: g.requestedPorts.map((p) => String(p)),
              portsPrior: priorState,
            });
            portsFailure.restore = async () => {
              if (priorState.exists) {
                await base.restoreGrant?.({
                  packageName: g.packageName,
                  orgId: g.orgId,
                  status: priorState.status as "pending" | "approved" | "revoked",
                  approvedPorts: [...(priorState.approvedPorts ?? [])],
                  requestedPortsHash: priorState.requestedPortsHash as string,
                  approvedBy: priorState.approvedBy ?? null,
                });
              } else {
                // No prior row to restore — correct the request to the
                // sibling-only union (a pending row conveys no ports).
                const survivors = await readSiblingPorts();
                await base.recordRequestedGrant({
                  packageName: g.packageName,
                  orgId: g.orgId,
                  requestedPorts: survivors,
                });
              }
            };
            await base.recordRequestedGrant({
              packageName: g.packageName,
              orgId: g.orgId,
              requestedPorts: union,
            });
          }
        : async (g) => {
            if (g.requestedPorts.length === 0) return;
            const grant = await base.readGrantForScope(g.packageName, g.orgId);
            const approved =
              grant && grant.status === "approved" ? new Set(grant.approvedPorts) : null;
            if (approved && g.requestedPorts.every((p) => approved.has(p))) return;
            throw new SideBySideInstallError(
              "PORTS_NOT_COVERED",
              `side-by-side install of ${g.packageName}@${version} refused — it requests host ` +
                `ports [${g.requestedPorts.join(", ")}] not covered by the scope's approved ` +
                `grant, and no durable grant-union capsule sink was injected. Approve the ` +
                `ports on the default install first, then retry.`,
            );
          },
      // NEVER auto-approve from a side-by-side install (either axis): a grown
      // union pends for the union-aware re-approval surface.
      approveGrant: async () => undefined,
      // cinatra#1040 S6: capability-OWNERSHIP grant union (or the preserved S3
      // refusal when no capsule sink is injected). Built above; spread AFTER
      // `...base` so it overrides the base ownership hooks.
      ...ownershipUnionDeps,
      // cinatra#1040 S5 — cross-version migration UNION lifts the S3
      // DECLARES_MIGRATIONS refusal: a side-by-side version MAY now declare host
      // migrations (`cinatra.migrationsDir`). We still run the base preflight so
      // its VALIDATION stands (containment / namespace / retired-JSON-DSL reject)
      // and its `true` return lets the pipeline's own trust gate reject an
      // UNSIGNED migration-declaring candidate BEFORE finalize — an unsigned
      // sibling must never durably poison the shared package schema (codex Q2).
      // No refusal for a SIGNED declarer.
      preflightMigrations: async (i) => (await base.preflightMigrations?.(i)) ?? false,
      // Application is DEFERRED to the loader's ordered union
      // (`applyMigrationUnionForTrustedRecords`) at boot/activation: migrations
      // are a per-package append-only namespace, so this new version's dir joins
      // the ordered (semver asc, filename) union with the default + siblings, and
      // the shared ledger dedupes (codex Q6: no double-application). Applying at
      // install would run this non-default version's DDL out of the cross-version
      // order — a no-op at install keeps the ordering owned by the union seam.
      applyMigrations: async () => undefined,
      // NO in-process activation — versioned runtime activation is S4. The
      // finalized row is durable; the S4 loader slice makes it addressable.
      activateInProcess: async () => ({
        activated: false,
        reason: "side-by-side version — activation deferred to versioned loader anchors (cinatra#1040 S4)",
      }),
    };
    await installExtensionFromRegistry(
      {
        packageName,
        version,
        orgId,
        actorUserId: input.actorUserId ?? null,
        // Stable per-(package, version, scope) op id: a retry of the SAME
        // side-by-side attempt resumes/reset its own journal row.
        installOpId: `sbs:${packageName}@${version}:${orgId ?? "(global)"}`,
        expectedKind: typeId as ExtensionStoreKind,
      },
      deps,
    );
    return { rowId };
  } catch (err) {
    // cinatra#1391: DIRECT-FAILURE restore of the shared host-port grant —
    // armed only when this attempt actually reached the union mutation. Still
    // under this install's per-package lock, so no admin decision or sibling
    // lifecycle can have interleaved: the exact captured prior state is the
    // correct restore target. Best-effort — a failure here leaves the durable
    // capsule on the ledger member for batch-compensation / boot-recovery to
    // reconcile; never masks the original error.
    if (portsFailure.restore) {
      try {
        await portsFailure.restore();
      } catch (restoreErr) {
        console.warn(
          `[side-by-side-capsule] direct-failure restore of the host-port grant for ` +
            `${packageName}@${version} failed (the durable capsule remains for ` +
            `compensation/boot recovery):`,
          restoreErr instanceof Error ? restoreErr.message : restoreErr,
        );
      }
    }
    // Roll back the placeholder THIS attempt created when the pipeline did not
    // finalize (version-scoped check — the versionless journal signal would see
    // the DEFAULT's finalized op and wrongly protect the placeholder).
    if (createdThisAttempt) {
      try {
        const op = await readInstallOpForVersion(packageName, orgId, version);
        if (op?.phase !== "finalized") {
          await deleteSideBySideVersionRow(rowId);
          if (op) await advanceInstallOpPhase({ installOpId: op.installOpId, phase: "rolled_back" });
        }
      } catch (rollbackErr) {
        console.warn(
          `[side-by-side-install] rollback of non-finalized side-by-side row '${rowId}' failed ` +
            `(left non-anchorable; a retry re-runs the pipeline):`,
          rollbackErr instanceof Error ? rollbackErr.message : rollbackErr,
        );
      }
    }
    throw err;
  }
}

/**
 * The COMPENSATION INVERSE (and boot-sweeper teardown) for a side-by-side
 * member: version-scoped, never touches the default install. Idempotent — a
 * missing row is a no-op. Runs under the per-package install lock.
 */
export async function uninstallExtensionVersionSideBySide(input: {
  packageName: string;
  version: string;
  orgId: string | null;
  /** cinatra#1040 S6 / cinatra#1391: the DURABLE capsule of the version being
   * torn down (from the batch ledger member; parsed TOLERANTLY here — the
   * ledger value is untrusted JSONB). Ownership keys reconcile against the
   * survivor set (survivor-check + revoke); the ports axis reconciles the
   * shared grant against the recomputed survivor union (hash-guarded prior
   * restore / narrow / pending ladder). A legacy/absent capsule → live-store
   * fallback reads decide whether anything needs reconciling. */
  capsule?: SideBySideGrantCapsule | null;
  /** Survivor reader override (tests); defaults to the fs+db reader. */
  readSurvivorOwnershipKeys?: (excludeVersion: string) => Promise<Set<string>>;
  /** Torn-down-version declared-keys reader override (tests) — the capsule-absent
   * fallback; defaults to reading the version's own live store manifest. */
  readTornDownDeclaredKeys?: () => Promise<string[]>;
  /** Ports survivor-union reader override (tests); defaults to the
   * journal-gated `defaultReadSiblingDeclaredHostPorts`. */
  readSurvivorDeclaredPorts?: (excludeVersion: string) => Promise<string[]>;
  /** Torn-down-version declared-ports reader override (tests) — the
   * capsule-absent trigger fallback; defaults to the live store manifest. */
  readTornDownDeclaredPorts?: () => Promise<string[]>;
}): Promise<{ removed: boolean }> {
  const { withInstallLock } = await import("@cinatra-ai/agents");
  return withInstallLock(input.packageName, async () => {
    const { packageName, version, orgId } = input;
    if (version === "0.0.0") {
      throw new SideBySideInstallError(
        "INVALID_VERSION",
        `side-by-side teardown of ${packageName}@"${version}" refused — '0.0.0' is the ` +
          `legacy/default namespace, never a side-by-side row.`,
      );
    }
    const { readInstalledExtensionsByPackageName } = await import(
      "@cinatra-ai/extensions/canonical-store"
    );
    const rows = await readInstalledExtensionsByPackageName(packageName);
    const row = rows.find(
      (r) =>
        (r.organizationId ?? null) === orgId &&
        r.isDefault === false &&
        (r.version ?? null) === version &&
        (r.status === "active" || r.status === "locked"),
    );
    const { readInstallOpForVersion, advanceInstallOpPhase } = await import(
      "@/lib/extension-install-ops"
    );
    if (row) {
      const { deleteSideBySideVersionRow } = await import(
        "@cinatra-ai/extensions/lifecycle-primitive"
      );
      await deleteSideBySideVersionRow(row.id);
    }
    // Terminalize the version-scoped journal op so it can never be mistaken
    // for an anchor (best-effort; the versionless default anchor is untouched).
    try {
      const op = await readInstallOpForVersion(packageName, orgId, version);
      if (op && op.phase !== "rolled_back") {
        await advanceInstallOpPhase({ installOpId: op.installOpId, phase: "rolled_back" });
      }
    } catch (err) {
      console.warn(
        `[side-by-side-install] terminalizing the journal op for ${packageName}@${version} failed:`,
        err instanceof Error ? err.message : err,
      );
    }

    // ---- cinatra#1040 S6: reconcile the shared OWNERSHIP grants -------------
    // A removed side-by-side version must not leave a key it declared owned when
    // no surviving sibling still declares it. The survivor set is read HERE —
    // under this per-package lock, AFTER the row teardown above — so concurrent
    // same-package teardowns serialize and the LAST teardown of a package
    // revokes an orphaned key (never restores a prior approval: round-1
    // resurrection-hole fix). Best-effort; never masks the teardown result.
    //
    // WHAT THE VERSION DECLARED: the DURABLE capsule (batch-compensation /
    // boot-recovery — survives a crash / store GC) OR, when NO capsule is present
    // (an EXPLICIT uninstall of a committed version whose capsule was released on
    // batch finalize — codex#1391 finding), a LIVE fallback read of the version's
    // own store manifest, so an explicitly-removed version can never orphan a key.
    // The ledger value is untrusted JSONB → tolerant boundary parse (never a throw).
    const capsule = parseSideBySideGrantCapsule(input.capsule ?? null);
    try {
      let declaredTokenKeys: string[] = capsule?.declaredTokenKeys ?? [];
      if (!capsule && row) {
        declaredTokenKeys = input.readTornDownDeclaredKeys
          ? await input.readTornDownDeclaredKeys()
          : await readTornDownVersionDeclaredKeys(packageName, row);
      }
      if (declaredTokenKeys.length > 0) {
        const readSurvivor =
          input.readSurvivorOwnershipKeys ??
          ((v: string) => defaultReadSurvivorOwnershipKeys(packageName, orgId, v));
        const survivorKeys = await readSurvivor(version);
        const { revokeOwnershipGrant } = await import(
          "@/lib/extension-capability-ownership-grants"
        );
        const res = await reconcileSideBySideOwnershipOnTeardown({
          packageName,
          orgId,
          declaredTokenKeys,
          survivorKeys,
          revokeOwnershipGrant: (g) => revokeOwnershipGrant(g).then(() => undefined),
          onFailure: (key, e) =>
            console.warn(
              `[side-by-side-capsule] revoke of orphaned ownership key '${key}' for ` +
                `${packageName}@${version} failed:`,
              e instanceof Error ? e.message : e,
            ),
        });
        if (res.revoked.length > 0) {
          console.warn(
            `[side-by-side-capsule] ${packageName}@${version} teardown revoked orphaned ` +
              `ownership key(s): ${res.revoked.join(", ")}`,
          );
        }
      }
    } catch (err) {
      console.warn(
        `[side-by-side-capsule] ownership reconcile for ${packageName}@${version} teardown failed:`,
        err instanceof Error ? err.message : err,
      );
    }

    // ---- cinatra#1391: reconcile the SHARED host-port grant -----------------
    // A removed side-by-side version must not leave stale union ports on the
    // shared per-(package, org) row, and the common (LIFO) teardown must
    // recover the default's approved grant instead of leaving it stuck
    // `pending`. The survivor union is RECOMPUTED here — under this
    // per-package lock, AFTER the row teardown above (journal-gated
    // digest-bound reads) — and the ladder in
    // `reconcileSideBySidePortsOnTeardown` decides: no-op / hash-guarded exact
    // prior restore / covered narrow / kept-revoked / corrected pending.
    // TRIGGER: the capsule's declaredPorts/portsPrior, or (capsule released on
    // batch finalize — explicit uninstall) a live fallback read of the
    // version's own store. Best-effort; never masks the teardown result.
    try {
      let declaredPorts: string[] = capsule?.declaredPorts ?? [];
      if ((!capsule || capsule.declaredPorts === undefined) && row) {
        declaredPorts = input.readTornDownDeclaredPorts
          ? await input.readTornDownDeclaredPorts()
          : await readTornDownVersionDeclaredPorts(packageName, row);
      }
      const portsPrior = capsule?.portsPrior ?? null;
      if (declaredPorts.length > 0 || portsPrior) {
        const readSurvivorPorts =
          input.readSurvivorDeclaredPorts ??
          ((v: string) => defaultReadSiblingDeclaredHostPorts(packageName, orgId, v));
        const survivorPorts = await readSurvivorPorts(version);
        const grants = await import("@/lib/extension-host-port-grants");
        const res = await reconcileSideBySidePortsOnTeardown({
          packageName,
          orgId,
          portsPrior,
          survivorPorts,
          computeHash: grants.computeRequestedPortsHash,
          readGrantForScope: async () => {
            const g = await grants.readGrantForScope({ packageName, orgId });
            return g
              ? {
                  status: g.status,
                  approvedPorts: g.approvedPorts,
                  requestedPortsHash: g.requestedPortsHash,
                  approvedBy: g.approvedBy,
                }
              : null;
          },
          restoreGrant: (i) =>
            grants
              .restoreGrant({ packageName, orgId, ...i })
              .then(() => undefined),
          recordRequestedGrant: (ports) =>
            grants
              .recordRequestedGrant({
                packageName,
                orgId,
                requestedPorts: ports as unknown as readonly import("@cinatra-ai/sdk-extensions").HostPortName[],
              })
              .then(() => undefined),
        });
        if (res.action !== "noop") {
          console.warn(
            `[side-by-side-capsule] ${packageName}@${version} teardown reconciled the shared ` +
              `host-port grant: ${res.action}`,
          );
        }
      }
    } catch (err) {
      console.warn(
        `[side-by-side-capsule] ports reconcile for ${packageName}@${version} teardown failed:`,
        err instanceof Error ? err.message : err,
      );
    }
    return { removed: Boolean(row) };
  });
}
