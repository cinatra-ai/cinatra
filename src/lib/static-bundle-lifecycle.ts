import "server-only";

// Static-bundle lifecycle seeding (manifest-completeness for bundled
// `serverEntry` extensions).
//
// The StaticBundleLoader's activation gate is a strict allow-list: a bundled
// `serverEntry` package activates ONLY when a live (active|locked)
// `installed_extension` row exists (see static-bundle-loader.ts). Bundled
// packages have no install pipeline — their bytes ship in the image — so this
// module makes them lifecycle-tracked: at boot (invoked by the loader BEFORE
// its status read) it ensures ONE platform-scoped ANCHOR row per bundled
// serverEntry package, created through the canonical lifecycle primitive.
//
// The anchor is the durable "lifecycle-tracked" memory that lets "no row" be
// read unambiguously:
//   - no rows at all            → never tracked → seed a LIVE anchor
//                                 (required-in-prod anchors auto-lock in prod);
//   - anchor exists, any status → operator/lifecycle state is authoritative —
//                                 NEVER touched (an archived tombstone from
//                                 `uninstall` stays archived; see
//                                 lifecycle-primitive.ts);
//   - rows exist but NONE live  → the package was retired before it had an
//                                 anchor (legacy archive) → seed the anchor
//                                 ARCHIVED so the retired state is preserved,
//                                 not resurrected;
//   - rows exist with a live one→ seed a live anchor (matches effective state).
//
// Soft-failing: a per-package failure is logged loudly and never blocks boot —
// the loader's own fail-open path and the post-boot required-set activation
// assertion (src/lib/required-extension-activation.ts on the registration
// cutover) are the backstops.

import {
  STATIC_EXTENSION_RECORDS,
} from "@/lib/generated/extensions.server";

export type StaticBundleLifecycleResult = {
  /** Packages whose anchor was created live (active, or locked in prod). */
  seededLive: string[];
  /** Packages whose anchor was created then immediately archived (legacy-retired). */
  seededArchived: string[];
  /** Packages whose anchor could not be ensured (logged; boot continues). */
  failed: string[];
};

/**
 * Ensure every bundled serverEntry package has a static-bundle anchor row.
 * Idempotent per package; safe under concurrent boots (an insert race is
 * re-read and treated as benign when the anchor now exists).
 */
export async function ensureStaticBundleLifecycleAnchors(): Promise<StaticBundleLifecycleResult> {
  const result: StaticBundleLifecycleResult = { seededLive: [], seededArchived: [], failed: [] };
  const records = STATIC_EXTENSION_RECORDS.filter(
    (r) => typeof r.serverEntry === "string" && r.serverEntry.length > 0,
  );
  if (records.length === 0) return result;

  const { readInstalledExtensionsByPackageName } = await import(
    "@cinatra-ai/extensions/canonical-store"
  );
  const { installExtensionManifest, transitionExtensionLifecycle } = await import(
    "@cinatra-ai/extensions/lifecycle-primitive"
  );
  const { isStaticBundleAnchorSource, staticBundleAnchorSource } = await import(
    "@cinatra-ai/extensions/static-bundle-anchor"
  );
  const { isPackageRequiredInProd } = await import("@cinatra-ai/extensions/required-in-prod");
  const { isExtensionKind } = await import("@cinatra-ai/extensions/canonical-types");
  const { randomUUID } = await import("node:crypto");

  const isDev = process.env.CINATRA_RUNTIME_MODE === "development";

  for (const rec of records) {
    try {
      const rows = await readInstalledExtensionsByPackageName(rec.packageName);
      if (rows.some((r) => isStaticBundleAnchorSource(r.source))) continue; // anchored (any status)

      const hasAny = rows.length > 0;
      const hasLive = rows.some((r) => r.status === "active" || r.status === "locked");
      const requiredInProd = isPackageRequiredInProd(rec.packageName);
      const legacyRetired = hasAny && !hasLive;

      if (legacyRetired && requiredInProd && !isDev) {
        // In prod a required-in-prod anchor is coerced to `locked` at install
        // and locked rejects `archive` — we could not preserve the retired
        // state. Leave the package un-anchored (the strict gate already skips
        // it via the archived rows) instead of flipping it live.
        console.warn(
          `[static-bundle-lifecycle] ${rec.packageName} is retired (rows exist, none live) ` +
            `but is required-in-prod — leaving it un-anchored rather than overriding the ` +
            `retired state. The required-set activation assertion will flag it.`,
        );
        continue;
      }

      const anchor = await installExtensionManifest(
        {
          id: `iext_${randomUUID().slice(0, 12)}`,
          packageName: rec.packageName,
          ownerLevel: "platform",
          ownerId: null,
          organizationId: null,
          kind: isExtensionKind(rec.kind) ? rec.kind : "connector",
          source: staticBundleAnchorSource(rec.packageName, rec.version ?? "0.0.0"),
          requiredInProd,
          dependencies: [],
          manifestHash: null,
          status: "active",
        },
        {
          actor: { source: "static-bundle-lifecycle" },
          reason: "static-bundle anchor seed (bundled serverEntry package)",
        },
      );

      if (legacyRetired) {
        // Preserve the operator's retired end-state: tombstone the fresh anchor
        // immediately (the loader's status read runs only after this seeder
        // completes in the same boot, so the short live window is not observed
        // by this process's gate).
        await transitionExtensionLifecycle(anchor.id, "archive", {
          actor: { source: "static-bundle-lifecycle" },
          reason: "static-bundle anchor seeded archived (package was retired pre-anchor)",
        });
        result.seededArchived.push(rec.packageName);
      } else {
        result.seededLive.push(rec.packageName);
      }
    } catch (err) {
      // Concurrent boot may have inserted the anchor between our read and
      // write — re-read before treating this as a failure.
      try {
        const rows = await readInstalledExtensionsByPackageName(rec.packageName);
        if (rows.some((r) => isStaticBundleAnchorSource(r.source))) continue;
      } catch {
        // fall through to the failure report
      }
      result.failed.push(rec.packageName);
      console.error(
        `[static-bundle-lifecycle] failed to ensure the lifecycle anchor for ${rec.packageName} ` +
          `— without a live row the strict activation gate will skip it:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (result.seededLive.length > 0 || result.seededArchived.length > 0) {
    console.info(
      `[static-bundle-lifecycle] anchored ${result.seededLive.length + result.seededArchived.length} ` +
        `bundled serverEntry package(s)` +
        (result.seededLive.length ? ` live: ${result.seededLive.join(", ")}` : "") +
        (result.seededArchived.length ? ` archived: ${result.seededArchived.join(", ")}` : ""),
    );
  }
  if (result.failed.length > 0) {
    console.error(
      `[static-bundle-lifecycle] ${result.failed.length} bundled serverEntry package(s) could ` +
        `NOT be anchored and will be skipped by the strict activation gate unless the status ` +
        `read itself fails open: ${result.failed.join(", ")}`,
    );
  }
  return result;
}
