// The activation-failure CLASS: does an operator fix this by changing a host
// setting, or are the bytes themselves wrong?
//
// The distinction decides whether a failed install may be durably archived. Get
// it wrong in the permissive direction and a good install is destroyed because a
// signing key had not been configured yet. Get it wrong in the other direction
// and genuinely broken bytes stay live forever. So the classifier is pure,
// exhaustively testable, and fails to the SAFE side: anything it cannot place is
// treated as config class, because leaving an install alone is recoverable and
// archiving one is the decision that needs to be right.
//
// Pure: no host imports, no DB, no `server-only`.

export type ActivationFailureClass = "config" | "byte";

/**
 * Failure reasons produced by MUTABLE HOST CONFIGURATION.
 *
 * These are the classifier verdicts and loader refusals that say nothing about
 * the package: the registry it came from is not on this host's activation
 * allow-list, this host trusts no signing key yet, or bootstrap trust is
 * switched off. An operator changes a setting and the same bytes activate.
 */
const CONFIG_CLASS_PATTERNS: readonly RegExp[] = [
  /not a trusted activation host/i,
  /signature required/i,
  /marketplace-bootstrap trust is disabled/i,
  /no trusted keys/i,
  /no persisted host trust decision/i,
  /trusted activation host/i,
];

/**
 * Failure reasons produced by the BYTES.
 *
 * Integrity and digest mismatches, a module that will not import, a `register`
 * that threw, a manifest that does not satisfy this host's SDK ABI. No host
 * setting changes any of these.
 *
 * `did not verify` is deliberately here and not in the config list: a signature
 * that is PRESENT and does not verify means the bytes do not match what was
 * signed. That is tampering or a wrong artifact, not a missing setting. An
 * ABSENT signature is the config case above.
 */
const BYTE_CLASS_PATTERNS: readonly RegExp[] = [
  /integrity/i,
  /digest/i,
  /signature did not verify/i,
  /could not be imported/i,
  /import failed/i,
  /register\(?\)? threw/i,
  /register-threw/i,
  /module (is )?absent/i,
  /no server entry/i,
  /sdk abi/i,
  /content hash/i,
];

/**
 * Classify an activation-failure reason.
 *
 * BYTE patterns are tested FIRST so a compound reason that names a real byte
 * problem is never softened by an incidental configuration word appearing in the
 * same sentence. An unrecognized reason is `config`, the non-destructive answer.
 */
export function classifyActivationFailure(reason: string): ActivationFailureClass {
  const text = reason ?? "";
  if (BYTE_CLASS_PATTERNS.some((re) => re.test(text))) return "byte";
  if (CONFIG_CLASS_PATTERNS.some((re) => re.test(text))) return "config";
  return "config";
}

/**
 * Whether a failed activation may be DURABLY ARCHIVED on boot. Only byte-class
 * failures may: archiving on a config-class failure would destroy an install
 * over a host setting an operator is about to change.
 */
export function mayDurablyArchiveOnBoot(reason: string): boolean {
  return classifyActivationFailure(reason) === "byte";
}
