// -----------------------------------------------------------------------------
// Instance namespace validator.
//
// Pure module: no I/O, no environment access. Consumed by:
//   - the setup wizard client island (instance-namespace-input.tsx)
//   - the post-freeze rename modal (rename-confirmation.tsx)
//   - the three server actions (saveInstanceIdentityAction,
//     editVendorAction, renameInstanceNamespaceAction)
//
// Validation order:
//   1. canonicalize (trim -> lowercase) - silent normalization
//   2. required (empty after canonicalization)
//   3. format (regex against canonical form)
//   4. reserved substring (against canonical form)
//   5. uniqueness/provisioning (out of scope; slot reserved)
//
// The verbatim error string is composed at the RENDER layer, not here.
// This module returns structured payloads only.
// -----------------------------------------------------------------------------

import type {
  NamespaceValidationError,
  NamespaceValidationResult,
} from "./types";
import { RESERVED_SUBSTRINGS } from "./reserved-patterns";

// Exported source string for HTML `pattern=` consumers.
// Three surfaces import this via the @/lib/instance-namespace barrel and
// pass it to <Input pattern={NAMESPACE_FORMAT_REGEX_SOURCE} />. Keeping the
// source string + regex literal next to each other makes drift between
// them visible at code-review time.
export const NAMESPACE_FORMAT_REGEX_SOURCE = "^[a-z0-9][a-z0-9-]{1,38}$";

// Format regex - must match the existing Zod schemas in
// src/app/setup/name/actions.ts and src/app/configuration/instance/actions.ts
// character-for-character. 2-39 chars; lowercase alphanumeric + hyphens;
// must start with alphanumeric.
const NAMESPACE_FORMAT_REGEX = /^[a-z0-9][a-z0-9-]{1,38}$/;

// Contact constants for reserved namespace requests.
const RESERVED_CONTACT = {
  channel: "open a GitHub issue at Cinatra-ai/cinatra",
  href: "https://github.com/Cinatra-ai/cinatra/issues/new?labels=registry-namespace-request",
} as const;

/**
 * Trim then lowercase. Persist canonical only.
 * Users are never rejected for casing/whitespace alone.
 */
export function canonicalizeInstanceNamespace(rawInput: string): string {
  return rawInput.trim().toLowerCase();
}

export function validateInstanceNamespace(
  rawInput: string,
  options?: {
    reservedSubstrings?: readonly string[];
    // EXACT namespaces that bypass the reserved-substring guard. The caller
    // sources these from the config file (see approved-list.ts) so this module
    // stays pure (no I/O). Defaults to none.
    approvedExactNames?: readonly string[];
  },
): NamespaceValidationResult {
  const canonical = canonicalizeInstanceNamespace(rawInput);

  // Step 1 - required (after canonicalization).
  if (canonical.length === 0) {
    const error: NamespaceValidationError = { code: "required" };
    return { ok: false, canonical, error };
  }

  // Step 2 - format.
  if (!NAMESPACE_FORMAT_REGEX.test(canonical)) {
    const error: NamespaceValidationError = { code: "format", canonical };
    return { ok: false, canonical, error };
  }

  // Step 3 - reserved substring (against canonical). EXACT names on the
  // approved list (config-file driven, supplied by the caller) bypass the
  // substring guard, allowing platform-owned instances.
  const approvedExact = options?.approvedExactNames ?? [];
  if (!approvedExact.includes(canonical)) {
    const reservedList = options?.reservedSubstrings ?? RESERVED_SUBSTRINGS;
    for (const substring of reservedList) {
      if (canonical.includes(substring)) {
        const error: NamespaceValidationError = {
          code: "reserved",
          canonical,
          reservedSubstring: substring,
          contact: { ...RESERVED_CONTACT },
        };
        return { ok: false, canonical, error };
      }
    }
  }

  // Step 4 - uniqueness/provisioning slot is intentionally not checked here.

  return { ok: true, canonical };
}
