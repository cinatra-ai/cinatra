/**
 * 3-state in-instance ABI compatibility verdict for the marketplace UI badge.
 *
 * This is the BADGE half of the host/SDK ABI contract — distinct from the
 * install/update GATE (`evaluateHostSdkCompat` in `extension-host-compat.ts`).
 * The gate is intentionally LENIENT for an undeclared range: an extension that
 * declares no `cinatra.sdkAbiRange` is treated as unpinned and installs fine
 * (`isSdkAbiRangeSatisfied(..., null|"" |"*") === true`). The BADGE must NOT
 * reuse that verdict for the undeclared case — surfacing "Compatible" (green)
 * for an extension that simply made no claim would over-promise. So the badge
 * derives THREE states from the DECLARED range:
 *
 *   - declared + satisfied   → "compatible"   (the host ABI satisfies the range)
 *   - declared + unsatisfied  → "incompatible" (host outside the range, OR the
 *                                                range is malformed — the gate
 *                                                fails closed on malformed, so
 *                                                the badge must too: never green)
 *   - ABSENT (no range)       → "unknown"      (neutral; NEVER green)
 *
 * The "compatible"/"incompatible" verdict is the SDK's own
 * `isSdkAbiRangeSatisfied` — never re-implemented — so the badge can never drift
 * from the loaders' activation gate. Only the undeclared→"unknown" branch is
 * new (the gate has no such state because it has nothing to gate on).
 *
 * This module is intentionally NOT `server-only`: it imports only the SDK's
 * pure ABI checker + version constant (no IO, no DB), so the presentational
 * badge can render in the marketplace screen and the detail header without
 * dragging a server boundary into the shared UI.
 */

import {
  isSdkAbiRangeSatisfied,
  SDK_EXTENSIONS_ABI_VERSION,
} from "@cinatra-ai/sdk-extensions";

export type ExtensionCompatState = "compatible" | "incompatible" | "unknown";

/**
 * Derive the 3-state badge verdict from an extension's DECLARED
 * `cinatra.sdkAbiRange` (from the catalog card-model for a not-installed
 * listing, or the materialized manifest for an installed extension).
 *
 * `null`/`undefined`/`""`/whitespace-only → "unknown" (the extension declared
 * no range — neutral, never green). A declared range is evaluated against the
 * host's frozen ABI: satisfied → "compatible"; unsatisfied OR malformed →
 * "incompatible" (the gate fails closed on a malformed range, so the badge is
 * never softer than the gate).
 */
export function deriveExtensionCompatState(
  sdkAbiRange: string | null | undefined,
): ExtensionCompatState {
  const declared = typeof sdkAbiRange === "string" ? sdkAbiRange.trim() : "";
  // No declaration at all → neutral. NOTE: we deliberately treat "*" as a
  // declaration here, NOT as undeclared — an extension that explicitly declares
  // "any ABI" has made a (lenient) claim, so it reads "compatible", whereas an
  // extension that declares nothing reads "unknown".
  if (declared === "") {
    return "unknown";
  }
  return isSdkAbiRangeSatisfied(SDK_EXTENSIONS_ABI_VERSION, declared)
    ? "compatible"
    : "incompatible";
}

/** The host's frozen SDK-extensions ABI version (for badge tooltips/copy). */
export const HOST_SDK_ABI_VERSION = SDK_EXTENSIONS_ABI_VERSION;
