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
// cinatra#2416: THE shared session-derived actor builders. The settings page
// imports the SAME `buildLifecycleActorFromSession` to evaluate its
// per-affordance capability, so the rendered enabled state and the enforced
// refusal are computed from one actor built by one function.
import {
  buildActorEnvelope,
  buildLifecycleActorFromSession,
  type LifecycleActorSession,
} from "./lifecycle-actor";
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
  isInstallAccessTargetKind,
  resolveInstallAccessTargetContract,
  type InstallAccessTarget,
  type InstallRowOwnership,
} from "./install-access-target";
// cinatra#2696: the dispatcher-side half of the contract — the anchor an
// install actually writes at, and the org-NULL workspace discriminator the
// rollback needs (a workspace-anchored row cannot be addressed by the org-pinned
// lifecycle resolver; that is S4 #2698).
import { isWorkspaceRowAnchor } from "./install-row-anchor";

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
// Session-derived actor construction (cinatra#2400) now lives in the shared
// `./lifecycle-actor` module (cinatra#2416): the settings page that RENDERS
// these affordances must build the caller's actor with the SAME code that the
// submission is later enforced against, and a `"use server"` module cannot
// export a builder (every export here becomes a callable Server Function). No
// wrapper hand-rolls an Actor literal.
// ---------------------------------------------------------------------------

type FormActionSession = LifecycleActorSession;

/**
 * Build the actor for a COMPENSATING uninstall (an install-rollback), with the
 * membership standing the rollback actually needs.
 *
 * The install actor is the standing-free envelope (`buildActorEnvelope`, in
 * ./lifecycle-actor), but the P5
 * row-scoped lifecycle standing gate (resolveLifecycleTargetRow →
 * assertActorWriteStandingOverRow) requires the actor to hold destructive-write
 * standing over the org-anchored row before it will remove it. So a role-less
 * actor's rollback is deterministically REFUSED, which — for a fail-closed
 * install-rollback — would leave the fresh install at the broader default. We
 * therefore attach the caller's REAL org role (resolved from the trusted
 * session, never client input) so the compensating uninstall takes the
 * ORG-SCOPED soft/archive path over THIS org's own row.
 *
 * We deliberately do NOT attach platformRole: platform standing routes uninstall
 * to the PACKAGE-GLOBAL hard-delete branch, which tears down EVERY org's row for
 * the package — a cross-org over-reach for what must be a single-org rollback. A
 * caller without org-owner/org-admin standing cannot compensate; the rollback
 * then honestly reports the partial state rather than over-reaching.
 */
async function buildInstallRollbackActor(
  session: FormActionSession,
  baseActor: Actor,
  packageName: string,
): Promise<Actor> {
  // TOTAL by contract — must NEVER throw. Both rollback sites call this OUTSIDE
  // their error handling, so a thrown membership-lookup error would escape the
  // compensation and leave the fresh install at the broader default with a
  // masked server-action error. On any resolution failure, fall back to the base
  // actor: the rollback then proceeds on whatever standing it already carries, or
  // is refused and honestly reported as access-partial — never an unhandled throw.
  try {
    const { buildCanDoOptsFromSession } = await import("@/lib/auth-session");
    const { orgRole } = await buildCanDoOptsFromSession(session);
    return orgRole ? { ...baseActor, orgRole } : baseActor;
  } catch (roleErr) {
    logMarketplaceFailureForOperator(
      "install-rollback-actor",
      packageName,
      "unrecoverable",
      roleErr,
    );
    return baseActor;
  }
}

/**
 * ROLL BACK a fresh install that was written at the WORKSPACE ANCHOR
 * (cinatra#2696).
 *
 * The org-anchored rollback routes through `uninstallExtensionPackage` →
 * `extensionRegistry.uninstall`, whose lifecycle target resolution selects rows
 * BY THE ACTOR'S ORGANIZATION — so it can address neither an `organization_id
 * NULL` row (no org to match) nor the platform-admin standing that would be
 * needed to, without taking the package-GLOBAL hard-delete branch that tears
 * down every other org's row. Teaching the lifecycle ops to target the full row
 * identity is S4 (#2698) and is deliberately NOT anticipated here.
 *
 * So this rollback takes the SAME inverse the install batch's compensation
 * already uses for exactly this reason (cinatra#2415): a ROW-SCOPED delete of
 * the single row identified by the install's own anchor identity. It can never
 * fan out — one row, by id — and it is only ever called when the pre-install
 * snapshot proved NO live row existed at that identity, so the row it deletes is
 * provably the one this call created. A pre-existing live row is never reached:
 * the caller returns `access-partial` before getting here.
 *
 * The two refusals the package-scoped uninstall would have applied are applied
 * FIRST, so this path is not a way around them: a SYSTEM extension
 * (`assertCanRemoveExtension`) and a package whose own declaration marks it
 * PROTECTED (`resolveDeclaredProtection`, fail-closed on an unreadable
 * declaration) are refused, and the caller reports the partial state honestly.
 *
 * TOTAL by contract — never throws; a failure is returned in the same shape
 * `uninstallExtensionPackage` returns so both rollback paths read identically.
 */
async function rollbackFreshInstallAtWorkspaceAnchor(
  identity: {
    organizationId: string | null;
    ownerLevel: "user" | "team" | "organization" | "workspace" | "platform";
    ownerId: string | null;
    packageName: string;
  },
): Promise<{ success: boolean; error?: string }> {
  try {
    assertCanRemoveExtension(identity.packageName, "uninstall");
    const { resolveDeclaredProtection } = await import("./protected-extension");
    let protectedPackage: boolean;
    try {
      protectedPackage = await resolveDeclaredProtection(identity.packageName);
    } catch {
      protectedPackage = true; // unreadable declaration ⇒ never torn down
    }
    if (protectedPackage) {
      return {
        success: false,
        error:
          `${identity.packageName} declares itself protected — the rollback of the ` +
          `workspace-anchored install is refused (the extension stays installed).`,
      };
    }
    const { readInstalledExtensionByIdentity } = await import("./canonical-store");
    const row = await readInstalledExtensionByIdentity(identity);
    // No row at the anchor — nothing was created (or it is already gone).
    if (!row) return { success: true };
    const { deleteScopedCanonicalRow } = await import("./lifecycle-primitive");
    await deleteScopedCanonicalRow(row.id);
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
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

// The THIRD install outcome's operator line (cinatra#2761). Deliberately NOT a
// `classify-failed` line and deliberately WITHOUT a diagnostic reference: the
// install COMMITTED, so it is not a failure and there is no support case to
// correlate. It is logged at info level so an operator can still see that the
// process is serving a package it has not loaded yet. Same CWE-117/CWE-134
// discipline as the chokepoint above: constant format string, sanitized args.
function logInstallActivationDeferredForOperator(
  operation: string,
  packageName: string,
  packageVersion: string,
): void {
  console.info(
    "[marketplace-install] %s committed pkg=%s version=%s activation=deferred-to-next-restart",
    operation,
    sanitizeForLog(packageName),
    packageVersion ? sanitizeForLog(packageVersion) : "(none)",
  );
}

/**
 * Whether a thrown install carries the STABLE activation-deferred code
 * (cinatra#2761). The install COMMITTED (the real-integrity pipeline finalized,
 * so the canonical row is real and anchorable) and only its in-process
 * hot-activation was refused this call.
 *
 * DUCK-TYPED over the `cause` chain rather than `instanceof`: the error crosses
 * dynamic-import boundaries and may be wrapped, so identity is unreliable here
 * (cinatra#2416 established this rule for the lifecycle codes above). Bounded
 * depth so a cyclic cause chain can never loop forever.
 */
function isActivationDeferredError(err: unknown, depth = 0): boolean {
  if (depth > 6 || err == null || typeof err !== "object") return false;
  const obj = err as { code?: unknown; cause?: unknown };
  if (obj.code === "INSTALL_ACTIVATION_DEFERRED") return true;
  return "cause" in obj ? isActivationDeferredError(obj.cause, depth + 1) : false;
}

// Whether the dependency batch reported THIS package as committed-but-not-
// activated. Tolerates a result without the field (the batch is reached through
// a dynamic import). An absent list means "nothing deferred", the pre-#2761
// meaning, so the surface degrades to plain success rather than throwing.
function batchDeferredCarries(batch: unknown, packageName: string): boolean {
  const list = (batch as { activationDeferred?: unknown } | null)?.activationDeferred;
  if (!Array.isArray(list)) return false;
  return list.some(
    (m) => (m as { packageName?: unknown } | null)?.packageName === packageName,
  );
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
/** The STABLE, duck-typed refusal code a thrown lifecycle error carries
 *  (NO_ADDRESSABLE_ROW / AMBIGUOUS_LIFECYCLE_TARGET / NO_LIFECYCLE_WRITE_STANDING
 *  / PLATFORM_ADMIN_REQUIRED, plus the removal guards' own codes), or undefined.
 *  Duck-typed rather than `instanceof` — these errors cross a dynamic-import
 *  boundary (cinatra#2416). */
function stableErrorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

function logRemovalFailureForOperator(
  operation: string,
  packageName: string,
  failure: RemovalActionResult,
  err: unknown,
  errorCode?: string,
): void {
  // cinatra#2416: record the refusal's STABLE code alongside the coarse reason.
  // The returned user-facing contract stays generic by design — this is the
  // operator-side discriminant that makes an addressability refusal greppable,
  // and the observable "expected error code" for a crafted direct submission
  // that the UI now renders as unavailable.
  console.error(
    "[extension-removal] %s refused/failed for %s (reason=%s code=%s):",
    operation,
    packageName,
    failure.reason,
    errorCode ?? "none",
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
  /**
   * cinatra#2696 — the PLANNED canonical row anchor. The install-access target
   * resolved it (S1's `accessTargetToRowOwnership`); it is threaded into the
   * dependency batch, which plans, installs, ledgers and compensates every
   * member at that anchor. ABSENT (every caller without an access target) → the
   * actor-derived default, unchanged.
   */
  rowOwnership?: InstallRowOwnership,
): Promise<{
  success: boolean;
  error?: string;
  failureCategory?: MarketplaceFailureCategory;
  reference?: string;
  /**
   * The THIRD install outcome (cinatra#2761). `success` is true AND this is
   * true when the real-integrity pipeline COMMITTED the install. The canonical
   * row is real, finalized and anchorable, but in-process hot-activation was
   * refused this call, so the package activates on the next restart.
   *
   * It is deliberately a flag ON a success, not a fourth failure category: the
   * install landed, so the operator must not be told it failed, and no support
   * reference is minted for it. The caller renders the caveat and the next step
   * ("installed; activates on the next restart") instead of the generic error.
   */
  activationDeferred?: boolean;
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
    const batch = await installExtensionWithDependencies({
      packageName,
      version: packageVersion,
      actor,
      // cinatra#2696: pass the threaded anchor through. Omitted when absent so
      // the batch derives its established default (byte-identical plan).
      ...(rowOwnership ? { rowOwnership } : {}),
    });
    // #2761: the batch kept a member that COMMITTED but did not hot-activate.
    // Report the caveat on the success, never a failure. Read defensively: the
    // batch crosses a dynamic-import boundary, so an older/partial result shape
    // must degrade to "fully activated", never throw over a missing field.
    if (batchDeferredCarries(batch, packageName)) {
      logInstallActivationDeferredForOperator("install", packageName, packageVersion);
      return { success: true, activationDeferred: true };
    }
    return { success: true };
  } catch (err) {
    // #2761: a COMMITTED install whose hot-activation was refused reaches here
    // only on a path that bypasses the batch's own handling. It is still not a
    // failure, because the row is finalized and anchorable, so it never reaches the
    // failure classifier and never mints a support reference.
    if (isActivationDeferredError(err)) {
      logInstallActivationDeferredForOperator("install", packageName, packageVersion);
      return { success: true, activationDeferred: true };
    }
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
  /** See `installExtensionPackage`. The same third outcome, for an update. */
  activationDeferred?: boolean;
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
      const batch = await installExtensionWithDependencies({
        packageName,
        version: packageVersion,
        actor,
        rootAction: "update",
      });
      // #2761: same third outcome on the update path.
      if (batchDeferredCarries(batch, packageName)) {
        logInstallActivationDeferredForOperator("update", packageName, packageVersion);
        return { success: true, activationDeferred: true };
      }
    }
    return { success: true };
  } catch (err) {
    // #2761: the GATEKEPT update path calls the registry directly, so a
    // committed-but-not-activated update surfaces as the typed throw here.
    if (isActivationDeferredError(err)) {
      logInstallActivationDeferredForOperator("update", packageName, packageVersion);
      return { success: true, activationDeferred: true };
    }
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
): Promise<{
  success: boolean;
  error?: string;
  /** cinatra#2416: the refusal's STABLE code, captured HERE — the only place
   *  that still holds the thrown error OBJECT (the caller receives `error` as a
   *  flattened string). Operator-side only; the user-facing `failure` contract
   *  stays deliberately generic. */
  errorCode?: string;
  failure?: RemovalActionResult;
}> {
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
      errorCode: stableErrorCode(err),
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
): Promise<{
  success: boolean;
  error?: string;
  /** cinatra#2416: the refusal's STABLE code, captured HERE — the only place
   *  that still holds the thrown error OBJECT (the caller receives `error` as a
   *  flattened string). Operator-side only; the user-facing `failure` contract
   *  stays deliberately generic. */
  errorCode?: string;
  failure?: RemovalActionResult;
}> {
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
      errorCode: stableErrorCode(err),
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
    // A restore is a MULTI-STAGE re-activation, not a DB-only write: the
    // `resolveExtensionTypeId` call above consults the gatekept authorize
    // response or reads a packument, and a hot-loadable kind's activate hook
    // installs from the registry — so this CAN carry a marketplace contract code
    // and is not always the fail-safe `unrecoverable` (cinatra#2333 corrected the
    // earlier "DB-only, no round-trip" claim). Route it through the same channel
    // either way so the client form has one uniform failure path (cinatra#685);
    // the copy still collapses the marketplace-shaped categories because the
    // category cannot be attributed to a stage.
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
   * Pre-install access selection (cinatra#805) — the org / team / project
   * target rows plus the always-offered workspace scopes (cinatra#1527:
   * "workspace" / "admin", platform-admin-only). Present → server-gated
   * (fail-closed) and persisted through setExtensionInstallAccess after a
   * successful install.
   *
   * OPTIONAL, but MANDATORY for an install-access-target kind (connector /
   * artifact / workflow — isInstallAccessTargetKind): when absent for such a
   * kind the action REFUSES the install (cinatra#1602, fail-closed) rather than
   * defaulting to the broadest per-kind grant (WORKSPACE_DEFAULT) — the kind is
   * resolved from the installed canonical row and the install is rolled back.
   * Absent for a NON-access kind → the unchanged legacy direct install (no
   * policy write). See the install-access-target contract note.
   */
  accessTarget?: {
    level: "organization" | "team" | "project" | "workspace" | "admin";
    id: string;
  };
}): Promise<MarketplaceInstallActionResult | void> {
  "use server";
  const session = await requireAdminSession();
  // Standing-free envelope by design — this actor is threaded into the
  // dependency batch, whose abort path compensates member installs with it.
  const actor = buildActorEnvelope(session);

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
      // cinatra#1527 / issue AC3: the workspace/admin audience is the
      // authenticated tenant itself. Re-derive its id from the session's active
      // org and DISCARD any client-supplied id — a client-supplied workspace is
      // a cross-tenant risk. (accessTargetToInstallPolicy ignores the id for
      // these levels anyway; this closes the loop so nothing downstream can read
      // a forged value.)
      if (accessTarget.level === "workspace" || accessTarget.level === "admin") {
        accessTarget = { level: accessTarget.level, id: orgId };
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
    // cinatra#2696 — THE CHOSEN ANCHOR, resolved once from S1's contract. It
    // decides three things at once: the identity the pre-install snapshot and
    // the post-install access write key on, the tuple the install writes the
    // canonical row at (threaded through the dependency batch), and which
    // rollback the fail-closed compensation may use.
    const { rowOwnership, policy } = resolveInstallAccessTargetContract(target, orgId);
    const workspaceAnchored = isWorkspaceRowAnchor(rowOwnership);
    const { withInstallLock } = await import("@cinatra-ai/agents");
    const outcome = await withInstallLock(
      input.packageName,
      async (): Promise<
        MarketplaceInstallActionResult | "installed" | "installed-activation-deferred"
      > => {
        const { readInstalledExtensionByIdentity } = await import(
          "./canonical-store"
        );
        // cinatra#2696: the identity FOLLOWS THE CHOSEN ANCHOR. It was hard-
        // coded to the org anchor, which S1 superseded for the two workspace
        // targets: a "Workspace: All" install writes `owner_level='workspace'`
        // with `organization_id NULL` and the `__platform__` owner sentinel, so
        // an org-keyed read would miss BOTH the pre-install snapshot (the
        // rollback protection) and the post-install row the access policy is
        // written against. Every other target keeps the org identity verbatim.
        const identity = {
          organizationId: rowOwnership.organizationId,
          ownerLevel: rowOwnership.ownerLevel,
          ownerId: rowOwnership.ownerId,
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
          // cinatra#2696: the write path installs AT the chosen anchor.
          rowOwnership,
        );
        // #2761: the install COMMITTED but did not hot-activate this call. It is
        // a success with a caveat, so it flows to the SAME "installed" outcome
        // and only changes which copy the client renders.
        const activationDeferred = result.activationDeferred === true;
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
          // The audience half of the SAME contract call above (S1) — identical
          // to the previous `accessTargetToInstallPolicy(target)` value:
          // `["workspace"]` / `["admin"]` for the workspace targets, undefined
          // for the organization target (defer to the kind's install default).
          const { setExtensionInstallAccess } = await import(
            "./install-access-contract"
          );
          await setExtensionInstallAccess({
            kind: row.kind,
            resourceId: row.id,
            ...(policy ? { policy } : {}),
            installedByUserId: session.user.id,
          });
          return activationDeferred ? "installed-activation-deferred" : "installed";
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
          //
          // cinatra#2696: the rollback FOLLOWS THE ANCHOR. An org-anchored
          // install keeps the established package-scoped uninstall, whose
          // rollback actor carries org-scoped standing so the P5 lifecycle gate
          // permits removing the org's own row (a role-less actor is refused)
          // and never platform standing (which would go package-global). A
          // WORKSPACE-anchored install has an org-NULL row that the org-pinned
          // lifecycle resolver cannot address, so it takes the row-scoped
          // inverse — deleting exactly the row this call created.
          const rollback = workspaceAnchored
            ? await rollbackFreshInstallAtWorkspaceAnchor(identity)
            : await uninstallExtensionPackage(
                input.packageName,
                input.packageVersion,
                await buildInstallRollbackActor(session, actor, input.packageName),
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
    if (outcome === "installed-activation-deferred") {
      // A committed install that activates on the next restart. Returned (not
      // redirected) so the client can render the caveat; a plain success still
      // redirects below.
      return { ok: true, activation: "deferred" };
    }
    if (outcome !== "installed") {
      return outcome;
    }
  } else {
    // -------------------------------------------------------------------------
    // No access target supplied.
    //
    // FAIL-CLOSED (issue #1602 — defense-in-depth follow-up of #1541): an
    // install-access-target kind (connector / artifact / workflow via
    // isInstallAccessTargetKind) installed WITHOUT a target would fall through to
    // the implicit per-kind default, which for these kinds is the BROADEST grant
    // (WORKSPACE_DEFAULT) — a silent workspace-wide grant. #1541 closed the two
    // UI call sites (card, modal), but the invariant "every caller remembers to
    // pass the target" already broke once. The server action is the ENFORCED
    // boundary for the picker contract: a non-UI / future caller (batch
    // installer, MCP tool, admin script, a new surface) that omits the target is
    // REFUSED here, never silently defaulted.
    //
    // The kind is only reliably known POST-install: a pre-install packument probe
    // falls back to "agent" for a registry that cannot serve the packument (or a
    // legacy package without `cinatra.kind`) — see the note in the access branch
    // above — so it cannot gate this pre-install. We therefore install under the
    // per-package lock (the SAME re-entrant lock the access branch, dispatcher
    // install, and uninstall hold — nested acquires run inline), then resolve the
    // AUTHORITATIVE kind from the installed canonical row(s); if it is an
    // access-target kind, REJECT and compensate — roll the fresh install back so
    // nothing is left at the broader default, unless a live row already existed
    // (never destroy it).
    //
    // Kind resolution is ORG-AGNOSTIC (readInstalledExtensionsByPackageName) —
    // kind is a package-level manifest property, uniform across every install of
    // the package — so the refusal holds even with no active org (a fail-open gap
    // an org-anchored-only lookup would leave). The pre-install snapshot that
    // protects a pre-existing install from rollback IS org-anchored (only that
    // org's row must be spared), skipped when there is no active org.
    //
    // Non-access kinds (agent / skill / connection / …) are UNAFFECTED: their
    // resolved kind is not in the access-target set, so the unchanged direct path
    // proceeds to the redirect below.
    // -------------------------------------------------------------------------
    const { withInstallLock } = await import("@cinatra-ai/agents");
    const outcome = await withInstallLock(
      input.packageName,
      async (): Promise<
        MarketplaceInstallActionResult | "installed" | "installed-activation-deferred"
      > => {
        const {
          readInstalledExtensionByIdentity,
          readInstalledExtensionsByPackageName,
        } = await import("./canonical-store");
        // Snapshot BEFORE the install (under the lock) so a re-install of an
        // already-installed access-target package is never rolled back by the
        // fail-closed compensation below.
        //
        // This branch has NO access target, so the install can only land at the
        // ACTOR-DERIVED anchor — the org identity below is exact. (The blanket
        // "access-target kinds are org-anchored" claim it used to make is no
        // longer true in general: cinatra#2694/#2695 anchor the two WORKSPACE
        // targets at `owner_level='workspace'` with `organization_id NULL`, and
        // the access branch above keys its snapshot on the chosen anchor. A
        // workspace anchor is unreachable here precisely because it requires a
        // target, and an absent target is refused below.) Skipped when there is
        // no active org — nothing org-anchored to protect.
        const identity = orgId
          ? {
              organizationId: orgId,
              ownerLevel: "organization" as const,
              ownerId: orgId,
              packageName: input.packageName,
            }
          : null;
        const preRow = identity
          ? await readInstalledExtensionByIdentity(identity)
          : null;
        const hadLiveRowBefore =
          preRow != null &&
          (preRow.status === "active" || preRow.status === "locked");

        const result = await installExtensionPackage(
          input.packageName,
          input.packageVersion,
          actor,
        );
        // #2761: the install COMMITTED but did not hot-activate this call. It is
        // a success with a caveat, so it flows to the SAME "installed" outcome
        // and only changes which copy the client renders.
        const activationDeferred = result.activationDeferred === true;
        if (!result.success) {
          // cinatra#685: RETURN the classified category instead of throwing. A
          // thrown server-action message is masked in production (digest only) so
          // it cannot carry the cause to the client; a returned value is delivered
          // intact. The raw technical error stays operator-side (logs).
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

        // Resolve the installed kind under a FAIL-CLOSED guard. A successful
        // install always writes a canonical row; kind is a package-level manifest
        // property, so ANY row resolves it (readInstalledExtensionsByPackageName
        // is org-agnostic — the refusal holds even with no active org). We refuse
        // unless we can POSITIVELY confirm a non-access kind: a read failure, no
        // row at all (anomalous after a success), or ANY access-target row all
        // mean "cannot prove this is safe to leave at the default" → compensate.
        // `.find()` is deterministic even for a — never-expected — heterogeneous
        // result (a single access-target row is enough to refuse).
        let requiresAccessTarget: boolean;
        let resolvedKind: string;
        try {
          const rows = await readInstalledExtensionsByPackageName(
            input.packageName,
          );
          const accessRow = rows.find((extension) =>
            isInstallAccessTargetKind(extension.kind),
          );
          if (accessRow) {
            requiresAccessTarget = true;
            resolvedKind = accessRow.kind;
          } else if (rows.length === 0) {
            // Anomalous: a successful install with no canonical row. Cannot verify
            // the kind → fail closed rather than assume a non-access kind.
            requiresAccessTarget = true;
            resolvedKind = "unresolved";
          } else {
            requiresAccessTarget = false;
            resolvedKind = rows[0]?.kind ?? "unknown";
          }
        } catch (resolveErr) {
          // A post-install kind-resolution failure is fail-closed — we cannot
          // prove a non-access kind, so compensate below rather than proceed and
          // risk leaving an access-target kind at the broadest default.
          requiresAccessTarget = true;
          resolvedKind = "unresolved";
          logMarketplaceFailureForOperator(
            "install-access-resolve",
            input.packageName,
            "unrecoverable",
            resolveErr,
          );
        }

        if (!requiresAccessTarget) {
          // Non-access kind — legacy direct path, unchanged outcome.
          return activationDeferred ? "installed-activation-deferred" : "installed";
        }

        // #1602: an access-target (or unverifiable) kind was installed with NO
        // access target. Refuse rather than persist the broadest per-kind default.
        logMarketplaceFailureForOperator(
          "install-access-required",
          input.packageName,
          "unrecoverable",
          new Error(
            `installed kind "${resolvedKind}" requires an explicit install ` +
              "access target; refusing to default to the workspace-wide grant (#1602).",
          ),
        );
        if (hadLiveRowBefore) {
          // A live install already existed — never destroy it; its prior access
          // policy stands. (A plain install writes NO access policy — install-
          // access-target.ts — so a re-install cannot have widened it.) No NET
          // change was made; the caller's omission is still refused (supply a
          // target and retry).
          return {
            ok: false,
            category: "unrecoverable",
            stage: "access-required",
          };
        }
        // Compensate: roll the fresh install back so an absent target can never
        // silently fail open to workspace access. (Root package only —
        // auto-installed dependencies are shared and stay.) The rollback actor
        // carries org-scoped standing so the P5 lifecycle gate permits removing
        // the org's own row (a role-less actor is refused → would leak the row),
        // and never platform standing (which would go package-global).
        const rollbackActor = await buildInstallRollbackActor(
          session,
          actor,
          input.packageName,
        );
        const rollback = await uninstallExtensionPackage(
          input.packageName,
          input.packageVersion,
          rollbackActor,
        );
        if (!rollback.success) {
          // Irreducible corner (identical to the access branch): the compensating
          // uninstall itself failed, so the extension remains installed with the
          // per-kind DEFAULT (workspace) access. Report the partial state honestly
          // — the operator log carries the details for manual remediation.
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
        return {
          ok: false,
          category: "unrecoverable",
          stage: "access-required",
        };
      },
    );
    if (outcome === "installed-activation-deferred") {
      // A committed install that activates on the next restart. Returned (not
      // redirected) so the client can render the caveat; a plain success still
      // redirects below.
      return { ok: true, activation: "deferred" };
    }
    if (outcome !== "installed") {
      return outcome;
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
  // Standing-free envelope by design — see installExtensionPackageFormAction
  // (the #1039 update path routes through the same dependency batch).
  const actor = buildActorEnvelope(session);
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

// ---------------------------------------------------------------------------
// Form-action wrappers for archive/restore/reinstall/forceDelete.
//
// NOTE (cinatra#2400): there is deliberately NO `uninstallExtensionPackageForm-
// Action`. It existed as an exported wrapper that no surface ever called — a
// dead export that shipped the same role-less-actor defect as the rest of the
// family, so it would have refused if a future caller had wired it. The settings
// page's removal affordances are the §V Danger-zone Archive + Force delete, and
// the UI's uninstall-bearing path is §V Maintenance · Reinstall latest
// (`reinstallLatestFormAction` → `extensionRegistry.uninstall` → install). The
// dead export was REMOVED rather than wired: adding an Uninstall affordance
// would be a new, unspecified UI control. The core dispatcher
// `uninstallExtensionPackage(packageName, version, actor)` above is UNCHANGED
// and still referenced — it is what the install-access rollbacks compensate
// through. (The MCP surface does not go through it; `mcp/handlers.ts`
// dispatches `extensionRegistry.uninstall` directly.)
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
  const actor = await buildLifecycleActorFromSession(
    session,
    "archive",
    input.packageName,
  );
  const result = await archiveExtensionPackage(
    input.packageName,
    input.packageVersion,
    actor,
  );
  if (!result.success) {
    // cinatra#1061: RETURN the classified refusal (see uninstall action note) so
    // the archive dependents/system message survives to the production client.
    const failure = result.failure ?? { ok: false as const, reason: "error" as const };
    logRemovalFailureForOperator(
      "archive",
      input.packageName,
      failure,
      result.error,
      result.errorCode,
    );
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
  const actor = await buildLifecycleActorFromSession(
    session,
    "restore",
    input.packageName,
  );
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
  const actor = await buildLifecycleActorFromSession(
    session,
    "reinstall",
    input.packageName,
  );
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
  // packageVersion.min(1), reason, and confirmDestructive: literal(true)). The
  // §V Danger-zone Force-delete dialog is the UI caller; a lax form-action
  // contract would let a future caller land a button without thinking through
  // the destructive-acknowledgment guard. Make the safety guard mandatory at the
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
  const actor = await buildLifecycleActorFromSession(
    session,
    "force-delete",
    input.packageName,
  );
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
  const { claimOfAuthorizedTemplate } = await import("@cinatra-ai/agents/agent-template-identity");
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
  // cinatra#2616 — under the claim of the row this action already resolved and
  // authorized, so the visibility write cannot land on a foreign identity.
  await updateAgentTemplateVisibility(
    input.packageName,
    "public",
    publicConfig.registryUrl,
    claimOfAuthorizedTemplate(template, (session as { session?: { activeOrganizationId?: string | null } }).session?.activeOrganizationId ?? null),
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
