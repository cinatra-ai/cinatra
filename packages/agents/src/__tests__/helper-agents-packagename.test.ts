/**
 * Presence-required assertion for the helper reference agents
 * (agent-planner, agent-security-reviewer, agent-code-reviewer).
 *
 * The parity test in agent-source-review-parity.test.ts enforces that when
 * metadata.cinatra.packageName is present, it must match package.json#name.
 * Absence is tolerated there for Flow agents that do not yet declare it.
 *
 * This sibling test enforces presence of metadata.cinatra.packageName on the
 * helper agents that must always declare their package identity.
 *
 * Run this test with Vitest from packages/agents.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const AGENTS_DIR = path.join(REPO_ROOT, "extensions", "cinatra-ai");

const NEW_HELPER_PACKAGES = [
  "planner-agent",
  "security-reviewer-agent",
  "code-reviewer-agent",
];

describe("helper agents must declare packageName", () => {
  for (const slug of NEW_HELPER_PACKAGES) {
    it(`${slug} declares metadata.cinatra.packageName (presence required)`, () => {
      const oasPath = path.join(AGENTS_DIR, slug, "cinatra", "oas.json");
      expect(
        fs.existsSync(oasPath),
        `expected oas.json to exist at ${oasPath}`,
      ).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(oasPath, "utf-8")) as {
        metadata?: { cinatra?: { packageName?: string } };
      };
      const packageName = parsed.metadata?.cinatra?.packageName;
      expect(
        packageName,
        `${slug} metadata.cinatra.packageName must be present for helper agents`,
      ).toBeDefined();
      expect(typeof packageName).toBe("string");
      expect((packageName as string).length).toBeGreaterThan(0);
    });

    it(`${slug} packageName matches sibling package.json#name`, () => {
      const oasPath = path.join(AGENTS_DIR, slug, "cinatra", "oas.json");
      const pkgPath = path.join(AGENTS_DIR, slug, "package.json");
      const oas = JSON.parse(fs.readFileSync(oasPath, "utf-8")) as {
        metadata?: { cinatra?: { packageName?: string } };
      };
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { name?: string };
      const oasPackageName = oas.metadata?.cinatra?.packageName;
      expect(pkg.name).toBeDefined();
      expect(oasPackageName).toBe(pkg.name);
    });
  }
});
