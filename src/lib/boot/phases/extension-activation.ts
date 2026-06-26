// Extension-activation boot phases (engineering #302).
//
// The dual-loader activation chain + its required-set enforcement + the
// crashed-install cleanup, extracted verbatim from `instrumentation.node.ts`.
// ORDERING IS LOAD-BEARING and preserved exactly:
//
//   1. static-bundle-loader   (bundled extensions; bumps generation "boot-static")
//   2. signature-backfill      (BEFORE the runtime loader so it classifies signed)
//   3. runtime-package-loader  (on-disk store; bumps generation "boot-runtime")
//   4. required-activation-assert  (fatal in prod — boot must not come up half-wired)
//   5. extension-closure-gate      (fatal in prod — required-in-prod dep closure)
//   6. install-op-boot-cleanup     (best-effort crashed-half-install rollback)
//
// The four loaders' ActivationResults accumulate in a SHARED array consumed by the
// required-activation assert; `extensionActivationPhases(results)` threads that
// array through. Phases 1-3 + 6 are `retryable` (each had its own log+swallow);
// phases 4-5 are `fatal` (they rethrew outside development) — the dev/prod split
// lives inside the phase body, so they only throw when prod-abort was the policy.
//
// Deliberately NOT importing "server-only": unit tests import the phase list.

import type { BootPhase } from "@/lib/boot/boot-phase";
import type { ActivationResult } from "@cinatra-ai/sdk-extensions";

const SKIPPED_BY_KILL_SWITCH = (envKey: string) => ({ skipped: `disabled via ${envKey}` });

export function extensionActivationPhases(
  bootActivationResults: ActivationResult[],
): BootPhase[] {
  return [
    {
      name: "static-bundle-loader",
      policy: "retryable",
      run: async () => {
        // The StaticBundleLoader (the BUNDLED half of "dual loaders, single
        // activation"). Failure isolation is per-extension; the required-set
        // assertion below catches a silent miss. Kill-switchable.
        if (process.env.CINATRA_DISABLE_STATIC_BUNDLE_LOADER === "true") {
          return SKIPPED_BY_KILL_SWITCH("CINATRA_DISABLE_STATIC_BUNDLE_LOADER");
        }
        const { loadStaticBundleExtensions } = await import("@/lib/static-bundle-loader");
        const results = await loadStaticBundleExtensions();
        bootActivationResults.push(...results);
        // Control-plane generation (#310): mark the static-bundle boot pass AFTER
        // it mutated the registries, so the first request sees the final boot
        // generation and the generation-keyed self-MCP cache builds against the
        // fully-activated boot surface.
        const { bumpActivationGeneration } = await import("@/lib/extension-activation-generation");
        bumpActivationGeneration("boot-static");
        if (results.length) {
          console.info(
            `[boot] StaticBundleLoader: ${results.length} result(s) — ` +
              results
                .map((r) => `${r.packageName.replace("@cinatra-ai/", "")}:${r.status}${r.reason ? `(${r.reason})` : ""}`)
                .join(", "),
          );
        }
      },
    },
    {
      name: "extension-signature-backfill",
      policy: "retryable",
      run: async () => {
        // Window-2 instance signature backfill — runs BEFORE the
        // RuntimePackageLoader so it sees the backfilled source.signature and can
        // classify rows trusted-signed. Inert until the host trusts a signing key;
        // kill-switchable, idempotent, bounded per-row, soft-failing.
        if ((process.env.CINATRA_EXTENSION_SIGNATURE_BACKFILL ?? "").trim().toLowerCase() === "off") {
          return SKIPPED_BY_KILL_SWITCH("CINATRA_EXTENSION_SIGNATURE_BACKFILL=off");
        }
        const { runExtensionSignatureBackfill } = await import("@/lib/extension-signature-backfill");
        const r = await runExtensionSignatureBackfill({ log: (m) => console.info(m) });
        if (r.skippedReason) {
          console.info(`[boot] ExtensionSignatureBackfill: skipped (${r.skippedReason})`);
        } else if (r.scanned > 0) {
          console.info(
            `[boot] ExtensionSignatureBackfill: scanned ${r.scanned}, ` +
              `written ${r.written}, skipped ${r.skipped}, failed ${r.failed}`,
          );
        }
      },
    },
    {
      name: "runtime-package-loader",
      policy: "retryable",
      run: async () => {
        // The RuntimePackageLoader (PROD half of "dual loaders, single
        // activation"). Activates packages materialized on disk by the live
        // installer WITHOUT an image rebuild. Trust-gated; re-verifies integrity
        // on every boot; fails closed until the installer wires resolveInstallAnchor.
        if (process.env.CINATRA_DISABLE_RUNTIME_PACKAGE_LOADER === "true") {
          return SKIPPED_BY_KILL_SWITCH("CINATRA_DISABLE_RUNTIME_PACKAGE_LOADER");
        }
        const { loadRuntimePackageExtensions } = await import("@/lib/runtime-package-loader");
        const { makeDefaultInstallAnchorResolver } = await import("@/lib/extension-install-anchor");
        const resolveInstallAnchor = await makeDefaultInstallAnchorResolver();
        const results = await loadRuntimePackageExtensions(undefined, { resolveInstallAnchor });
        bootActivationResults.push(...results);
        // Control-plane generation (#310): one bump per loader (see static-bundle).
        const { bumpActivationGeneration } = await import("@/lib/extension-activation-generation");
        bumpActivationGeneration("boot-runtime");
        if (results.length) {
          console.info(
            `[boot] RuntimePackageLoader: ${results.length} result(s) — ` +
              results
                .map((r) => `${r.packageName.replace("@cinatra-ai/", "")}:${r.status}${r.reason ? `(${r.reason})` : ""}`)
                .join(", "),
          );
        }
      },
    },
    {
      name: "required-activation-assert",
      policy: "fatal",
      run: async () => {
        // After BOTH boot loaders ran, assert every REQUIRED serverEntry extension
        // actually activated. console.error always; THROWS outside development (a
        // prod boot must not come up half-wired). Kill-switchable for emergency
        // operability. The throw makes this `fatal` phase abort boot in prod.
        const { assertRequiredExtensionActivations } = await import(
          "@/lib/required-extension-activation"
        );
        assertRequiredExtensionActivations(bootActivationResults);
      },
    },
    {
      name: "extension-closure-gate",
      policy: "fatal",
      run: async () => {
        // Extension dependency-closure + required-in-prod boot gate (issue #78).
        // PROD: awaited + throwing (fail closed). DEV: fire-and-forget pure
        // advisory (never throws). The dev/prod split lives inside this body, so
        // the phase only throws — and only then aborts boot — in production.
        const { enforceExtensionClosureAtBoot } = await import(
          "@/lib/extension-closure-boot-gate"
        );
        if (process.env.CINATRA_RUNTIME_MODE === "development") {
          void enforceExtensionClosureAtBoot().catch((err) => {
            console.warn("[extension-closure] dev advisory failed (non-fatal):", err);
          });
          return;
        }
        await enforceExtensionClosureAtBoot();
      },
    },
    {
      name: "install-op-boot-cleanup",
      policy: "retryable",
      run: async () => {
        // workflow-install-saga boot-orphan cleanup. A process killed mid-saga
        // leaves an extension_install_ops row in a NON-terminal phase. Compensate
        // + roll back any op idle beyond the threshold. Idempotent + best-effort:
        // a transient DB error here must NOT crash boot. Kill-switchable.
        if (process.env.CINATRA_DISABLE_INSTALL_OP_BOOT_CLEANUP === "true") {
          return SKIPPED_BY_KILL_SWITCH("CINATRA_DISABLE_INSTALL_OP_BOOT_CLEANUP");
        }
        const { listUnfinalizedInstallOps } = await import("@/lib/extension-install-ops");
        const { compensateOrphanInstallOp, makeDefaultWorkflowInstallSagaDeps } = await import(
          "@/lib/extension-workflow-install-saga"
        );
        // Only sweep ops idle for >=5 minutes so an install in-flight in another
        // worker is never compensated out from under it.
        const STALE_MS = 5 * 60 * 1000;

        // dependency-BATCH sweep FIRST (#180). The batch sweeper OWNS batch-member
        // ops; the per-op cleanup below SKIPS ops owned by STILL-ACTIVE batches.
        const { sweepStaleInstallBatches, collectActiveBatchMemberKeys } = await import(
          "@/lib/extension-install-batch"
        );
        // Collect the batch-owned (package, org) keys BEFORE sweeping.
        // FAIL-CLOSED (cinatra#158): if the active-batch key collection FAILS, we
        // cannot tell which orphan ops are owned by a still-active batch, so we SKIP
        // the per-op cleanup this boot (retries next boot) rather than risk
        // compensating a live batch member out from under its running install.
        let activeBatchKeys: Set<string> | null;
        try {
          activeBatchKeys = await collectActiveBatchMemberKeys();
        } catch (err) {
          console.warn(
            "[boot] active-batch key collection failed — SKIPPING per-op orphan cleanup this boot (fail-closed; retries next boot):",
            err,
          );
          activeBatchKeys = null;
        }
        try {
          const { swept } = await sweepStaleInstallBatches({ olderThanMs: STALE_MS });
          if (swept > 0) {
            console.info(`[boot] compensated ${swept} stale dependency install batch(es) from the ledger`);
          }
        } catch (err) {
          console.warn("[boot] install-batch sweep failed (non-fatal):", err);
        }

        const orphansAll = activeBatchKeys === null ? [] : await listUnfinalizedInstallOps(STALE_MS);
        const orphans = orphansAll.filter(
          (op) => !activeBatchKeys!.has(`${op.packageName}::${op.orgId ?? "(global)"}`),
        );
        if (orphans.length) {
          const deps = await makeDefaultWorkflowInstallSagaDeps();
          for (const op of orphans) {
            await compensateOrphanInstallOp(
              { installOpId: op.installOpId, packageName: op.packageName, orgId: op.orgId, phase: op.phase },
              deps,
            );
          }
          console.info(
            `[boot] workflow-install-saga: rolled back ${orphans.length} orphan install op(s) — ` +
              orphans.map((o) => `${o.packageName.replace("@cinatra-ai/", "")}(${o.phase})`).join(", "),
          );
        }
      },
    },
  ];
}
