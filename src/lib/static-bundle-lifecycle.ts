import "server-only";

// Static-bundle lifecycle seeding (manifest-completeness for bundled
// `serverEntry` extensions AND bundled required-in-prod extensions).
//
// The StaticBundleLoader's activation gate is a strict allow-list: a bundled
// `serverEntry` package activates ONLY when a live (active|locked)
// `installed_extension` row exists (see static-bundle-loader.ts). Bundled
// packages have no install pipeline — their bytes ship in the image — so this
// module makes them lifecycle-tracked: at boot (invoked by the loader BEFORE
// its status read) it ensures ONE platform-scoped ANCHOR row per bundled
// serverEntry package, written through the canonical lifecycle primitive.
//
// Required-in-prod packages WITHOUT a serverEntry (skills, artifacts, agents,
// schema-config connectors — 21 of the 33-entry required set today) are
// anchored too: the prod acquisition path (`cinatra setup prod`) materializes
// their SOURCE but inserts no canonical rows, and the extension-closure boot
// gate (extension-closure-boot-gate.ts) fails a prod boot closed when a
// required package has no live row. Anchoring the full bundled required set
// here is what makes that gate's premise true — a violating prod boot is a
// REAL defect (drifted image, row surgery, uninstall tombstone), not a
// bootstrapping gap. Anchors carry the generated manifest's dependency edges
// so the closure scan can actually validate bundled rows (pre-existing anchor
// rows created before this change keep their persisted edges — refreshing
// them is deliberately out of scope; new installs/anchors are complete).
//
// The anchor is the durable "lifecycle-tracked" memory that lets "no row" be
// read unambiguously, and it must NEVER resurrect an operator's
// archive/uninstall decision. Per package:
//   - anchor row exists (any status)   → authoritative — never touched (an
//                                        archived tombstone from `uninstall`
//                                        stays archived; lifecycle-primitive.ts);
//   - a platform-scoped NON-anchor row → ADOPTED as the anchor via
//     exists (the platform identity      `sourceSwitchExtension` (STATUS
//     slot is unique)                    PRESERVED: active stays active,
//                                        archived stays archived) — creating a
//                                        second platform row would violate the
//                                        identity index, and a later uninstall
//                                        of a non-anchor row would hard-delete
//                                        the lifecycle memory;
//   - no rows at all                   → never tracked → seed a LIVE anchor
//                                        (required-in-prod auto-locks in prod);
//   - only non-platform rows, NONE live→ retired before it was anchor-tracked
//                                        → seed the anchor DIRECTLY archived
//                                        (tombstone seed; no live-row window).
//
// Soft-failing: a per-package failure is logged loudly and never blocks boot —
// the loader's own fail-open path and the post-boot required-set activation
// assertion of the registration cutover are the backstops.

import {
  STATIC_EXTENSION_RECORDS,
} from "@/lib/generated/extensions.server";

export type StaticBundleLifecycleResult = {
  /** Packages whose anchor was created/adopted live (active, or locked in prod). */
  seededLive: string[];
  /** Packages whose anchor was created/adopted archived (retired state preserved). */
  seededArchived: string[];
  /** Packages whose anchor could not be ensured (logged; boot continues). */
  failed: string[];
};

/**
 * Ensure every bundled serverEntry package AND every bundled required-in-prod
 * package has a static-bundle anchor row.
 * Idempotent per package; safe under concurrent boots (an insert race is
 * re-read and treated as benign when an anchor now exists). NOTE: this runs
 * lock-free at boot, before any user-driven lifecycle action can execute in
 * this process (server actions/MCP only serve after boot); a concurrent
 * dispatcher install in ANOTHER process can transiently overwrite an adopted
 * row's provenance when it finalizes — the package stays lifecycle-tracked
 * either way.
 */
export async function ensureStaticBundleLifecycleAnchors(): Promise<StaticBundleLifecycleResult> {
  const result: StaticBundleLifecycleResult = { seededLive: [], seededArchived: [], failed: [] };

  const { readInstalledExtensionsByPackageName } = await import(
    "@cinatra-ai/extensions/canonical-store"
  );
  const { installExtensionManifest, sourceSwitchExtension } = await import(
    "@cinatra-ai/extensions/lifecycle-primitive"
  );
  const { isStaticBundleAnchorSource, staticBundleAnchorSource } = await import(
    "@cinatra-ai/extensions/static-bundle-anchor"
  );
  const { isPackageRequiredInProd } = await import("@cinatra-ai/extensions/required-in-prod");
  const { isExtensionKind } = await import("@cinatra-ai/extensions/canonical-types");
  const { randomUUID } = await import("node:crypto");

  const records = STATIC_EXTENSION_RECORDS.filter(
    (r) =>
      (typeof r.serverEntry === "string" && r.serverEntry.length > 0) ||
      isPackageRequiredInProd(r.packageName),
  );
  if (records.length === 0) return result;

  const actorOpts = {
    actor: { source: "static-bundle-lifecycle" },
    reason: "static-bundle anchor seed (bundled serverEntry or required-in-prod package)",
  };

  for (const rec of records) {
    try {
      const rows = await readInstalledExtensionsByPackageName(rec.packageName);
      if (rows.some((r) => isStaticBundleAnchorSource(r.source))) continue; // anchored (any status)

      const anchorSource = staticBundleAnchorSource(rec.packageName, rec.version ?? "0.0.0");

      // The platform identity slot (owner_level, owner_id, package_name) is
      // UNIQUE for organization_id IS NULL rows — if a platform-scoped row
      // already exists, a second platform row cannot be inserted, and that
      // row IS the package's platform lifecycle state. Adopt it as the anchor
      // (provenance switch only; STATUS PRESERVED — an archived platform row
      // stays archived, so adoption can never resurrect a retired package).
      const platformRow = rows.find((r) => r.ownerLevel === "platform");
      if (platformRow) {
        await sourceSwitchExtension(platformRow.id, anchorSource, {
          ...actorOpts,
          reason: "static-bundle anchor adoption (existing platform row)",
        });
        const live = platformRow.status === "active" || platformRow.status === "locked";
        (live ? result.seededLive : result.seededArchived).push(rec.packageName);
        continue;
      }

      // No platform row. If OTHER rows exist and none are live, the package
      // was retired before it was anchor-tracked — seed the anchor DIRECTLY
      // archived (tombstone seed: no live-row window a concurrent boot could
      // activate, no fallible install-then-archive two-step). Otherwise (no
      // rows at all, or a live non-platform row) seed it live.
      const hasAny = rows.length > 0;
      const hasLive = rows.some((r) => r.status === "active" || r.status === "locked");
      const legacyRetired = hasAny && !hasLive;
      const requiredInProd = isPackageRequiredInProd(rec.packageName);
      if (legacyRetired && requiredInProd) {
        console.warn(
          `[static-bundle-lifecycle] ${rec.packageName} is required-in-prod but retired ` +
            `(rows exist, none live) — anchoring it ARCHIVED to preserve that state; the ` +
            `required-set activation assertion will flag it until it is restored.`,
        );
      }

      await installExtensionManifest(
        {
          id: `iext_${randomUUID().slice(0, 12)}`,
          packageName: rec.packageName,
          ownerLevel: "platform",
          ownerId: null,
          organizationId: null,
          kind: isExtensionKind(rec.kind) ? rec.kind : "connector",
          source: anchorSource,
          requiredInProd,
          // Real edges from the generated manifest — the closure boot gate
          // validates bundled rows through these (was: [] — which made the
          // closure scan vacuous for every anchored package).
          dependencies: rec.dependencies ?? [],
          manifestHash: null,
          status: legacyRetired ? "archived" : "active",
        },
        actorOpts,
      );
      (legacyRetired ? result.seededArchived : result.seededLive).push(rec.packageName);
    } catch (err) {
      // Concurrent boot may have anchored the package between our read and
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
        `bundled serverEntry/required-in-prod package(s)` +
        (result.seededLive.length ? ` live: ${result.seededLive.join(", ")}` : "") +
        (result.seededArchived.length ? ` archived: ${result.seededArchived.join(", ")}` : ""),
    );
  }
  if (result.failed.length > 0) {
    console.error(
      `[static-bundle-lifecycle] ${result.failed.length} bundled serverEntry/required-in-prod ` +
        `package(s) could NOT be anchored — serverEntry packages will be skipped by the strict ` +
        `activation gate unless the status read itself fails open; required-in-prod packages ` +
        `without a live row fail the prod closure boot gate: ${result.failed.join(", ")}`,
    );
  }
  return result;
}
