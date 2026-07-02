// Extension trust classification — VENDOR-AGNOSTIC.
//
// PURE + fail-closed. "Trusted" gates whether an extension's code may be
// dynamically imported IN-PROCESS by the host. The trust root is NOT a
// hard-coded vendor scope — scope confers ZERO
// trust. Instead a package is import-trusted ONLY when ALL hold:
//   1. a persisted host trust decision exists for it (the DB install row),
//      and it is not an explicit revocation;
//   2. its tarball integrity was verified (SRI matched the recorded digest);
//   3. its resolved registry host is in `trustedActivationHosts` — sourced ONLY
//      from the deployment's `publicRegistryUrl` (the marketplace), NEVER the
//      instance's own publish target (see extension-trust-config.ts). An
//      instance-local / private-Verdaccio host is simply absent → denied;
//   4. EITHER a cryptographic signature verified against a host-trusted key
//      (`trusted-signed` — the vendor-agnostic root), OR — ONLY when the operator
//      has explicitly opted in via `allowMarketplaceBootstrapTrust`
//      (CINATRA_EXTENSION_ALLOW_UNSIGNED_BOOTSTRAP=true) — an unsigned package
//      (`trusted-bootstrap`, transition/dev only). Default (no opt-in): unsigned
//      marketplace code stays untrusted and is NOT imported in-process.
//
// A signed marketplace artifact verified against a host-configured key is NOT
// untrusted code — the signature is the boundary that lets ANY marketplace vendor
// activate in-process WITHOUT container isolation. Isolation remains required only
// for unsigned / non-marketplace / instance-local code, which stays DENIED.
// In prod an UNTRUSTED package is NEVER imported in-process (fail-closed).
//
// IMPORT-trust here is DECOUPLED from privileged host capability (ports + DDL):
// auto-granting privileged ports / running host DDL requires `trusted-signed` (or
// an explicit admin grant), NEVER `trusted-bootstrap` alone — enforced by the
// install pipeline + saga + loader callers. A bootstrap-trusted package may
// import, but does not silently receive privileged capabilities.
//
// This module is PURE: the host-derived `trustedActivationHosts` /
// `allowMarketplaceBootstrapTrust` inputs are computed by the server-only
// `extension-trust-config.ts` and passed in, so the classifier stays unit-testable
// over explicit inputs.

/** In-process import trust tiers. `trusted-signed` is the vendor-agnostic root;
 *  `trusted-bootstrap` is the transition-window tier (import-only, no privileged
 *  capability). */
export type ExtensionTrustTier = "trusted-signed" | "trusted-bootstrap" | "untrusted";

export type TrustInput = {
  packageName: string;
  /** The registry URL the package was resolved from, if known. */
  registryUrl?: string | null;
  /** Whether the tarball SRI was verified against the recorded digest. */
  integrityVerified: boolean;
  /**
   * A persisted host trust decision (the DB install record). REQUIRED:
   * only an explicit `true` trusts. `undefined` (not yet decided) and
   * `false` (revoked) both refuse — metadata alone is never sufficient.
   */
  persistedTrustDecision?: boolean;
  /**
   * Whether a cryptographic signature over the extension TARBALL verified against
   * a host-trusted key:
   *   - `true`      → the vendor-agnostic trust root (`trusted-signed`);
   *   - `false`     → a producer attested a signature that did NOT verify → REFUSE;
   *   - `undefined` → no signature present / no signing configured → falls through
   *                   to the bootstrap-trust transition lever below.
   */
  signatureVerified?: boolean;
  /**
   * The host allowlist (registry hosts) for in-process activation — sourced ONLY
   * from `trustedActivationHosts()` (the deployment `publicRegistryUrl`). Omitted
   * → `[]` (fail-closed: no host matches → everything untrusted).
   */
  trustedActivationHosts?: readonly string[];
  /**
   * Whether an integrity-verified, persisted-decision, trusted-host package with
   * NO signature may bootstrap-trust during the transition window
   * (`allowMarketplaceBootstrapTrust()`). Omitted → `false` (fail-closed: only a
   * verified signature trusts).
   */
  allowMarketplaceBootstrapTrust?: boolean;
};

export type TrustVerdict = {
  tier: ExtensionTrustTier;
  trusted: boolean;
  /** Human-readable reason, surfaced in logs + the install UI. */
  reason: string;
};

function registryHostOf(registryUrl: string | null | undefined): string | null {
  if (!registryUrl) return null;
  try {
    return new URL(registryUrl).host.toLowerCase();
  } catch {
    return null;
  }
}

const untrusted = (reason: string): TrustVerdict => ({ tier: "untrusted", trusted: false, reason });

/**
 * Classify an extension's in-process import trust tier. VENDOR-AGNOSTIC — never
 * reads package scope. Fail-closed: any missing/failed factor → `untrusted`. A
 * `persistedTrustDecision === false` is an explicit revocation that overrides
 * everything (incl. a valid signature).
 *
 * Precedence:
 *   persistedTrustDecision === false                 → untrusted (revoked — wins)
 *   !integrityVerified                               → untrusted
 *   persistedTrustDecision !== true                  → untrusted (before host/sig)
 *   host ∉ trustedActivationHosts                    → untrusted (config-driven; local host absent → denied)
 *   signatureVerified === false                      → untrusted (tampered / wrong key)
 *   signatureVerified === true                       → trusted-signed
 *   else && allowMarketplaceBootstrapTrust           → trusted-bootstrap (Window-1 parity)
 *   else                                             → untrusted ('signature required')
 */
export function classifyExtensionTrust(input: TrustInput): TrustVerdict {
  const allow = (input.trustedActivationHosts ?? []).map((h) => h.toLowerCase());

  if (input.persistedTrustDecision === false) {
    return untrusted("trust explicitly revoked by host decision");
  }
  if (!input.integrityVerified) {
    return untrusted("tarball integrity not verified");
  }
  // A persisted host trust decision is a REQUIRED factor and short-circuits
  // BEFORE the host/signature factors. `undefined` (not-yet-decided) does NOT
  // auto-trust — only an explicit `true` does. The affirmative decision lives in
  // the DB install record (the installer flow), never sidecar/registry metadata.
  if (input.persistedTrustDecision !== true) {
    return untrusted("no persisted host trust decision");
  }
  const host = registryHostOf(input.registryUrl);
  if (!host || !allow.includes(host)) {
    return untrusted(
      `registry ${host ?? "(unknown)"} is not a trusted activation host (${allow.join(", ") || "none configured"})`,
    );
  }
  // A producer attested a signature and it did NOT verify against any host-trusted
  // key (tamper / wrong key) — REFUSE, even when signatures are not required.
  if (input.signatureVerified === false) {
    return untrusted("package signature did not verify");
  }
  // The vendor-agnostic trust root: a signature verified against a host-trusted
  // key. ANY vendor reaches this tier; scope is never consulted.
  if (input.signatureVerified === true) {
    return {
      tier: "trusted-signed",
      trusted: true,
      reason: "verified signature from a trusted activation host (integrity + persisted decision)",
    };
  }
  // No signature present. During the pre-signature transition window a package
  // from a trusted activation host with verified integrity + a persisted decision
  // may import in-process as `trusted-bootstrap` — but it does NOT receive
  // privileged host capabilities (the caller's capability split enforces that).
  if (input.allowMarketplaceBootstrapTrust) {
    return {
      tier: "trusted-bootstrap",
      trusted: true,
      reason: "marketplace-bootstrap trust (trusted activation host + integrity + persisted decision; signature pending — transition window)",
    };
  }
  return untrusted("signature required (no verified signature, and marketplace-bootstrap trust is disabled)");
}

/**
 * Whether an untrusted package may be activated at all in the current
 * environment. Untrusted in-process import is NEVER allowed. The only
 * non-prod escape hatch is the explicit subprocess-RPC PROTOTYPE flag
 * (`CINATRA_EXTENSION_UNTRUSTED_ISOLATION=subprocess`, untrusted isolation) — and even
 * then it is documented as a prototype, not a security boundary.
 */
export function untrustedActivationMode(
  env: Record<string, string | undefined> = process.env,
): "deny" | "subprocess-prototype" {
  return env.CINATRA_EXTENSION_UNTRUSTED_ISOLATION === "subprocess"
    ? "subprocess-prototype"
    : "deny";
}
