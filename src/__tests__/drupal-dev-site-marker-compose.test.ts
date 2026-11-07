/**
 * The local Drupal fixture carries the development-site marker (cinatra-ai/cinatra#4226).
 *
 * drupal-module's `cinatra_dev_site` submodule serves its exposure only in a
 * process whose environment holds `CINATRA_DEV_SITE` exactly "1"
 * (`CinatraDevSite::exposureActive()` reads the marker first). The web server
 * of the `drupal` compose service answers the remote MCP requests, so the
 * marker has to be in that service's environment; the connector's dev setup
 * passes it only to its own drush calls.
 *
 * We do NOT add a YAML parser dependency (as src/__tests__/a2a-peer-compose.test.ts):
 * the checks are string assertions against the raw file content. The readers take
 * the text as an argument, so the look-alike cases below run them on small inputs.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(__dirname, "..", "..");
const composePath = path.join(root, "docker-compose.yml");
const yaml = fs.existsSync(composePath) ? fs.readFileSync(composePath, "utf8") : "";
const MARKER = "CINATRA_DEV_SITE";

/** The text of one top-level service: from its key line to the next top-level service key or comment block. */
function serviceBlock(text: string, name: string): string {
  const start = text.indexOf(`\n  ${name}:\n`);
  if (start < 0) return "";
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z0-9#-]/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** The `environment:` map of a service block, as its indented lines. */
function environmentLines(block: string): string[] {
  const lines = block.split("\n");
  const at = lines.findIndex((l) => l === "    environment:");
  if (at < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (!l.startsWith("      ")) break;
    out.push(l.trim());
  }
  return out;
}

/** Every reason why a compose text does not set the marker exactly once, as "1", in the drupal service only. */
function markerProblems(text: string): string[] {
  const problems: string[] = [];
  const block = serviceBlock(text, "drupal");
  const env = environmentLines(block);
  if (env.length === 0) problems.push("the drupal service has no environment map");
  const marker = env.filter((l) => l.startsWith(`${MARKER}:`));
  if (JSON.stringify(marker) !== JSON.stringify([`${MARKER}: "1"`])) {
    problems.push(`the drupal environment does not set ${MARKER} exactly once to "1"`);
  }
  const all = text.split("\n").filter((l) => l.includes(MARKER));
  if (all.length !== 1 || !block.includes(all[0])) problems.push(`not exactly one line names ${MARKER}`);
  return problems;
}

/** The other compose files Compose can load from the repository root. */
function otherRootComposeFiles(): string[] {
  return fs
    .readdirSync(root)
    .filter((n) => /^(docker-)?compose(\.[A-Za-z0-9_-]+)*\.ya?ml$/.test(n) && n !== "docker-compose.yml")
    .sort();
}

describe("the drupal compose service carries the development-site marker", () => {
  it("has a drupal service with an environment map", () => {
    expect(fs.existsSync(composePath)).toBe(true);
    expect(serviceBlock(yaml, "drupal")).toContain("container_name: cinatra-drupal-1");
    expect(environmentLines(serviceBlock(yaml, "drupal")).length).toBeGreaterThan(0);
  });

  it('sets CINATRA_DEV_SITE to the string "1" in the drupal environment and nowhere else in the file', () => {
    expect(markerProblems(yaml)).toEqual([]);
  });

  it("no other compose file of the repository root names the marker, extends a service or defines drupal", () => {
    for (const name of otherRootComposeFiles()) {
      const lines = fs.readFileSync(path.join(root, name), "utf8").split("\n");
      expect(lines.filter((l) => l.includes(MARKER)), name).toEqual([]);
      expect(lines.filter((l) => !l.trim().startsWith("#") && /\bextends\b/.test(l)), name).toEqual([]);
      expect(lines.filter((l) => l === "  drupal:"), name).toEqual([]);
    }
  });
});

const VALID = [
  "services:",
  "  postgres:",
  "    image: postgres",
  "  drupal:",
  "    container_name: cinatra-drupal-1",
  "    environment:",
  "      DRUPAL_ADMIN_USER: admin",
  "      # the marker",
  `      ${MARKER}: "1"`,
  "    volumes:",
  "      - data:/data",
  "volumes:",
  "  data:",
  "",
].join("\n");

describe("the marker reader refuses look-alikes of the drupal service", () => {
  it("accepts a minimal valid file", () => {
    expect(markerProblems(VALID)).toEqual([]);
  });

  it("refuses a drupal key outside the services map", () => {
    const text = [
      "services:",
      "  postgres:",
      "    image: postgres",
      "x-fixture:",
      "  drupal:",
      "    container_name: cinatra-drupal-1",
      "    environment:",
      `      ${MARKER}: "1"`,
      "",
    ].join("\n");
    expect(markerProblems(text)).not.toEqual([]);
  });

  it("refuses the marker inside a block-scalar value of another variable", () => {
    const text = VALID.replace(`      ${MARKER}: "1"`, `      PAYLOAD: |\n        ${MARKER}: "1"`);
    expect(markerProblems(text)).not.toEqual([]);
  });

  it("refuses a service that extends the drupal service", () => {
    const text = VALID.replace("volumes:\n  data:", "  drupal-clone:\n    extends:\n      service: drupal\nvolumes:\n  data:");
    expect(text).toContain("  drupal-clone:\n    extends:");
    expect(markerProblems(text)).not.toEqual([]);
  });

  it("refuses an anchored drupal service that another service aliases", () => {
    const text = VALID.replace("  drupal:\n", "  drupal: &drupal\n").replace("volumes:\n  data:", "  drupal-copy: *drupal\nvolumes:\n  data:");
    expect(text).toContain("  drupal-copy: *drupal");
    expect(markerProblems(text)).not.toEqual([]);
  });
});
