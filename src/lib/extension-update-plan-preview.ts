import "server-only";

// ---------------------------------------------------------------------------
// Update-plan DRY-RUN preview (cinatra#1041 outcome 2).
//
// The §II detail-modal footer's "Update now" runs the resolver as a dry-run
// FIRST and shows the concrete plan an admin confirms before anything is
// written. This module computes that preview by calling the EXISTING unified
// planner (`planDependencyInstall`, #1039) with `rootAction:"update"` and NO
// execution — the plan the preview renders is the plan the batch will run,
// because both go through `deps.plan` with identical inputs (the apply path is
// the unchanged `updateExtensionPackage` → `installExtensionWithDependencies`
// rootAction:"update" route; this module never mutates anything).
//
// GUARDS (outcome 4/5) — all re-checked server-side, never trusted from the UI:
//   • non-comparable installed sources (github refs, `0.0.0-dev.*`, local /
//     null-version rows) have NO update state — refused, never a
//     string-equality fallback;
//   • an ABI-incompatible target (deriveExtensionCompatState) is refused —
//     the same activation gate the marketplace CTA greys out on;
//   • a locked / requiredInProd row updates only WITHIN the host's required
//     pin range (`checkRequiredExtensionVersionPin`);
//   • refusals cross the boundary as a #685 CATEGORY only — the raw reason is
//     logged server-side by the action wrapper, never sent to the client.
//
// The GATEKEPT path keeps its ratified fence (#1296): updates there are a
// direct in-place root update (never routed through the planner), so the
// preview is exactly the one-member direct-update plan.
// ---------------------------------------------------------------------------

import type { InstalledExtension } from "@cinatra-ai/extensions/canonical-types";
import {
  assertUpdateDoesNotBreakDependents,
  DependencyClosureError,
  edgesOf,
  isInstallBlockingEdge,
  makeScopedManifestLookup,
} from "@cinatra-ai/extensions/dependency-closure";
import { isDevVersion } from "@cinatra-ai/extensions/dev-version";
import {
  checkRequiredExtensionVersionPin,
  type RequiredVersionPinVerdict,
} from "@cinatra-ai/extensions/required-in-prod";
import {
  comparePluginVersions,
  isExactVersion,
} from "@cinatra-ai/registries/src/version-compare";
import type { InstalledUpdateReadout } from "@cinatra-ai/registries/src/update-read-model";
import type { MarketplaceFailureCategory } from "@cinatra-ai/extensions/screens/marketplace-failure-copy";
// The WIRE shape the §II modal flow renders — one pure module shared by this
// server computation, the action wrapper, and the client panel, so the three
// can never disagree on the plan's serialized fields.
import type {
  UpdatePlanPreviewDto,
  UpdatePlanPreviewMemberDto,
} from "@cinatra-ai/extensions/screens/update-plan-model";
import type {
  DependencyInstallPlan,
  PlannedMember,
} from "@/lib/extension-dependency-plan";
import { DependencyPlanError, defaultRowOwnership } from "@/lib/extension-dependency-plan";
import { deriveExtensionCompatState } from "@/lib/extension-compat-badge";

export type UpdatePlanPreviewMember = UpdatePlanPreviewMemberDto;
export type UpdatePlanPreview = UpdatePlanPreviewDto;

/**
 * A guarded refusal. Carries ONLY the #685 category across the boundary; the
 * message stays server-side (the action wrapper logs it for the operator).
 */
export class UpdatePlanRefusal extends Error {
  constructor(
    public readonly category: MarketplaceFailureCategory,
    message: string,
  ) {
    super(message);
    this.name = "UpdatePlanRefusal";
  }
}

/** Injectable seams — the default factory wires the live host reads. */
export type UpdatePlanPreviewDeps = {
  readInstalledRows: () => Promise<InstalledExtension[]>;
  readUpdateReadout: (packageName: string) => Promise<InstalledUpdateReadout | null>;
  isGatekeptInstallEnabled: () => boolean;
  plan: (input: {
    root: { packageName: string; version: string };
    orgId: string | null;
    rowOwnership?: ReturnType<typeof defaultRowOwnership>;
    closure: null;
    rootAction: "update";
  }) => Promise<DependencyInstallPlan>;
  /**
   * Display + ABI metadata for one exact pin (packument read on the
   * dev/non-gatekept path). Returns `null` ONLY when the read FAILED; a
   * successful read of a range-less / name-less manifest returns an object with
   * the missing fields `null`. The two callers treat the `null` (failed-read)
   * case differently by design: the ROOT ABI read fails CLOSED on it (an
   * unreadable manifest cannot be proven ABI-compatible — see the ABI gate
   * below), whereas the per-member DISPLAY reads stay cosmetic (a null there
   * falls back to the package name and never fails the dry-run).
   */
  fetchDisplayInfo: (
    packageName: string,
    version: string,
  ) => Promise<{ displayName: string | null; sdkAbiRange: string | null } | null>;
  /**
   * The host's required-pin gate (outcome 5): a locked / requiredInProd row
   * updates only WITHIN the pinned range. Defaults to
   * `checkRequiredExtensionVersionPin` (reading the host's own package.json);
   * injectable so the refusal is unit-testable without touching the real root
   * manifest.
   */
  checkRequiredPin: (input: {
    packageName: string;
    version: string;
    op: "update";
  }) => RequiredVersionPinVerdict;
};

/** The registry-comparable installed version of a row (null = non-registry). */
function registryVersionOfRow(row: InstalledExtension): string | null {
  if (row.source.type === "verdaccio" || row.source.type === "bundled") {
    return row.source.version;
  }
  return null;
}

/** Resolve the live DEFAULT row for a package at the [org, platform] binary —
 *  the same fallback the batch's pre-state reads use. Side-by-side siblings
 *  (`isDefault === false`, cinatra#1040 S1) are NEVER the row a dedupe-upward
 *  updates, so they are excluded here — otherwise a sibling's version could
 *  masquerade as the "from" version. */
function resolveLiveRow(
  rows: InstalledExtension[],
  packageName: string,
  orgId: string | null,
): InstalledExtension | null {
  // Mirror the planner's row resolution EXACTLY (extension-dependency-plan.ts
  // `findLiveRowsInScope` + `defaultLiveRow`) so the preview never resolves a
  // row the apply path would refuse (preview↔apply row-identity parity). Two
  // steps, in the planner's order:
  //   (1) pick the scope LEVEL by whether it holds ANY live (active|locked)
  //       row — DEFAULT OR NOT: the org level wins when it holds any such row,
  //       else the platform level. A non-default side-by-side sibling at the
  //       org level therefore CLAIMS the org level (it does NOT fall through to
  //       platform), exactly as `findLiveRowsInScope` does;
  //   (2) return the EXACTLY-ONE default of that level — null when the level
  //       holds zero defaults (e.g. only a side-by-side sibling) OR more than
  //       one (cross-owner ambiguity). The apply path fails closed on both, so
  //       the preview refuses there too rather than reporting an arbitrary
  //       (or a non-default sibling's) `fromVersion` and succeeding where apply
  //       refuses.
  const orgKey = orgId ?? null;
  const live = rows.filter(
    (r) =>
      r.packageName === packageName && (r.status === "active" || r.status === "locked"),
  );
  const atOrg = live.filter((r) => (r.organizationId ?? null) === orgKey);
  const scope = atOrg.length > 0 ? atOrg : live.filter((r) => (r.organizationId ?? null) === null);
  const defaults = scope.filter((r) => r.isDefault !== false);
  return defaults.length === 1 ? defaults[0]! : null;
}

/**
 * PURE mapper: planner members → preview rows (unit-testable without a DB).
 *
 *  • `alreadyInstalled` members are SKIPPED (the saga skips them — nothing
 *    happens to them, so the plan panel must not list them);
 *  • non-root `action:"update"` members are the shared-dependency
 *    dedupe-upward group, and each one derives its REBOUND dependents — the
 *    live rows whose install-blocking edge binds the row being upgraded
 *    (excluding plan members themselves, whose re-pin is already listed);
 *  • ordering follows the drawing: the root update first, then shared-dep
 *    updates, installs, side-by-side, rebounds.
 */
export function buildUpdatePlanPreviewMembers(input: {
  ordered: PlannedMember[];
  rootPackageName: string;
  installedRows: InstalledExtension[];
  orgId: string | null;
}): Omit<UpdatePlanPreviewMember, "displayName">[] {
  const { ordered, rootPackageName, installedRows, orgId } = input;
  const acted = ordered.filter((m) => !m.alreadyInstalled);
  const planNames = new Set(acted.map((m) => m.packageName));

  const root: Omit<UpdatePlanPreviewMember, "displayName">[] = [];
  const updates: Omit<UpdatePlanPreviewMember, "displayName">[] = [];
  const installs: Omit<UpdatePlanPreviewMember, "displayName">[] = [];
  const sideBySide: Omit<UpdatePlanPreviewMember, "displayName">[] = [];
  const rebounds: Omit<UpdatePlanPreviewMember, "displayName">[] = [];
  const reboundSeen = new Set<string>();

  const liveVersionOf = (name: string): string | null => {
    const row = resolveLiveRow(installedRows, name, orgId);
    return row ? registryVersionOfRow(row) : null;
  };

  for (const m of acted) {
    const isRoot = m.packageName === rootPackageName;
    const from = liveVersionOf(m.packageName);
    if (m.action === "update") {
      (isRoot ? root : updates).push({
        packageName: m.packageName,
        action: "update",
        fromVersion: from,
        toVersion: m.version,
        reboundToPackageName: null,
        isRoot,
      });
      if (!isRoot) {
        // REBOUND dependents: live rows whose install-blocking edge binds THE
        // row being upgraded — row IDENTITY, not just the package name: a
        // dependent pinned to an untouched side-by-side sibling is
        // NOT rebound. A persisted resolution must point at the updated
        // default row; an unresolved edge binds via the dependent's own scoped
        // lookup, which must also land on that row (the same identity rule
        // `assertUpdateDoesNotBreakDependents` applies). The plan already
        // proved every binding dependent admits the pin, so each one is
        // re-pointed to the new version by the write-time edge resolver.
        const targetRow = resolveLiveRow(installedRows, m.packageName, orgId);
        for (const row of installedRows) {
          if (targetRow === null) break;
          if (row.packageName === m.packageName) continue;
          if (row.status !== "active" && row.status !== "locked") continue;
          if (planNames.has(row.packageName) || reboundSeen.has(row.packageName)) continue;
          const binds = edgesOf(row).some(
            (edge) =>
              edge.packageName === m.packageName &&
              isInstallBlockingEdge(edge) &&
              (edge.resolvedInstallId != null
                ? edge.resolvedInstallId === targetRow.id
                : makeScopedManifestLookup(installedRows, row.organizationId)(m.packageName)
                    ?.id === targetRow.id),
          );
          if (!binds) continue;
          reboundSeen.add(row.packageName);
          rebounds.push({
            packageName: row.packageName,
            action: "rebound",
            fromVersion: null,
            toVersion: null,
            reboundToPackageName: m.packageName,
            isRoot: false,
          });
        }
      }
    } else if (m.action === "install") {
      installs.push({
        packageName: m.packageName,
        action: "install",
        fromVersion: null,
        toVersion: m.version,
        reboundToPackageName: null,
        isRoot,
      });
    } else {
      sideBySide.push({
        packageName: m.packageName,
        action: "side-by-side",
        fromVersion: from,
        toVersion: m.version,
        reboundToPackageName: null,
        isRoot,
      });
    }
  }

  return [...root, ...updates, ...installs, ...sideBySide, ...rebounds];
}

async function makeDefaultDeps(): Promise<UpdatePlanPreviewDeps> {
  const { isGatekeptInstallEnabled } = await import("@/lib/gatekept-install");
  const { readInstalledUpdateReadouts } = await import(
    "@/lib/extension-update-read-model-store"
  );
  const { makeDefaultInstallBatchSagaDeps } = await import("@/lib/extension-install-batch");
  return {
    readInstalledRows: async () => {
      const { listInstalledExtensions } = await import("@cinatra-ai/extensions/canonical-store");
      return listInstalledExtensions({});
    },
    readUpdateReadout: async (packageName) =>
      (await readInstalledUpdateReadouts([packageName])).find(
        (r) => r.packageName === packageName,
      ) ?? null,
    isGatekeptInstallEnabled,
    plan: async (input) => {
      // The SAME planner wiring the batch executes with — the preview can
      // never disagree with the apply path about the member set.
      const sagaDeps = await makeDefaultInstallBatchSagaDeps();
      return sagaDeps.plan(input);
    },
    fetchDisplayInfo: async (packageName, version) => {
      try {
        const { getPublishedExtensionSummary } = await import("@cinatra-ai/registries");
        const { loadVerdaccioConfigForReads } = await import("@/lib/verdaccio-config");
        const config = await loadVerdaccioConfigForReads();
        const summary = await getPublishedExtensionSummary(
          { packageName, packageVersion: version },
          config,
        );
        const cinatra = (summary.manifest as { cinatra?: Record<string, unknown> } | null)
          ?.cinatra;
        const displayName =
          typeof cinatra?.displayName === "string" && cinatra.displayName.trim()
            ? cinatra.displayName
            : null;
        const sdkAbiRange =
          typeof cinatra?.sdkAbiRange === "string" ? cinatra.sdkAbiRange : null;
        return { displayName, sdkAbiRange };
      } catch {
        // Signal a FAILED read (distinct from a successful read of a
        // range-less manifest, which returns fields set to null): the ROOT ABI
        // gate fails closed on this, the per-member display reads fall back to
        // the package name.
        return null;
      }
    },
    checkRequiredPin: (input) => checkRequiredExtensionVersionPin(input),
  };
}

/**
 * Compute the dry-run update plan for one installed extension. Throws
 * `UpdatePlanRefusal` (category-mapped) on every guard; other throws are the
 * caller's to classify (#685 `classifyMarketplaceFailure`).
 */
export async function computeExtensionUpdatePlanPreview(
  input: {
    packageName: string;
    /** Explicit target (the marketplace modal's catalog version); absent →
     *  the cached update read model's latest. */
    targetVersion?: string;
    orgId: string | null;
  },
  depsOverride?: UpdatePlanPreviewDeps,
): Promise<UpdatePlanPreview> {
  const deps = depsOverride ?? (await makeDefaultDeps());
  const { packageName, orgId } = input;

  const installedRows = await deps.readInstalledRows();
  const liveRow = resolveLiveRow(installedRows, packageName, orgId);
  if (!liveRow) {
    throw new UpdatePlanRefusal(
      "unrecoverable",
      `update-plan: ${packageName} has no live installed row at the actor scope`,
    );
  }

  // Outcome 4 — non-comparable installed sources (github refs, 0.0.0-dev.*,
  // local) have NO update state; never a string-equality fallback.
  const installedVersion = registryVersionOfRow(liveRow);
  if (
    installedVersion == null ||
    !isExactVersion(installedVersion) ||
    isDevVersion(installedVersion)
  ) {
    throw new UpdatePlanRefusal(
      "unrecoverable",
      `update-plan: ${packageName} has a non-comparable installed source ` +
        `(version ${installedVersion ?? "unknown"}) — no update state exists for it`,
    );
  }

  const readout = await deps.readUpdateReadout(packageName);
  const modelLatest = readout && !readout.stale ? (readout.entry?.latestVersion ?? null) : null;
  const target = input.targetVersion ?? modelLatest;
  if (!target || !isExactVersion(target)) {
    throw new UpdatePlanRefusal(
      "unavailable-version",
      `update-plan: no resolvable update target for ${packageName} ` +
        `(requested ${input.targetVersion ?? "—"}, read model ${modelLatest ?? "—"})`,
    );
  }
  if (comparePluginVersions(installedVersion, target) !== "update-available") {
    throw new UpdatePlanRefusal(
      "unavailable-version",
      `update-plan: ${packageName}@${installedVersion} is not semver-older than ${target} — nothing to update`,
    );
  }

  // Outcome 5 — ABI gate: the target's declared sdkAbiRange must not be
  // incompatible with this host (the same activation-gate verdict the chip /
  // CTA grey out on). Range source: the read model when it covers the target,
  // else the target's packument manifest (dev path). FAIL CLOSED when neither
  // source can prove anything on the gatekept path.
  // Trust the cached ABI ONLY from a NON-stale readout whose entry is the very
  // target (a specific version's declared range is immutable, but a stale
  // readout may not be trusted at all — the dev path then falls through to the
  // fresh packument read, the gatekept path refuses).
  let abiRange: string | null | undefined =
    readout && !readout.stale && readout.entry?.latestVersion === target
      ? readout.entry.latestSdkAbiRange
      : undefined;
  let fetchedRootDisplay: string | null = null;
  if (abiRange === undefined) {
    if (deps.isGatekeptInstallEnabled()) {
      throw new UpdatePlanRefusal(
        "unavailable-version",
        `update-plan: ${packageName}@${target} is not covered by the update read model on a ` +
          `gatekept deployment — refusing (no ABI verdict available)`,
      );
    }
    // Dev path: read the target's DECLARED ABI from its packument. A `null`
    // return means the read FAILED — never a genuine "no range" (a successful
    // read of a range-less manifest returns an object with `sdkAbiRange: null`).
    // The ABI gate FAILS CLOSED on an unreadable manifest: an "unknown"
    // fallthrough would let an incompatible target pass the preview while apply
    // reads the materialized manifest and fails closed (preview↔apply ABI
    // parity). A genuine undeclared range (`sdkAbiRange:null`)
    // still reads "unknown" → lenient, exactly like the activation gate.
    const info = await deps.fetchDisplayInfo(packageName, target);
    if (info === null) {
      throw new UpdatePlanRefusal(
        "unavailable-version",
        `update-plan: could not read ${packageName}@${target} manifest to verify ABI ` +
          `compatibility — refusing (fail closed rather than assume compatible)`,
      );
    }
    abiRange = info.sdkAbiRange;
    fetchedRootDisplay = info.displayName;
  }
  if (deriveExtensionCompatState(abiRange) === "incompatible") {
    throw new UpdatePlanRefusal(
      "denied-entitlement",
      `update-plan: ${packageName}@${target} declares an sdkAbiRange (${abiRange}) this host ` +
        `does not satisfy — the activation gate would refuse it`,
    );
  }

  // Outcome 5 — locked / requiredInProd rows update only WITHIN the host's
  // required pin range. Same gate the dispatcher enforces at apply time.
  const pin = deps.checkRequiredPin({ packageName, version: target, op: "update" });
  if (!pin.ok) {
    throw new UpdatePlanRefusal("denied-entitlement", `update-plan: ${pin.reason}`);
  }

  // Outcome 5 — the ROOT dependent-break fence. The planner exempts the root
  // from the conflict classifier, so its dry-run alone would NOT catch a root
  // update that violates a live dependent's install-blocking edge; the apply
  // path runs `assertUpdateDoesNotBreakDependents` for the root at write time
  // (packages/extensions index.ts "UPDATE GATE") and refuses. Run the SAME gate
  // here (read-only, same args) so the preview refuses in lockstep instead of
  // rendering a plan the admin confirms and the apply then rejects
  // (preview↔apply root-fence parity). Same compatibility-constraint
  // family as the required-pin refusal above → `denied-entitlement`; the named
  // dependents stay server-side (#685).
  try {
    assertUpdateDoesNotBreakDependents(packageName, target, installedRows, {
      organizationId: orgId,
    });
  } catch (err) {
    if (err instanceof DependencyClosureError && err.code === "UPDATE_BREAKS_DEPENDENTS") {
      throw new UpdatePlanRefusal(
        "denied-entitlement",
        `update-plan: ${packageName}@${target} would break live dependents ` +
          `(${err.dependents.join(", ")}) — the apply-time update gate would refuse it`,
      );
    }
    throw err;
  }

  // The plan. Gatekept: the ratified #1296 fence keeps updates as a direct
  // in-place root update (never planner-routed) — the truthful preview is the
  // one-member plan. Dev/non-gatekept: the REAL planner dry-run.
  let bare: Omit<UpdatePlanPreviewMember, "displayName">[];
  if (deps.isGatekeptInstallEnabled()) {
    bare = [
      {
        packageName,
        action: "update",
        fromVersion: installedVersion,
        toVersion: target,
        reboundToPackageName: null,
        isRoot: true,
      },
    ];
  } else {
    let plan: DependencyInstallPlan;
    try {
      plan = await deps.plan({
        root: { packageName, version: target },
        orgId,
        rowOwnership: defaultRowOwnership(orgId),
        closure: null,
        rootAction: "update",
      });
    } catch (err) {
      if (err instanceof DependencyPlanError) {
        throw new UpdatePlanRefusal(
          err.code === "MEMBER_UNRESOLVABLE" ? "unavailable-version" : "unrecoverable",
          `update-plan: planner refused (${err.code}): ${err.message}`,
        );
      }
      throw err;
    }
    bare = buildUpdatePlanPreviewMembers({
      ordered: plan.ordered,
      rootPackageName: packageName,
      installedRows,
      orgId,
    });
  }

  // Display names (§II: rendered names are displayNames) — best-effort packument
  // reads on the dev path; the client falls back to the card's displayName for
  // the root and to the package name otherwise.
  const gatekept = deps.isGatekeptInstallEnabled();
  const members: UpdatePlanPreviewMember[] = await Promise.all(
    bare.map(async (m) => {
      if (gatekept) return { ...m, displayName: null };
      if (m.isRoot && fetchedRootDisplay) return { ...m, displayName: fetchedRootDisplay };
      const memberRow = resolveLiveRow(installedRows, m.packageName, orgId);
      const versionForRead =
        m.toVersion ?? (memberRow ? registryVersionOfRow(memberRow) : null) ?? undefined;
      const info = versionForRead
        ? await deps.fetchDisplayInfo(m.packageName, versionForRead)
        : null;
      return { ...m, displayName: info?.displayName ?? null };
    }),
  );

  return { packageName, fromVersion: installedVersion, toVersion: target, members };
}
