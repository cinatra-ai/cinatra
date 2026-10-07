/**
 * What the steps smoke shares: the account it signs in with, and whether it can
 * run here at all.
 *
 * The global setup (`readiness.global-setup.ts`) probes once, before any worker
 * starts, for a browser and for a development server, and leaves each answer in
 * the environment the workers inherit. Every test file of the smoke reads them
 * at collection time and skips with a reason that names what is missing, so the
 * suite is safe to run on a machine with neither.
 */
import { suitePath } from "../../config/base";

/** The environment names the global setup writes its two readings to. */
export const STEPS_BROWSER_ENV = "E2E_STEPS_BROWSER";
export const STEPS_SERVER_ENV = "E2E_STEPS_SERVER";
/** The reading of a probe that found what it looked for. */
export const READY = "present";

/** Where the setup keeps the smoke account's session. */
export const STEPS_STORAGE_STATE = suitePath("steps", "smoke", ".auth", "state.json");

/**
 * The smoke account. The defaults are local-only and deterministic, like every
 * suite's; a run overrides them through the environment.
 */
export const STEPS_CREDENTIALS = Object.freeze({
  email: process.env.E2E_STEPS_USER_EMAIL ?? "steps-smoke@local.test",
  password: process.env.E2E_STEPS_USER_PASSWORD ?? "StepsSmoke2026!",
});

/** Why the smoke cannot run here, or null when it can. */
export function readinessGap(): string | null {
  const unprobed = "not probed (run the smoke through tests/e2e/config/steps.config.ts)";
  const browser = process.env[STEPS_BROWSER_ENV] ?? unprobed;
  const server = process.env[STEPS_SERVER_ENV] ?? unprobed;
  if (browser !== READY) return `no browser: ${browser}`;
  if (server !== READY) return `no development server: ${server}`;
  return null;
}
