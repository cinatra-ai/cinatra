// The host typecheck spans a companion extension's SOURCE, never its tests
// (cinatra#3091, W3 of #3087).
//
// The host's root tsconfig deliberately reaches into `extensions/`: the
// generated renderer map emits literal imports into each companion package's
// `src/renderers/*`, so those modules must typecheck HERE, against the
// workspace-linked SDK this branch ships, or a generated import would resolve
// to something that does not compile.
//
// A companion's own TESTS are a different matter, and the tree says so: each
// extracted extension repository ships a standalone tsconfig, and whether that
// config compiles the package's `tests/` is the COMPANION's decision — most
// leave them out, a handful opt in. While the host's root config swept every
// companion's tests in regardless, the host was compiling files whose owner
// had chosen not to compile them, against an SDK resolution those suites do
// not use: the companion could not make the host green without a config it
// does not have, and the host failed on code it does not own. Wave 3's re-pin
// surfaced exactly that — four merged display halves whose new suites are
// green under vitest and clean under their own repositories' contract, and
// which the host root typecheck alone rejected.
//
// The contract this suite pins: companion SOURCE stays inside the host
// typecheck, companion TESTS stay outside it, and the exclusion is expressed
// once in the committed root tsconfig.
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const COMPANION_TESTS_GLOB = "extensions/**/tests/**";

/**
 * tsconfig.json is JSONC: line comments appear both on their own line and
 * trailing a value. Strip them string-aware so a `//` inside a string value
 * (a URL, say) survives.
 */
function parseJsonc(raw) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && raw[i + 1] === "/") {
      while (i < raw.length && raw[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    out += ch;
  }
  return JSON.parse(out);
}

function readHostTsconfig() {
  return parseJsonc(readFileSync(join(REPO_ROOT, "tsconfig.json"), "utf8"));
}

/** Every companion that ships a standalone tsconfig, with its include list. */
function companionConfigs() {
  const scopeRoot = join(REPO_ROOT, "extensions", "cinatra-ai");
  const found = [];
  for (const entry of readdirSync(scopeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let raw;
    try {
      raw = readFileSync(join(scopeRoot, entry.name, "tsconfig.json"), "utf8");
    } catch {
      continue; // not every companion ships one
    }
    const include = parseJsonc(raw).include ?? [];
    if (Array.isArray(include) && include.length > 0) {
      found.push({ name: entry.name, include });
    }
  }
  return found;
}

const startsWithAny = (include, prefix) =>
  include.some((p) => String(p).startsWith(prefix));

describe("the host typecheck's reach into the companion tree (#3091)", () => {
  it("excludes every companion package's tests", () => {
    expect(readHostTsconfig().exclude).toContain(COMPANION_TESTS_GLOB);
  });

  it("still reaches companion SOURCE — the generated map imports into it", () => {
    const { include, exclude } = readHostTsconfig();
    // The broad source sweep stays: nothing narrows `extensions/**/src`.
    expect(include).toContain("**/*.ts");
    expect(include).toContain("**/*.tsx");
    for (const pattern of exclude) {
      expect(String(pattern)).not.toMatch(/^extensions\/\*\*\/src\b/);
    }
  });

  it("leaves a companion's own test compilation to the companion, which the tree shows is split", () => {
    // Read the real tree rather than restating a constant. Every companion
    // compiles its own `src/`; on `tests/` the tree genuinely divides, and it
    // is that division which makes a host-imposed rule wrong — the host cannot
    // pick either answer on the companion's behalf.
    const configs = companionConfigs();
    expect(configs.length).toBeGreaterThan(0);

    for (const { name, include } of configs) {
      expect(startsWithAny(include, "src/"), `${name} compiles its own src`).toBe(true);
    }

    const optIn = configs.filter((c) => startsWithAny(c.include, "tests/"));
    const optOut = configs.filter((c) => !startsWithAny(c.include, "tests/"));
    // Non-vacuous on BOTH sides: if either side ever emptied, the tree would
    // have converged on one answer and this exclusion would deserve a re-think
    // rather than a silently passing case.
    expect(optIn.length, "companions that compile their own tests").toBeGreaterThan(0);
    expect(optOut.length, "companions that do not").toBeGreaterThan(0);
  });
});
