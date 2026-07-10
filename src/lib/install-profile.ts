// Install-profile + dev-fixture activation contract (`cinatra install demo`;
// cinatra-ai/cinatra-cli#122).
//
// `demo` is a STRICT SUPERSET of `dev`: a demo instance runs with
// `CINATRA_RUNTIME_MODE=development` (so every development-mode gate AND the
// dev-auto-setup connector wiring still fire) PLUS the orthogonal
// `CINATRA_INSTALL_PROFILE=demo` overlay. It is DELIBERATELY *not* a third
// `CINATRA_RUNTIME_MODE` value — that would silently flip the ~dozens of
// `RUNTIME_MODE === "development"` checks across the codebase and break the
// dev-identical guarantee. The profile is an independent axis layered on top of
// the runtime mode.
//
// Fixtures relocation: the extension dev-fixtures dataset (applied at dev boot by
// `dev-fixture-seeder`) used to seed on EVERY development boot. Its activation is
// relocated to:
//   - demo ⇒ ALWAYS seeded (`CINATRA_INSTALL_PROFILE=demo`),
//   - dev  ⇒ seeded ONLY when explicitly opted in (`CINATRA_DEV_FIXTURES` truthy),
//   - never outside strict development runtime (prod ⇒ never).
// The monolithic `scripts/seed.mjs` dataset stays gated by `setup.sh`'s `SEED`
// prompt (already opt-in in dev); the demo install path forces `SEED=1` there.
//
// Pure env logic (no server-only APIs, no IO) so it is importable from the boot
// phases, the seeder, and unit tests alike.

export type InstallProfile = "dev" | "demo";

/**
 * The install profile for this instance. Defaults to `"dev"` when the env is
 * unset or holds any unrecognised value (fail-safe: only the exact string
 * `"demo"` opts into the demo overlay).
 */
export function getInstallProfile(env: Record<string, string | undefined> = process.env): InstallProfile {
  return env.CINATRA_INSTALL_PROFILE === "demo" ? "demo" : "dev";
}

/** True when this instance runs the demo overlay (`CINATRA_INSTALL_PROFILE=demo`). */
export function isDemoProfile(env: Record<string, string | undefined> = process.env): boolean {
  return getInstallProfile(env) === "demo";
}

/**
 * Loose truthy parse for an opt-in env flag: `1` / `true` / `yes` / `on`
 * (case-insensitive, surrounding whitespace trimmed). Everything else — including
 * `0`, `false`, `""`, and `undefined` — is false.
 */
export function isEnvFlagEnabled(value: string | undefined): boolean {
  if (typeof value !== "string") return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/**
 * Strict development runtime (exact-equality; mirrors `dev-auto-setup`'s
 * `isStrictDevelopmentRuntime`): development mode AND not a production Node env.
 * Fixtures never seed outside this — prod never gets demo/dev fixtures.
 */
export function isStrictDevelopmentRuntime(env: Record<string, string | undefined> = process.env): boolean {
  return env.CINATRA_RUNTIME_MODE === "development" && env.NODE_ENV !== "production";
}

/**
 * Should the extension dev-fixtures dataset be seeded on this boot?
 *   demo ⇒ always; dev ⇒ only when `CINATRA_DEV_FIXTURES` is truthy; never in prod.
 *
 * Single source of truth for the activation decision: the dev boot phase gates
 * the seeder CALL on it, and `dev-fixture-seeder` self-guards on it too (defense
 * in depth), so no caller — present or future — can leak fixtures into a plain
 * dev boot or a prod instance.
 */
export function shouldSeedDevFixtures(env: Record<string, string | undefined> = process.env): boolean {
  if (!isStrictDevelopmentRuntime(env)) return false;
  return isDemoProfile(env) || isEnvFlagEnabled(env.CINATRA_DEV_FIXTURES);
}

/**
 * The pending-demo-seed decision (`cinatra install demo`, cinatra#1238 item 3).
 *
 * The monolithic `scripts/seed.mjs` demo dataset (ACME Group) INTENTIONALLY
 * no-ops until a HUMAN platform admin exists — it must never fabricate/promote
 * a machine admin, because the one-shot first-human admin slot belongs to the
 * first real registrant (cinatra#1135). So a demo install cannot seed the
 * monolithic dataset synchronously at setup time on a fresh DB (no admin yet).
 *
 * Instead the demo overlay seeds it LAZILY: on each strict-dev demo boot, once a
 * human admin has registered AND the one-shot has not already run, the seed
 * fires exactly once and a durable sentinel is recorded so it never re-runs.
 * This function is that pure gate (no IO) — the boot runner supplies the two
 * runtime facts (`humanAdminExists`, `alreadySeeded`) it reads from the DB.
 *
 * ALL of:
 *   - install profile is `demo` (`CINATRA_INSTALL_PROFILE=demo`),
 *   - strict development runtime (never prod, never a plain dev instance),
 *   - a human platform admin now exists (the seed's own precondition), and
 *   - the one-shot demo seed has not already completed.
 */
export function shouldRunDemoSeed(
  facts: { humanAdminExists: boolean; alreadySeeded: boolean },
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!isStrictDevelopmentRuntime(env)) return false;
  if (!isDemoProfile(env)) return false;
  return facts.humanAdminExists && !facts.alreadySeeded;
}
