// Activation routing — the PURE decision that maps a trust verdict + the
// untrusted-isolation mode onto WHERE an extension's `register(ctx)` runs.
//
// PURE + total + no IO. This is the single seam between the trust classifier
// (`extension-trust.ts`) and the two execution surfaces:
//   - "in-process"            → the host imports the serverEntry directly into
//                               its own process (only for TRUSTED records).
//   - "subprocess-prototype"  → fork a child node process + drive `register`
//                               over an RPC seam (untrusted, opt-in PROTOTYPE).
//   - "deny"                  → refuse activation entirely (the fail-closed
//                               default for untrusted records).
//
// The fail-closed defaults live upstream in `extension-trust.ts`
// (`untrustedActivationMode` returns "deny" unless the opt-in flag is set;
// `classifyExtensionTrust` denies anything untrusted). This module only routes
// the already-computed inputs; it never reads env or touches the filesystem, so
// it is unit-testable in isolation.

/** The three mutually-exclusive places an extension can be activated. */
export type ActivationRoute = "in-process" | "subprocess-prototype" | "deny";

/** The untrusted-isolation mode (the resolved value of `untrustedActivationMode`). */
export type UntrustedIsolationMode = "deny" | "subprocess-prototype";

export type ActivationRouteInput = {
  /** Did the trust classifier mark this record TRUSTED? */
  trusted: boolean;
  /**
   * What may an UNTRUSTED record do in this environment? "deny" is the
   * fail-closed default; "subprocess-prototype" is the opt-in escape hatch.
   * Ignored when `trusted` is true.
   */
  untrustedMode: UntrustedIsolationMode;
};

/**
 * Decide where an extension activates. Pure + total:
 *  - trusted                              → "in-process".
 *  - untrusted + mode "subprocess-prototype" → "subprocess-prototype".
 *  - untrusted + mode "deny"              → "deny".
 *
 * Trusted records ALWAYS route in-process regardless of `untrustedMode` (the
 * mode only governs the untrusted branch).
 */
export function decideActivationRoute(input: ActivationRouteInput): ActivationRoute {
  if (input.trusted) return "in-process";
  return input.untrustedMode === "subprocess-prototype" ? "subprocess-prototype" : "deny";
}
