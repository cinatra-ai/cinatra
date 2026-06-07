// Resolver-bypass regression coverage.
//
// Asserts:
//   1. Every publishAgentPackage / publishAgentPackageFromGitDir call in production code
//      is preceded (within ~80 lines) by resolvePublishDestination.
//   2. Every installAgentPackageWithDependencies call in production code is preceded
//      (within ~80 lines) by resolveInstallEnvironment.
//   3. No ad-hoc DeploymentRegistryConfig literals exist outside __fixtures__ and test files.
//
// Implementation note: uses grep -r (not rg) because rg is a Claude Code shell alias
// that wraps the CLI binary and is not available inside vitest's execSync environment.

import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dirname, "../../../..");

// ---------------------------------------------------------------------------
// Source code search helper (grep, ts files only, excludes tests)
// ---------------------------------------------------------------------------
function grepRecursive(pattern: string, paths: string[]): string {
  try {
    const pathArgs = paths.map((p) => `"${join(PROJECT_ROOT, p)}"`).join(" ");
    return execSync(
      `grep -rn --include='*.ts' --exclude-dir=__tests__ --exclude='*.test.ts' --exclude-dir=tests '${pattern}' ${pathArgs} 2>/dev/null || true`,
      { encoding: "utf8", cwd: PROJECT_ROOT },
    );
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Resolver-presence checker: reads each file containing the call pattern and
// checks that the resolver pattern appears within lookbackLines lines before
// the call. Returns a list of violations: "file:line" strings.
// ---------------------------------------------------------------------------
function findResolverBypassViolations(
  callPattern: RegExp,
  resolverPattern: RegExp,
  searchPaths: string[],
  lookbackLines = 80,
  // Files where the call is in the definition itself (not a caller) are expected
  // to have no resolver before them and should be excluded.
  definitionFileGlob?: string,
): string[] {
  // grep for files containing the call pattern
  const rawGrepPaths = searchPaths.map((p) => `"${join(PROJECT_ROOT, p)}"`).join(" ");
  let filesOutput: string;
  try {
    filesOutput = execSync(
      `grep -rln --include='*.ts' --exclude-dir=__tests__ --exclude='*.test.ts' '${callPattern.source}' ${rawGrepPaths} 2>/dev/null || true`,
      { encoding: "utf8", cwd: PROJECT_ROOT },
    );
  } catch {
    return [];
  }

  const files = filesOutput.split("\n").filter((f) => f.trim());
  const violations: string[] = [];

  for (const filePath of files) {
    // Skip definition files where the function is declared, not called.
    if (definitionFileGlob && filePath.includes(definitionFileGlob)) continue;

    const content = readFileSync(filePath.trim(), "utf8");
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      // Found a call site
      if (callPattern.test(lines[i]) && !lines[i].trim().startsWith("//") && !lines[i].trim().startsWith("*")) {
        // Look back up to lookbackLines for the resolver pattern.
        const start = Math.max(0, i - lookbackLines);
        let resolverFound = false;
        for (let j = start; j < i; j++) {
          if (resolverPattern.test(lines[j])) {
            resolverFound = true;
            break;
          }
        }
        if (!resolverFound) {
          violations.push(`${filePath.trim()}:${i + 1}`);
        }
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------
const PUBLISH_AGENT_PACKAGE_CALL = /\bawait publishAgentPackage\b/;
const PUBLISH_AGENT_PACKAGE_FROM_GIT_CALL = /\bawait publishAgentPackageFromGitDir\b/;
const INSTALL_DEP_CALL = /\bawait installAgentPackageWithDependencies\b/;
const RESOLVE_PUBLISH_PATTERN = /\bresolvePublishDestination\b/;
const RESOLVE_INSTALL_PATTERN = /\bresolveInstallEnvironment\b/;

const SEARCH_PATHS = ["src", "packages"];

// ---------------------------------------------------------------------------
// Regression tests
// ---------------------------------------------------------------------------

describe("resolver bypass regression", () => {
  // -------------------------------------------------------------------------
  // Publish calls must be preceded by resolvePublishDestination.
  // -------------------------------------------------------------------------
  it("every publishAgentPackage call routes through resolvePublishDestination", () => {
    const violations = findResolverBypassViolations(
      PUBLISH_AGENT_PACKAGE_CALL,
      RESOLVE_PUBLISH_PATTERN,
      SEARCH_PATHS,
      80,
      // Exclude the verdaccio/client.ts definition file
      "verdaccio/client.ts",
    );

    // Report all violations for easier debugging
    const message = violations.length > 0
      ? `publishAgentPackage called without preceding resolvePublishDestination at:\n  ${violations.join("\n  ")}`
      : "";
    expect(violations, message).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Git-directory publish calls must be preceded by resolvePublishDestination.
  // -------------------------------------------------------------------------
  it("every publishAgentPackageFromGitDir call routes through resolvePublishDestination", () => {
    const violations = findResolverBypassViolations(
      PUBLISH_AGENT_PACKAGE_FROM_GIT_CALL,
      RESOLVE_PUBLISH_PATTERN,
      SEARCH_PATHS,
      80,
      "verdaccio/client.ts",
    );

    const message = violations.length > 0
      ? `publishAgentPackageFromGitDir called without preceding resolvePublishDestination at:\n  ${violations.join("\n  ")}`
      : "";
    expect(violations, message).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Dependency installs must be preceded by resolveInstallEnvironment.
  // -------------------------------------------------------------------------
  it("every installAgentPackageWithDependencies call routes through resolveInstallEnvironment", () => {
    const violations = findResolverBypassViolations(
      INSTALL_DEP_CALL,
      RESOLVE_INSTALL_PATTERN,
      SEARCH_PATHS,
      80,
      // Exclude the install-from-package.ts definition file
      "install-from-package.ts",
    );

    const message = violations.length > 0
      ? `installAgentPackageWithDependencies called without preceding resolveInstallEnvironment at:\n  ${violations.join("\n  ")}`
      : "";
    expect(violations, message).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // DeploymentRegistryConfig constants belong only in fixtures or tests.
  // -------------------------------------------------------------------------
  it("DEPLOYMENT_REGISTRY_CONFIG_FIXTURE is the sole DeploymentRegistryConfig constant in non-test code", () => {
    const output = grepRecursive(
      "const [A-Za-z_]*:.*DeploymentRegistryConfig.*=",
      SEARCH_PATHS,
    );
    const lines = output
      .split("\n")
      .filter((l) => l.trim())
      .filter((l) => !l.includes("__fixtures__"))
      .filter((l) => !l.includes("__tests__"))
      .filter((l) => !l.includes(".test.ts"));
    expect(lines.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // resolvePublishDestination is called by publish path callers.
  // -------------------------------------------------------------------------
  it("resolvePublishDestination is called by production publish code", () => {
    const output = grepRecursive("resolvePublishDestination", SEARCH_PATHS);
    const callerLines = output
      .split("\n")
      .filter((l) => l.trim())
      // Exclude import lines and the declaration file itself
      .filter((l) => !l.includes("import "))
      .filter((l) => !l.includes("destination-resolver.ts"))
      .filter((l) => !l.includes(".test.ts"));
    // Should have at least 3 call sites (actions.ts, mcp/handlers.ts x2, import-agent-core.ts)
    expect(callerLines.length).toBeGreaterThanOrEqual(3);
  });

  // -------------------------------------------------------------------------
  // resolveInstallEnvironment is called by install path callers.
  // -------------------------------------------------------------------------
  it("resolveInstallEnvironment is called by production install code", () => {
    const output = grepRecursive("resolveInstallEnvironment", SEARCH_PATHS);
    const callerLines = output
      .split("\n")
      .filter((l) => l.trim())
      .filter((l) => !l.includes("import "))
      .filter((l) => !l.includes("destination-resolver.ts"))
      .filter((l) => !l.includes(".test.ts"));
    // Should have at least 3 call sites (actions.ts install, actions.ts update, extension-handler.ts)
    expect(callerLines.length).toBeGreaterThanOrEqual(3);
  });
});
