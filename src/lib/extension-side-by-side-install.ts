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
//   - Host-port grants + capability-OWNERSHIP grants: STILL refuse here
//     (PORTS_NOT_COVERED / DECLARES_OWNERSHIP_KEYS). Their non-refusing grant
//     UNION needs a DURABLE rollback capsule reconciled through batch
//     compensation, boot recovery, and orphan GC (codex round-1 D1-D3) — a
//     dedicated slice (S6), not this migration-union slice.
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
// TYPE from the ledger module (already in the install route graph); the runtime
// capsule module is reached ONLY via dynamic import (route-graph-ratchet).
import type { SideBySideGrantCapsule } from "@/lib/extension-install-batch-ops";

/**
 * Ownership grant-UNION hooks a caller (the dependency-batch saga) injects to
 * ENABLE the non-refusing capability-ownership union (cinatra#1040 S6). Their
 * presence lifts the S3 `DECLARES_OWNERSHIP_KEYS` refusal; their ABSENCE keeps
 * it (fail-closed — a side-by-side install must never mutate the shared
 * ownership grant without a durable capsule to reconcile it on teardown).
 * PORTS stay refused regardless (deferred: a grown ports union pends the shared
 * per-(package,org) grant and would degrade the running default with no
 * re-approval surface).
 */
export type SideBySideGrantUnionHooks = {
  /** Persist the declaration capsule DURABLY (idempotent, first-capture-wins)
   * BEFORE any ownership-grant mutation. Production: the batch ledger member's
   * `grantCapsule` (JSONB). The capsule records WHAT this version declared, so a
   * later batch-compensation / boot-recovery teardown can reconcile the shared
   * grant even when this version's store is gone. */
  persistCapsule: (capsule: SideBySideGrantCapsule) => Promise<void>;
  /** Read the ownership keys declared by the CURRENTLY-finalized siblings
   * (excluding `excludeVersion`) — the survivor set the teardown/unwind consults.
   * Defaults to the real fs+db reader (`defaultReadSurvivorOwnershipKeys`);
   * injected in tests. */
  readSurvivorOwnershipKeys?: (excludeVersion: string) => Promise<Set<string>>;
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
 * shape drift (garbage → null, never a throw). */
export function parseSideBySideGrantCapsule(value: unknown): SideBySideGrantCapsule | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { v?: unknown; declaredTokenKeys?: unknown };
  if (v.v !== 1) return null;
  if (!Array.isArray(v.declaredTokenKeys)) return null;
  const keys = Array.from(
    new Set(v.declaredTokenKeys.filter((k): k is string => typeof k === "string")),
  ).sort();
  return { v: 1, declaredTokenKeys: keys };
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
  try {
    const { installExtensionFromRegistry, makeDefaultInstallPipelineDeps } = await import(
      "@/lib/extension-install-pipeline"
    );
    const { makeCanonicalRowInstallDeps } = await import(
      "@/lib/extension-install-canonical-row-deps"
    );
    const { beginInstallOp } = await import("@/lib/extension-install-ops");
    const base = await makeDefaultInstallPipelineDeps();

    // ---- cinatra#1040 S6: capability-OWNERSHIP grant UNION ------------------
    // Injected `grantUnion` ENABLES the non-refusing per-key union (a durable
    // declaration capsule captured BEFORE any mutation + a survivor-aware
    // unwind); its ABSENCE keeps the S3 DECLARES_OWNERSHIP_KEYS refusal. PORTS
    // stay refused either way (deferred slice).
    const grantUnion = input.grantUnion;
    let survivorKeysCache: Promise<Set<string>> | null = null;
    const readSurvivorKeys = (): Promise<Set<string>> =>
      (survivorKeysCache ??= (
        grantUnion?.readSurvivorOwnershipKeys ??
        ((v: string) => defaultReadSurvivorOwnershipKeys(packageName, orgId, v))
      )(version));
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
          readWidgetAuthTokenKeys: async (storeDir) => {
            const keys = base.readWidgetAuthTokenKeys
              ? await base.readWidgetAuthTokenKeys(storeDir)
              : [];
            const capsule = buildSideBySideGrantCapsule(keys);
            if (capsule) await grantUnion.persistCapsule(capsule);
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
      // SHARED-STATE DISCIPLINE: host-port grants are per (package, org) and
      // owned by the default install. Empty request → no-op; request covered
      // by the scope's APPROVED grant → no-op; anything else → refuse (the
      // grant-union + reset-on-change choreography is the S4/S5 slice).
      recordRequestedGrant: async (g) => {
        if (g.requestedPorts.length === 0) return;
        const grant = await base.readGrantForScope(g.packageName, g.orgId);
        const approved =
          grant && grant.status === "approved" ? new Set(grant.approvedPorts) : null;
        if (approved && g.requestedPorts.every((p) => approved.has(p))) return;
        throw new SideBySideInstallError(
          "PORTS_NOT_COVERED",
          `side-by-side install of ${g.packageName}@${version} refused — it requests host ` +
            `ports [${g.requestedPorts.join(", ")}] not covered by the scope's approved ` +
            `grant; the per-scope grant union is a later slice. Approve the ports on the ` +
            `default install first, then retry.`,
        );
      },
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
  /** cinatra#1040 S6: the DURABLE declaration capsule of the version being torn
   * down (from the batch ledger member). When present, its declared ownership
   * keys are reconciled against the survivor set (survivor-check + revoke). A
   * legacy/absent capsule → no ownership reconcile (nothing was mutated). */
  capsule?: SideBySideGrantCapsule | null;
  /** Survivor reader override (tests); defaults to the fs+db reader. */
  readSurvivorOwnershipKeys?: (excludeVersion: string) => Promise<Set<string>>;
  /** Torn-down-version declared-keys reader override (tests) — the capsule-absent
   * fallback; defaults to reading the version's own live store manifest. */
  readTornDownDeclaredKeys?: () => Promise<string[]>;
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
    try {
      let declaredTokenKeys: string[] = input.capsule?.declaredTokenKeys ?? [];
      if (!input.capsule && row) {
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
    return { removed: Boolean(row) };
  });
}
