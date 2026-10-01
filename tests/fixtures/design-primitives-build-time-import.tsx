// A FIXTURE standing in for a SOURCE-COMPILED package (cinatra#3512, slice 2b
// of #3471, epic #2926 — decision 407 of 2026-09-13).
//
// A connector's setup page and an artifact package's server parts are NOT
// dynamically loaded bundles: they are compiled FROM SOURCE into the host's own
// build through the tsconfig path map (see
// `extensions/cinatra-ai/linkedin-connector/src/linkedin-setup-impl.tsx`, a
// `server-only` module the host compiles). For those, the bare id
// `@cinatra-ai/design-primitives` has to resolve in the HOST COMPILER and hand
// back the host's own instance — the run-time road (externals + module registry
// + preamble) never runs for them.
//
// This file is not a test; it is the thing the test compiles and imports. The
// host typecheck sweeps it (root `tsconfig.json` includes `**/*.tsx` and
// excludes only `node_modules`, `**/__tests__/fixtures/**` and
// `extensions/**/tests/**`), so on a head without the build-time path it fails
// the host build with TS2307 — exactly the red this slice closes.
import { Alert, AlertDescription, AlertTitle, Button } from "@cinatra-ai/design-primitives";

/** The bindings the fixture imported, for the identity assertion. */
export const FIXTURE_IMPORTED_PRIMITIVES = {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
};

/**
 * The shape a connector setup page actually writes: JSX over the host's own
 * components, so the fixture proves the TYPES arrive with the names and not
 * only that the specifier resolves.
 */
export function FixtureSetupNotice() {
  return (
    <Alert>
      <AlertTitle>Connected</AlertTitle>
      <AlertDescription>The host serves this primitive.</AlertDescription>
    </Alert>
  );
}
