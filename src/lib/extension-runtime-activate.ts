import "server-only";

// Host-side hot-activate / hot-update orchestration (the production caller
// that closes the runtime-installer loop).
//
// The dispatcher (`@cinatra-ai/extensions` registry.install) fires the injected
// `ExtensionActivateHook` after a verdaccio-source NEW install commits. The host
// wires that hook to `runHostExtensionInstallAndActivate` below, which:
//   1. resolves the canonical install row (the verdaccio source + version);
//   2. runs the REAL-integrity install pipeline (`installExtensionFromRegistry`)
//      so the placeholder `dispatcher-install` provenance is REPLACED by the
//      real sha512 SRI + content hash, the package is materialized into the
//      on-disk store, the host-port grant is recorded/auto-approved, the
//      extension migrations run, and the install-op journal is FINALIZED — the
//      transition that makes the trusted anchor resolve the row;
//   3. targeted-activates the package in-process via `loadRuntimePackageExtensions`
//      ({ onlyPackage }) through the SAME shared activation driver the boot
//      loader uses — so the running process picks it up WITHOUT a restart.
//
// HOT-UPDATE (new digest): when a previously-materialized digest already exists
// for the package, the activator GCs the superseded store dir(s) (so the
// runtime loader's fail-closed duplicate-name gate never sees two dirs for one
// package), fires the (async) capability teardown for the old package AND calls
// `destroyExtensionModule` on the old module BEFORE re-activating the new digest.
// A same-digest re-activate is idempotent (the in-memory registries replace by
// id/package).
//
// FAIL-CLOSED PRESERVED: this never bypasses the anchor/loader trust gates. The
// pipeline finalizes the journal LATE, and the loader still refuses any package
// whose trusted anchor does not resolve (non-finalized, placeholder integrity,
// unapproved grant, integrity mismatch). Activation runs ONLY after finalize.
//
// BEST-EFFORT: every step is wrapped so a registry-unreachable / activation
// failure NEVER rolls back the already-committed install (the boot loader is the
// durable path; this is the no-restart convenience on top).

import {
  DEFAULT_PACKAGE_STORE_PATH,
  classifyServerEntryArtifact,
  destroyExtensionModule,
  normalizeServerModule,
  resolveServerEntryPath,
  type ActivationResult,
  type ExtensionModule,
  type PackageStoreRecord,
} from "@cinatra-ai/sdk-extensions";
import type { ExtensionActivateResult } from "@cinatra-ai/extensions";

/**
 * Targeted in-process activation for a SINGLE package, after its trusted anchor
 * is resolvable (real provenance recorded + journal finalized + grant approved).
 *
 * Drives the package through the SAME `loadRuntimePackageExtensions` path the
 * boot loader uses, scoped to `onlyPackage`.
 *
 * HOT-UPDATE SAFETY (the order matters): when a superseded digest exists (the
 * UPDATE case), the new digest is PROVEN importable + integrity-verified FIRST —
 * BEFORE the old digest is torn down / destroyed / GC'd. A loader returns
 * structured results (it does NOT throw on a bad module), so the previous order
 * (GC old → activate new) would, for a bad new module, leave the old torn down +
 * its dir removed with nothing to fall back to. Now:
 *   1. (update only) verify the NEW digest imports + integrity-checks; if it does
 *      NOT, RETURN early leaving the old digest fully intact (in-memory + on-disk);
 *   2. teardown the OLD in-memory registrations + destroy the OLD module + GC the
 *      superseded dir(s) (so the loader's duplicate-name gate is satisfied);
 *   3. activate the NEW digest via the shared loader.
 *
 * Returns the loader's `ActivationResult[]` for the package (empty when the
 * anchor refuses it — fail-closed; or a single `skipped`/`failed` result when the
 * new digest fails the pre-verify on an update — old left intact).
 */
export async function activateInstalledPackageInProcess(
  packageName: string,
  orgId: string | null,
  opts: { currentStoreDir?: string; storeRoot?: string } = {},
): Promise<ActivationResult[]> {
  const storeRoot = opts.storeRoot ?? DEFAULT_PACKAGE_STORE_PATH;

  const { makeDefaultInstallAnchorResolver } = await import("@/lib/extension-install-anchor");
  const resolveInstallAnchor = await makeDefaultInstallAnchorResolver(orgId);

  // Detect a hot-UPDATE: any materialized store dir for this package that is NOT
  // the just-installed current digest. (Empty for a clean NEW install / a SAME-
  // digest re-activate.)
  const superseded = await discoverSupersededStoreDirs(packageName, storeRoot, opts.currentStoreDir);
  const isUpdate = superseded.length > 0;

  // (1) UPDATE pre-verify: prove the NEW digest imports + integrity-verifies
  // against its trusted anchor BEFORE we tear the old one down. If it does not,
  // leave the OLD digest fully intact and return a failure result — a bad new
  // module never strands the package with neither digest live.
  if (isUpdate) {
    const verify = await verifyNewDigestActivatable(packageName, orgId, storeRoot, opts.currentStoreDir, resolveInstallAnchor);
    if (!verify.ok) {
      console.warn(
        `[extension-runtime-activate] hot-update for "${packageName}" ABORTED before teardown — ` +
          `the new digest is not activatable (${verify.reason}); the previous digest is left intact.`,
      );
      return [{ packageName, status: "failed", reason: "register-threw" }];
    }
  }

  // Resolve the package's APPROVED host-port grant once so the OLD module's
  // `destroy(ctx)` runs against a ctx that has the SAME granted ports it
  // registered with. Host-port grants are package+org scoped (NOT
  // digest scoped), so the current anchor's approvedPorts apply to the old digest
  // too. A destroy hook that releases a resource via an approved port (e.g.
  // settings/secrets/jobs) would otherwise hit a NOT-GRANTED fail-loud ctx and its
  // release would silently fail. Best-effort: a refusing anchor → empty ports
  // (the destroy still runs; only ungranted ports fail loud, as in real activation).
  let destroyPorts: readonly import("@cinatra-ai/sdk-extensions").HostPortName[] = [];
  try {
    const anchor = await resolveInstallAnchor(packageName);
    destroyPorts = (anchor?.approvedPorts ?? []) as readonly import("@cinatra-ai/sdk-extensions").HostPortName[];
  } catch {
    destroyPorts = [];
  }

  // (2) HOT-UPDATE teardown + GC: drop in-memory state from a previous activation
  // of this package + destroy the old module(s) + remove superseded store dir(s)
  // so a single (current) dir remains for the loader's duplicate-name gate. For a
  // clean NEW install this still fires the (idempotent) capability teardown
  // defensively so a re-activate replaces rather than stacks.
  await teardownAndGcSupersededDigests(packageName, storeRoot, opts.currentStoreDir, superseded, destroyPorts);

  // (3) Activate the NEW digest through the SAME shared loader the boot path uses.
  const { loadRuntimePackageExtensions } = await import("@/lib/runtime-package-loader");
  const results = await loadRuntimePackageExtensions(storeRoot, {
    onlyPackage: packageName,
    resolveInstallAnchor,
  });

  // Self-MCP: the host's self-primitive handler map is memoised per process and
  // was captured BEFORE this package registered its primitives. Drop it AFTER the
  // activation pass so the next `ctx.mcp.callPrimitive` rebuild picks up the
  // newly-registered primitives. Non-fatal if the module is unavailable.
  try {
    const { __resetHostSelfPrimitiveHandlers } = await import("@/lib/extension-self-mcp");
    __resetHostSelfPrimitiveHandlers();
  } catch {
    /* self-mcp module unavailable (e.g. a worker) — non-fatal. */
  }

  return results;
}

/**
 * Pre-verify the NEW digest (the just-installed `currentStoreDir`) is safe to
 * activate BEFORE tearing the old digest down: its trusted anchor must resolve,
 * its materialized integrity must verify against THAT anchor, and its server
 * module must import (realpath-bound) + expose a `register` entry. Best-effort +
 * never throws — any failure → `{ ok:false, reason }` (old left intact).
 */
async function verifyNewDigestActivatable(
  packageName: string,
  orgId: string | null,
  storeRoot: string,
  currentStoreDir: string | undefined,
  resolveInstallAnchor: (pkg: string) => Promise<import("@/lib/extension-package-store").InstallTrustAnchor | null>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const anchor = await resolveInstallAnchor(packageName);
  if (!anchor) return { ok: false, reason: "no-trusted-anchor" };
  // The new digest must also be TRUSTED (grant approved) — a finalized-but-
  // unapproved row resolves an anchor with trustDecision:false; activating it
  // would tear the old digest down for a package that cannot register with its
  // requested ports. Refuse before teardown.
  if (!anchor.trustDecision) return { ok: false, reason: "anchor-not-trusted" };
  return verifyDigestImportsAndRegisters(packageName, storeRoot, currentStoreDir, {
    integrity: anchor.integrity,
    contentHash: anchor.contentHash,
    approvedPorts: anchor.approvedPorts ?? [],
  });
}

/**
 * The shared "prove a materialized digest activates" check, parameterized by the
 * trusted integrity/contentHash + approved ports DIRECTLY (not via the persisted
 * anchor). Exported so the install PIPELINE can prove a NEW update digest
 * registers BEFORE it records provenance / finalizes the journal:
 * the persisted-anchor variant (`verifyNewDigestActivatable`) cannot run
 * pre-finalize because the anchor refuses a non-finalized row, so the pre-finalize
 * caller supplies the in-flight integrity/contentHash + just-approved ports here.
 *
 * Discovers the target store record (the `currentStoreDir` record, or the sole
 * record for the package), integrity-verifies it against the supplied trusted
 * values, imports it (realpath-bound) + confirms a server entry, then PROVES
 * `register(ctx)` SUCCEEDS against an inert PROBE host ctx (no live registry
 * mutation; ungranted ports still fail loud). Never throws — any failure →
 * `{ ok:false, reason }`.
 */
export async function verifyDigestImportsAndRegisters(
  packageName: string,
  storeRoot: string,
  currentStoreDir: string | undefined,
  trusted: { integrity: string; contentHash: string; approvedPorts: readonly string[] },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const { discoverPackageStoreRecords, resolveServerEntry } = await import("@cinatra-ai/sdk-extensions");
    const all = await discoverPackageStoreRecords(storeRoot, await makeRealFs());
    // Target the new digest precisely: the currentStoreDir record (or, if not
    // supplied, the sole record for the package).
    const candidates = all.filter((r) => r.packageName === packageName);
    const rec = currentStoreDir
      ? candidates.find((r) => r.storeDir === currentStoreDir)
      : candidates.length === 1
        ? candidates[0]
        : undefined;
    if (!rec) return { ok: false, reason: "new-digest-record-not-found" };

    const { verifyMaterializedPackageIntegrity } = await import("@/lib/extension-package-store");
    const integrityOk = await verifyMaterializedPackageIntegrity(rec, {
      trustedIntegrity: trusted.integrity,
      trustedContentHash: trusted.contentHash,
    });
    if (!integrityOk) return { ok: false, reason: "integrity-mismatch" };

    // Import the module (realpath-bound) and confirm it exposes a server entry.
    // Importing only runs the module's top-level code (NOT `register(ctx)`).
    const mod = await importStoreModule(rec);
    if (!mod) return { ok: false, reason: "import-failed" };
    const server = resolveServerEntry(mod);
    if (!server) return { ok: false, reason: "no-server-entry" };

    // PROVE `register(ctx)` SUCCEEDS before tearing the old digest down — the
    // core invariant. A server-entry check alone does NOT prove activation: a
    // module can import + expose `register` yet throw inside it (a missing config,
    // a bad object-type descriptor, an ungranted host-port access). Run it against
    // a PROBE host ctx (inert register-channel sinks → NO live registry mutation;
    // every other port is the REAL grant-gated impl, so an ungranted access fails
    // loud exactly as in real activation). If `register` throws, ABORT the update
    // (the old digest is still fully intact — never torn down). Granted ports come
    // from the new digest's approved grant.
    try {
      const { createExtensionProbeHostContext } = await import("@/lib/extension-host-context");
      const { ctx } = createExtensionProbeHostContext(
        packageName,
        trusted.approvedPorts as import("@cinatra-ai/sdk-extensions").HostPortName[],
      );
      await server.register(ctx);
    } catch (err) {
      return {
        ok: false,
        reason: `register-threw:${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `verify-threw:${err instanceof Error ? err.message : String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// ATOMIC HOT-UPDATE WITH DURABLE-ROLLBACK-FIRST
//
// The pre-finalize probe can NEVER perfectly predict the live `register(ctx)`
// (it runs in a different process region — no jobs/notifications context, no
// peer capabilities, a fresh module-eval cache), so it is NOT the safety
// boundary. The boundary is this: an UPDATE guarantees the OLD version survives
// ANY bad new digest by being POST-COMMIT-ROLLBACKABLE.
//
// `hotUpdateWithDurableRollback` runs AFTER the pipeline has committed the NEW
// install (provenance + finalized journal + grant) and is the production caller
// for a superseding UPDATE. Order:
//   (a) QUARANTINE the OLD digest store dir (move it OUT of the discovery walk —
//       the loader refuses duplicate package names, so the old dir must not
//       co-exist as a live discovery, but it stays RECOVERABLE on disk);
//   (b) ACTIVATE the NEW digest in-process via the shared loader;
//   (c) NEW activates → GC the quarantined OLD dir → { activated:true };
//   (d) NEW FAILS → DURABLE ROLLBACK in order:
//         (i)   restore the OLD durable anchor (pipeline callback: re-record the
//               OLD provenance/source + re-finalize the OLD journal op + re-approve
//               the OLD host-port grant);
//         (ii)  tear down any PARTIAL new in-process registrations (capability
//               teardown for the package + destroy the new module if it loaded);
//         (iii) restore the OLD store dir from quarantine;
//         (iv)  best-effort re-activate the OLD digest in-process (now resolving the
//               restored OLD anchor);
//         (v)   return { activated:false, rolledBack:true, reason } — even if (iv)
//               fails, the DURABLE state points to OLD (recoverable at next boot),
//               never lost, never reported as success.
// ---------------------------------------------------------------------------

/**
 * The outcome of the OLD-durable-anchor restore (provenance + journal + grant).
 * `complete:true` ⇒ EVERY durable restore step that was applicable succeeded — the
 * OLD install is fully re-pinned (clean rollback). `complete:false` ⇒ at least one
 * step FAILED — the durable state is only PARTIALLY restored, so the caller MUST
 * NOT claim a clean rollback (it surfaces a manual-recovery signal instead). The
 * closure never throws; it records each step's success and returns this verdict.
 */
export type DurableRestoreOutcome = {
  complete: boolean;
  /** Names the failed restore step(s) when `complete` is false (truthful signal). */
  reason?: string;
};

export type HotUpdateRollbackDeps = {
  /**
   * Restore the OLD durable anchor (the pipeline owns these writers): re-record
   * the OLD provenance/source, re-`begin`+`finalize` the OLD install-op journal,
   * and re-approve the OLD host-port grant. Best-effort + must not throw (the
   * caller logs and proceeds). After this runs, a fresh `resolveInstallAnchor`
   * resolves the OLD install. Returns a `DurableRestoreOutcome` so the caller can
   * tell a CLEAN rollback (every step OK) from a PARTIAL one (≥1 step failed).
   */
  restoreDurableAnchor: () => Promise<DurableRestoreOutcome>;
};

export type HotUpdateActivateResult = {
  activated: boolean;
  /** True when the NEW digest failed live activation and OLD was durably restored. */
  rolledBack?: boolean;
  /**
   * When `rolledBack` is true: whether EVERY durable restore step succeeded. A
   * CLEAN rollback (the calm "previous version retained" path) requires `true`. A
   * `false` here means the durable state is only PARTIALLY restored — the caller
   * surfaces a LOUD manual-recovery signal, NOT a calm success. Undefined when not
   * a rollback.
   */
  rollbackComplete?: boolean;
  reason?: string;
};

/**
 * Atomic hot-UPDATE activation with durable-rollback-first. The
 * caller (pipeline) has ALREADY committed the new install durably; this picks it
 * up in-process and — if the live activation fails for ANY reason the probe
 * could not predict — durably rolls the anchor back to the OLD version.
 *
 * Returns `{ activated:true }` on success; `{ activated:false, rolledBack:true,
 * reason }` when the new digest could not activate and OLD was restored.
 */
export async function hotUpdateWithDurableRollback(
  packageName: string,
  orgId: string | null,
  newStoreDir: string,
  rollbackDeps: HotUpdateRollbackDeps,
  opts: { storeRoot?: string } = {},
): Promise<HotUpdateActivateResult> {
  const storeRoot = opts.storeRoot ?? DEFAULT_PACKAGE_STORE_PATH;

  const { makeDefaultInstallAnchorResolver } = await import("@/lib/extension-install-anchor");

  // The superseded OLD digest dir(s) — everything for this package that is NOT the
  // just-installed new digest. (Empty ⇒ no UPDATE; the caller routes those elsewhere.)
  const superseded = await discoverSupersededStoreDirs(packageName, storeRoot, newStoreDir);
  if (superseded.length === 0) {
    // Not actually an update on disk — fall back to a plain activation of the new
    // digest (no quarantine/rollback path).
    const resolver = await makeDefaultInstallAnchorResolver(orgId);
    const results = await loadOnlyPackage(storeRoot, packageName, resolver);
    return summarizeActivation(results, packageName);
  }

  // Resolve the package's APPROVED ports once so the OLD module's destroy(ctx) and
  // the partial-NEW teardown run against a ctx with the same granted ports the
  // package registered with. The anchor at this point resolves the NEW
  // (committed) install; its grant is package+org scoped (not digest scoped), so it
  // applies to the old digest too.
  const newResolver = await makeDefaultInstallAnchorResolver(orgId);
  let grantedPorts: readonly import("@cinatra-ai/sdk-extensions").HostPortName[] = [];
  try {
    const anchor = await newResolver(packageName);
    grantedPorts = (anchor?.approvedPorts ?? []) as readonly import("@cinatra-ai/sdk-extensions").HostPortName[];
  } catch {
    grantedPorts = [];
  }

  // (a) QUARANTINE the OLD digest dir(s) — move them OUT of the discovery walk so
  // the loader's duplicate-name gate sees exactly the new dir, while keeping them
  // recoverable. We capture the (originalDir → quarantineDir) map for restore/GC.
  // ALSO tear down the OLD in-memory registrations + destroy the OLD module(s)
  // FIRST so the in-memory registries hold a single package's registrations after
  // the new digest activates (mirrors the previous teardown ordering).
  await teardownAndGcSupersededDigests(
    packageName,
    storeRoot,
    newStoreDir,
    superseded,
    grantedPorts,
    { quarantineInsteadOfGc: true },
  );
  const quarantined = await readQuarantineManifest(storeRoot, packageName);

  // (b) ACTIVATE the NEW digest in-process through the shared loader.
  let results: ActivationResult[];
  try {
    results = await loadOnlyPackage(storeRoot, packageName, newResolver);
  } catch (err) {
    results = [{ packageName, status: "failed", reason: "register-threw", error: err }];
  }
  // SUCCESS DETERMINATION: the new digest counts as activated ONLY when its
  // activation has at least one `registered`/`bootstrapped` result AND NO `failed`
  // result for the package — i.e. BOTH register AND bootstrap passed. A loader
  // returns one result per phase: a package can `register` (one result) yet still
  // `failed` during bootstrap (a second result, e.g. `failed:bootstrap-threw`). If
  // ANY result for the package is `failed`, the new digest is NOT a clean success →
  // do NOT GC the quarantined OLD digest, do NOT report `activated:true` → proceed
  // to the durable rollback path so the previous version is restored.
  const pkgResults = results.filter((r) => r.packageName === packageName);
  const hasRegistered = pkgResults.some(
    (r) => r.status === "registered" || r.status === "bootstrapped",
  );
  const hasFailed = pkgResults.some((r) => r.status === "failed");
  const activated = hasRegistered && !hasFailed;

  if (activated) {
    // (c) SUCCESS — GC the quarantined OLD dir(s); the new digest is live.
    await gcQuarantined(quarantined);
    resetHostSelfPrimitives();
    return { activated: true };
  }

  // (d) FAILURE — DURABLE ROLLBACK to OLD. Prefer the `failed` result for the
  // reason (a register-then-bootstrap-throw produces both a `registered` and a
  // `failed` result; the `failed` one carries the actionable reason), falling back
  // to the first result, then `anchor-refused` when the loader returned none.
  const refusal = pkgResults.find((r) => r.status === "failed") ?? pkgResults[0];
  const failReason = refusal ? `${refusal.status}${refusal.reason ? `:${refusal.reason}` : ""}` : "anchor-refused";

  // (d-i) restore the OLD durable anchor (pipeline owns the writers). Capture the
  // completeness verdict: a PARTIAL restore (≥1 step failed) must NOT be reported
  // as a clean rollback — the caller surfaces a manual-recovery signal instead.
  let restoreComplete = true;
  let restoreFailReason: string | undefined;
  try {
    const outcome = await rollbackDeps.restoreDurableAnchor();
    restoreComplete = outcome.complete;
    restoreFailReason = outcome.reason;
  } catch (err) {
    // The closure is best-effort and should not throw; if it does, the durable
    // restore is at best partial — NOT a clean rollback.
    restoreComplete = false;
    restoreFailReason = `restore-threw:${err instanceof Error ? err.message : String(err)}`;
    console.error(
      `[extension-runtime-activate] durable anchor restore FAILED during hot-update rollback for "${packageName}" (disk restore + re-activate still proceed, but the rollback is NOT clean):`,
      err instanceof Error ? err.message : err,
    );
  }

  // (d-ii) tear down any PARTIAL new in-process registrations (capability teardown
  // for the package + destroy the new module if it loaded). The new digest may have
  // registered SOME capabilities before failing; clear them so the re-activated OLD
  // digest is the sole live registration.
  await teardownPartialNewRegistration(packageName, storeRoot, newStoreDir, grantedPorts);

  // (d-iii) restore the OLD store dir(s) from quarantine AND GC the failed NEW digest
  // dir, so AFTER the rollback only the OLD digest is discoverable — otherwise the
  // OLD re-activation (d-iv) would trip the loader's duplicate-name gate (OLD + NEW
  // both present for one package). The durable anchor now points to OLD, so the NEW
  // dir is dead weight; removing it keeps the post-rollback store single-digest.
  await gcStoreDirBestEffort(newStoreDir);
  // Fold the on-disk store restore into the rollback completeness verdict: if the
  // OLD digest's store dir could not be restored from quarantine, the rollback is
  // NOT clean (the old version may be undiscoverable on disk) → the caller surfaces
  // the loud manual-recovery signal, not the calm "previous version retained" path.
  const storeRestore = await restoreQuarantined(quarantined);
  if (!storeRestore.ok) {
    restoreComplete = false;
    restoreFailReason = `${restoreFailReason ? `${restoreFailReason}; ` : ""}store-restore-failed:${storeRestore.failed.join(",")}`;
  }

  // (d-iv) best-effort re-activate the OLD digest (now resolving the restored OLD
  // anchor). A fresh resolver reads the durable state restoreDurableAnchor() just
  // re-pinned to OLD.
  try {
    const oldResolver = await makeDefaultInstallAnchorResolver(orgId);
    // Defensive: a stale partial-new registration could still be in memory; fire the
    // (idempotent) capability teardown once more so the OLD re-activation replaces it.
    await loadOnlyPackage(storeRoot, packageName, oldResolver, { teardownFirst: true });
  } catch (err) {
    // (d-v) even an OLD re-activation failure does NOT change the verdict: the
    // DURABLE state points to OLD (recoverable at next boot), never reported as success.
    console.error(
      `[extension-runtime-activate] OLD re-activation FAILED during hot-update rollback for "${packageName}" — the durable state is restored to OLD (recoverable on next boot):`,
      err instanceof Error ? err.message : err,
    );
  }
  resetHostSelfPrimitives();
  // Report the rollback's durable completeness truthfully: a clean rollback ONLY
  // when EVERY durable restore step succeeded. A partial restore appends the
  // failed-step reason so the caller can surface the manual-recovery signal.
  return {
    activated: false,
    rolledBack: true,
    rollbackComplete: restoreComplete,
    reason: restoreComplete ? failReason : `${failReason} (durable rollback INCOMPLETE: ${restoreFailReason ?? "unknown"})`,
  };
}

/** Activate a single package through the shared loader, optionally firing the
 *  (idempotent) capability teardown first (used by the OLD re-activation path). */
async function loadOnlyPackage(
  storeRoot: string,
  packageName: string,
  resolveInstallAnchor: (pkg: string) => Promise<import("@/lib/extension-package-store").InstallTrustAnchor | null>,
  opts: { teardownFirst?: boolean } = {},
): Promise<ActivationResult[]> {
  if (opts.teardownFirst) {
    try {
      const { fireExtensionCapabilityTeardown } = await import("@cinatra-ai/extensions");
      await fireExtensionCapabilityTeardown(packageName);
    } catch {
      /* best-effort */
    }
  }
  const { loadRuntimePackageExtensions } = await import("@/lib/runtime-package-loader");
  return loadRuntimePackageExtensions(storeRoot, { onlyPackage: packageName, resolveInstallAnchor });
}

// Canonical activation-result → {activated, reason} verdict, shared by the
// no-supersede early-out, the hot-update path, AND the pipeline's fresh-install
// activateInProcess (so the success rule can never drift between paths again).
export function summarizeActivation(results: ActivationResult[], packageName: string): HotUpdateActivateResult {
  const pkgResults = results.filter((r) => r.packageName === packageName);
  const hasRegistered = pkgResults.some((r) => r.status === "registered" || r.status === "bootstrapped");
  // A package emits ONE result per phase (register, then bootstrap), so a
  // register-passes/bootstrap-throws activation yields BOTH a "registered" AND a
  // "failed" result — success requires a registration AND no failure (else a
  // bootstrap failure would falsely report activated:true).
  const hasFailed = pkgResults.some((r) => r.status === "failed");
  if (hasRegistered && !hasFailed) return { activated: true };
  // Prefer the actionable failed result for the surfaced reason, not the earlier "registered".
  const refusal = pkgResults.find((r) => r.status === "failed") ?? pkgResults[0];
  return {
    activated: false,
    reason: refusal ? `${refusal.status}${refusal.reason ? `:${refusal.reason}` : ""}` : "anchor-refused",
  };
}

/** Tear down the PARTIAL new registration after a failed new activation: fire the
 *  in-memory capability teardown for the package + destroy the new module if it
 *  loaded (so a half-registered new digest releases what it acquired). */
async function teardownPartialNewRegistration(
  packageName: string,
  storeRoot: string,
  newStoreDir: string,
  grantedPorts: readonly import("@cinatra-ai/sdk-extensions").HostPortName[],
): Promise<void> {
  try {
    const { fireExtensionCapabilityTeardown } = await import("@cinatra-ai/extensions");
    await fireExtensionCapabilityTeardown(packageName);
  } catch (err) {
    console.warn(
      `[extension-runtime-activate] partial-new capability teardown threw for "${packageName}" (non-fatal):`,
      err instanceof Error ? err.message : err,
    );
  }
  // Destroy the new module if it loaded — best-effort.
  try {
    const { discoverPackageStoreRecords } = await import("@cinatra-ai/sdk-extensions");
    const all = await discoverPackageStoreRecords(storeRoot, await makeRealFs());
    const rec = all.find((r) => r.packageName === packageName && r.storeDir === newStoreDir);
    if (rec) {
      const mod = await importStoreModule(rec);
      if (mod) {
        const { createExtensionHostContext } = await import("@/lib/extension-host-context");
        const ctx = createExtensionHostContext(rec.packageName, grantedPorts);
        await destroyExtensionModule(mod, ctx);
      }
    }
  } catch (err) {
    console.warn(
      `[extension-runtime-activate] could not destroy partial-new "${packageName}" module (non-fatal):`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** Hard-GC a single store dir + its sibling `.tgz` (best-effort). */
async function gcStoreDirBestEffort(storeDir: string): Promise<void> {
  const { rm } = await import("node:fs/promises");
  try {
    await rm(storeDir, { recursive: true, force: true });
    await rm(`${storeDir}.tgz`, { force: true }).catch(() => undefined);
  } catch (err) {
    console.warn(
      `[extension-runtime-activate] could not GC failed NEW store dir "${storeDir}" during rollback (non-fatal):`,
      err instanceof Error ? err.message : err,
    );
  }
}

function resetHostSelfPrimitives(): void {
  void (async () => {
    try {
      const { __resetHostSelfPrimitiveHandlers } = await import("@/lib/extension-self-mcp");
      __resetHostSelfPrimitiveHandlers();
    } catch {
      /* self-mcp module unavailable (e.g. a worker) — non-fatal. */
    }
  })();
}

// ---------------------------------------------------------------------------
// Quarantine: a recoverable, discovery-invisible relocation of an OLD digest.
//
// The store layout is `<root>/<pkg@ver>/<digest>/package.json`. Discovery walks
// only depth 1 (`<root>/<entry>/package.json`) and depth 2
// (`<root>/<entry>/<sub>/package.json`). We move the OLD digest dir to
// `<root>/<pkg@ver>/.cinatra-quarantine/<digest>/`, whose package.json sits at
// depth 3 — INVISIBLE to discovery (so the duplicate-name gate is satisfied) yet
// recoverable by an in-place rename back. A `.json` manifest at
// `<root>/<pkg@ver>/.cinatra-quarantine/manifest.json` records the moves so a
// fresh process can find + restore (or GC) them. Same-filesystem rename = atomic.
// ---------------------------------------------------------------------------

const QUARANTINE_DIRNAME = ".cinatra-quarantine";

type QuarantineEntry = { originalDir: string; quarantineDir: string };

/** Move an OLD digest store dir into the package's quarantine subtree. Returns the
 *  quarantine dir, or null on failure (best-effort — a failed quarantine leaves the
 *  old dir in place; the new-digest activation will then fail the duplicate-name
 *  gate and rollback restores OLD, the SAFE direction). */
async function quarantineStoreDir(storeDir: string): Promise<string | null> {
  try {
    const path = await import("node:path");
    const { mkdir, rename, rm } = await import("node:fs/promises");
    const pkgVerDir = path.dirname(storeDir); // <root>/<pkg@ver>
    const digestSeg = path.basename(storeDir); // <digest>
    const qRoot = path.join(pkgVerDir, QUARANTINE_DIRNAME);
    await mkdir(qRoot, { recursive: true });
    const qDir = path.join(qRoot, digestSeg);
    await rm(qDir, { recursive: true, force: true }).catch(() => undefined);
    await rename(storeDir, qDir);
    // also relocate the sibling verified tarball, if present.
    await rename(`${storeDir}.tgz`, `${qDir}.tgz`).catch(() => undefined);
    return qDir;
  } catch (err) {
    console.warn(
      `[extension-runtime-activate] could not quarantine store dir "${storeDir}" (non-fatal):`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/** Discover the quarantined OLD digest dirs for a package (the moves a prior
 *  `quarantineStoreDir` made — found by walking each `<pkg@ver>/.cinatra-quarantine`
 *  subtree). Recoverable across a process restart. */
async function readQuarantineManifest(
  storeRoot: string,
  packageName: string,
): Promise<QuarantineEntry[]> {
  try {
    const path = await import("node:path");
    const { readdir, stat, readFile } = await import("node:fs/promises");
    const out: QuarantineEntry[] = [];
    let pkgVerDirs: string[];
    try {
      pkgVerDirs = await readdir(storeRoot);
    } catch {
      return [];
    }
    for (const pkgVer of pkgVerDirs) {
      const qRoot = path.join(storeRoot, pkgVer, QUARANTINE_DIRNAME);
      let digestDirs: string[];
      try {
        digestDirs = await readdir(qRoot);
      } catch {
        continue;
      }
      for (const digest of digestDirs) {
        const qDir = path.join(qRoot, digest);
        try {
          if (!(await stat(qDir)).isDirectory()) continue;
          const manifest = path.join(qDir, "package.json");
          const raw = await readFile(manifest, "utf8").catch(() => null);
          if (!raw) continue;
          const pkg = JSON.parse(raw) as { name?: string };
          if (pkg.name !== packageName) continue;
          // The original dir is the sibling of `.cinatra-quarantine`, same digest seg.
          const originalDir = path.join(storeRoot, pkgVer, digest);
          out.push({ originalDir, quarantineDir: qDir });
        } catch {
          /* skip an unreadable quarantine entry */
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Restore quarantined OLD digest dir(s) back to their original location (rollback
 *  step d-iii). Best-effort per entry. */
export async function restoreQuarantined(entries: QuarantineEntry[]): Promise<{ ok: boolean; failed: string[] }> {
  const { rename, rm } = await import("node:fs/promises");
  const failed: string[] = [];
  for (const e of entries) {
    try {
      await rm(e.originalDir, { recursive: true, force: true }).catch(() => undefined);
      await rename(e.quarantineDir, e.originalDir);
      await rename(`${e.quarantineDir}.tgz`, `${e.originalDir}.tgz`).catch(() => undefined);
    } catch (err) {
      failed.push(e.originalDir);
      console.error(
        `[extension-runtime-activate] could not restore quarantined dir "${e.quarantineDir}" → "${e.originalDir}" (the OLD digest's durable DB anchor is still restored; boot re-materializes if needed):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  // Clean up the now-empty quarantine roots (best-effort).
  await cleanupEmptyQuarantineRoots(entries);
  // Report whether EVERY old store dir was restored on disk — folded into the
  // rollback completeness verdict so a disk-restore failure surfaces the loud
  // manual-recovery signal (the old version may be undiscoverable on disk).
  return { ok: failed.length === 0, failed };
}

/** GC the quarantined OLD digest dir(s) after a SUCCESSFUL new activation (step c). */
async function gcQuarantined(entries: QuarantineEntry[]): Promise<void> {
  const { rm } = await import("node:fs/promises");
  for (const e of entries) {
    try {
      await rm(e.quarantineDir, { recursive: true, force: true });
      await rm(`${e.quarantineDir}.tgz`, { force: true }).catch(() => undefined);
    } catch (err) {
      console.warn(
        `[extension-runtime-activate] could not GC quarantined dir "${e.quarantineDir}" (non-fatal — boot-orphan cleanup will sweep it):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  await cleanupEmptyQuarantineRoots(entries);
}

async function cleanupEmptyQuarantineRoots(entries: QuarantineEntry[]): Promise<void> {
  const path = await import("node:path");
  const { rmdir } = await import("node:fs/promises");
  const roots = new Set(entries.map((e) => path.dirname(e.quarantineDir)));
  for (const root of roots) {
    await rmdir(root).catch(() => undefined); // only removes if empty
  }
}

/**
 * The host activate-hook body. Records real provenance + activates a
 * verdaccio-source package in-process. Returns `{ activated, reason? }` for the
 * dispatcher's best-effort firer (which already swallows throws).
 */
export async function runHostExtensionInstallAndActivate(
  packageName: string,
  orgId: string | null,
  passedVersion?: string,
): Promise<ExtensionActivateResult> {
  // Resolve the canonical row to learn the source + version. The dispatcher
  // created it platform-scoped (organization_id IS NULL); the caller passes the
  // matching `orgId` (null for the dispatch path).
  const { readInstalledExtensionsByPackageName } = await import(
    "@cinatra-ai/extensions/canonical-store"
  );
  const { pickSingleActiveRow } = await import("@/lib/extension-install-anchor");
  const rows = await readInstalledExtensionsByPackageName(packageName);
  const row = pickSingleActiveRow(rows, orgId);
  if (!row) return { finalized: false, activated: false, reason: "no-active-canonical-row" };
  if (!row.source || row.source.type !== "verdaccio") {
    // github / local / add-from-chat are not real-integrity-pipeline sources.
    // finalized:undefined (NOT false) — the dispatcher must NOT roll back a row
    // for a non-verdaccio source it cannot drive through this pipeline (the
    // handler owns those installs; e.g. a github skill the handler resolved).
    return { activated: false, reason: "non-verdaccio-source" };
  }
  // Prefer the REQUESTED install/target version (the dispatcher passes
  // `ref.version`). On an UPDATE the canonical row still carries the OLD version —
  // provenance (incl. the version) is rewritten only at the tail of the pipeline —
  // so using `row.source.version` here would re-install the OLD version and the
  // requested new one would never be materialized. Fall back to the row's recorded
  // version when no version is passed (a fresh install already matches).
  const version = passedVersion || row.source.version || "0.0.0";

  // Run the REAL-integrity pipeline (records real provenance + finalizes the
  // journal + materializes the store). `installExtensionFromRegistry` returns
  // `installed:true` ONLY after the journal is `finalized` — it THROWS on any
  // failure BEFORE finalize (resolve / materialize / provenance). So a clean
  // return ⇒ finalized:true; a throw ⇒ finalized:false. The dispatcher uses
  // `finalized` as the authoritative success gate (rolls back the placeholder row
  // when false). The in-process ACTIVATION half stays best-effort (the boot
  // loader is the durable path) — surfaced via `activated`/`reason`.
  try {
    const { installExtensionFromRegistry, makeDefaultInstallPipelineDeps } = await import(
      "@/lib/extension-install-pipeline"
    );
    const deps = await makeDefaultInstallPipelineDeps();
    const result = await installExtensionFromRegistry({ packageName, version, orgId }, deps);
    return {
      finalized: result.installed === true,
      activated: result.activated,
      // Surface the durable-rollback verdict so the extensions_update
      // handler reports the update did NOT take (previous version retained).
      // ALSO surface rollbackComplete so the dispatcher distinguishes a
      // CLEAN rollback (calm "previous version retained") from a PARTIAL one (LOUD
      // manual-recovery error).
      ...(result.rolledBack ? { rolledBack: true, rollbackComplete: result.rollbackComplete === true } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
    };
  } catch (err) {
    // A throw means the pipeline did NOT finalize — the install is NOT anchorable.
    // Report finalized:false so the dispatcher rolls back the placeholder row.
    return {
      finalized: false,
      activated: false,
      reason: `pipeline-threw:${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------

/**
 * Hot-update teardown + GC for a package. Imports + destroys the OLD module(s)
 * whose store dir is NOT `keepStoreDir`, fires the package's in-memory capability
 * teardown, then removes the superseded store dir(s) (and their sibling `.tgz`)
 * so the runtime loader's duplicate-name gate sees a single current dir.
 *
 * Order (per the update contract): (1) fire+await capability teardown for
 * the OLD package, (2) destroy the OLD module(s), (3) GC the superseded dir(s).
 * All steps best-effort — a teardown/destroy/unlink failure is logged, never
 * thrown (in-memory + filesystem cleanup must not abort a committed install).
 */
async function teardownAndGcSupersededDigests(
  packageName: string,
  storeRoot: string,
  keepStoreDir: string | undefined,
  precomputedSuperseded?: PackageStoreRecord[],
  destroyPorts: readonly import("@cinatra-ai/sdk-extensions").HostPortName[] = [],
  // When set, QUARANTINE the superseded dir(s) (recoverable) instead of
  // hard-GC'ing them — so a failed new activation can durably roll back to OLD.
  opts: { quarantineInsteadOfGc?: boolean } = {},
): Promise<void> {
  const superseded =
    precomputedSuperseded ?? (await discoverSupersededStoreDirs(packageName, storeRoot, keepStoreDir));
  // Even with NO superseded dir (clean NEW install), still fire the capability
  // teardown defensively: a re-activate of the same package in one process must
  // replace, not stack. The teardown is idempotent + a no-op when nothing was
  // registered.
  try {
    const { fireExtensionCapabilityTeardown } = await import("@cinatra-ai/extensions");
    await fireExtensionCapabilityTeardown(packageName);
  } catch (err) {
    console.warn(
      `[extension-runtime-activate] capability teardown threw for "${packageName}" (non-fatal):`,
      err instanceof Error ? err.message : err,
    );
  }

  if (superseded.length === 0) return;

  // Destroy the OLD module(s) before removing their dir(s) — gives a hot-updated
  // extension's `destroy(ctx)` a chance to release resources it acquired.
  for (const rec of superseded) {
    try {
      const mod = await importStoreModule(rec);
      if (mod) {
        const { createExtensionHostContext } = await import("@/lib/extension-host-context");
        // Build the destroy ctx with the package's APPROVED ports (NOT
        // an empty grant set), so a destroy hook that releases a resource through
        // an approved host port (settings/secrets/jobs/…) gets the real wired impl
        // instead of a NOT-GRANTED fail-loud Proxy.
        const ctx = createExtensionHostContext(rec.packageName, destroyPorts);
        const res = await destroyExtensionModule(mod, ctx);
        if (res.status === "failed") {
          console.warn(
            `[extension-runtime-activate] destroy(ctx) threw for old "${packageName}" digest (non-fatal):`,
            res.error instanceof Error ? res.error.message : res.error,
          );
        }
      }
    } catch (err) {
      console.warn(
        `[extension-runtime-activate] could not destroy old "${packageName}" module (non-fatal):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Either QUARANTINE (recoverable; the new activation may still fail
  // and need OLD restored) or hard-GC (the new digest already proved
  // activatable via the pre-verify probe) the superseded store dir(s).
  if (opts.quarantineInsteadOfGc) {
    for (const rec of superseded) {
      await quarantineStoreDir(rec.storeDir);
    }
    return;
  }
  // GC the superseded store dir(s) + their sibling verified-tarball files.
  const { rm } = await import("node:fs/promises");
  for (const rec of superseded) {
    try {
      await rm(rec.storeDir, { recursive: true, force: true });
      await rm(`${rec.storeDir}.tgz`, { force: true }).catch(() => undefined);
    } catch (err) {
      console.warn(
        `[extension-runtime-activate] could not GC superseded store dir for "${packageName}" (non-fatal):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/**
 * Public supersession probe for the install PIPELINE's pre-finalize gate:
 * the materialized store records for `packageName` whose store dir
 * is NOT `keepStoreDir` (the just-installed current digest). A non-empty result
 * means this materialize SUPERSEDES a prior digest (an UPDATE), so the pipeline
 * must prove the new digest activates BEFORE it overwrites provenance / finalizes.
 */
export async function discoverSupersededStoreDirsForPackage(
  packageName: string,
  storeRoot: string,
  keepStoreDir: string | undefined,
): Promise<PackageStoreRecord[]> {
  return discoverSupersededStoreDirs(packageName, storeRoot, keepStoreDir);
}

/**
 * Discover the materialized store records for `packageName` whose store dir is
 * NOT `keepStoreDir` (the just-installed current digest). These are the
 * superseded digests a hot-update must tear down + GC.
 */
async function discoverSupersededStoreDirs(
  packageName: string,
  storeRoot: string,
  keepStoreDir: string | undefined,
): Promise<PackageStoreRecord[]> {
  try {
    const { discoverPackageStoreRecords } = await import("@cinatra-ai/sdk-extensions");
    const all = await discoverPackageStoreRecords(storeRoot, await makeRealFs());
    return all.filter(
      (r) => r.packageName === packageName && r.storeDir !== keepStoreDir,
    );
  } catch {
    return [];
  }
}

/** Minimal node:fs/promises-backed store filesystem surface for discovery (the
 *  same shape the runtime loader injects; kept local to avoid coupling to the
 *  loader's private `realFs`). */
async function makeRealFs(): Promise<import("@cinatra-ai/sdk-extensions").PackageStoreFs> {
  const { readFile, readdir, stat } = await import("node:fs/promises");
  return {
    exists: async (p) => {
      try {
        await stat(p);
        return true;
      } catch {
        return false;
      }
    },
    isDirectory: async (p) => {
      try {
        return (await stat(p)).isDirectory();
      } catch {
        return false;
      }
    },
    readdir: (p) => readdir(p),
    readFile: (p) => readFile(p, "utf8"),
  };
}

/** Import + normalize a store record's server module (best-effort; null on any
 *  failure — an unloadable old module is just GC'd without a destroy). Applies
 *  the SAME refusal rules as the runtime loader's importServerEntry (cinatra#161,
 *  codex AB-r1 finding 1): a declared-but-invalid exports target and a
 *  non-importable (source/extensionless) entry are refused BEFORE any import —
 *  the pre-finalize probe must never execute top-level code the real loader
 *  would refuse. */
async function importStoreModule(rec: PackageStoreRecord): Promise<ExtensionModule | null> {
  if (rec.invalidExportsTargetDeclared) return null;
  const abs = resolveServerEntryPath(rec);
  if (!abs) return null;
  if (classifyServerEntryArtifact(abs) !== "importable") return null;
  try {
    const { pathToFileURL } = await import("node:url");
    const { realpath } = await import("node:fs/promises");
    const [realAbs, realStore] = await Promise.all([realpath(abs), realpath(rec.storeDir)]);
    if (realAbs !== realStore && !realAbs.startsWith(realStore + "/")) return null;
    const imported = await import(/* webpackIgnore: true */ /* @vite-ignore */ pathToFileURL(realAbs).href);
    return normalizeServerModule(rec.packageName, imported);
  } catch {
    return null;
  }
}
