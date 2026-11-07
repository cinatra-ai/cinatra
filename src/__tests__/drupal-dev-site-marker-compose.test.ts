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
 * the checks are string assertions against the raw file content.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(__dirname, "..", "..");
const composePath = path.join(root, "docker-compose.yml");
const yaml = fs.existsSync(composePath) ? fs.readFileSync(composePath, "utf8") : "";

/** The text of one top-level service: from its key line to the next top-level service key or comment block. */
function serviceBlock(name: string): string {
  const start = yaml.indexOf(`\n  ${name}:\n`);
  if (start < 0) return "";
  const rest = yaml.slice(start + 1);
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

describe("the drupal compose service carries the development-site marker", () => {
  it("has a drupal service with an environment map", () => {
    expect(fs.existsSync(composePath)).toBe(true);
    expect(serviceBlock("drupal")).toContain("container_name: cinatra-drupal-1");
    expect(environmentLines(serviceBlock("drupal")).length).toBeGreaterThan(0);
  });

  it('sets CINATRA_DEV_SITE to the string "1" in the drupal environment', () => {
    const env = environmentLines(serviceBlock("drupal"));
    expect(env.filter((l) => l.startsWith("CINATRA_DEV_SITE:"))).toEqual(['CINATRA_DEV_SITE: "1"']);
  });

  it("sets the marker in no other service", () => {
    const all = yaml.split("\n").filter((l) => l.includes("CINATRA_DEV_SITE"));
    expect(all).toHaveLength(1);
    expect(serviceBlock("drupal")).toContain(all[0]);
  });
});
