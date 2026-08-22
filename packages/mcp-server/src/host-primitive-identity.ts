// ---------------------------------------------------------------------------
// THE HOST'S OWN PRIMITIVE IDENTITY (cinatra#2817).
//
// Extracted into its own leaf module for ONE reason: both the capability plan
// and the host declaration table need these two constants, and the plan needs
// to read the table (a host-owned primitive's declaration comes FROM the host).
// Leaving the constants in the plan would make that a cycle.
// ---------------------------------------------------------------------------

/** The package that owns core/bundled primitives. */
export const HOST_PRIMITIVE_OWNER_PACKAGE = "@cinatra-ai/host";

/**
 * The RELEASE version core/bundled primitives are planned and admitted against.
 *
 * Core primitives have no package version of their own — they ship with the
 * host — so admission needs a stated release identity to bind to. This constant
 * IS that identity: the migrated core admission records are written against
 * `(HOST_PRIMITIVE_OWNER_PACKAGE, HOST_PRIMITIVE_RELEASE_VERSION, name,
 * digest)`, and bumping it is a deliberate act that RE-REVIEWS the whole core
 * surface (every core record must be re-migrated at the new version, and the
 * old ones stop matching). It is deliberately not read from package.json: a
 * routine version bump must not silently invalidate — or silently carry
 * forward — a reviewed security decision.
 */
export const HOST_PRIMITIVE_RELEASE_VERSION = "2817.1.0";
