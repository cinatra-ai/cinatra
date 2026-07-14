"use server";

import "./handler-bootstrap";
import { redirect } from "next/navigation";
import { getAgentPackage as _getAgentPackage } from "@cinatra-ai/registries";
// getAgentPackage import retained for deprecated agent-only call sites that
// may yet exist in this file's tail; lifecycle dispatch now uses
// resolveExtensionPackageForLifecycle.
void _getAgentPackage;
import { extensionRegistry } from "./index";
import type { Actor } from "@cinatra-ai/extension-types";
import type { DanglingReferences } from "./audit-log";
import { requireAdminSession } from "@/lib/auth-session";
import {
  assertCanRemoveExtension,
  isSystemExtension,
} from "./system-extension-inventory";
import {
  deriveTypeId,
  resolveExtensionTypeId,
  resolveExtensionPackageForLifecycle,
} from "./utils";
import {
  classifyMarketplaceFailure,
  extractContractCode,
  extractHttpStatus,
  type MarketplaceFailureCategory,
  type MarketplaceInstallActionResult,
} from "./screens/marketplace-failure-copy";
// NOTE (cinatra#1041): the §II modal-footer DRY-RUN action deliberately does
// NOT live here — it is screens-only (screens/update-plan-action.ts). This
// module is reachable from the MCP / A2A / LLM-bridge dispatch surfaces, and
// homing a UI-only action here would grow those locked route graphs.
// cinatra#1061: the REMOVAL-side returned contract (uninstall/archive). Separate
// from the marketplace taxonomy above — a removal refusal is a local closure
// gate that NAMES its blockers, not a registry install failure.
import {
  classifyRemovalFailure,
  type RemovalActionResult,
} from "./removal-failure";
// Pre-install access selector (cinatra#805): target schema + target→policy
// mapping. PURE module — the authz gates + policy write are lazy-imported
// inside the action so the no-target path pays nothing.
import {
  InstallAccessTargetSchema,
  accessTargetToInstallPolicy,
  isInstallAccessTargetKind,
  type InstallAccessTarget,
} from "./install-access-target";

// ---------------------------------------------------------------------------
// Operator-side failure logging (cinatra#685). The end user only ever sees a
// category-derived, NON-technical message; the FULL technical error must stay
// available to operators. install-batch already console.error/warn the
// underlying detail; the dispatch boundary logs once more with a stable
// `[marketplace-install]` tag + the classified category so an operator can
// correlate "the user saw category X" with the raw cause in the same logs.
// Defined here (not exported) — a "use server" module may only EXPORT async
// functions, but a private sync helper is fine.
function logMarketplaceFailureForOperator(
  operation: string,
  packageName: string,
  category: MarketplaceFailureCategory,
  err: unknown,
): void {
  // Use a CONSTANT format string with %s placeholders and pass the dynamic
  // values (incl. the user-controlled packageName) as separate arguments — never
  // interpolate user input into the format-string position, which console.error
  // would interpret for %-directives (CWE-134 externally-controlled format string).
  console.error(
    "[marketplace-install] %s failed for %s (category=%s):",
    operation,
    packageName,
    category,
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
}

// ---------------------------------------------------------------------------
// Operator diagnostics at the classification chokepoint (cinatra#1539).
//
// This dispatch boundary is the ONLY place that still holds the RAW error
// object (its `cause` chain / MarketplaceMcpError `responseBody` + `httpStatus`)
// before it is stringified — so it is the only place that can record the true
// contract code + HTTP status. The incident that motivated #1539 was
// UNDIAGNOSED precisely because the existing operator log carried only the
// app-facing category, not the underlying code/status. Every classified failure
// now emits ONE STRICTLY-SANITIZED structured line here, tagged with an opaque
// diagnostic reference that ALSO travels to the user (in the failure toast) so
// an admin can cite it and an operator can grep for it.
//
// STRICTLY SANITIZED — the structured line carries ONLY bounded, non-secret
// fields: the coarse contract code (extracted, `[a-z0-9_]+`), the numeric HTTP
// status, the app category, and the opaque reference. It DELIBERATELY does NOT
// include the raw error message/stack: a MarketplaceMcpError embeds the upstream
// response `detail` into its message, so logging it here would risk a CWE-532
// leak. The full technical error, if needed, stays in the pre-existing
// `logMarketplaceFailureForOperator` / install-batch operator logs. The
// user-controlled `packageName`/`packageVersion` are newline/control-stripped
// (CWE-117 log-injection) and pass as %s args, never into the format position
// (CWE-134).
// ---------------------------------------------------------------------------

// Opaque, non-technical correlation id. crypto.randomUUID is always present in
// the Node server runtime this "use server" module executes in. Uppercased hex
// so it reads as an id ("REF-1A2B3C4D"), never leaks anything, and carries no
// operator jargon in the user-facing toast.
function newDiagnosticReference(): string {
  const hex = globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  return `REF-${hex.toUpperCase()}`;
}

// Bound a user-controlled value for a single log line: replace CR/LF + other
// C0 control chars and DEL (CWE-117 log injection) with a space, then cap the
// length. Char-code filtered (no regex) so no control char lives in source.
function sanitizeForLog(value: string): string {
  let out = "";
  for (const ch of value.slice(0, 200)) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out;
}

// Classify + emit the strictly-sanitized structured chokepoint log, and mint the
// diagnostic reference that correlates the log line with the user's toast.
// Returns both so the caller can thread the reference back to the client.
function classifyAndLogInstallFailure(
  operation: string,
  packageName: string,
  packageVersion: string,
  err: unknown,
): { category: MarketplaceFailureCategory; reference: string } {
  const category = classifyMarketplaceFailure(err);
  const contractCode = extractContractCode(err);
  const httpStatus = extractHttpStatus(err);
  const reference = newDiagnosticReference();
  // CONSTANT format string with %s placeholders; every value is bounded/sanitized
  // (see the header). NO raw error message/stack — that would risk leaking the
  // upstream response detail embedded in a MarketplaceMcpError message.
  console.error(
    "[marketplace-install] %s classify-failed pkg=%s version=%s category=%s code=%s httpStatus=%s ref=%s",
    operation,
    sanitizeForLog(packageName),
    packageVersion ? sanitizeForLog(packageVersion) : "(none)",
    category,
    contractCode ?? "none",
    httpStatus ?? "none",
    reference,
  );
  return { category, reference };
}

// A missing/empty version is rejected BEFORE any install request is made
// (cinatra#1539 AC6): the request cannot succeed, and the resulting contract
// error would be a bad-input (`invalid_version`) that must not surface as a
// "gone version". Logged like a chokepoint failure (with a reference) but
// without a network round-trip. `unrecoverable` → generic, non-"gone" copy.
function rejectEmptyInstallVersion(
  operation: string,
  packageName: string,
): { category: MarketplaceFailureCategory; reference: string } {
  const reference = newDiagnosticReference();
  console.error(
    "[marketplace-install] %s rejected pkg=%s reason=empty-version ref=%s",
    operation,
    sanitizeForLog(packageName),
    reference,
  );
  return { category: "unrecoverable", reference };
}

// cinatra#1061 sibling of the above for REMOVAL (uninstall/archive). The user
// sees only the reason-derived, non-technical copy (which for `dependents` names
// the blocking installed extensions); the FULL technical error stays here for
// operators. Same CWE-134-safe constant-format-string discipline.
function logRemovalFailureForOperator(
  operation: string,
  packageName: string,
  failure: RemovalActionResult,
  err: unknown,
): void {
  console.error(
    "[extension-removal] %s refused/failed for %s (reason=%s):",
    operation,
    packageName,
    failure.reason,
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
}

// ---------------------------------------------------------------------------
// Extension-local server actions dispatch through the extensionRegistry
// singleton. Kept in @cinatra-ai/extensions to avoid the circular dependency
// that would result from importing extensionRegistry into @cinatra-ai/agents
// (packages/agents depends on packages/extensions would close a cycle:
// agents→extensions→agents).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Core dispatch functions — explicit actor parameter, used by MCP handlers
// and callable from any server context that already has an actor object.
// ---------------------------------------------------------------------------

export async function installExtensionPackage(
  packageName: string,
  packageVersion: string,
  actor: Actor,
): Promise<{
  success: boolean;
  error?: string;
  failureCategory?: MarketplaceFailureCategory;
  reference?: string;
}> {
  "use server";
  await requireAdminSession();
  // #1539 AC6: reject a missing/empty version BEFORE the install request is
  // made — it cannot succeed and its contract error (`invalid_version`) must not
  // surface as a "gone version". Non-"gone" generic copy + a diagnostic ref.
  if (packageVersion == null || packageVersion.trim() === "") {
    const { category, reference } = rejectEmptyInstallVersion("install", packageName);
    return {
      success: false,
      error: "missing package version",
      failureCategory: category,
      reference,
    };
  }
  try {
    // DEPENDENCY-BATCH entry (#180): authorize-once → plan (manifest-edge
    // walk, auto-installable edges only) → install missing dependencies
    // DEPENDENCIES-FIRST through this same registry → the requested root
    // LAST — with a persisted batch ledger + inverse-order compensation.
    // A depless root takes the unchanged single-install fast path inside.
    // typeId resolution happens in the planner (one packument read per
    // member, under the root grant on the gatekept path). Dynamic import:
    // @/lib is the host; same pattern utils.ts uses for gatekept-install.
    const { installExtensionWithDependencies } = await import(
      "@/lib/extension-install-batch"
    );
    await installExtensionWithDependencies({ packageName, version: packageVersion, actor });
    return { success: true };
  } catch (err) {
    // Classify from the REAL error object here, BEFORE it is stringified — this
    // is the only place that still has the `cause` chain / MarketplaceMcpError
    // `responseBody` + `httpStatus` the taxonomy classifier reads (cinatra#685).
    // #1539: the chokepoint also emits the sanitized structured diagnostics
    // (raw contract code + HTTP status) and mints the correlating reference.
    const { category, reference } = classifyAndLogInstallFailure(
      "install",
      packageName,
      packageVersion,
      err,
    );
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      failureCategory: category,
      reference,
    };
  }
}

export async function updateExtensionPackage(
  packageName: string,
  packageVersion: string,
  actor: Actor,
): Promise<{
  success: boolean;
  error?: string;
  failureCategory?: MarketplaceFailureCategory;
  reference?: string;
}> {
  "use server";
  await requireAdminSession();
  // #1539 AC6 (symmetry with install): reject a missing/empty version before any
  // update request — it cannot succeed and must not surface as a "gone version".
  if (packageVersion == null || packageVersion.trim() === "") {
    const { category, reference } = rejectEmptyInstallVersion("update", packageName);
    return {
      success: false,
      error: "missing package version",
      failureCategory: category,
      reference,
    };
  }
  try {
    // #1039 Option B (update-time slice): on the dev/non-gatekept path route the
    // update THROUGH the dependency planner/batch (rootAction:'update') instead
    // of the bare `extensionRegistry.update` — so the new version's newly
    // required dependencies auto-install DEPENDENCIES-FIRST, dependent-break
    // checking becomes plan-aware, and a clean shared-dependency dedupe-upward
    // executes as a committed update. The root is realized as a COMMITTED
    // in-place update member (leave-at-NEW). The GATEKEPT path keeps the direct
    // in-place update: its host-computed-set dedupe + durable-restore is the
    // deferred slice (Option A, #1296), so update-through-batch there stays
    // fenced. Dynamic import: @/lib is the host (mirrors installExtensionPackage).
    const { isGatekeptInstallEnabled } = await import("@/lib/gatekept-install");
    if (isGatekeptInstallEnabled()) {
      const typeId = await resolveExtensionTypeId(packageName, packageVersion);
      await extensionRegistry.update(
        typeId,
        { registryUrl: "", packageName, version: packageVersion },
        actor,
      );
    } else {
      const { installExtensionWithDependencies } = await import(
        "@/lib/extension-install-batch"
      );
      await installExtensionWithDependencies({
        packageName,
        version: packageVersion,
        actor,
        rootAction: "update",
      });
    }
    return { success: true };
  } catch (err) {
    // Classify from the real error before stringification (cinatra#685); emit
    // the #1539 sanitized chokepoint diagnostics + correlating reference.
    const { category, reference } = classifyAndLogInstallFailure(
      "update",
      packageName,
      packageVersion,
      err,
    );
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      failureCategory: category,
      reference,
    };
  }
}

export async function uninstallExtensionPackage(
  packageName: string,
  packageVersion: string,
  actor: Actor,
): Promise<{ success: boolean; error?: string; failure?: RemovalActionResult }> {
  "use server";
  await requireAdminSession();
  try {
    // cinatra#1036: a system extension can be updated but never removed from the
    // live runtime. Refuse the intent up front — before any registry round-trip —
    // with the stable typed error (the dispatcher primitive is the backstop).
    assertCanRemoveExtension(packageName, "uninstall");
    const typeId = await resolveExtensionTypeId(packageName, packageVersion);
    await extensionRegistry.uninstall(
      typeId,
      { registryUrl: "", packageName, version: packageVersion },
      actor,
    );
    return { success: true };
  } catch (err) {
    // cinatra#1061: classify the caught error HERE (the real error object, with
    // its typed shape) so the form action can RETURN a structured refusal the
    // user sees in production instead of a Next.js-masked thrown message —
    // system-extension / active-dependents (named) / generic.
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      failure: classifyRemovalFailure(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Core dispatchers for archive/restore/reinstall/forceDelete.
// ---------------------------------------------------------------------------

export async function archiveExtensionPackage(
  packageName: string,
  packageVersion: string,
  actor: Actor,
): Promise<{ success: boolean; error?: string; failure?: RemovalActionResult }> {
  "use server";
  await requireAdminSession();
  try {
    // cinatra#1036: archive removes a package from the live runtime — refused for
    // a system extension (which is required-in-prod and must stay live).
    assertCanRemoveExtension(packageName, "archive");
    const typeId = await resolveExtensionTypeId(packageName, packageVersion);
    await extensionRegistry.archive(
      typeId,
      { registryUrl: "", packageName, version: packageVersion },
      actor,
    );
    return { success: true };
  } catch (err) {
    // cinatra#1061: classify so the archive form action returns a structured,
    // dependents-naming refusal instead of a prod-masked thrown error.
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      failure: classifyRemovalFailure(err),
    };
  }
}

export async function restoreExtensionPackage(
  packageName: string,
  actor: Actor,
): Promise<{ success: boolean; error?: string; failureCategory?: MarketplaceFailureCategory }> {
  "use server";
  await requireAdminSession();
  try {
    const typeId = await resolveExtensionTypeId(packageName);
    // Version is intentionally empty — the handler reads the archived row's version.
    await extensionRegistry.restore(
      typeId,
      { registryUrl: "", packageName, version: "" },
      actor,
    );
    return { success: true };
  } catch (err) {
    // Restore is DB-only (no marketplace round-trip) so this almost always
    // classifies as `unrecoverable`; route it through the same channel anyway so
    // the client form has one uniform failure path (cinatra#685).
    const failureCategory = classifyMarketplaceFailure(err);
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      failureCategory,
    };
  }
}

export async function reinstallLatestExtensionPackage(
  packageName: string,
  actor: Actor,
): Promise<{ success: boolean; error?: string }> {
  "use server";
  await requireAdminSession();
  try {
    // Resolve the latest version FIRST and bail out before any destructive
    // uninstall step if the registry is unreachable or returns a package
    // without a version. Otherwise this would archive
    // (or hard-delete) the existing extension and then attempt to install
    // with version: "", landing the user in a partial-state with nothing to
    // restore from.
    //
    // Kind-agnostic dispatch is required because getAgentPackage fails for
    // non-agent kinds; deriving the type ID from pkg.kind would silently
    // mis-route skills/connectors/artifacts.
    let resolution;
    try {
      resolution = await resolveExtensionPackageForLifecycle(packageName);
    } catch {
      return {
        success: false,
        error: `Could not resolve latest version for ${packageName}; reinstall not attempted (no destructive change made).`,
      };
    }
    if (!resolution.resolvedVersion) {
      return {
        success: false,
        error: `Could not resolve latest version for ${packageName}; reinstall not attempted (no destructive change made).`,
      };
    }
    const latestVersion = resolution.resolvedVersion;
    const typeId = resolution.typeId;
    // cinatra#1036: a system extension can be reinstalled/upgraded but must NEVER
    // leave the live runtime. Route its "reinstall" through an IN-PLACE update
    // (re-materialize → re-finalize → re-activate the latest digest) instead of
    // the uninstall-then-install path — so there is NO uninstall phase that could
    // strand it, and "reinstall" honors "update is permitted, deletion is not".
    if (isSystemExtension(packageName)) {
      await extensionRegistry.update(
        typeId,
        { registryUrl: "", packageName, version: latestVersion },
        actor,
      );
      return { success: true };
    }
    // Step 1: uninstall (archive or hard-delete per predicate)
    await extensionRegistry.uninstall(
      typeId,
      { registryUrl: "", packageName, version: latestVersion },
      actor,
    );
    // Step 2: install at the latest resolved version
    try {
      await extensionRegistry.install(
        typeId,
        { registryUrl: "", packageName, version: latestVersion },
        actor,
      );
    } catch (installErr) {
      // Surface the underlying install error so the user can act on it
      // (Verdaccio unreachable, manifest validation, skill registration crash,
      // etc.). A fixed string would also incorrectly assume the prior uninstall
      // took the archive path; uninstall is predicate-driven, so for unused
      // extensions it hard-deletes and there is nothing in the Archived tab to
      // recover from.
      const detail =
        installErr instanceof Error ? installErr.message : String(installErr);
      return {
        success: false,
        error: `Reinstall failed after uninstall step: ${detail}. Try reinstalling from the marketplace.`,
      };
    }
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function forceDeleteExtensionPackage(
  packageName: string,
  packageVersion: string,
  actor: Actor,
  reason?: string,
): Promise<{ success: boolean; error?: string; danglingReferences?: DanglingReferences }> {
  "use server";
  await requireAdminSession();
  try {
    // cinatra#1036: force-delete is the hardest removal — still refused for a
    // system extension (update is the only permitted destructive-looking op).
    assertCanRemoveExtension(packageName, "force_delete");
    const typeId = await resolveExtensionTypeId(packageName, packageVersion);
    const result = await extensionRegistry.forceDelete(
      typeId,
      { registryUrl: "", packageName, version: packageVersion },
      actor,
      reason,
    );
    return { success: true, danglingReferences: result.danglingReferences };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// UI form-action wrappers — derive actor from session internally so screens
// can use .bind(null, { packageName, packageVersion }) without needing to
// pass an actor object at bind time.
// ---------------------------------------------------------------------------

export async function installExtensionPackageFormAction(input: {
  packageName: string;
  packageVersion: string;
  /**
   * Pre-install access selection (cinatra#805) — the same org / team /
   * project target rows the agent InstallScopeDialog offers. OPTIONAL:
   * absent → exactly the legacy behavior (install with the implicit per-kind
   * default access, no policy write). Present → server-gated (fail-closed)
   * and persisted through setExtensionInstallAccess after a successful
   * install. Only the connector / artifact / workflow kinds accept it.
   */
  accessTarget?: { level: "organization" | "team" | "project"; id: string };
}): Promise<MarketplaceInstallActionResult | void> {
  "use server";
  const session = await requireAdminSession();
  const actor: Actor = {
    actorType: "human",
    userId: session.user.id,
    source: "ui",
    // Forward the active org so kind:"workflow" lifecycle (dashboard
    // materialization) has organization context from the UI server-action path.
    ...(session.session?.activeOrganizationId ? { orgId: session.session.activeOrganizationId } : {}),
  };

  // -------------------------------------------------------------------------
  // Pre-install access-target validation + authorization (cinatra#805).
  // Runs BEFORE any mutation so a denied/invalid target installs nothing.
  // The dialog's disabled rows are UX only — this gate is the security
  // boundary, shared verbatim with the agent at-scope install path
  // (@cinatra-ai/agents/install-target-authz).
  // -------------------------------------------------------------------------
  let accessTarget: InstallAccessTarget | undefined;
  const orgId = session.session?.activeOrganizationId ?? null;
  if (input.accessTarget) {
    try {
      accessTarget = InstallAccessTargetSchema.parse(input.accessTarget);
      if (!orgId) {
        throw new Error(
          "An install access target requires an active organization.",
        );
      }
      const { buildCanDoOptsFromSession } = await import("@/lib/auth-session");
      const {
        readActorRolesForInstall,
        assertTargetBelongsToActiveOrg,
        assertCanInstallAtTarget,
      } = await import("@cinatra-ai/agents/install-target-authz");
      const { orgRole } = await buildCanDoOptsFromSession(session);
      const roleBag = readActorRolesForInstall(session, orgId, orgRole);
      const tenantCheck = await assertTargetBelongsToActiveOrg(
        roleBag,
        accessTarget,
        orgId,
      );
      await assertCanInstallAtTarget(
        roleBag,
        accessTarget,
        tenantCheck.projectOwnership,
      );
      // NOTE — the KIND gate ("only connector/artifact/workflow accept an
      // access target") runs POST-install against the canonical row's kind,
      // NOT here. A pre-install packument probe (resolveExtensionTypeId) is
      // unreliable for this: when the connected registry cannot serve the
      // packument (or a legacy package omits `cinatra.kind`) it falls back to
      // "agent" and would wrongly refuse a legitimate connector install
      // (observed live). The canonical row's kind comes from the REAL
      // installed manifest — authoritative; a mismatch there compensates the
      // fresh install (fail-closed), see below.
    } catch (err) {
      // Fail closed, nothing installed. RETURN a classified category instead
      // of throwing (thrown messages are masked in production — cinatra#685);
      // the full technical error stays operator-side.
      logMarketplaceFailureForOperator(
        "install-access-gate",
        input.packageName,
        "unrecoverable",
        err,
      );
      return { ok: false, category: "unrecoverable" };
    }
  }

  if (accessTarget && orgId) {
    // -------------------------------------------------------------------------
    // Install + install-time access as ONE unit under the per-package install
    // lock — the SAME ALS re-entrant lock the dispatcher install and uninstall
    // paths hold (nested acquires run inline). Without it, the "did a live row
    // exist before?" snapshot could race a CONCURRENT install of the same
    // package, and the fail-closed compensation below could uninstall a row
    // the other request just installed.
    //
    // The selected access persists through the sanctioned contract
    // (setExtensionInstallAccess) — organization target applies the per-kind
    // default (workspace); team/project targets scope all visibility tiers to
    // the selection. FAIL-CLOSED: if the policy write fails (or the installed
    // kind turns out not to accept a target), the fresh install is rolled back
    // (uninstalled) rather than left at the BROADER default — unless a live
    // install already existed before this call, in which case we must not
    // destroy it and report the partial state instead.
    // -------------------------------------------------------------------------
    const target = accessTarget;
    const { withInstallLock } = await import("@cinatra-ai/agents");
    const outcome = await withInstallLock(
      input.packageName,
      async (): Promise<MarketplaceInstallActionResult | "installed"> => {
        const { readInstalledExtensionByIdentity } = await import(
          "./canonical-store"
        );
        const identity = {
          organizationId: orgId,
          ownerLevel: "organization" as const,
          ownerId: orgId,
          packageName: input.packageName,
        };
        // Snapshot BEFORE the install (under the lock): an install of an
        // already-installed package is a registry no-op that still reports
        // success — the compensation must never uninstall that row.
        const preRow = await readInstalledExtensionByIdentity(identity);
        const hadLiveRowBefore =
          preRow != null &&
          (preRow.status === "active" || preRow.status === "locked");

        const result = await installExtensionPackage(
          input.packageName,
          input.packageVersion,
          actor,
        );
        if (!result.success) {
          // cinatra#685: RETURN the classified category (see legacy path note).
          const category = result.failureCategory ?? "unrecoverable";
          logMarketplaceFailureForOperator(
            "install",
            input.packageName,
            category,
            result.error,
          );
          // #1539: carry the chokepoint diagnostic reference to the client toast.
          return { ok: false, category, reference: result.reference };
        }

        try {
          const row = await readInstalledExtensionByIdentity(identity);
          if (!row) {
            throw new Error(
              "canonical install row not found after a successful install",
            );
          }
          if (!isInstallAccessTargetKind(row.kind)) {
            throw new Error(
              `installed kind "${row.kind}" does not accept an install access target`,
            );
          }
          const policy = accessTargetToInstallPolicy(target);
          const { setExtensionInstallAccess } = await import(
            "./install-access-contract"
          );
          await setExtensionInstallAccess({
            kind: row.kind,
            resourceId: row.id,
            ...(policy ? { policy } : {}),
            installedByUserId: session.user.id,
          });
          return "installed";
        } catch (accessErr) {
          logMarketplaceFailureForOperator(
            "install-access",
            input.packageName,
            "unrecoverable",
            accessErr,
          );
          if (hadLiveRowBefore) {
            // Pre-existing install — never uninstall it; its previous access
            // stands. Surface the partial state honestly.
            return {
              ok: false,
              category: "unrecoverable",
              stage: "access-partial",
            };
          }
          // Compensate: roll the fresh install back so a narrower-than-default
          // selection can never silently fail open to workspace access. (Root
          // package only — auto-installed dependencies are shared and stay.)
          const rollback = await uninstallExtensionPackage(
            input.packageName,
            input.packageVersion,
            actor,
          );
          if (!rollback.success) {
            logMarketplaceFailureForOperator(
              "install-access-rollback",
              input.packageName,
              "unrecoverable",
              rollback.error,
            );
            return {
              ok: false,
              category: "unrecoverable",
              stage: "access-partial",
            };
          }
          return { ok: false, category: "unrecoverable", stage: "access" };
        }
      },
    );
    if (outcome !== "installed") {
      return outcome;
    }
  } else {
    // Legacy path (no access target) — behavior unchanged.
    const result = await installExtensionPackage(input.packageName, input.packageVersion, actor);
    if (!result.success) {
      // cinatra#685: RETURN the classified category instead of throwing. A thrown
      // server-action message is masked in production (digest only) so it cannot
      // carry the cause to the client; a returned value is delivered intact. The
      // raw technical error stays operator-side (logs), never in the user toast.
      const category = result.failureCategory ?? "unrecoverable";
      logMarketplaceFailureForOperator("install", input.packageName, category, result.error);
      // #1539: carry the chokepoint diagnostic reference to the client toast.
      return { ok: false, category, reference: result.reference };
    }
  }

  redirect("/configuration/extensions");
}

export async function updateExtensionPackageFormAction(input: {
  packageName: string;
  packageVersion: string;
}): Promise<MarketplaceInstallActionResult | void> {
  "use server";
  const session = await requireAdminSession();
  const actor: Actor = {
    actorType: "human",
    userId: session.user.id,
    source: "ui",
    // Forward the active org so kind:"workflow" lifecycle (dashboard
    // materialization) has organization context from the UI server-action path.
    ...(session.session?.activeOrganizationId ? { orgId: session.session.activeOrganizationId } : {}),
  };
  const result = await updateExtensionPackage(input.packageName, input.packageVersion, actor);
  if (!result.success) {
    // cinatra#685: return the classified category (see install action note).
    const category = result.failureCategory ?? "unrecoverable";
    logMarketplaceFailureForOperator("update", input.packageName, category, result.error);
    // #1539: carry the chokepoint diagnostic reference to the client toast.
    return { ok: false, category, reference: result.reference };
  }
  redirect("/configuration/extensions");
}

export async function uninstallExtensionPackageFormAction(input: {
  packageName: string;
  packageVersion: string;
}): Promise<RemovalActionResult | void> {
  "use server";
  const session = await requireAdminSession();
  const actor: Actor = {
    actorType: "human",
    userId: session.user.id,
    source: "ui",
    // Forward the active org so kind:"workflow" lifecycle (dashboard
    // materialization) has organization context from the UI server-action path.
    ...(session.session?.activeOrganizationId ? { orgId: session.session.activeOrganizationId } : {}),
  };
  const result = await uninstallExtensionPackage(input.packageName, input.packageVersion, actor);
  if (!result.success) {
    // cinatra#1061: RETURN the classified refusal instead of throwing. A thrown
    // server-action error is masked by Next.js in production (digest only) so
    // the dependents/system message never reaches the user; a returned value is
    // delivered intact and the client renders the reason-mapped copy. Raw detail
    // stays operator-side (logs).
    const failure = result.failure ?? { ok: false as const, reason: "error" as const };
    logRemovalFailureForOperator("uninstall", input.packageName, failure, result.error);
    return failure;
  }
  redirect("/configuration/extensions");
}

// ---------------------------------------------------------------------------
// Form-action wrappers for archive/restore/reinstall/forceDelete.
// ---------------------------------------------------------------------------

export async function archiveExtensionPackageFormAction(input: {
  packageName: string;
  // Required. The MCP schema at mcp/schemas.ts requires
  // packageVersion: z.string().min(1); the form-action contract mirrors that
  // so callers can't silently pass "" and have downstream code misbehave on
  // ref.version reads.
  packageVersion: string;
}): Promise<RemovalActionResult | void> {
  "use server";
  if (!input.packageVersion) {
    throw new Error("archiveExtensionPackageFormAction requires a non-empty packageVersion");
  }
  const session = await requireAdminSession();
  const actor: Actor = {
    actorType: "human",
    userId: session.user.id,
    source: "ui",
    // Forward the active org so kind:"workflow" lifecycle (dashboard
    // materialization) has organization context from the UI server-action path.
    ...(session.session?.activeOrganizationId ? { orgId: session.session.activeOrganizationId } : {}),
  };
  const result = await archiveExtensionPackage(
    input.packageName,
    input.packageVersion,
    actor,
  );
  if (!result.success) {
    // cinatra#1061: RETURN the classified refusal (see uninstall action note) so
    // the archive dependents/system message survives to the production client.
    const failure = result.failure ?? { ok: false as const, reason: "error" as const };
    logRemovalFailureForOperator("archive", input.packageName, failure, result.error);
    return failure;
  }
  // revalidatePath is unnecessary because redirect re-renders the destination.
  redirect("/configuration/extensions");
}

export async function restoreExtensionPackageFormAction(input: {
  packageName: string;
}): Promise<MarketplaceInstallActionResult | void> {
  "use server";
  const session = await requireAdminSession();
  const actor: Actor = {
    actorType: "human",
    userId: session.user.id,
    source: "ui",
    // Forward the active org so kind:"workflow" lifecycle (dashboard
    // materialization) has organization context from the UI server-action path.
    ...(session.session?.activeOrganizationId ? { orgId: session.session.activeOrganizationId } : {}),
  };
  const result = await restoreExtensionPackage(input.packageName, actor);
  if (!result.success) {
    // cinatra#685: return the classified category (see install action note).
    const category = result.failureCategory ?? "unrecoverable";
    logMarketplaceFailureForOperator("restore", input.packageName, category, result.error);
    return { ok: false, category };
  }
  // revalidatePath is unnecessary because redirect re-renders the destination.
  redirect("/configuration/extensions");
}

export async function reinstallLatestFormAction(input: {
  packageName: string;
}): Promise<void> {
  "use server";
  const session = await requireAdminSession();
  const actor: Actor = {
    actorType: "human",
    userId: session.user.id,
    source: "ui",
    // Forward the active org so kind:"workflow" lifecycle (dashboard
    // materialization) has organization context from the UI server-action path.
    ...(session.session?.activeOrganizationId ? { orgId: session.session.activeOrganizationId } : {}),
  };
  const result = await reinstallLatestExtensionPackage(input.packageName, actor);
  if (!result.success) {
    throw new Error(result.error ?? "Reinstall failed");
  }
  // revalidatePath is unnecessary because redirect re-renders the destination.
  redirect("/configuration/extensions");
}

export async function forceDeleteExtensionPackageFormAction(input: {
  packageName: string;
  // Tighten the contract to mirror the MCP schema (mcp/schemas.ts requires
  // packageVersion.min(1), reason, and confirmDestructive: literal(true)).
  // Today no UI surface invokes this action; a lax form-action contract would
  // let a future caller land a button without thinking through the
  // destructive-acknowledgment guard. Make the safety guard mandatory at the
  // form-action boundary too.
  packageVersion: string;
  reason: string;
  confirmDestructive: true;
}): Promise<void> {
  "use server";
  if (input.confirmDestructive !== true) {
    throw new Error(
      "Force-delete requires explicit confirmDestructive: true",
    );
  }
  if (!input.packageVersion) {
    throw new Error(
      "forceDeleteExtensionPackageFormAction requires a non-empty packageVersion",
    );
  }
  if (!input.reason || input.reason.trim().length === 0) {
    throw new Error(
      "forceDeleteExtensionPackageFormAction requires a non-empty reason",
    );
  }
  const session = await requireAdminSession();
  const actor: Actor = {
    actorType: "human",
    userId: session.user.id,
    source: "ui",
    // Forward the active org so kind:"workflow" lifecycle (dashboard
    // materialization) has organization context from the UI server-action path.
    ...(session.session?.activeOrganizationId ? { orgId: session.session.activeOrganizationId } : {}),
  };
  const result = await forceDeleteExtensionPackage(
    input.packageName,
    input.packageVersion,
    actor,
    input.reason,
  );
  if (!result.success) {
    throw new Error(result.error ?? "Force-delete failed");
  }
  // revalidatePath is unnecessary because redirect re-renders the destination.
  redirect("/configuration/extensions?tab=archived");
}

// ---------------------------------------------------------------------------
// Promotion path: private → public only.
// ---------------------------------------------------------------------------

// ExtensionAlreadyPublicError moved to promotion-errors.ts because Next.js
// "use server" files may only export async functions.
import { ExtensionAlreadyPublicError } from "./promotion-errors";

type PromoteExtensionInput = {
  packageName: string;
  packageVersion: string;
};

/**
 * Promotes a private extension to the public registry.
 *
 * Only the private → public path is supported. Public → private is blocked;
 * the UI renders a visible-but-disabled "Demote to private" menu item with
 * the locked tooltip.
 *
 * Side effects (in order):
 *   1. Auth-gate via requireAdminSession
 *   2. Read existing origin row — throw if missing or already public
 *   3. Resolve public destination via resolvePublishDestination('public')
 *   4. Rebuild + republish the package to the public registry via publishAgentPackage
 *      (fetches the stored template record + latest version snapshot from DB)
 *   5. Update origin.visibility='public', clear destinationId, set registryUrl
 *   6. Fire-and-forget audit log entry; log failure does NOT roll back the
 *      promotion
 *
 * resolvePublishDestination("public") calls deployConfig.publicPublishToken;
 * this is null in the baseline fixture, so promotion throws
 * PublishDestinationNotConfiguredError in any fixture-backed environment.
 *
 * TODO: wire the live deployment-registry resolver before exercising promotion
 * in long-lived deployments. See deployment-registry-config.ts.
 */
export async function promoteExtensionToPublicAction(
  input: PromoteExtensionInput,
): Promise<void> {
  "use server";
  const session = await requireAdminSession();

  const {
    readAgentTemplateOrigin,
    readAgentTemplateByPackageName,
    readAgentVersionsByTemplate,
    updateAgentTemplateVisibility,
  } = await import("@cinatra-ai/agents/store");
  const { resolvePublishDestination } = await import("@cinatra-ai/extensions/destination-resolver");
  const { publishAgentPackage } = await import("@cinatra-ai/agents/verdaccio/client");
  const { logAuditEvent, POLICY_VERSION } = await import("@/lib/authz");
  const { derivePublishMetadataFromSnapshot } = await import("@cinatra-ai/agents/verdaccio/publish-metadata");

  const existingOrigin = await readAgentTemplateOrigin(input.packageName);
  if (!existingOrigin) {
    throw new Error(`No origin row found for package ${input.packageName}`);
  }
  if (existingOrigin.visibility === "public") {
    throw new ExtensionAlreadyPublicError(input.packageName);
  }

  const template = await readAgentTemplateByPackageName(input.packageName);
  if (!template) {
    throw new Error(`Agent template not found for package ${input.packageName}`);
  }

  const versions = await readAgentVersionsByTemplate(template.id);
  if (!versions.length) {
    throw new Error(
      `No version snapshot found for package ${input.packageName} — cannot promote without a saved version`,
    );
  }

  const version = versions[0]; // latest version (ordered by createdAt DESC)
  const publishMetadata = derivePublishMetadataFromSnapshot(version.snapshot);

  // Use the DB-stored version as the semver source of truth rather than
  // input.packageVersion. The caller (UI form) could supply any semver string
  // (e.g. "99.0.0"), which would re-publish under a fabricated version.
  // template.packageVersion mirrors the stored snapshot version.
  const semverToPublish = template.packageVersion ?? input.packageVersion;
  if (!semverToPublish) {
    throw new Error(`Cannot promote ${input.packageName} — no package version available`);
  }

  const publicConfig = await resolvePublishDestination("public");

  // Re-publish the package to the public registry by rebuilding from the stored
  // template + version snapshot. publishAgentPackage is idempotent: if this
  // version already exists in the public registry, it returns { alreadyPublished: true }.
  await publishAgentPackage(
    {
      template,
      version,
      semver: semverToPublish,
      // Pin the package name to its already-published private value. Without
      // this, publishAgentPackage rebuilds the name from `config.packageScope +
      // slug`, which would silently rescope a delegated private extension
      // (e.g. @acme-test/foo) under the instance namespace on promotion to
      // public. Stability across promotion is the right semantic here: a
      // package's name should not change when its visibility does.
      packageName: input.packageName,
      title: template.name ?? input.packageName,
      description: template.description ?? undefined,
      changelog: undefined,
      riskLevel: publishMetadata.riskLevel,
      toolAccess: publishMetadata.toolAccess,
      hasApprovalGates: publishMetadata.hasApprovalGates,
    },
    publicConfig,
  );

  // Persist the new visibility coordinates.
  await updateAgentTemplateVisibility(
    input.packageName,
    "public",
    publicConfig.registryUrl,
  );

  // Fire-and-forget audit log.
  // A failure to write the audit row MUST NOT roll back the promotion.
  // Wrapped in try/catch to swallow both sync throws and async rejections:
  // the handler.ts precedent uses `void fn()` which silently drops Promise
  // rejections, but to guard against synchronous throws from mocked/broken
  // logAuditEvent implementations, we use a try/catch wrapper instead.
  try {
    void Promise.resolve(
      logAuditEvent({
        actorPrincipalId: session.user.id,
        actorPrincipalType: "human",
        authSource: "ui",
        resourceType: "extension_registry",
        resourceId: input.packageName,
        operation: "promote",
        decision: "allowed",
        policyVersion: POLICY_VERSION,
        metadata: {
          from_visibility: "private",
          to_visibility: "public",
          package_name: input.packageName,
          package_version: input.packageVersion,
        },
      }),
    ).catch(() => {});
  } catch {
    // Audit write failure MUST NOT propagate — promotion is already persisted.
  }
}
