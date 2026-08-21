// Required-environment PREFLIGHT (cinatra#789 item 3).
//
// A prod deploy must FAIL CLEARLY + EARLY on a missing required env — naming the
// missing var(s) — rather than dying with a confusing downstream error (or, worse,
// booting "healthy" while a fail-closed subsystem silently 403s every request).
//
// WHY AN IMPORT-TIME PREFLIGHT (not a boot phase): the boot PHASES run inside
// `register()`, but `instrumentation.node.ts` evaluates its STATIC DI-wiring
// imports at module load — BEFORE `register()`. Several of those binders reach
// env-sensitive modules (e.g. `@/lib/auth` throws at import on a missing
// `BETTER_AUTH_SECRET`), so a boot phase can never be the FIRST thing to catch a
// missing hard var, nor AGGREGATE all missing vars into one message. This module is
// imported (side-effect) as the FIRST line of instrumentation.node.ts's import
// block, so it runs before every other binder and can report the full set at once.
//
// SCOPE GUARD (load-bearing): the preflight only ARMS in APP RUNTIME PRODUCTION and
// only OUTSIDE the Next.js `next build` page-data phase. The Docker image build runs
// with `NODE_ENV=production` but deliberately does NOT provide these secrets (they
// are injected at deploy time), and Next spawns build workers that evaluate
// `instrumentation.node.ts`; keying off `NODE_ENV` would break the image build.
// We therefore key off the app's own `CINATRA_RUNTIME_MODE`/`APP_RUNTIME_MODE`
// (`getAppRuntimeMode()`) AND skip `NEXT_PHASE === "phase-production-build"`.
//
// IT ALSO CARRIES THE MEASURED DEPLOYMENT REQUIREMENTS (cinatra#2754). Not every
// deployment requirement is an environment variable: some are properties of the
// shipped code that a deployment must be able to rely on. Those live in
// `@/lib/boot/deployment-invariants`, are MEASURED (executed, never declared) in
// the same pass as the vars, and abort a prod boot exactly as a missing hard var
// does.
//
// Two severities:
//   - HARD: a missing var THROWS (aborts boot). The app genuinely cannot serve
//     without it. SUPABASE_DB_URL, BETTER_AUTH_SECRET, CINATRA_ENCRYPTION_KEY.
//     CINATRA_ENCRYPTION_KEY is additionally validated to DECODE to 32 bytes (the
//     same hex/base64 disambiguation instance-secrets.ts enforces at use time) so a
//     malformed key fails at boot, not at the first secret op.
//   - SOFT: a missing var WARNS clearly but does NOT abort. Needed for a WayFlow
//     deploy (CINATRA_BRIDGE_TOKEN — WayFlow bridge callbacks fail-closed 403
//     without it) but a deploy WITHOUT WayFlow boots fine and the UI serves.
//
// Deliberately NOT importing "server-only": vitest unit tests import this module.

import { getAppRuntimeMode } from "@/lib/runtime-mode";
// cinatra#2754 — the MEASURED deployment requirements. A missing env var and an
// unmet security requirement are the same class of problem at boot: the
// deployment is not configured the way the app requires, and it must say so
// loudly here rather than serve as if it were.
import {
  checkDeploymentInvariants,
  DEPLOYMENT_INVARIANTS,
  formatDeploymentInvariantFailureMessage,
  type DeploymentInvariant,
  type DeploymentInvariantFailure,
} from "@/lib/boot/deployment-invariants";

/** A hard-required var whose absence (or malformed value) aborts a prod boot. */
type HardVar = {
  name: string;
  why: string;
  /** Optional value validator; returns an error string when the value is malformed. */
  validate?: (raw: string) => string | null;
};

/** A soft-required var whose absence WARNS but does not abort. */
type SoftVar = { name: string; why: string };

const KEY_BYTES = 32;

/**
 * Validate CINATRA_ENCRYPTION_KEY decodes to exactly 32 bytes, mirroring
 * instance-secrets.ts getKey(): a 64-char all-hex string is hex, otherwise base64.
 * Returns an error string when malformed, or null when valid.
 */
export function validateEncryptionKey(raw: string): string | null {
  const buf = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");
  if (buf.length !== KEY_BYTES) {
    return `must decode to ${KEY_BYTES} bytes (got ${buf.length}) — a 64-char hex string or a base64 32-byte value`;
  }
  return null;
}

export const HARD_REQUIRED_ENV: readonly HardVar[] = [
  {
    name: "SUPABASE_DB_URL",
    why: "the Postgres connection string; without it the app cannot run migrations or serve any data",
  },
  {
    name: "BETTER_AUTH_SECRET",
    why: "signs auth sessions; without it every authenticated request fails",
  },
  {
    name: "CINATRA_ENCRYPTION_KEY",
    why: "encrypts instance/connector secrets (AES-256-GCM); without it secret storage cannot operate",
    validate: validateEncryptionKey,
  },
] as const;

export const SOFT_REQUIRED_ENV: readonly SoftVar[] = [
  {
    name: "CINATRA_BRIDGE_TOKEN",
    why: "authenticates WayFlow bridge callbacks (fail-closed 403 when unset); required for a deploy that runs the WayFlow agent runtime",
  },
] as const;

export type EnvPreflightReport = {
  /** Hard vars that are missing or malformed, with the actionable reason. */
  hardFailures: { name: string; reason: string }[];
  /** Soft vars that are missing (warn-only). */
  softMissing: { name: string; why: string }[];
  /**
   * MEASURED deployment requirements that did not hold (cinatra#2754). Same
   * severity as a hard var: a prod boot aborts. Absent (empty) when the
   * preflight no-ops outside app-runtime production.
   */
  invariantFailures: DeploymentInvariantFailure[];
};

/** A read-only env bag: a supertype of NodeJS.ProcessEnv for the reads we do here. */
export type EnvBag = Record<string, string | undefined>;

/**
 * PURE check (no env mutation, no throw). Given an env bag, classify hard/soft
 * required-var problems. Exported for unit testing.
 */
export function checkRequiredEnv(
  env: EnvBag,
  invariants: readonly DeploymentInvariant[] = DEPLOYMENT_INVARIANTS,
): EnvPreflightReport {
  const hardFailures: { name: string; reason: string }[] = [];
  for (const v of HARD_REQUIRED_ENV) {
    const raw = env[v.name];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value) {
      hardFailures.push({ name: v.name, reason: `missing — ${v.why}` });
      continue;
    }
    if (v.validate) {
      const err = v.validate(value);
      if (err) hardFailures.push({ name: v.name, reason: `${err} — ${v.why}` });
    }
  }
  const softMissing: { name: string; why: string }[] = [];
  for (const v of SOFT_REQUIRED_ENV) {
    const raw = env[v.name];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value) softMissing.push({ name: v.name, why: v.why });
  }
  // The MEASURED requirements run in the same pass (cinatra#2754). They read no
  // env — they execute the shipped code and check what it actually does — so
  // they are reported here beside the vars rather than in a second place an
  // operator would have to know to look at.
  return {
    hardFailures,
    softMissing,
    invariantFailures: checkDeploymentInvariants(invariants),
  };
}

/** Build the loud multi-line abort message for the hard failures. */
export function formatHardFailureMessage(
  hardFailures: readonly { name: string; reason: string }[],
): string {
  const lines = hardFailures.map((f) => `  - ${f.name}: ${f.reason}`);
  return (
    `[required-env-preflight] ${hardFailures.length} required environment variable(s) are missing or ` +
    `invalid — refusing to boot (a prod deploy must provision these):\n${lines.join("\n")}`
  );
}

export type RunPreflightDeps = {
  env?: EnvBag;
  /** Only arm in app-runtime production. Injectable for tests. */
  isProd?: () => boolean;
  /** Skip during `next build` page-data collection. Injectable for tests. */
  isBuildPhase?: () => boolean;
  logWarn?: (msg: string) => void;
  logInfo?: (msg: string) => void;
  /** The measured deployment requirements. Injectable so a test can prove the
   *  abort path without having to break the shipped redactor to do it. */
  invariants?: readonly DeploymentInvariant[];
};

/**
 * Arm the preflight: THROW on any hard failure, WARN on any soft-missing var.
 * No-op outside app-runtime production or during the Next build phase (the image
 * build runs NODE_ENV=production without the deploy secrets — see module header).
 *
 * Returns the report (also when it no-ops, with a note in the fields being empty)
 * so tests can assert the decision without relying on process.exit.
 */
export function runRequiredEnvPreflight(deps: RunPreflightDeps = {}): EnvPreflightReport {
  const {
    env = process.env,
    isProd = () => getAppRuntimeMode() === "production",
    isBuildPhase = () => env.NEXT_PHASE === "phase-production-build",
    logWarn = (msg) => console.warn(msg),
    logInfo = (msg) => console.info(msg),
    invariants = DEPLOYMENT_INVARIANTS,
  } = deps;

  const empty: EnvPreflightReport = {
    hardFailures: [],
    softMissing: [],
    invariantFailures: [],
  };

  // Only enforce for the app's PRODUCTION RUNTIME, never during the image build.
  if (isBuildPhase() || !isProd()) return empty;

  const report = checkRequiredEnv(env, invariants);

  if (report.hardFailures.length > 0) {
    throw new Error(formatHardFailureMessage(report.hardFailures));
  }

  // A MEASURED deployment requirement that does not hold aborts the boot too
  // (cinatra#2754). It is reported AFTER the env set so an operator who is
  // missing both sees the vars first — those are the ones they can fix by
  // provisioning — but it is just as fatal: the alternative is an instance
  // serving traffic while a security requirement it claims to meet does not
  // hold.
  if (report.invariantFailures.length > 0) {
    throw new Error(formatDeploymentInvariantFailureMessage(report.invariantFailures));
  }

  for (const s of report.softMissing) {
    logWarn(
      `[required-env-preflight] ${s.name} is not set — ${s.why}. The app will boot, but the dependent ` +
        `feature is unavailable until it is provisioned.`,
    );
  }
  if (report.softMissing.length === 0) {
    logInfo("[required-env-preflight] all required environment variables present.");
  }
  return report;
}
