#!/usr/bin/env node
// THE shared compose-scoping step for every entry point that starts the dev
// stack (cinatra#2839).
//
// Why this file exists: the port derivation used to live only in the `pnpm dev`
// launcher, so `make dev` and `pnpm services` brought the stack up on the
// compose files' fixed defaults and the launcher then reconciled the SAME
// project onto derived ports afterwards. Whichever ran first decided what got
// published, which is not a scoping scheme — it is a race. All three entry
// points now read their scoping from here:
//
//   Makefile `dev`          → eval "$(node scripts/dev-compose-env.mjs)"
//   package.json `services` → eval "$(node scripts/dev-compose-env.mjs)"
//   scripts/dev-server.mjs  → imports the same resolvers directly
//
// Output is shell `export` lines on stdout, so it composes with `eval` in a
// Makefile recipe or an npm script. Operator-facing notes go to STDERR so they
// never land inside the `eval`.
//
//   --json                emit the resolved plan as JSON instead (introspection;
//                         used by the tests, never exits non-zero)
//   --require-manageable  additionally REFUSE when this lane stands a service
//                         down. Passed by the entry points that run a
//                         WHOLE-STACK `docker compose up` (see below).
//
// EXIT STATUS IS PART OF THE CONTRACT. A plan this step cannot resolve — a named
// lane with no host port for a scoped service, an unusable override, a companion
// port that overflows — exits non-zero and prints NOTHING on stdout, so the
// recipe's `&&` chain never reaches `docker compose up`. That only works if the
// caller propagates it: `eval "$(node scripts/dev-compose-env.mjs)"` does NOT
// (eval of an empty string succeeds), so every entry point assigns first and
// evals second:
//
//   CINATRA_COMPOSE_ENV="$(node scripts/dev-compose-env.mjs …)" && eval "$CINATRA_COMPOSE_ENV" && docker compose … up -d
//
// A bare assignment carries the exit status of its command substitution, so a
// refusal stops the chain there.
//
// SCOPE LIMIT (cinatra#2845/#2849): only nango-server, nango-connect, nango-db
// and redis are parameterized. A second lane running a WHOLE-STACK bring-up
// still collides on the stack's other fixed host ports — wayflow 3010,
// verdaccio 4873, postgres 5434, neo4j, graphiti. That is stated here because
// package.json cannot carry a comment; the `Makefile` dev target says the same.
//
// On a checkout that states no COMPOSE_PROJECT_NAME the exported ports are the
// HISTORICAL DEFAULTS (3003/3009/5435/6379) and no COMPOSE_PROJECT_NAME line is
// emitted at all: that is the main checkout, and compose renders exactly what it
// rendered before — verified by rendering `docker compose config` with and
// without this step on an unconfigured checkout and diffing. Derivation from a
// service URL happens only for a named project (see resolveComposeHostPortPlan),
// so a main checkout whose REDIS_URL names some other loopback port still
// publishes 6379.

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPOSE_PROJECT_ENV_VAR,
  formatStandDownRefusal,
  formatUnmanagedServices,
  isLinkedWorktree,
  planMessages,
  readEnvFileValue,
  resolveComposeHostPortPlan,
  resolveComposeProjectName,
} from "./lib/dev-preflight.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The cwd's `.env.local` first (a worktree lane launched from its own dir),
// then the repo root's. Identical when they are the same directory.
const envFiles = [path.join(process.cwd(), ".env.local"), path.join(repoRoot, ".env.local")].filter(
  (file, i, all) => all.indexOf(file) === i,
);

const lookupEnvFiles = (key) => {
  for (const file of envFiles) {
    const value = readEnvFileValue(file, key);
    if (value !== undefined) return value;
  }
  return undefined;
};

const projectName = resolveComposeProjectName({
  processEnv: process.env,
  envFileValues: [lookupEnvFiles(COMPOSE_PROJECT_ENV_VAR)],
});

const plan = resolveComposeHostPortPlan({
  processEnv: process.env,
  envFileLookup: lookupEnvFiles,
  projectName,
  // Compose composes from the checkout root (every `-f` in the Makefile,
  // package.json and scripts/setup.sh is relative and none pass `-p`), so this
  // is the project name it would derive on its own — the operator's own stack.
  // Naming THAT project is a no-op pin, not a second lane; see `laneScope`.
  defaultProjectName: repoRoot,
  // …but only from the MAIN checkout. A linked worktree named after its own
  // basename passed that test too, so it took the operator's leniency and
  // published the shared defaults; it is a second stack by construction. Probed
  // here — the same input the launcher passes, so the two plans stay identical.
  linkedWorktree: isLinkedWorktree(repoRoot),
});

const fail = (lines) => {
  for (const line of lines) process.stderr.write(`[dev-compose-env] ✖ ${line}\n`);
  process.exit(1);
};

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify({ projectName, ...plan }, null, 2)}\n`);
} else {
  // A plan with a hole in it is never papered over with the shared default:
  // stdout stays EMPTY and the exit status stops the caller's `&&` chain.
  if (plan.refusals.length > 0) fail(planMessages(plan.refusals));

  // The whole-stack entry points cannot honor a per-service stand-down — `up -d`
  // over the whole file starts the service anyway, on the compose default — so
  // for them the stand-down is enforced by not running at all.
  if (
    plan.unmanaged.length > 0 &&
    plan.laneScope === "lane" &&
    process.argv.includes("--require-manageable")
  ) {
    fail([formatStandDownRefusal({ unmanaged: plan.unmanaged })]);
  }

  for (const line of planMessages(plan.warnings)) {
    process.stderr.write(`[dev-compose-env] ⚠ ${line}\n`);
  }

  const lines = [];
  // Docker reads COMPOSE_PROJECT_NAME from its own process env but NOT from
  // `.env.local` — which is exactly where a worktree lane records it — so the
  // shared step is also what makes `make dev` and `pnpm services` act on the
  // lane's project instead of the checkout directory's basename.
  if (projectName) lines.push([COMPOSE_PROJECT_ENV_VAR, projectName]);
  for (const [key, value] of Object.entries(plan.portEnv)) lines.push([key, value]);
  process.stdout.write(
    lines.map(([k, v]) => `export ${k}='${String(v).replace(/'/g, `'\\''`)}'`).join("\n") +
      (lines.length ? "\n" : ""),
  );

  // Per-service, not all-or-nothing: a service configured somewhere else simply
  // gets no host port from us. Reached only when the caller did NOT pass
  // --require-manageable (the launcher's own path, which honors a stand-down
  // per service with `--no-deps`) or when this is the checkout's own project
  // rather than a second lane — say plainly what a whole-stack up would do.
  if (plan.unmanaged.length > 0) {
    process.stderr.write(
      `[dev-compose-env] ⚠ not claiming a host port for: ${formatUnmanagedServices(plan.unmanaged)} — ` +
        `not an explicit-port loopback URL, so that service is not this checkout's to publish. ` +
        `Starting it here anyway would publish the compose default.\n`,
    );
  }
}
