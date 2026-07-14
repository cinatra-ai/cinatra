/**
 * Fixed allowlist for the `?error=` query param on /organizations/new.
 *
 * The param is caller-controlled, so the lookup is guarded with
 * `Object.hasOwn`: a plain `RECORD[key]` read would let inherited keys
 * (`__proto__`, `constructor`, `toString`, …) escape the allowlist and
 * return non-string prototype members instead of falling through to the
 * generic message.
 *
 * Kept in its own module (no server-action import chain) so it stays unit
 * testable.
 */
const ERROR_MESSAGES: Record<string, string> = {
  "missing-name": "Enter an organization name.",
  "slug-unavailable":
    "A unique URL slug could not be derived from that name. Try a different name.",
};

const GENERIC_ERROR_MESSAGE = "Could not create the organization.";

/** Resolve the banner text for an `?error=` code; undefined = no banner. */
export function organizationCreateErrorMessage(
  code: string | undefined,
): string | undefined {
  if (!code) return undefined;
  return Object.hasOwn(ERROR_MESSAGES, code)
    ? ERROR_MESSAGES[code]
    : GENERIC_ERROR_MESSAGE;
}
