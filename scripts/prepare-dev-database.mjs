#!/usr/bin/env node
// Prepare a development database without starting the application. Keep the
// real writers in their required order: Better Auth -> store baseline -> the
// published CLI's versioned migration command (the same entry as db:migrate).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertDeclaredDevelopmentRuntime } from "../src/lib/dev-instance-provisioning/runtime-gate.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prefix = "[prepare:dev-database]";

async function prepare() {
  // Before configuration values are consumed or any database module is loaded.
  assertDeclaredDevelopmentRuntime("prepare:dev-database");
  if (process.argv.slice(2).some((argument) => argument !== "--")) {
    throw new Error("No arguments are accepted; use the existing database and authentication environment configuration.");
  }
  if (!process.env.SUPABASE_DB_URL?.trim()) {
    throw new Error("SUPABASE_DB_URL is required; select a development database before preparing it.");
  }
  if (!process.env.BETTER_AUTH_SECRET?.trim()) {
    throw new Error("BETTER_AUTH_SECRET is required; supply it through the existing secret environment.");
  }

  await runStep("auth migration", async () => {
    const { runBetterAuthMigration } = await import("./better-auth-migrate.mts");
    await runBetterAuthMigration({
      connectionString: process.env.SUPABASE_DB_URL,
      secret: process.env.BETTER_AUTH_SECRET,
      baseURL: process.env.BETTER_AUTH_URL,
    });
  });

  await runStep("base schema", async () => {
    const { ensurePostgresSchema } = await import("../src/lib/postgres-schema-init.ts");
    ensurePostgresSchema();
  });

  await runStep("db:migrate", async () => {
    // Resolve the pinned, already-installed CLI exactly as package.json's
    // db:migrate does. No shell expansion and no credentials in argv. Capture
    // diagnostics instead of forwarding arbitrary driver output with a DSN.
    const result = spawnSync(process.execPath, [
      path.join(root, "node_modules/@cinatra-ai/cinatra/bin/cinatra.mjs"),
      "instance", "db", "migrate",
    ], {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) throw new Error("migration command failed");
  });
  console.log(`${prefix} Database ready for provision:dev-instance; no application boot was needed.`);
}

async function runStep(name, run) {
  try {
    await run();
  } catch {
    // Driver errors may contain connection credentials. Report the failing
    // phase without echoing the environment, a raw exception, or its cause.
    throw new Error(`${name} failed; preparation stopped. Check the development database configuration and that phase's prerequisites before retrying.`);
  }
  console.log(`${prefix} ${name} complete.`);
}

try {
  await prepare();
} catch (error) {
  console.error(`${prefix} ${error.message}`);
  process.exitCode = 1;
}
