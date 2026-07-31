// The app release identifier of the RUNNING build (cinatra#2260).
//
// WHY a module rather than a literal: the app package manifest is the ONE
// in-tree source of the release identity. A release image is built from the
// tagged release, so the baked manifest version IS the installed release; a
// dev/source build reports the checked-out manifest version. Re-typing the
// number anywhere in `src/` would create a second source that silently drifts
// at the next version bump — so the value is imported, never restated.
//
// Build-time only: the bundler resolves the JSON import, so a reader costs no
// filesystem I/O and makes NO network call at render time. The import is a
// NAMED one (`{ version }`) to give the bundler the chance to drop the rest of
// the manifest — that is an optimization, not a guarantee, so treat this module
// as SERVER-SIDE: importing it from a client component could pull the whole
// manifest into the browser bundle.
import { version } from "../../package.json";

/**
 * App package-manifest version of this build — a dotted release string
 * (illustrative shape: `"1.2.3"`). The example is deliberately NOT the current
 * version: a test asserts this file restates no version literal, so that a
 * hardcoded constant can never impersonate the derived value.
 */
export const APP_VERSION: string = version;
