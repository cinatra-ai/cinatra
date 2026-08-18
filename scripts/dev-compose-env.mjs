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
//   --json   emit the resolved plan as JSON instead (used by the tests)
//
// Emits NOTHING when the checkout states no COMPOSE_PROJECT_NAME and no
// explicit override: that is the main checkout, and its behavior is unchanged.

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPOSE_PROJECT_ENV_VAR,
  formatUnmanagedServices,
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
});

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify({ projectName, ...plan }, null, 2)}\n`);
} else {
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
  // gets no host port from us. Entry points that bring the WHOLE stack up can
  // still start it — they are not the preflight — so say plainly that if they
  // do, it lands on the compose default.
  if (plan.unmanaged.length > 0) {
    process.stderr.write(
      `[dev-compose-env] not claiming a host port for: ${formatUnmanagedServices(plan.unmanaged)} — ` +
        `not an explicit-port loopback URL, so that service is not this checkout's to publish. ` +
        `Starting it here anyway would publish the compose default.\n`,
    );
  }
}
