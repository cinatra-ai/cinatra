// ---------------------------------------------------------------------------
// removal-failure — the RETURNED failure contract for a removal
// (uninstall / archive) that must reach the user in production (cinatra#1061).
//
// WHY A SEPARATE CONTRACT (not the #685 marketplace taxonomy).
// The #685 `MarketplaceFailureCategory` set (marketplace-failure-copy.ts) is a
// STRICT mirror of a PHP `InstallFailureTaxonomy` with a cross-repo parity test,
// and its install-time contract deliberately carries NO dependency-identity
// oracle. A removal REFUSAL is a fundamentally different thing: it is a LOCAL
// closure/lifecycle gate, and naming the blocking dependents is the whole point
// (they are extensions the operator installed — not an entitlement secret). So
// removal gets its OWN small returned union rather than polluting the taxonomy.
//
// WHY RETURNED (not thrown). A thrown server-action error is masked by Next.js
// production builds (digest only), so the message naming the blocking dependents
// never reaches the user — the exact bug cinatra#1061 fixes. A server-action
// RETURN value crosses the boundary intact. Same pattern install/update/restore
// already use (#685); this is its removal-side sibling.
//
// SECURITY. `dependents` are LOCAL installed-extension display names the gate
// already computed to refuse the op; the raw technical error stays operator-side
// (logs). An unclassifiable failure fails SAFE to `error` (opaque, generic copy).
// ---------------------------------------------------------------------------

/** The removal operations whose refusal we describe. */
export type RemovalOperation = "uninstall" | "archive";

/**
 * What a removal FORM action returns to the client on FAILURE. The success path
 * never returns (it `redirect()`s), so a returned value always means failure.
 *  - `dependents` — a closure/reverse-dependency gate refused the removal; the
 *    named extensions require the target and must be removed/detached first.
 *  - `system`     — the #1036 system-extension guard refused (update-only).
 *  - `error`      — any other failure (incl. a fail-CLOSED closure-check-
 *    unavailable outage); raw detail stays operator-side, generic copy shown.
 */
export type RemovalActionResult =
  | { ok: false; reason: "dependents"; dependents: string[] }
  | { ok: false; reason: "system" }
  | { ok: false; reason: "error" };

/**
 * Classify a thrown removal failure into the returned contract. Duck-types on
 * STABLE discriminants (`.code` / `.name`) rather than `instanceof` so it is
 * robust across the dynamic-import / package boundary (an error constructed in
 * one module instance still classifies). Mirrors the error surface of the
 * removal choke-point:
 *  - `SystemExtensionRemovalError`  (code SYSTEM_EXTENSION_PROTECTED) → system
 *  - `DependencyClosureError`       (code ARCHIVE_BREAKS_CLOSURE, .dependents[]) → dependents
 *  - `ActiveDependentError`         (name, .dependentName) → dependents([one])
 *  - anything else (incl. ClosureCheckUnavailableError) → error (fail-safe)
 */
export function classifyRemovalFailure(error: unknown): RemovalActionResult {
  const e = error as { code?: unknown; name?: unknown; dependents?: unknown; dependentName?: unknown } | null;
  const code = typeof e?.code === "string" ? e.code : undefined;
  const name = typeof e?.name === "string" ? e.name : undefined;

  if (code === "SYSTEM_EXTENSION_PROTECTED") {
    return { ok: false, reason: "system" };
  }
  if (code === "ARCHIVE_BREAKS_CLOSURE" && Array.isArray(e?.dependents)) {
    const dependents = (e.dependents as unknown[]).filter(
      (d): d is string => typeof d === "string" && d.length > 0,
    );
    if (dependents.length > 0) return { ok: false, reason: "dependents", dependents };
  }
  if (name === "ActiveDependentError" && typeof e?.dependentName === "string" && e.dependentName.length > 0) {
    return { ok: false, reason: "dependents", dependents: [e.dependentName] };
  }
  return { ok: false, reason: "error" };
}

/** Oxford-comma join of dependent display names for the copy. */
function formatDependentList(names: string[]): string {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

// Keep in lockstep with SYSTEM_EXTENSION_REMOVAL_MESSAGE
// (system-extension-inventory.ts). Duplicated as a literal here because this
// module is isomorphic (imported into the client bundle) and must not pull in
// the server-only inventory reader.
const SYSTEM_REMOVAL_COPY = "System extension — can be updated but not deleted.";

/**
 * Plain-language, ACTIONABLE end-user copy for a refused removal. Names the
 * blocking dependents for the `dependents` case (they are local, operator-
 * installed extensions); never leaks raw technical detail for `error`.
 */
export function removalFailureCopy(
  result: RemovalActionResult,
  operation: RemovalOperation,
  packageTitle: string,
): string {
  const verb = operation === "archive" ? "archive" : "uninstall";
  switch (result.reason) {
    case "dependents": {
      const list = formatDependentList(result.dependents);
      const requires = result.dependents.length === 1 ? "requires" : "require";
      const them = result.dependents.length === 1 ? "it" : "them";
      return `Can't ${verb} ${packageTitle} — ${list} ${requires} it. Uninstall or archive ${them} first.`;
    }
    case "system":
      return SYSTEM_REMOVAL_COPY;
    case "error":
    default:
      return `Couldn't ${verb} ${packageTitle}. Please try again, and contact your administrator if it keeps happening.`;
  }
}
