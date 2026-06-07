// -----------------------------------------------------------------------------
// Shared verbatim error message composer.
//
// Consumed by both server action files (setup/name/actions.ts and
// administration/instance/actions.ts) so the verbatim copy lives in exactly one
// place. Centralizing the copy prevents a typo or wording tweak in either
// action from passing the "verbatim reserved-substring substring" assertion in
// single-export-site.test.ts while still drifting user-facing copy across
// surfaces.
//
// Surface boundary:
//   - This module composes the PLAIN-TEXT redirect copy used by
//     redirectWithError(...) — the contact channel is a phrase, not a
//     hyperlink. The clickable link variant lives in the wizard client
//     island (src/app/setup/name/instance-namespace-input.tsx) which
//     consumes the same structured payload but renders it as JSX.
//   - Verbatim copy is locked. Do NOT alter punctuation, casing, or wording.
// -----------------------------------------------------------------------------

import type { NamespaceValidationError } from "./types";

export function composeNamespaceErrorMessage(error: NamespaceValidationError): string {
  if (error.code === "required") {
    return "Instance namespace is required.";
  }
  if (error.code === "format") {
    return "Instance namespace must be 2–39 lowercase letters, digits, or hyphens, starting with a letter or digit.";
  }
  // error.code === "reserved" — verbatim copy is locked.
  // Do NOT alter punctuation, casing, or wording.
  return (
    'Instance namespace "' +
    error.canonical +
    '" contains the reserved substring "' +
    error.reservedSubstring +
    '" and is restricted. Names containing "' +
    error.reservedSubstring +
    '" are reserved for Cinatra.ai-affiliated instances and require pre-registration. ' +
    "To request approval, " +
    error.contact.channel +
    "."
  );
}
