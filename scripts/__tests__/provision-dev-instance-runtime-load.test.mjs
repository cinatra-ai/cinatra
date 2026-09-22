/**
 * THE PROVISIONING COMMAND'S MODULES, LOADED IN THE COMMAND'S OWN RUNTIME.
 *
 * `pnpm provision:dev-instance` runs in a plain Node process under
 * `--conditions=react-server`. Under that condition `next/navigation` evaluates
 * `React.createContext` at load time, and the react-server build of React has
 * no such export — so a module that reaches a route-level barrel cannot be
 * loaded by this command at all. The failure is a module-load error that names
 * React and nothing else, and it takes down every road in the file it lands in,
 * including the roads that never needed the module.
 *
 * THE UNIT TIER CANNOT SEE THIS. It aliases `server-only`, resolves the graph
 * through the test runner, and never applies the react-server condition, so the
 * command's graph loads there whatever it does in the real invocation. The only
 * instrument that can tell the two apart is a PROCESS started with the
 * command's own flags — which is what these arms are.
 *
 * NO DATABASE, DELIBERATELY. What broke was LOADABILITY, and loadability is
 * what these arms assert. The command's behaviour against real rows is the
 * dedicated real-database tier's subject; no workflow gives this tier a
 * Postgres, so a database arm here would only ever skip.
 *
 * Runner: hosted by the root vitest include glob `scripts/__tests__/**\/*.test.{ts,mjs}`.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const COMMAND_SCRIPT = "provision-dev-instance.mjs";

/**
 * The node flags the command actually runs under, READ FROM THE SCRIPT rather
 * than restated here. A test that hard-coded them would keep passing after the
 * invocation changed, which is the one thing it must not do.
 */
function commandRuntimeFlags() {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const script = pkg.scripts?.["provision:dev-instance"];
  if (typeof script !== "string") {
    throw new Error("the provision:dev-instance script is missing from package.json");
  }
  const tokens = script.split(/\s+/).filter(Boolean);
  const entry = tokens.findIndex((token) => token.endsWith(COMMAND_SCRIPT));
  if (tokens[0] !== "node" || entry < 1) {
    throw new Error(`could not read the command's node flags from: ${script}`);
  }
  return tokens.slice(1, entry);
}

/** Import each specifier in one process under the command's own flags. */
function importInCommandRuntime(specifiers) {
  const source = specifiers.map((s) => `await import(${JSON.stringify(s)});`).join("\n");
  return spawnSync(
    process.execPath,
    [...commandRuntimeFlags(), "--input-type=module", "--eval", source],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 300_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

/**
 * The child's complaint, as ONE line and without its stack frames.
 *
 * An assertion message becomes part of the thrown error's `stack`, and a
 * reporter reads that stack back as frames — so pasting a child process's
 * frames in makes the reporter try to resolve file positions that belong to
 * another process, and it fails while printing the failure rather than
 * printing it. The complaint itself is what a reader needs anyway.
 */
function loadFailureDigest(stderr) {
  return stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 && !line.startsWith("at ") && !line.includes("sourceMappingURL"),
    )
    .slice(0, 6)
    .join(" | ")
    .slice(0, 400);
}

function expectCleanLoad(result, what) {
  const digest = loadFailureDigest(result.stderr ?? "");
  // Named explicitly: this is the signature of the fault, and a bare exit code
  // would send the next reader looking in the wrong place.
  expect(
    result.stderr ?? "",
    `${what} did not LOAD under the command's runtime — ${digest}`,
  ).not.toMatch(/createContext/);
  expect(result.status, `${what} — ${digest}`).toBe(0);
}

describe("the provisioning command's provider leg, in the command's own runtime", () => {
  it(
    "loads the provider module itself",
    () => {
      expectCleanLoad(
        importInCommandRuntime([
          "./src/lib/dev-instance-provisioning/provision-provider-connection.ts",
        ]),
        "the provider module",
      );
    },
    300_000,
  );

  it(
    "loads every module the environment-bootstrap road reaches WHILE IT RUNS",
    () => {
      // The road imports these at the point of use rather than at load time, so
      // one of them failing to load breaks the LIVE run and nothing earlier —
      // exactly the shape that reached an operator instead of a test. They are
      // listed because that is the only way an arm without a database can walk
      // the road's run-time graph at all.
      expectCleanLoad(
        importInCommandRuntime([
          "./src/lib/setup-provider-commit.ts",
          "./src/lib/setup-readiness-saga.ts",
          "./src/lib/boot/phases/provider-connection-bootstrap.ts",
          "./src/lib/openai-connection-store.ts",
          "./src/lib/database-metadata.ts",
          "./src/lib/connector-config-secret-fields.ts",
          "./src/lib/llm-credential-fingerprint.ts",
          "./src/lib/admin/default-llm-provider-mutation.ts",
        ]),
        "the environment-bootstrap road's run-time modules",
      );
    },
    300_000,
  );
});
