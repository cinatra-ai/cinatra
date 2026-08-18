// WayFlow "down" remediation hint — shared by scripts/check-services.mjs and
// its test (scripts/__tests__/check-services-wayflow-hint.test.mjs).
//
// Pulled into its own module (cf. scripts/lib/nango-health.mjs) so the
// guidance text is a plain importable string a test can assert on directly,
// rather than slicing check-services.mjs's raw source (check-services.mjs
// runs top-level probing + process.exit side effects on import, so it isn't
// unit-importable itself).
//
// cinatra#2654: an install that owns a local compose stack now starts the
// runtime with it, so a down runtime being unreachable is not automatically
// unexpected — it depends on what THIS install recorded in `.env.local`
// (CINATRA_WAYFLOW_RUNTIME=local|off|external, the same key `cinatra doctor`
// reads). A hint that ignores that key tells an operator who deliberately
// opted out, or who points at an external runtime, to "start" a local
// container this install never owns. `wayflowDownHint(mode)` mirrors cinatra
// doctor's local/off/external split so this dev-side check gives the same
// shape of guidance the CLI does.
//
// `cinatra instance wayflow start` is not on every released cinatra-cli yet,
// so every hint that names it caveats it instead of asserting it
// unconditionally, and every docker fallback is complete: pinned to the live
// stack's compose project (`-p cinatra_cinatra`) — an unpinned invocation
// forks a SEPARATE project that can't see the running network — and preceded
// by the docker/wayflow/.wayflow.env generator
// (scripts/gen-wayflow-env.mjs --require-bridge-token) the wayflow container
// needs to boot at all.

const CLI_START_HINT =
  "`cinatra instance wayflow start` if your cinatra-cli has it (not every " +
  "released CLI does yet)";

const DOCKER_FALLBACK =
  "`source .env.local && node scripts/gen-wayflow-env.mjs --require-bridge-token " +
  "&& docker compose -p cinatra_cinatra -f docker-compose.yml -f docker-compose.dev.yml " +
  "--profile wayflow up -d --build wayflow`";

const VALID_MODES = new Set(["local", "off", "external"]);

/** Normalize a recorded CINATRA_WAYFLOW_RUNTIME value; unknown/absent reads
 *  as "local" (default-on is the contract — a checkout predating the key is
 *  read as "should have a runtime", not silently excused). Matches
 *  `normalizeWayflowRuntimeMode` in cinatra-cli. */
export function normalizeWayflowRuntimeMode(raw) {
  const value = String(raw ?? "").trim().toLowerCase();
  return VALID_MODES.has(value) ? value : "local";
}

/**
 * Build the WayFlow "down" remediation hint for the recorded runtime mode.
 *
 * @param {string | undefined} rawMode  The raw CINATRA_WAYFLOW_RUNTIME value
 *   read from `.env.local` (normalized internally).
 * @returns {string}
 */
export function wayflowDownHint(rawMode) {
  const mode = normalizeWayflowRuntimeMode(rawMode);
  if (mode === "off") {
    return (
      "disabled for this install (CINATRA_WAYFLOW_RUNTIME=off, e.g. " +
      "--no-wayflow) — agent runs fail until you enable it: re-run setup " +
      `without the opt-out, start it now with ${CLI_START_HINT}, or bring ` +
      `it up directly: ${DOCKER_FALLBACK}`
    );
  }
  if (mode === "external") {
    return (
      "configured for an external runtime (CINATRA_WAYFLOW_RUNTIME=external) " +
      "— this checkout starts no local WayFlow container; point " +
      "WAYFLOW_BASE_URL at the runtime you operate and verify it answers /.health"
    );
  }
  return (
    `agent runs fail until it's started — start it with ${CLI_START_HINT}, ` +
    `or from the checkout root: ${DOCKER_FALLBACK}`
  );
}

/** Local-mode hint, kept as a plain string constant for callers that have no
 *  mode to pass (and for back-compat with existing imports of this name). */
export const WAYFLOW_DOWN_HINT = wayflowDownHint("local");
