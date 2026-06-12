import "server-only";

// Extension dependency-closure + required-in-prod BOOT GATE.
//
// Production fail-closed enforcement for the required-extension contract
// (issue #78), enabled by the prod acquisition path: `cinatra setup prod`
// acquires the pinned required-extension set from the committed
// cinatra-required-extensions.lock.json BEFORE any DB mutation, and the
// static-bundle lifecycle seeds anchor rows at boot — so a prod boot whose
// canonical manifest still violates the contract is a REAL defect (drifted
// image, manual row surgery, an uninstall tombstone on a required package),
// not a bootstrapping gap.
//
// Posture (mirrors src/lib/required-extension-activation.ts):
//   - dev:  advisory — every violation is logged loudly, nothing throws.
//   - prod (CINATRA_RUNTIME_MODE !== "development"): THROWS on
//       (i)  a broken REQUIRED dependency closure of any active|locked row, or
//       (ii) a failed required-in-prod verification (missing package or
//            version-pin mismatch — verifyRequiredInProdInstalled).
//     Kill-switchable for emergency operability:
//     CINATRA_DISABLE_REQUIRED_CLOSURE_ASSERT=true.
//   - INDETERMINATE: only the INITIAL canonical-store read may be skipped
//     (console.error + return) when it throws — a fresh DB before
//     `cinatra setup prod` ran, or a transient DB error, is not a broken
//     closure, and a genuine outage fails boot on its own. Once the snapshot
//     exists, evaluation runs to completion and violations fail closed.
//
// Optional-missing deps never fail boot. They are dispatched through the
// per-kind behavior table (optionalMissingBehaviorForKind) and surfaced as
// behavior-tagged advisories — the consumable for the run-layer surfaces
// ("stop-run-hitl", "skip-step-audit", "log-continue"); the workflow
// "fail-instantiate" behavior is enforced at the instantiate boundary
// (src/lib/workflow-host-deps.ts), not here.

import type { InstalledExtension } from "@cinatra-ai/extensions/canonical-types";
import type { RequiredVerificationResult } from "@cinatra-ai/extensions/required-in-prod";

export type ClosureBootReport = {
  /** active|locked rows whose REQUIRED transitive closure is broken —
   *  missing/archived install-blocking deps AND (#180 item 6) present deps
   *  whose installed version violates the declared constraint. */
  brokenClosures: { packageName: string; missingRequired: string[]; rangeViolations: string[] }[];
  /** Required-in-prod presence + version-pin verification (same snapshot). */
  verification: RequiredVerificationResult;
  /** Behavior-tagged optional-missing advisories (never boot-fatal). */
  optionalAdvisories: {
    packageName: string;
    kind: InstalledExtension["kind"];
    behavior: string;
    missingOptional: string[];
  }[];
};

/**
 * Pure decision: the boot-fatal violation messages for a report. Empty array
 * means the required-extension contract holds. Exported for unit tests.
 */
export function closureBootViolations(report: ClosureBootReport): string[] {
  const violations: string[] = [];
  if (report.brokenClosures.length > 0) {
    violations.push(
      `${report.brokenClosures.length} installed extension(s) have a broken REQUIRED dependency closure: ` +
        report.brokenClosures
          .map((b) => {
            const parts = [
              ...b.missingRequired,
              // VERSION AWARENESS (#180 item 6): a violating installed
              // version is named with its constraint, not just the package.
              ...b.rangeViolations,
            ];
            return `${b.packageName} → [${parts.join(", ")}]`;
          })
          .join("; "),
    );
  }
  if (!report.verification.ok) {
    violations.push(report.verification.reason);
  }
  return violations;
}

/**
 * Build the report from one canonical-manifest snapshot. The optional-missing
 * advisories consume the per-kind behavior table via evaluateExecutionClosure.
 */
export async function buildClosureBootReport(
  rows: InstalledExtension[],
): Promise<ClosureBootReport> {
  const { findBrokenClosures, evaluateExecutionClosure, makeScopedManifestLookup } =
    await import("@cinatra-ai/extensions/dependency-closure");
  const { verifyRequiredInProdInstalled } = await import(
    "@cinatra-ai/extensions/required-in-prod"
  );
  const live = rows.filter((r) => r.status === "active" || r.status === "locked");
  const optionalAdvisories: ClosureBootReport["optionalAdvisories"] = [];
  for (const row of live) {
    // Scope-aware: each row's deps resolve from its own org, then platform —
    // a foreign org's live row never satisfies the edge (mirrors
    // findBrokenClosures, which scopes itself the same way).
    const verdict = evaluateExecutionClosure(row, makeScopedManifestLookup(rows, row.organizationId));
    if (verdict.advisory) {
      optionalAdvisories.push({
        packageName: row.packageName,
        kind: verdict.advisory.kind,
        behavior: verdict.advisory.behavior,
        missingOptional: verdict.advisory.missingOptional.map((d) => d.packageName),
      });
    }
  }
  return {
    brokenClosures: findBrokenClosures(rows),
    verification: await verifyRequiredInProdInstalled(rows),
    optionalAdvisories,
  };
}

/**
 * Log the report; throw outside development on violations (kill-switchable).
 * Split from the store read so tests drive it with an explicit report + mode.
 */
export function assertClosureBootReport(
  report: ClosureBootReport,
  opts?: { mode?: string | undefined; disabled?: boolean },
): void {
  const mode = opts?.mode ?? process.env.CINATRA_RUNTIME_MODE;
  const disabled =
    opts?.disabled ?? process.env.CINATRA_DISABLE_REQUIRED_CLOSURE_ASSERT === "true";

  for (const adv of report.optionalAdvisories) {
    console.warn(
      `[extension-closure] ${adv.packageName} (kind=${adv.kind}): optional dependencies ` +
        `missing/archived [${adv.missingOptional.join(", ")}] — per-kind behavior "${adv.behavior}".`,
    );
  }

  const violations = closureBootViolations(report);
  if (violations.length === 0) return;

  const message =
    `[extension-closure] required-extension contract violated at boot:\n  - ` +
    violations.join("\n  - ") +
    `\n  Remediation: the prod acquisition path owns this set — re-run \`cinatra setup prod\` ` +
    `(or \`cinatra extensions acquire-prod\`) against the committed ` +
    `cinatra-required-extensions.lock.json, or restore the archived/missing required rows. ` +
    `Emergency bypass: CINATRA_DISABLE_REQUIRED_CLOSURE_ASSERT=true.`;
  console.error(message);

  if (disabled) {
    console.error(
      "[extension-closure] CINATRA_DISABLE_REQUIRED_CLOSURE_ASSERT=true — fail-closed boot assert SKIPPED.",
    );
    return;
  }
  if (mode !== "development") {
    throw new Error(message);
  }
}

/**
 * Boot entry point. Dev: advisory (callers fire-and-forget). Prod: AWAIT it —
 * a violation throws out of register() and the boot fails closed.
 */
export async function enforceExtensionClosureAtBoot(): Promise<void> {
  let rows: InstalledExtension[];
  try {
    const { listInstalledExtensions } = await import("@cinatra-ai/extensions/canonical-store");
    rows = await listInstalledExtensions({});
  } catch (err) {
    // Indeterminate — the ONLY skippable failure (see module header).
    console.error(
      "[extension-closure] canonical-store read failed — closure boot gate skipped (indeterminate, not a verdict):",
      err instanceof Error ? err.message : err,
    );
    return;
  }
  const report = await buildClosureBootReport(rows);
  assertClosureBootReport(report);
}
