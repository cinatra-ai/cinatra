// ---------------------------------------------------------------------------
// supplied-install-refusal-copy.ts — the ADMIN-FACING words of a supplied
// install refusal (cinatra#3204, the Upload screen).
//
// WHY THIS MODULE EXISTS.
//
// The supplied-install road deliberately reports a refusal "in the words of
// whatever refused it": the trust gate, the validator and the containment
// policy each say the one sentence the operator has to act on, and a summary
// written here would replace it with something vaguer. That rule holds for
// every refusal the operator can DO something about in the product's own terms.
//
// The connector access-declaration refusal is the exception, and it is an
// exception of AUDIENCE, not of correctness. A connector package that ships no
// `cinatra/config.json` is refused by the SDK validator, whose message names
// the file and the internal issue that closed the absence rule; the runtime
// activator wraps that in its own failure token; the dispatcher appends what it
// did to the placeholder install row. Every one of those sentences is true and
// every one of them is written for whoever maintains the install chain. Handed
// to an admin on the upload screen they compose a paragraph of diagnostics —
// and the paragraph's LENGTH, not its content, is what pushed the toast off the
// top of the viewport, so the admin was told nothing at all.
//
// So this module keeps the diagnostics where they belong (the server log) and
// answers the admin with ONE short sentence in product words: what the package
// lacks, and what has to be true before it can be installed. It is a pure,
// dependency-free string function on purpose — it is imported by a
// `"use server"` module, which may export nothing but async functions, and it
// is the unit under test for the refusal copy.
//
// RECOGNITION is by the markers the composed message carries. The refusal
// crosses three packages and arrives as a plain `Error` whose message is the
// only thing that survived the composition, so the message is what we match on.
// The unit suite reproduces the raw text from the REAL chain rather than a
// literal, so a reword anywhere in that chain fails the suite instead of
// silently turning this recognizer into dead code.
// ---------------------------------------------------------------------------

/** Every `ConnectorAccessConfigError` prefixes its message with this. */
const CONNECTOR_ACCESS_CONFIG_MARKER = "[connector-access-config]";

/** The absence rule's own phrase, inside that error's message. */
const ABSENT_CONFIG_MARKER = "ships no cinatra/config.json";

/**
 * The ceiling a refusal on the toast surface has to stay under to be readable
 * without growing the toast past the viewport. Exported so the suite asserts
 * against the same number the copy was written to.
 */
export const CONNECTOR_REFUSAL_MAX_LENGTH = 160;

/** The package declares nothing at all. */
export const CONNECTOR_SHIPS_NO_CONFIG_REFUSAL =
  "This connector package ships no configuration, so it cannot be installed until it declares its access scope.";

/** The package declares something the access-scope contract cannot accept. */
export const CONNECTOR_INVALID_CONFIG_REFUSAL =
  "This connector package's configuration is not valid, so it cannot be installed until it declares a valid access scope.";

/**
 * The admin-facing sentence for a refusal whose own words are diagnostics, or
 * `null` when the refusal already speaks to the operator — in which case the
 * caller passes it through untouched, exactly as before.
 */
export function adminFacingSuppliedInstallRefusal(rawMessage: string): string | null {
  if (!rawMessage.includes(CONNECTOR_ACCESS_CONFIG_MARKER)) return null;
  return rawMessage.includes(ABSENT_CONFIG_MARKER)
    ? CONNECTOR_SHIPS_NO_CONFIG_REFUSAL
    : CONNECTOR_INVALID_CONFIG_REFUSAL;
}
