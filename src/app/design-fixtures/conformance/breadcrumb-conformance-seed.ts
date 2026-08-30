// ---------------------------------------------------------------------------
// Deterministic seed for the `breadcrumb-entity-resolution` conformance
// surface (adopted with the cinatra#3057 pin reconciliation).
//
// Imported by BOTH the harness fixture (breadcrumb-conformance-fixtures.tsx)
// and the Playwright drivers (tests/e2e/design/conformance/contract.ts), so a
// field assertion compares against the SAME values the harness rendered.
//
// Intentionally dependency-free (no "@/" or workspace imports): the Playwright
// suite imports this file by relative path, outside the Next.js toolchain —
// same contract as fixture-data.ts / seed-data.ts / connector-setup-seed.ts.
//
// ANTI-LOOKALIKE: the display name shares no token, and no substring longer
// than a single character, with the id it is resolved from. A driver that read
// the placeholder where the manifest binds `entity.displayName` therefore REDS
// instead of passing on a lookalike.
//
// PLACEHOLDER_ IS AN EXPECTATION, NOT A COPY OF THE RULE. The harness renders
// whatever the REAL trail builder produces for an unresolved id segment
// (src/lib/breadcrumb-trail.ts `idSegmentPlaceholder`: the first eight
// characters of the decoded segment followed by a horizontal ellipsis). This
// constant states what that must come out as, so a change to the floor rule
// reds the driver rather than silently redefining what the manifest field
// binds.
// ---------------------------------------------------------------------------

/** An id-like (UUID) entity segment, so the trail's placeholder rule applies. */
export const BREADCRUMB_ENTITY_ID = "9c0dfce6-b2cb-4dab-9a41-7f0e5d2c4a13";

/** The crumb path the gated route publishes its resolved label for. */
export const BREADCRUMB_ENTITY_PATH = `/teams/${BREADCRUMB_ENTITY_ID}`;

/** `entity.displayName` — what a RESOLVED crumb must render. */
export const BREADCRUMB_ENTITY_DISPLAY_NAME = "Northwind Research Guild";

/** `entity.id` — what an UNRESOLVED crumb must render instead. */
export const BREADCRUMB_ENTITY_PLACEHOLDER = "9c0dfce6…";

/** The session/org fence the real shell supplies from crumb-epoch-context. */
export const BREADCRUMB_HARNESS_EPOCH = "conformance-breadcrumb-harness";
