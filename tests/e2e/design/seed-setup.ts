/**
 * Converges the run's seeded fixture namespace ONCE, before any worker starts.
 *
 * The seeded conformance surfaces assert EXACT counts against the rows the seed
 * endpoint provisions (src/app/design-fixtures/conformance/seed/route.ts), and
 * every family that needs them calls `ensureSeeded` itself. Once the namespace
 * equals the committed kit, such a call lists it, finds every row matching and
 * writes nothing, so any number of workers may make it at the same time.
 *
 * The FIRST convergence is the one call that must not run twice at once. Two
 * calls on an empty namespace race the inserts: each row is installed and then
 * moved to its committed status by the call that won its insert, and the call
 * that lost the LAST insert can return before the winner has moved that row. A
 * page read in that moment counts the wrong split between active, locked and
 * archived rows. With several workers in one run (tests/e2e/config/
 * design-workers.mjs), converging here, before the workers start, closes that
 * window for every family.
 *
 * Best effort, like the per-family seeding it precedes. Without the capability
 * (a local run that did not arm it) it does nothing. A failure is reported and
 * left to the seeded tests, whose own `ensureSeeded` then fails with the
 * reason; the families that need no seeded row still run.
 */
export default async function seedSetup(): Promise<void> {
  if (!process.env.CINATRA_CONFORMANCE_SEED_TOKEN) return;
  // Loaded only when the capability is armed: a run without it pays nothing.
  const { ensureSeeded } = await import("./conformance/contract");
  try {
    await ensureSeeded();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(
      `design suite: the seeded fixture namespace was not converged before the workers started (${reason}); the seeded tests provision it themselves`,
    );
  }
}
