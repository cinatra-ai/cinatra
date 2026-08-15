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
// runtime with it, so a down runtime means it was stopped, deliberately
// opted out (--no-wayflow / NO_WAYFLOW=1), or the install predates that
// change. The remediation is the same either way.
// `cinatra instance wayflow start` is not on every
// released cinatra-cli yet, so the hint caveats it instead of asserting it
// unconditionally, and gives a complete fallback: the docker invocation must
// be pinned to the live stack's compose project (`-p cinatra_cinatra`) or it
// forks a SEPARATE project that can't see the running network, and the
// wayflow container needs docker/wayflow/.wayflow.env generated first
// (scripts/gen-wayflow-env.mjs --require-bridge-token) or it refuses to boot.
export const WAYFLOW_DOWN_HINT =
  "agent runs fail until it's started — `cinatra instance wayflow start` " +
  "if your cinatra-cli has it (not every released CLI does yet), or from " +
  "the checkout root: `source .env.local && node scripts/gen-wayflow-env.mjs " +
  "--require-bridge-token && docker compose -p cinatra_cinatra -f docker-compose.yml " +
  "-f docker-compose.dev.yml --profile wayflow up -d --build wayflow`";
