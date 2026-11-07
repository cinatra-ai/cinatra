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
 * service, an environment that is not a map or a list (a null environment is read as
 * none), a `$` in a service key, an environment key or an environment list entry (Compose
 * does not interpolate keys; the readers refuse a `$` there all the same), or a string
 * value, at any place of the text, with a `$` form that Compose does not read or whose
 * interpolation can name the marker. Compose interpolates every string value: the
 * readers read each `$` form of a value with its variable unset, so a value is read with
 * each default (`:-` and `-`) or alternative (`:+` and `+`) and with none, nested forms
 * included, and `$$` as one `$`. A variable's value from the shell or from an untracked
 * .env file is not read, and a command's shell code is not run. In docker-compose.yml
 * the drupal environment must set the marker to the string "1", and the marker may be
 * named once: in the text and in the parsed keys and string values. The other root
 * compose files may not name drupal, the marker, extends or include, and no tracked file
 * other than docker-compose.yml and this test may name the marker: in its text, or, for
 * a YAML file, in a parsed key or string value. A tracked YAML file must parse, a tracked
 * file with a compose file name is read as a compose text, and no .env file is tracked at
 * the root (Compose reads it for the values of the variables). A tracked link (git mode
 * 120000) with a YAML file name is read under its own name with the text of the tracked
 * regular file it points to, as Compose follows it; such a link that points to no tracked
 * regular file is refused. Submodules are not read.
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
/** The git mode of a tracked link. */
const LINK = "120000";
/** A variable name of a Compose `$` form. */
const VAR_NAME = /^[_A-Za-z][_A-Za-z0-9]*/;
/** The most readings of one value that the readers expand; a value with more is refused. */
const MAX_FORMS = 256;
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

/** Each string value of a parsed value (keys left out), with its place: Compose interpolates these. */
function stringValues(value: unknown, at = "", out: { at: string; s: string }[] = [], open: unknown[] = []): { at: string; s: string }[] {
  if (typeof value === "string") out.push({ at, s: value });
  else if (value !== null && typeof value === "object" && !open.includes(value)) {
    open.push(value);
    if (Array.isArray(value)) value.forEach((v, i) => stringValues(v, `${at}[${i}]`, out, open));
    else for (const [k, v] of Object.entries(value)) stringValues(v, at === "" ? k : `${at}.${k}`, out, open);
    open.pop();
  }
  return out;
}

/**
 * Every string a value can become when Compose interpolates it with its variables unset: `$$` is one `$`; `$NAME` and
 * `${NAME}` are empty; `${NAME:-w}`, `${NAME-w}`, `${NAME:+w}`, `${NAME+w}`, `${NAME:?w}` and `${NAME?w}` are empty or a
 * reading of w (nested forms included). Null when the value holds a `$` form that Compose does not read, or more than
 * MAX_FORMS readings.
 */
function interpolations(s: string): string[] | null {
  let forms = [""];
  let i = 0;
  while (i < s.length) {
    if (s[i] !== "$") {
      forms = forms.map((f) => f + s[i]);
      i++;
      continue;
    }
    if (s[i + 1] === "$") {
      forms = forms.map((f) => f + "$");
      i += 2;
      continue;
    }
    const bare = VAR_NAME.exec(s.slice(i + 1));
    if (bare) {
      i += 1 + bare[0].length;
      continue;
    }
    if (s[i + 1] !== "{") return null;
    let depth = 1;
    let j = i + 2;
    while (j < s.length && depth > 0) {
      if (s[j] === "$" && s[j + 1] === "$") j += 2;
      else if (s[j] === "$" && s[j + 1] === "{") {
        depth++;
        j += 2;
      } else {
        if (s[j] === "}") depth--;
        j++;
      }
    }
    if (depth !== 0) return null;
    const form = /^([_A-Za-z][_A-Za-z0-9]*)(?:(:?[-+?])([\s\S]*))?$/.exec(s.slice(i + 2, j - 1));
    if (!form) return null;
    let words = [""];
    if (form[2] !== undefined) {
      const inner = interpolations(form[3]);
      if (inner === null) return null;
      words = ["", ...inner];
    }
    const next = new Set<string>();
    for (const f of forms) for (const w of words) next.add(f + w);
    if (next.size > MAX_FORMS) return null;
    forms = [...next];
    i = j;
  }
  return forms;
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
  for (const { at, s } of stringValues(value)) {
    if (!s.includes("$")) continue;
    const forms = interpolations(s);
    if (forms === null) problems.push(`interpolation: the value at ${at} holds a $ form that the readers do not read`);
    else if (forms.some((f) => f.includes(MARKER))) problems.push(`interpolation: the value at ${at} can name ${MARKER} after interpolation`);
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

/** A tracked file: its path, its text (for a link, the link's target) and its git mode (a regular file when none). */
interface TrackedFile {
  name: string;
  text: string;
  mode?: string;
}

/** The path inside the repository that a link of the list points to, or null when it points outside it. */
function linkTarget(link: TrackedFile): string | null {
  if (path.posix.isAbsolute(link.text)) return null;
  const to = path.posix.normalize(path.posix.join(path.posix.dirname(link.name), link.text));
  return to === ".." || to.startsWith("../") ? null : to;
}

/** Every reason why a file of the list, other than the files that may, could name the marker (see the header). */
function trackedFileProblems(files: TrackedFile[]): string[] {
  const problems: string[] = [];
  const regular = new Map(files.filter((x) => x.mode !== LINK).map((x) => [x.name, x.text]));
  for (const f of files.filter((x) => !MARKER_FILES.includes(x.name))) {
    const at = (p: string) => p.replace(/^([a-z-]+): /, `$1: ${f.name}: `);
    if (f.name === ".env") problems.push(`env: ${f.name}: Compose reads the root .env file for the values of the variables`);
    if (f.text.includes(MARKER)) problems.push(`names: ${f.name}: the text names ${MARKER}`);
    if (!/\.ya?ml$/i.test(f.name)) continue;
    let text = f.text;
    if (f.mode === LINK) {
      const to = linkTarget(f);
      const target = to === null ? undefined : regular.get(to);
      if (target === undefined) {
        problems.push(`link: ${f.name}: the link points to no tracked regular file of the list`);
        continue;
      }
      text = target;
      if (text.includes(MARKER)) problems.push(`names: ${f.name}: the text of the link's target names ${MARKER}`);
    }
    let values: unknown[] = [];
    if (COMPOSE_NAME.test(path.posix.basename(f.name))) {
      const read = composeRead(text);
      problems.push(...read.problems.map(at));
      values = [read.value];
    } else {
      const { docs, problems: parsed } = parse(text);
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

/** The tracked regular files and links of the repository (`git ls-files -s`: mode, object and path; submodules left out). */
function trackedFileNames(): { mode: string; object: string; name: string }[] {
  const out = execFileSync("git", ["-C", root, "ls-files", "-z", "-s"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return out
    .split("\0")
    .filter((e) => /^(100644|100755|120000) /.test(e))
    .map((e) => {
      const [mode, object] = e.slice(0, e.indexOf("\t")).split(" ");
      return { mode, object, name: e.slice(e.indexOf("\t") + 1) };
    });
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
    const entries = trackedFileNames();
    expect(entries.map((e) => e.name)).toContain("docker-compose.yml");
    const regular = new Set(entries.filter((e) => e.mode !== LINK).map((e) => e.name));
    const read = (name: string) => fs.readFileSync(path.join(root, name), "utf8");
    const problems = entries.flatMap((e) => {
      if (e.mode !== LINK) return trackedFileProblems([{ name: e.name, text: read(e.name) }]);
      // A link is read with its target from git (as Compose follows it), and with the tracked regular file it points to.
      const link = { name: e.name, text: execFileSync("git", ["-C", root, "cat-file", "blob", e.object], { encoding: "utf8" }), mode: LINK };
      const to = linkTarget(link);
      return trackedFileProblems(to !== null && regular.has(to) ? [link, { name: to, text: read(to) }] : [link]);
    });
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

/** A wordpress service whose command exports the marker only after Compose interpolates `${CINATRA_G10_PART:-SITE}`. */
const COMMAND_FRAGMENT = [
  "services:",
  "  wordpress:",
  "    image: busybox",
  '    entrypoint: ["/bin/sh", "-c"]',
  "    command:",
  '      - "export CINATRA_DEV_${CINATRA_G10_PART:-SITE}=1; exec sleep 600"',
  "",
].join("\n");
/** A compose-named link (git mode 120000) whose text is its target, and the tracked file it points to. */
const LINK_FILES = [
  { name: "docker/extra/compose.yml", text: "compose-body.txt", mode: "120000" },
  { name: "docker/extra/compose-body.txt", text: COMMAND_FRAGMENT },
];

describe("the marker readers read interpolation in every value, the root .env and tracked compose-named links", () => {
  it("refuses a command of another service that gets the marker through interpolation", () => {
    const text = VALID.replace("    image: postgres\n", '    image: postgres\n    command:\n      - "export CINATRA_DEV_${CINATRA_G10_PART:-SITE}=1; exec sleep 600"\n');
    expect(text).toContain("CINATRA_DEV_${CINATRA_G10_PART:-SITE}=1");
    expectReason(markerProblems(text), "interpolation");
  });

  it("refuses an entrypoint of another service that gets the marker through a default without a colon", () => {
    const text = VALID.replace("    image: postgres\n", "    image: postgres\n    entrypoint: \"sh -c 'export CINATRA_DEV_${CINATRA_G10_PART-SITE}=1'\"\n");
    expect(text).toContain("CINATRA_DEV_${CINATRA_G10_PART-SITE}=1");
    expectReason(markerProblems(text), "interpolation");
  });

  it("refuses a lifecycle hook of another service that gets the marker through a nested default", () => {
    const text = VALID.replace(
      "    image: postgres\n",
      '    image: postgres\n    post_start:\n      - command: ["sh", "-c", "export CINATRA_DEV_${CINATRA_G10_A:-${CINATRA_G10_B:-SI}TE}=1"]\n',
    );
    expect(text).toContain("${CINATRA_G10_A:-${CINATRA_G10_B:-SI}TE}");
    expectReason(markerProblems(text), "interpolation");
  });

  it("refuses a value with a $ form that Compose does not read", () => {
    const text = VALID.replace("    image: postgres\n", '    image: "postgres:${PG_TAG"\n');
    expect(text).toContain('    image: "postgres:${PG_TAG"\n');
    expectReason(markerProblems(text), "interpolation");
  });

  it("accepts interpolations whose values do not name the marker", () => {
    // A function as the replacement: in a replacement string, "$$" stands for one "$".
    const text = VALID.replace(
      "    image: postgres\n",
      () => '    image: "postgres:${PG_TAG:-16}"\n    healthcheck:\n      test: ["CMD-SHELL", "pg_isready -U $${PGUSER:-postgres}"]\n    labels:\n      key: "${CINATRA_G10_A:-${CINATRA_G10_B:-}}"\n',
    );
    expect(text).toContain("$${PGUSER:-postgres}");
    expect(markerProblems(text)).toEqual([]);
  });

  it("refuses another root compose file whose command gets the marker through interpolation", () => {
    expectReason(rootFileProblems(COMMAND_FRAGMENT), "interpolation");
  });

  it("refuses a tracked compose file whose command gets the marker through interpolation", () => {
    expectReason(trackedFileProblems([{ name: "docker/extra/compose.override.yml", text: COMMAND_FRAGMENT }]), "interpolation");
  });

  it("refuses a tracked .env file at the root, which Compose reads for interpolation", () => {
    expectReason(trackedFileProblems([{ name: ".env", text: "CINATRA_G10_PART=SITE\n" }]), "env");
  });

  it("reads a tracked compose-named link as the compose text of its target", () => {
    const problems = trackedFileProblems(LINK_FILES);
    expect(problems.filter((p) => p.startsWith("interpolation: docker/extra/compose.yml: ")), JSON.stringify(problems)).not.toEqual([]);
  });

  it("refuses a tracked compose-named link that does not point to a tracked file of the list", () => {
    const files = [{ name: "docker/extra/compose.yml", text: "../../../outside/compose.yml", mode: "120000" }];
    expectReason(trackedFileProblems(files), "link");
  });
});
