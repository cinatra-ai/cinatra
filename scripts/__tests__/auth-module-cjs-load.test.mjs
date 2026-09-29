// src/lib/auth.ts — loads under the TypeScript loader the product's own
// commands run.
//
// Why: this package is CommonJS (no `"type": "module"`), so a command started
// with `node --import tsx` compiles every `src/**/*.ts` it reaches in CommonJS
// form. A module-level `await` has no CommonJS form — esbuild answers
// `Top-level await is currently not supported with the "cjs" output format` —
// so a module carrying one stops the command before it runs. The
// authentication module sits on that import graph (the development
// provisioning command reaches it through the skill-sync service, and the
// first-administrator step imports it directly), and it keeps its boot-time
// Google OAuth settings behind a lazy, memoised read for exactly that reason:
// Better Auth awaits the social-provider factory while it builds the auth
// context, so the settings are read once, before their first use, and the
// module itself stays free of a top-level `await`.
//
// What this file gates:
//   1) `src/lib/auth.ts` compiles AND evaluates under `node --import tsx` in
//      this package's CommonJS form, and Better Auth's context settles.
//   2) An install with no saved Google OAuth client registers no social
//      provider at all — the shape the lazy factory has to preserve.
//
// Hermetic: no database. With no `SUPABASE_DB_URL` in the child's environment
// the module takes its documented DB-unavailable arm (a warning, empty Google
// OAuth settings) and auth still constructs, so this needs nothing but Node,
// tsx and the `server-only` stub.
//
// Runner: hosted by the root vitest include glob
// `scripts/__tests__/**/*.test.{ts,mjs}`.

import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const AUTH_MODULE = path.join(REPO_ROOT, "src", "lib", "auth.ts");

// `server-only` throws the moment it is imported outside a React Server
// Component. `vitest.config.ts` aliases it to an empty stub; a plain Node
// process has no aliases, so the same redirection is installed on the
// CommonJS resolver — the EXACT request "server-only" resolves to that
// package's own `empty.js` (the file its `react-server` export condition
// points at), and nothing else is touched.
const SERVER_ONLY_SHIM = `const Module = require("node:module");
const path = require("node:path");
const indexPath = require.resolve("server-only", { paths: [${JSON.stringify(REPO_ROOT)}] });
const emptyPath = path.join(path.dirname(indexPath), "empty.js");
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === "server-only" ? emptyPath : resolveFilename.call(this, request, ...rest);
};
`;

// Awaiting `$context` is what makes this deterministic: Better Auth resolves
// the social-provider factories there, so the boot-time read has finished by
// the time the marker is printed.
const LOADER = `import { pathToFileURL } from "node:url";
const mod = await import(pathToFileURL(${JSON.stringify(AUTH_MODULE)}).href);
const context = await mod.auth.$context;
console.log("SOCIAL_PROVIDERS " + JSON.stringify(context.socialProviders.map((p) => p.id)));
console.log("AUTH_MODULE_LOADED");
`;

function loadAuthModuleUnderScriptsRuntime() {
  const dir = mkdtempSync(path.join(tmpdir(), "auth-cjs-load-"));
  const shim = path.join(dir, "server-only-shim.cjs");
  const loader = path.join(dir, "load-auth.mjs");
  writeFileSync(shim, SERVER_ONLY_SHIM);
  writeFileSync(loader, LOADER);

  const env = { ...process.env, BETTER_AUTH_SECRET: "auth-module-cjs-load-test-secret" };
  // Deliberately absent: the DB-unavailable arm is the one this test drives,
  // and dropping it here keeps the run identical on a developer machine that
  // happens to export a database URL.
  delete env.SUPABASE_DB_URL;
  delete env.NEXT_PHASE;

  try {
    return spawnSync(process.execPath, ["--import", "tsx", "--require", shim, loader], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env,
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("src/lib/auth.ts under the scripts' TypeScript loader", () => {
  // One child process for both assertions: the load costs a few seconds and
  // both questions are answered by the same run.
  let result;
  beforeAll(() => {
    result = loadAuthModuleUnderScriptsRuntime();
  }, 180_000);

  it("loads in this package's CommonJS form and settles Better Auth's context", () => {
    expect(result.error).toBeUndefined();
    // Named explicitly: this is the compiler's answer to a module-level
    // `await`, and it is what a regression here would look like.
    expect(result.stderr).not.toContain(
      'Top-level await is currently not supported with the "cjs" output format',
    );
    expect(result.status, `stderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("AUTH_MODULE_LOADED");
  });

  it("registers no social provider when no Google OAuth client is saved", () => {
    expect(result.status, `stderr:\n${result.stderr}`).toBe(0);
    const line = result.stdout.split("\n").find((l) => l.startsWith("SOCIAL_PROVIDERS "));
    expect(line, `stdout:\n${result.stdout}`).toBeDefined();
    expect(JSON.parse(line.slice("SOCIAL_PROVIDERS ".length))).toEqual([]);
  });
});
