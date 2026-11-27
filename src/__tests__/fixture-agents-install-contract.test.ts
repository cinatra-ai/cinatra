/**
 * Every agent package under tests/fixtures must pass the checks the host makes
 * before it installs an agent package from disk.
 *
 * The import path refuses a package whose top-level Flow has a visible input
 * with no default that the start step does not declare required, or a model
 * step the run does not read (`scanOasForInstallFindings`, called with the
 * package's own name as the installer does). The runtime refuses a package
 * whose published marker does not match the definition bytes. Two fixtures
 * were committed with an empty start-step `metadata` and could not be
 * installed; this test finds every fixture package on disk so a new one cannot
 * repeat that.
 *
 *   npx vitest run src/__tests__/fixture-agents-install-contract.test.ts
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { scanOasForInstallFindings } from "../../packages/agents/src/validate-oas-runtime-invariants";

const FIXTURES_ROOT = join(__dirname, "..", "..", "tests", "fixtures");

/**
 * Packages the host never installs, with the visible inputs they leave
 * undeclared. The works-after harness mounts the echo fixture straight on the
 * runtime (scripts/ci/works-after/wayflow.sh), so the import path never reads
 * it. The entry is exact: it fails when the package gains or loses a finding.
 */
const NOT_INSTALLED_BY_THE_HOST: Record<string, readonly string[]> = {
  "@cinatra-works-after/echo-proof": ["echo_nonce"],
};

/** Every directory under tests/fixtures that holds `cinatra/oas.json`. */
function findAgentPackageRoots(dir: string): string[] {
  const found: string[] = [];
  if (existsSync(join(dir, "cinatra", "oas.json"))) found.push(dir);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules") continue;
    found.push(...findAgentPackageRoots(join(dir, entry.name)));
  }
  return found;
}

const packageRoots = findAgentPackageRoots(FIXTURES_ROOT).sort();

function readPackage(root: string) {
  const oasBytes = readFileSync(join(root, "cinatra", "oas.json"));
  const oas = JSON.parse(oasBytes.toString("utf8")) as Record<string, unknown>;
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string };
  const marker = JSON.parse(readFileSync(join(root, ".cinatra-published.json"), "utf8")) as {
    packageName: string;
    oasSha256: string;
  };
  return { oasBytes, oas, name: pkg.name, marker };
}

/** The input titles the import path would refuse this package for. */
function refusedInputTitles(oas: Record<string, unknown>, packageName: string): string[] {
  return scanOasForInstallFindings(oas, packageName)
    .map((finding) => /visible Flow input "([^"]+)"/.exec(finding.message)?.[1] ?? finding.message)
    .sort();
}

describe("agent packages under tests/fixtures", () => {
  it("finds a package in every *-agent fixture directory", () => {
    const agentDirs = readdirSync(FIXTURES_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.endsWith("-agent"))
      .map((entry) => entry.name);
    expect(agentDirs.length).toBeGreaterThan(0);
    for (const dir of agentDirs) {
      const found = packageRoots.filter((root) => relative(FIXTURES_ROOT, root).split(sep)[0] === dir);
      expect(`${dir}: ${found.length > 0 ? "found" : "no package"}`).toBe(`${dir}: found`);
    }
    const names = packageRoots.map((root) => readPackage(root).name);
    for (const name of Object.keys(NOT_INSTALLED_BY_THE_HOST)) expect(names).toContain(name);
  });

  for (const root of packageRoots) {
    const label = relative(FIXTURES_ROOT, root);

    it(`${label}: the published marker matches the definition bytes`, () => {
      const { oasBytes, name, marker } = readPackage(root);
      expect(marker.packageName).toBe(name);
      expect(marker.oasSha256).toBe(createHash("sha256").update(oasBytes).digest("hex"));
    });

    it(`${label}: every visible input has a default or is declared required`, () => {
      const { oas, name } = readPackage(root);
      expect(refusedInputTitles(oas, name)).toEqual([...(NOT_INSTALLED_BY_THE_HOST[name] ?? [])].sort());
    });
  }
});
