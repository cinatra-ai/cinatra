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
 * The readers parse the compose files with the `yaml` package. The root adds no
 * dependency: the package is loaded through createRequire from packages/skills, a
 * workspace dependency of the root that depends on `yaml`. CRLF line ends are read as
 * LF, and aliases are resolved. The readers take the text as an argument, so the
 * look-alike cases below run them on small inputs; each problem starts with its reason
 * and a colon. A compose text is refused when it holds a carriage return outside a CRLF
 * pair or a NEL, LS or PS line break (Compose's YAML reader reads these as line breaks,
 * the package does not), a parse error or warning, more than one document, an explicit
 * tag, a `<<` merge key, a top-level key other than name, version, services, networks,
 * volumes, configs, secrets and `x-*` (`include` loads other files), `extends` in a
 * service, an environment that is not a map or a list, or a `$` (Compose interpolation)
 * in a service key, an environment key or an environment list entry. In
 * docker-compose.yml the drupal environment must set the marker to the string "1", and
 * the marker may be named once: in the text and in the parsed keys and string values.
 * The other root compose files may not name drupal, the marker, extends or include, and
 * no tracked file other than docker-compose.yml and this test may name the marker: in its
 * text, or, for a YAML file, in a parsed key or string value. A tracked YAML file must
 * parse, and a tracked file with a compose file name is read as a compose text.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(__dirname, "..", "..");
const composePath = path.join(root, "docker-compose.yml");
const yaml = fs.existsSync(composePath) ? fs.readFileSync(composePath, "utf8") : "";
const MARKER = "CINATRA_DEV_SITE";
/** The tracked files that may name the marker. */
const MARKER_FILES = ["docker-compose.yml", "src/__tests__/drupal-dev-site-marker-compose.test.ts"];
/** The top-level keys the readers model, besides `x-` extension keys. `include` is not one: it loads other files. */
const TOP_KEYS = ["name", "version", "services", "networks", "volumes", "configs", "secrets"];
/** The names that Compose gives a compose file in a folder. */
const COMPOSE_NAME = /^(docker-)?compose(\.[A-Za-z0-9_-]+)*\.ya?ml$/;
/** The line breaks that the package and Compose's YAML reader do not read alike (checked after CRLF is read as LF). */
const ODD_BREAK = new RegExp("[\\r\\u0085\\u2028\\u2029]");

/** The parts of the `yaml` package (2.x) that the readers use. */
interface YamlIssue {
  code: string;
}
interface YamlNode {
  tag?: string;
}
interface YamlDocument {
  errors: YamlIssue[];
  warnings: YamlIssue[];
  toJS(): unknown;
}
interface YamlApi {
  parseAllDocuments(text: string, options: { uniqueKeys: boolean; merge: boolean }): YamlDocument[];
  visit(doc: YamlDocument, visitor: { Node: (key: unknown, node: YamlNode) => void }): void;
}
const YAML = createRequire(path.join(root, "packages", "skills", "package.json"))("yaml") as YamlApi;

function isMap(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function own(m: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(m, key);
}

function occurrences(text: string, word: string): number {
  return text.split(word).length - 1;
}

/** Each key and string value of a parsed value. A value that two aliases share is read at both places; a cycle once. */
function strings(value: unknown, out: string[] = [], open: unknown[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (value !== null && typeof value === "object" && !open.includes(value)) {
    open.push(value);
    if (Array.isArray(value)) value.forEach((v) => strings(v, out, open));
    else
      for (const [k, v] of Object.entries(value)) {
        out.push(k);
        strings(v, out, open);
      }
    open.pop();
  }
  return out;
}

/** True when a map of the parsed value, at any depth, has the key `<<`. */
function hasMergeKey(value: unknown, open: unknown[] = []): boolean {
  if (value === null || typeof value !== "object" || open.includes(value)) return false;
  open.push(value);
  const found = Array.isArray(value)
    ? value.some((v) => hasMergeKey(v, open))
    : Object.entries(value).some(([k, v]) => k === "<<" || hasMergeKey(v, open));
  open.pop();
  return found;
}

/** The documents of a YAML text, CRLF read as LF, and every reason why it is not a clean parse (line breaks, errors). */
function parse(text: string): { docs: YamlDocument[]; problems: string[] } {
  const t = text.replace(/\r\n/g, "\n");
  if (ODD_BREAK.test(t)) return { docs: [], problems: ["line-breaks: a carriage return outside a CRLF pair, or a NEL, LS or PS line break"] };
  const docs = YAML.parseAllDocuments(t, { uniqueKeys: true, merge: false });
  return { docs, problems: docs.flatMap((d) => d.errors.map((e) => `yaml: ${e.code}`)) };
}

/** A compose text's value, aliases resolved, and every reason why it is not of the shape the readers model (see the header). */
function composeRead(text: string): { value: unknown; problems: string[] } {
  const { docs, problems } = parse(text);
  if (problems.length > 0) return { value: undefined, problems };
  if (docs.length !== 1) return { value: undefined, problems: [`documents: the text holds ${docs.length} YAML documents, not one`] };
  const doc = docs[0];
  problems.push(...doc.warnings.map((w) => `yaml: ${w.code}`));
  YAML.visit(doc, {
    Node: (_key, node) => {
      if (node.tag !== undefined) problems.push(`tag: an explicit tag ${node.tag}`);
    },
  });
  let value: unknown;
  try {
    value = doc.toJS();
  } catch {
    return { value: undefined, problems: [...problems, "aliases: the aliases do not resolve"] };
  }
  if (!isMap(value)) return { value, problems: [...problems, "top: the text is not a map"] };
  if (hasMergeKey(value)) problems.push("merge: a << merge key");
  for (const k of Object.keys(value)) {
    if (!TOP_KEYS.includes(k) && !k.startsWith("x-")) problems.push(`top: the top-level key ${k} is not one the readers model`);
  }
  const services = value.services;
  if (services !== undefined && services !== null && !isMap(services)) problems.push("services: the services value is not a map");
  for (const [name, service] of Object.entries(isMap(services) ? services : {})) {
    if (name.includes("$")) problems.push(`interpolation: the service key ${name}`);
    if (service === null) continue;
    if (!isMap(service)) {
      problems.push(`service: the service ${name} is not a map`);
      continue;
    }
    if (own(service, "extends")) problems.push(`extends: the service ${name}`);
    const env = service.environment;
    if (Array.isArray(env)) {
      for (const entry of env) {
        if (typeof entry !== "string") problems.push(`environment: an environment list entry of ${name} is not a string`);
        else if (entry.includes("$")) problems.push(`interpolation: an environment list entry of ${name}`);
      }
    } else if (isMap(env)) {
      for (const key of Object.keys(env)) if (key.includes("$")) problems.push(`interpolation: an environment key of ${name}`);
    } else if (env !== undefined && env !== null) problems.push(`environment: the environment of ${name} is not a map or a list`);
  }
  return { value, problems };
}

/** Every reason why a compose text does not set the marker exactly once, as the string "1", in the drupal service only. */
function markerProblems(text: string): string[] {
  const { value, problems } = composeRead(text);
  const services = isMap(value) && isMap(value.services) ? value.services : {};
  const drupal = own(services, "drupal") ? services.drupal : undefined;
  const env = isMap(drupal) ? drupal.environment : undefined;
  if (!isMap(drupal)) problems.push("drupal: the services map has no drupal service map");
  else if (!isMap(env)) problems.push("drupal: the drupal environment is not a map");
  else if (!own(env, MARKER) || env[MARKER] !== "1") problems.push(`drupal: the drupal environment does not set ${MARKER} to the string "1"`);
  const named = strings(value).filter((s) => s.includes(MARKER)).length;
  if (named !== 1) problems.push(`marker: ${named} parsed keys or values name ${MARKER}, not one`);
  const raw = occurrences(text, MARKER);
  if (raw !== 1) problems.push(`marker: the text names ${MARKER} ${raw} times, not once`);
  return problems;
}

/** The other compose files Compose can load from the repository root. */
function otherRootComposeFiles(): string[] {
  return fs
    .readdirSync(root)
    .filter((n) => COMPOSE_NAME.test(n) && n !== "docker-compose.yml")
    .sort();
}

/** Every reason why another root compose file could reach the drupal service: its shape, or a name of drupal, the marker, extends or include (any case) in its text or in a parsed key or value. */
function rootFileProblems(text: string): string[] {
  const { value, problems } = composeRead(text);
  const raw = text.toLowerCase();
  const read = strings(value).join("\n").toLowerCase();
  for (const w of ["drupal", MARKER.toLowerCase(), "extends", "include"]) {
    if (raw.includes(w) || read.includes(w)) problems.push(`names: the file names ${w}`);
  }
  return problems;
}

/** Every reason why a file of the list, other than the files that may, could name the marker (see the header). */
function trackedFileProblems(files: { name: string; text: string }[]): string[] {
  const problems: string[] = [];
  for (const f of files.filter((x) => !MARKER_FILES.includes(x.name))) {
    const at = (p: string) => p.replace(/^([a-z-]+): /, `$1: ${f.name}: `);
    if (f.text.includes(MARKER)) problems.push(`names: ${f.name}: the text names ${MARKER}`);
    if (!/\.ya?ml$/i.test(f.name)) continue;
    let values: unknown[] = [];
    if (COMPOSE_NAME.test(path.posix.basename(f.name))) {
      const read = composeRead(f.text);
      problems.push(...read.problems.map(at));
      values = [read.value];
    } else {
      const { docs, problems: parsed } = parse(f.text);
      problems.push(...parsed.map(at));
      if (parsed.length > 0) continue;
      try {
        values = docs.map((d) => d.toJS());
      } catch {
        problems.push(`aliases: ${f.name}: the aliases do not resolve`);
      }
    }
    if (values.some((v) => strings(v).some((s) => s.includes(MARKER)))) problems.push(`names: ${f.name}: a parsed key or value names ${MARKER}`);
  }
  return problems;
}

/** The tracked regular files of the repository (`git ls-files`; links and submodules left out). */
function trackedFileNames(): string[] {
  const out = execFileSync("git", ["-C", root, "ls-files", "-z", "-s"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return out
    .split("\0")
    .filter((e) => /^100(644|755) /.test(e))
    .map((e) => e.slice(e.indexOf("\t") + 1));
}

/** The test fails unless one of the problems has the reason (the word before its first colon). */
function expectReason(problems: string[], reason: string): void {
  expect(
    problems.map((p) => p.slice(0, p.indexOf(":"))),
    JSON.stringify(problems),
  ).toContain(reason);
}

describe("the drupal compose service carries the development-site marker", () => {
  it("has a drupal service with an environment map", () => {
    expect(fs.existsSync(composePath)).toBe(true);
    const { value } = composeRead(yaml);
    const drupal = isMap(value) && isMap(value.services) ? value.services.drupal : undefined;
    expect(isMap(drupal) ? drupal.container_name : undefined).toBe("cinatra-drupal-1");
    expect(isMap(drupal) && isMap(drupal.environment) ? Object.keys(drupal.environment).length : 0).toBeGreaterThan(0);
  });

  it('sets CINATRA_DEV_SITE to the string "1" in the drupal environment and nowhere else in the file', () => {
    expect(markerProblems(yaml)).toEqual([]);
  });

  it("no other compose file of the repository root names drupal, the marker, extends or include", () => {
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
    expectReason(markerProblems(text), "drupal");
  });

  it("refuses the marker inside a block-scalar value of another variable", () => {
    const text = VALID.replace(`      ${MARKER}: "1"`, `      PAYLOAD: |\n        ${MARKER}: "1"`);
    expectReason(markerProblems(text), "drupal");
  });

  it("refuses a service that extends the drupal service", () => {
    const text = VALID.replace("volumes:\n  data:", "  drupal-clone:\n    extends:\n      service: drupal\nvolumes:\n  data:");
    expect(text).toContain("  drupal-clone:\n    extends:");
    expectReason(markerProblems(text), "extends");
  });

  it("refuses an anchored drupal service that another service aliases", () => {
    const text = VALID.replace("  drupal:\n", "  drupal: &drupal\n").replace("volumes:\n  data:", "  drupal-copy: *drupal\nvolumes:\n  data:");
    expect(text).toContain("  drupal-copy: *drupal");
    expectReason(markerProblems(text), "marker");
  });

  it("refuses a second environment key in the drupal service", () => {
    const text = VALID.replace("    volumes:\n      - data:/data\n", "    volumes:\n      - data:/data\n    environment: {}\n");
    expect(text).toContain("      - data:/data\n    environment: {}\n");
    expect(markerProblems(text)).toContain("yaml: DUPLICATE_KEY");
  });

  it("refuses a quoted second drupal key in the services map", () => {
    const text = VALID.replace("volumes:\n  data:", '  "drupal":\n    image: drupal\nvolumes:\n  data:');
    expect(text).toContain('  "drupal":\n');
    expect(markerProblems(text)).toContain("yaml: DUPLICATE_KEY");
  });

  it("refuses a second top-level services map", () => {
    const text = VALID + "services:\n  extra:\n    image: busybox\n";
    expect(markerProblems(text)).toContain("yaml: DUPLICATE_KEY");
  });

  it("refuses a service that takes a map through a merge key", () => {
    const text = VALID.replace("services:\n", "x-copy: &copy\n  image: drupal\nservices:\n").replace(
      "volumes:\n  data:",
      "  drupal-copy:\n    <<: *copy\nvolumes:\n  data:",
    );
    expect(text).toContain("  drupal-copy:\n    <<: *copy\n");
    expect(text).not.toContain("extends");
    expectReason(markerProblems(text), "merge");
  });

  it("refuses an escaped spelling of extends", () => {
    const text = VALID.replace("volumes:\n  data:", '  drupal-copy:\n    "ext\\u0065nds":\n      service: drupal\nvolumes:\n  data:');
    expect(text).toContain('    "ext\\u0065nds":\n');
    expectReason(markerProblems(text), "extends");
  });

  it("refuses an escaped spelling of the marker in another service", () => {
    const text = VALID.replace("    image: postgres\n", '    image: postgres\n    environment:\n      "CINATRA_DEV_\\u0053ITE": "1"\n');
    expect(text).toContain('      "CINATRA_DEV_\\u0053ITE": "1"\n');
    expectReason(markerProblems(text), "marker");
  });

  it("refuses an include of another compose file", () => {
    const text = "include:\n  - docker-compose.extra.yml\n" + VALID;
    expectReason(markerProblems(text), "top");
  });

  it("refuses another root compose file that defines drupal in flow style", () => {
    expectReason(rootFileProblems('services: { drupal: { image: "drupal:11" } }\n'), "names");
  });

  it("refuses a tracked file other than the compose file that names the marker", () => {
    expectReason(trackedFileProblems([{ name: "docker/drupal-clone/clone.env", text: `${MARKER}=1\n` }]), "names");
  });

  it("refuses a repeated entry in the drupal environment", () => {
    const text = VALID.replace("      DRUPAL_ADMIN_USER: admin\n", "      DRUPAL_ADMIN_USER: admin\n      DRUPAL_ADMIN_USER: root\n");
    expect(text).toContain("      DRUPAL_ADMIN_USER: admin\n      DRUPAL_ADMIN_USER: root\n");
    expect(markerProblems(text)).toContain("yaml: DUPLICATE_KEY");
  });

  it("refuses a repeated plain service key", () => {
    const text = VALID.replace("volumes:\n  data:", "  postgres:\n    image: postgres:16\nvolumes:\n  data:");
    expect(text).toContain("  postgres:\n    image: postgres:16\n");
    expect(markerProblems(text)).toContain("yaml: DUPLICATE_KEY");
  });

  it("refuses a second YAML document", () => {
    expectReason(markerProblems(VALID + "---\nservices: {}\n"), "documents");
  });
});

/** A compose text whose wordpress service gets the marker only after Compose interpolates `${CINATRA_G10_PART:-SITE}`. */
const INTERPOLATED = ["services:", "  wordpress:", "    environment:", "      - CINATRA_DEV_${CINATRA_G10_PART:-SITE}=1", ""].join("\n");
/** A double-quoted key split by an escaped line break whose break is a lone carriage return, or a NEL. */
const LONE_CR_KEY = '      "CINATRA_DEV_\\\rSITE": "1"';
const NEL_KEY = `      "CINATRA_DEV_\\${String.fromCharCode(0x85)}SITE": "1"`;

describe("the marker readers refuse interpolated names and line breaks that only Compose reads, and accept CRLF files", () => {
  it("refuses an interpolated environment list entry in another service", () => {
    const text = VALID.replace("    image: postgres\n", "    image: postgres\n    environment:\n      - CINATRA_DEV_${CINATRA_G10_PART:-SITE}=1\n");
    expect(text).toContain("      - CINATRA_DEV_${CINATRA_G10_PART:-SITE}=1\n");
    expectReason(markerProblems(text), "interpolation");
  });

  it("refuses an interpolated environment key in another service", () => {
    const text = VALID.replace("    image: postgres\n", '    image: postgres\n    environment:\n      CINATRA_DEV_${CINATRA_G10_PART:-SITE}: "1"\n');
    expect(text).toContain('      CINATRA_DEV_${CINATRA_G10_PART:-SITE}: "1"\n');
    expectReason(markerProblems(text), "interpolation");
  });

  it("refuses an interpolated service key", () => {
    const text = VALID.replace("volumes:\n  data:", "  drupal${CINATRA_G10_SUFFIX:-}:\n    image: drupal\nvolumes:\n  data:");
    expect(text).toContain("  drupal${CINATRA_G10_SUFFIX:-}:\n");
    expectReason(markerProblems(text), "interpolation");
  });

  it("refuses another root compose file with an interpolated environment list entry", () => {
    expectReason(rootFileProblems(INTERPOLATED), "interpolation");
  });

  it("refuses a tracked compose file with an interpolated environment list entry", () => {
    expectReason(trackedFileProblems([{ name: "docker/extra/compose.yaml", text: INTERPOLATED }]), "interpolation");
  });

  it("refuses an escaped name split by a lone carriage return in another service", () => {
    const text = VALID.replace("    image: postgres\n", `    image: postgres\n    environment:\n${LONE_CR_KEY}\n`);
    expect(text).toContain("CINATRA_DEV_\\\rSITE");
    expectReason(markerProblems(text), "line-breaks");
  });

  it("refuses a lone carriage return in a tracked YAML file", () => {
    expectReason(trackedFileProblems([{ name: "docker/extra/vars.yml", text: `vars:\n${LONE_CR_KEY}\n` }]), "line-breaks");
  });

  it("refuses a NEL line break in another root compose file", () => {
    expectReason(rootFileProblems(`services:\n  wordpress:\n    environment:\n${NEL_KEY}\n`), "line-breaks");
  });

  it("refuses an explicit tag in another service", () => {
    const text = VALID.replace("    image: postgres\n", "    image: postgres\n    environment: !override {}\n");
    expect(text).toContain("    environment: !override {}\n");
    expectReason(markerProblems(text), "tag");
  });

  it("accepts the minimal valid file with CRLF line ends", () => {
    expect(markerProblems(VALID.replace(/\n/g, "\r\n"))).toEqual([]);
  });

  it("accepts the real docker-compose.yml with CRLF line ends", () => {
    // The working tree may already hold CRLF line ends: read them as LF before building the CRLF copy.
    const lf = yaml.replace(/\r\n/g, "\n");
    expect(lf).toContain("services:\n");
    expect(markerProblems(lf.replace(/\n/g, "\r\n"))).toEqual([]);
  });
});
