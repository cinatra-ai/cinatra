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
//   - anchor row exists (any status)   → authoritative lifecycle memory — the
//                                        STATUS is never touched (an archived
//                                        tombstone from `uninstall` stays
//                                        archived; lifecycle-primitive.ts); a
//                                        LIVE anchor's PROVENANCE is refreshed
//                                        when the image's version/digest
//                                        drifted (cinatra#795), so the row
//                                        keeps describing the running image;
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

import { isInstallBlockingEdge } from "@cinatra-ai/extensions/dependency-closure";
import type { NormalizedExtensionRecord } from "@cinatra-ai/sdk-extensions";

import {
  STATIC_EXTENSION_RECORDS,
} from "@/lib/generated/extensions.server";

/**
 * The transitive REQUIRED-dependency closure of a seed set, over the bundled
 * registry's dependency edges.
 *
 * The boot closure gate (extension-closure-boot-gate.ts → dependency-closure.ts
 * `findBrokenClosures`/`computeClosure`) fails a prod boot closed when an
 * `active|locked` row holds an INSTALL-BLOCKING edge (a `required`, non-`peer`
 * runtime/install-time edge — `isInstallBlockingEdge`) whose target has no live
 * row. A bundled serverEntry/required-in-prod record is anchored (seeded) and so
 * gets a live row; but its OWN install-blocking targets are not necessarily
 * seeded by the base filter — a target with `serverEntry=null` that is not
 * itself required-in-prod (e.g. a host-only OAuth/UI connector) gets no anchor,
 * so the seeded dependent's edge to it is unsatisfiable and the boot throws.
 *
 * Seeding the transitive install-blocking closure of the seed set closes that
 * gap PRINCIPALLY: every package the boot gate would walk as a required edge
 * from a seeded row is itself anchored, so seeding and the assert agree. We key
 * on the SAME predicate (`isInstallBlockingEdge`) and the SAME edge source
 * (`record.dependencies`, an `ExtensionDependency[]`) the boot gate uses — peer
 * and optional edges are deliberately NOT followed (they are never
 * install/boot-blocking), so this never over-anchors. Cycles are handled (the
 * visited set), and edges to packages outside the bundled registry are ignored
 * (an unbundled target cannot be anchored from here — the boot gate surfaces it
 * the same way regardless).
 */
export function transitiveRequiredClosure(
  seedPackageNames: Iterable<string>,
  records: readonly NormalizedExtensionRecord[],
): Set<string> {
  const byName = new Map(records.map((r) => [r.packageName, r] as const));
  const closure = new Set<string>();
  const stack: string[] = [];
  for (const name of seedPackageNames) {
    if (byName.has(name) && !closure.has(name)) {
      closure.add(name);
      stack.push(name);
    }
  }
  while (stack.length > 0) {
    const rec = byName.get(stack.pop()!);
    if (!rec) continue;
    for (const dep of rec.dependencies ?? []) {
      // Only follow edges the boot closure gate would treat as blocking
      // (required, non-peer). Optional/peer edges never break a boot, so
      // following them would anchor records the gate does not require.
      if (!isInstallBlockingEdge(dep)) continue;
      if (!byName.has(dep.packageName)) continue; // unbundled target — cannot anchor here
      if (closure.has(dep.packageName)) continue; // cycle / already queued
      closure.add(dep.packageName);
      stack.push(dep.packageName);
    }
  }
  return closure;
}

export type StaticBundleLifecycleResult = {
  /** Packages whose anchor was created/adopted live (active, or locked in prod). */
  seededLive: string[];
  /** Packages whose anchor was created/adopted archived (retired state preserved). */
  seededArchived: string[];
  /**
   * LIVE anchor rows whose provenance was refreshed to the image's current
   * version/digest (cinatra#795) — status untouched.
   */
  refreshed: string[];
  /** Packages whose anchor could not be ensured (logged; boot continues). */
  failed: string[];
  /**
   * Packages whose EXISTING live anchor failed its provenance refresh — the
   * package stays anchored (activation unaffected); the row keeps its stale
   * version/digest until a later boot succeeds. Kept apart from `failed`,
   * whose contract is "no anchor could be ensured".
   */
  refreshFailed: string[];
  /**
   * Connector packages whose access DECLARATION (cinatra#951) could not be
   * resolved (invalid bundled cinatra/config.json) or cached — logged loudly;
   * the anchor itself is unaffected but the registration record keeps its
   * previous (possibly null) cached declaration, so the W2 resolver stays on
   * the last-known-good truth rather than a half-validated one.
   */
  accessDeclarationFailed: string[];
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
  const result: StaticBundleLifecycleResult = {
    seededLive: [],
    seededArchived: [],
    refreshed: [],
    failed: [],
    refreshFailed: [],
    accessDeclarationFailed: [],
  };

  const { readInstalledExtensionsByPackageName } = await import(
    "@cinatra-ai/extensions/canonical-store"
  );
  const { installExtensionManifest, sourceSwitchExtension, recordExtensionAccessDeclaration } =
    await import("@cinatra-ai/extensions/lifecycle-primitive");
  const { parseConnectorAccessConfig, resolveAbsentConnectorAccessConfig } = await import(
    "@cinatra-ai/sdk-extensions/access-config"
  );
  const { isStaticBundleAnchorSource, staticBundleAnchorSource } = await import(
    "@cinatra-ai/extensions/static-bundle-anchor"
  );
  const { isPackageRequiredInProd } = await import("@cinatra-ai/extensions/required-in-prod");
  const { isExtensionKind } = await import("@cinatra-ai/extensions/canonical-types");
  const { randomUUID } = await import("node:crypto");

  // Image-recorded bundled digests (cinatra#795) — the `<digest>` half of the
  // bundled identity. Fail-soft empty map on dev boots / read problems (the
  // reader never throws). The digest an anchor row carries must describe
  // EXACTLY the payload the image ships, so a recorded entry is used only when
  // its version AND kind match the generated record for the same tree.
  const { readRecordedBundledDigests } = await import("@/lib/bundled-digests");
  const recordedDigests = readRecordedBundledDigests();
  const digestFor = (rec: (typeof STATIC_EXTENSION_RECORDS)[number]): string | undefined => {
    const entry = recordedDigests.get(rec.packageName);
    if (!entry) return undefined;
    if (entry.version !== (rec.version ?? "0.0.0") || (entry.kind ?? null) !== (rec.kind ?? null)) {
      console.warn(
        `[static-bundle-lifecycle] recorded digest for ${rec.packageName} does not match the ` +
          `generated record (recorded ${entry.kind ?? "?"}@${entry.version}, record ` +
          `${rec.kind ?? "?"}@${rec.version ?? "0.0.0"}) — anchoring without a digest`,
      );
      return undefined;
    }
    return entry.digest;
  };

  // HOST CONFIG READER at boot registration (cinatra#951): resolve a bundled
  // connector's access declaration from the generated record's RAW
  // `accessConfig` pass-through (the SAME bytes the image ships — never a
  // repo-path re-read), through the single SDK validator with INSTALL-surface
  // absence semantics. Non-connector kinds resolve null. A throw is handled
  // per-record below (loud, anchor-preserving, accessDeclarationFailed).
  const resolveRecordAccessDeclaration = (rec: (typeof STATIC_EXTENSION_RECORDS)[number]) => {
    if (rec.kind !== "connector") return null;
    const raw = rec.accessConfig ?? null;
    return raw === null
      ? resolveAbsentConnectorAccessConfig({ packageName: rec.packageName, surface: "install" })
      : parseConnectorAccessConfig(raw, { packageName: rec.packageName });
  };
  type DeclarationShape = {
    formatVersion: number;
    mode: string;
    scope: string;
    source: string;
  };
  const declarationsEqual = (
    a: DeclarationShape | null | undefined,
    b: DeclarationShape | null,
  ): boolean =>
    !!a && !!b && a.formatVersion === b.formatVersion && a.mode === b.mode &&
    a.scope === b.scope && a.source === b.source;
  // Cache the resolved declaration on the registration record when it drifts
  // (once per image change — no per-boot write churn). Best-effort per record:
  // a failure is loud + recorded, never an anchor/boot blocker.
  const ensureDeclarationCached = async (
    rec: (typeof STATIC_EXTENSION_RECORDS)[number],
    rowId: string,
    current: DeclarationShape | null | undefined,
  ): Promise<void> => {
    if (rec.kind !== "connector") return;
    try {
      const resolved = resolveRecordAccessDeclaration(rec);
      if (resolved === null || declarationsEqual(current, resolved)) return;
      await recordExtensionAccessDeclaration(rowId, resolved, {
        actor: { source: "static-bundle-lifecycle" },
        reason: "connector access declaration cache @ boot registration (cinatra#951)",
      });
    } catch (err) {
      result.accessDeclarationFailed.push(rec.packageName);
      console.error(
        `[static-bundle-lifecycle] could not resolve/cache the access declaration for ` +
          `${rec.packageName} — the registration record keeps its previous cached value:`,
        err instanceof Error ? err.message : err,
      );
    }
  };

  // Base seed set: bundled serverEntry packages + bundled required-in-prod
  // packages (unchanged from PR #204).
  const baseSeed = STATIC_EXTENSION_RECORDS.filter(
    (r) =>
      (typeof r.serverEntry === "string" && r.serverEntry.length > 0) ||
      isPackageRequiredInProd(r.packageName),
  );
  // Transitive REQUIRED-closure seeding: a record is ALSO anchored when it is a
  // required (non-peer, non-optional) dependency — transitively — of any
  // base-seed record. This makes serverEntry-less required targets (e.g. a
  // host-only OAuth connector that a seeded connector requires) get a DB anchor,
  // so the boot closure gate's required edge to them resolves instead of failing
  // closed (fixes the linkedin-oauth-connector boot crash; see PR #204, #253).
  // We follow the SAME install-blocking edge predicate and edge source the boot
  // gate uses, so seeding and the assert agree and nothing is over-anchored.
  const anchorNames = transitiveRequiredClosure(
    baseSeed.map((r) => r.packageName),
    STATIC_EXTENSION_RECORDS,
  );
  const records = STATIC_EXTENSION_RECORDS.filter((r) => anchorNames.has(r.packageName));
  if (records.length === 0) return result;

  const actorOpts = {
    actor: { source: "static-bundle-lifecycle" },
    reason: "static-bundle anchor seed (bundled serverEntry or required-in-prod package)",
  };

  for (const rec of records) {
    try {
      const rows = await readInstalledExtensionsByPackageName(rec.packageName);
      const version = rec.version ?? "0.0.0";
      const digest = digestFor(rec);

      // Already anchored (any status) — the anchor is authoritative lifecycle
      // memory. STATUS is never touched here; but a LIVE anchor's PROVENANCE
      // must keep describing the image actually running (cinatra#795): an
      // image upgrade changes version/payload, and the required-in-prod
      // verifier reads the anchored version. Refresh live rows on real drift
      // only (once per image change, no per-boot write churn); archived
      // TOMBSTONES are historical retirement records — never rewritten.
      const anchored = rows.find((r) => isStaticBundleAnchorSource(r.source));
      if (anchored) {
        if (anchored.status !== "active" && anchored.status !== "locked") continue;
        const src = anchored.source;
        if (!isStaticBundleAnchorSource(src)) continue; // unreachable; narrows the type
        // Keep the cached access declaration current on every live anchor
        // (drift-gated write — see ensureDeclarationCached).
        await ensureDeclarationCached(rec, anchored.id, anchored.accessDeclaration);
        const versionDrift = src.version !== version;
        const digestDrift = digest !== undefined && src.digest !== digest;
        if (!versionDrift && !digestDrift) continue;
        // On a version bump with no (matching) recorded digest, the stale
        // digest is DROPPED — a digest describing the previous payload would
        // be a false identity claim. Same version + no recorded digest never
        // reaches here (digestDrift is false), so a known-good digest is
        // never stripped by a mere dev boot.
        const nextDigest = digest ?? (versionDrift ? undefined : src.digest);
        // Refresh failures are handled HERE (refreshFailed) and never fall
        // through to the outer catch: its anchored-row re-read would misread
        // "anchor exists" as a benign insert race and swallow the failure.
        try {
          await sourceSwitchExtension(
            anchored.id,
            staticBundleAnchorSource(rec.packageName, version, nextDigest),
            {
              ...actorOpts,
              reason: "static-bundle anchor provenance refresh (image version/digest changed)",
            },
          );
          result.refreshed.push(rec.packageName);
        } catch (err) {
          result.refreshFailed.push(rec.packageName);
          console.error(
            `[static-bundle-lifecycle] provenance refresh failed for ${rec.packageName} — the ` +
              `anchor row stays live with stale version/digest until a later boot succeeds:`,
            err instanceof Error ? err.message : err,
          );
        }
        continue;
      }

      const anchorSource = staticBundleAnchorSource(rec.packageName, version, digest);

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
        await ensureDeclarationCached(rec, platformRow.id, platformRow.accessDeclaration);
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

      const seededId = `iext_${randomUUID().slice(0, 12)}`;
      await installExtensionManifest(
        {
          id: seededId,
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
      await ensureDeclarationCached(rec, seededId, null);
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
  if (result.refreshed.length > 0) {
    console.info(
      `[static-bundle-lifecycle] refreshed anchor provenance (image version/digest) for ` +
        `${result.refreshed.length} package(s): ${result.refreshed.join(", ")}`,
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
