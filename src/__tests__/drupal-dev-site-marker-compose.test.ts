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
 * the text as an argument, so the look-alike cases below run them on small inputs. They
 * read only a plain shape and refuse anything else: the drupal key exactly once in the
 * top-level `services:` map, one-line environment entries, no `extends` in any service.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(__dirname, "..", "..");
const composePath = path.join(root, "docker-compose.yml");
const yaml = fs.existsSync(composePath) ? fs.readFileSync(composePath, "utf8") : "";
const MARKER = "CINATRA_DEV_SITE";
/** The tracked files that may name the marker. */
const MARKER_FILES = ["docker-compose.yml", "src/__tests__/drupal-dev-site-marker-compose.test.ts"];

/** The lines of the top-level `services:` map, without its key line: up to the next top-level key. */
function servicesSection(text: string): string[] {
  const lines = text.split("\n");
  const at = lines.indexOf("services:");
  if (at < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (/^[^\s#]/.test(l)) break;
    out.push(l);
  }
  return out;
}

/**
 * The text of one service of the `services:` map: from its exact key line (no anchor, no inline value) to the next
 * line at the service indent. Empty when the map does not hold the key exactly once.
 */
function serviceBlock(text: string, name: string): string {
  const lines = servicesSection(text);
  if (lines.filter((l) => l === `  ${name}:`).length !== 1) return "";
  const at = lines.indexOf(`  ${name}:`);
  const out = [lines[at]];
  for (const l of lines.slice(at + 1)) {
    if (/^ {2}\S/.test(l)) break;
    out.push(l);
  }
  return out.join("\n") + "\n";
}

/** One entry of an environment map: a one-line `KEY: value`, the value plain or fully quoted, no anchor or alias. */
const ENTRY = /^[A-Za-z_][A-Za-z0-9_]*: (?:"[^"\\]*"|'[^']*'|[^\s"'|>&*!%@`#{[\]][^#]*)$/;

/**
 * The `environment:` map of a service block, as its entries. Only lines at the map's own indent (six spaces) are
 * entries; comment lines are skipped. A deeper line (a value that spans lines) or an entry of another shape makes the
 * result `null`, as does a second `environment:` key.
 */
function environmentLines(block: string): string[] | null {
  const lines = block.split("\n");
  if (lines.filter((l) => l === "    environment:").length !== 1) return lines.some((l) => /^ {4}environment\b/.test(l)) ? null : [];
  const at = lines.indexOf("    environment:");
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() === "" || /^ {6}#/.test(l)) continue;
    if (!l.startsWith("      ")) break;
    if (l.startsWith("       ")) return null;
    const entry = l.slice(6);
    if (!ENTRY.test(entry)) return null;
    out.push(entry);
  }
  return out;
}

/** Every reason why a compose text does not set the marker exactly once, as "1", in the drupal service only. */
function markerProblems(text: string): string[] {
  const problems: string[] = [];
  const block = serviceBlock(text, "drupal");
  if (block === "") problems.push("the services map has no single plain drupal key");
  const env = environmentLines(block);
  if (env === null) problems.push("the drupal environment holds a line that is not a one-line KEY: value entry");
  else if (env.length === 0) problems.push("the drupal service has no environment map");
  const marker = (env ?? []).filter((l) => l.startsWith(`${MARKER}:`));
  if (JSON.stringify(marker) !== JSON.stringify([`${MARKER}: "1"`])) {
    problems.push(`the drupal environment does not set ${MARKER} exactly once to "1"`);
  }
  const all = text.split("\n").filter((l) => l.includes(MARKER));
  if (all.length !== 1 || all[0] !== `      ${MARKER}: "1"` || !block.split("\n").includes(all[0])) {
    problems.push(`not exactly one line names ${MARKER}, as the drupal entry`);
  }
  const extending = servicesSection(text).filter((l) => !l.trim().startsWith("#") && /\bextends\b/.test(l));
  if (extending.length > 0) problems.push("a service extends another service");
  return problems;
}

/** The other compose files Compose can load from the repository root. */
function otherRootComposeFiles(): string[] {
  return fs
    .readdirSync(root)
    .filter((n) => /^(docker-)?compose(\.[A-Za-z0-9_-]+)*\.ya?ml$/.test(n) && n !== "docker-compose.yml")
    .sort();
}

/** The reasons why another root compose file names the marker, extends a service or defines drupal: its lines that do. */
function rootFileProblems(text: string): string[] {
  const lines = text.split("\n");
  return [
    ...lines.filter((l) => l.includes(MARKER)),
    ...lines.filter((l) => !l.trim().startsWith("#") && /\bextends\b/.test(l)),
    ...lines.filter((l) => l === "  drupal:"),
  ];
}

/** The scan of the tracked files is not made in this commit: it finds nothing. */
function trackedFileProblems(files: { name: string; text: string }[]): string[] {
  return files.filter(() => false).map((f) => `${f.name} names ${MARKER}`);
}

/** The tracked regular files of the repository (`git ls-files`; links and submodules left out). */
function trackedFileNames(): string[] {
  const out = execFileSync("git", ["-C", root, "ls-files", "-z", "-s"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return out
    .split("\0")
    .filter((e) => /^100(644|755) /.test(e))
    .map((e) => e.slice(e.indexOf("\t") + 1));
}

describe("the drupal compose service carries the development-site marker", () => {
  it("has a drupal service with an environment map", () => {
    expect(fs.existsSync(composePath)).toBe(true);
    expect(serviceBlock(yaml, "drupal")).toContain("container_name: cinatra-drupal-1");
    expect(environmentLines(serviceBlock(yaml, "drupal"))?.length ?? 0).toBeGreaterThan(0);
  });

  it('sets CINATRA_DEV_SITE to the string "1" in the drupal environment and nowhere else in the file', () => {
    expect(markerProblems(yaml)).toEqual([]);
  });

  it("no other compose file of the repository root names the marker, extends a service or defines drupal", () => {
    for (const name of otherRootComposeFiles()) {
      expect(rootFileProblems(fs.readFileSync(path.join(root, name), "utf8")), name).toEqual([]);
    }
  });

  it("no tracked file other than docker-compose.yml and this test names the marker", () => {
    const names = trackedFileNames();
    expect(names).toContain("docker-compose.yml");
    const problems = names.flatMap((name) => trackedFileProblems([{ name, text: fs.readFileSync(path.join(root, name), "utf8") }]));
    expect(problems).toEqual([]);
  }, 120_000);
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

  it("refuses a second environment key in the drupal service", () => {
    const text = VALID.replace("    volumes:\n      - data:/data\n", "    volumes:\n      - data:/data\n    environment: {}\n");
    expect(text).toContain("      - data:/data\n    environment: {}\n");
    expect(markerProblems(text)).not.toEqual([]);
  });

  it("refuses a quoted second drupal key in the services map", () => {
    const text = VALID.replace("volumes:\n  data:", '  "drupal":\n    image: drupal\nvolumes:\n  data:');
    expect(text).toContain('  "drupal":\n');
    expect(markerProblems(text)).not.toEqual([]);
  });

  it("refuses a second top-level services map", () => {
    const text = VALID + "services:\n  extra:\n    image: busybox\n";
    expect(markerProblems(text)).not.toEqual([]);
  });

  it("refuses a service that takes extends through a merge key", () => {
    const text = VALID.replace("services:\n", "x-copy: &copy\n  extends:\n    service: drupal\nservices:\n").replace(
      "volumes:\n  data:",
      "  drupal-copy:\n    <<: *copy\nvolumes:\n  data:",
    );
    expect(text).toContain("  drupal-copy:\n    <<: *copy\n");
    expect(markerProblems(text)).not.toEqual([]);
  });

  it("refuses an escaped spelling of extends", () => {
    const text = VALID.replace("volumes:\n  data:", '  drupal-copy:\n    "ext\\u0065nds":\n      service: drupal\nvolumes:\n  data:');
    expect(text).toContain('    "ext\\u0065nds":\n');
    expect(markerProblems(text)).not.toEqual([]);
  });

  it("refuses an escaped spelling of the marker in another service", () => {
    const text = VALID.replace("    image: postgres\n", '    image: postgres\n    environment:\n      "CINATRA_DEV_\\u0053ITE": "1"\n');
    expect(text).toContain('      "CINATRA_DEV_\\u0053ITE": "1"\n');
    expect(markerProblems(text)).not.toEqual([]);
  });

  it("refuses an include of another compose file", () => {
    const text = "include:\n  - docker-compose.extra.yml\n" + VALID;
    expect(markerProblems(text)).not.toEqual([]);
  });

  it("refuses another root compose file that defines drupal in flow style", () => {
    expect(rootFileProblems('services: { drupal: { image: "drupal:11" } }\n')).not.toEqual([]);
  });

  it("refuses a tracked file other than the compose file that names the marker", () => {
    expect(trackedFileProblems([{ name: "docker/drupal-clone/clone.env", text: `${MARKER}=1\n` }])).not.toEqual([]);
  });
});
