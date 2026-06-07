#!/usr/bin/env node
/**
 * Extension dev-fixtures static gate (required status check).
 *
 * Every extension that declares `cinatra.devFixtures` (a path) MUST ship a
 * well-formed, DECLARATIVE fixture file. The host's dev-only seeder is
 * fire-and-forget — a malformed file would only surface as a swallowed dev-boot
 * warning — so this gate validates every declared file at CI time and FAILS the
 * build on any violation.
 *
 * The validation rules mirror `parseDevFixtures` in
 * `packages/sdk-extensions/src/dev-fixtures.ts` (the leaf SDK validator the
 * runtime seeder uses). Kept self-contained here (a .mjs gate cannot import the
 * package's .ts) — `scripts/audit/__tests__/dev-fixtures-gate.test.mjs` pins the
 * two in agreement against the real proof fixture.
 *
 * Exit codes: 0 = clean, 1 = findings, 2 = scanner error.
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = process.cwd();
const EXTENSIONS_ROOT = join(REPO_ROOT, "extensions");
const SURFACES = ["setting", "object"];
const FORBIDDEN_KEYS = ["sql", "js", "fn", "function", "exec", "eval", "secret", "secrets"];

/** Validate a parsed fixture file. Returns an array of error strings (empty = ok). */
export function validateDevFixtureFile(parsed) {
  const errors = [];
  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  if (!isObj(parsed)) return ["top-level must be an object { version?, fixtures: [...] }"];
  if (!Array.isArray(parsed.fixtures)) return ["`fixtures` must be an array"];
  if (parsed.fixtures.length === 0) errors.push("`fixtures` must declare at least one entry");
  if (
    "version" in parsed &&
    parsed.version !== undefined &&
    (typeof parsed.version !== "number" || !Number.isInteger(parsed.version) || parsed.version < 1)
  ) {
    errors.push("`version` must be a positive integer when present");
  }
  const seen = new Set();
  parsed.fixtures.forEach((f, i) => {
    const at = `fixtures[${i}]`;
    if (!isObj(f)) {
      errors.push(`${at}: must be an object`);
      return;
    }
    for (const k of Object.keys(f)) {
      if (FORBIDDEN_KEYS.includes(k.toLowerCase())) errors.push(`${at}: forbidden key "${k}" (declarative data only)`);
    }
    if (typeof f.id !== "string" || f.id.trim() === "") errors.push(`${at}: \`id\` must be a non-empty string`);
    else if (seen.has(f.id)) errors.push(`${at}: duplicate fixture id "${f.id}"`);
    else seen.add(f.id);
    if (!SURFACES.includes(f.surface)) {
      errors.push(`${at}: \`surface\` must be one of ${JSON.stringify(SURFACES)} (got ${JSON.stringify(f.surface)})`);
      return;
    }
    if (f.surface === "setting") {
      if (typeof f.key !== "string" || f.key.trim() === "") errors.push(`${at}: setting needs a non-empty \`key\``);
      if (!("value" in f) || f.value === undefined) errors.push(`${at}: setting needs a \`value\``);
    } else {
      if (typeof f.typeId !== "string" || f.typeId.trim() === "") errors.push(`${at}: object needs a non-empty \`typeId\``);
      if (!isObj(f.data)) errors.push(`${at}: object needs a \`data\` object`);
      else for (const k of Object.keys(f.data)) {
        if (FORBIDDEN_KEYS.includes(k.toLowerCase())) errors.push(`${at}.data: forbidden key "${k}"`);
      }
    }
  });
  return errors;
}

/** Find every extension package.json that declares `cinatra.devFixtures`. */
export function discoverDeclaredFixtures(root = EXTENSIONS_ROOT) {
  const out = [];
  if (!existsSync(root)) return out;
  for (const vendor of readdirSync(root)) {
    const vendorDir = join(root, vendor);
    if (!statSync(vendorDir).isDirectory()) continue;
    for (const slug of readdirSync(vendorDir)) {
      const dir = join(vendorDir, slug);
      const pkgPath = join(dir, "package.json");
      if (!existsSync(pkgPath)) continue;
      let pkg;
      try {
        pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      } catch {
        continue;
      }
      const declared = pkg?.cinatra?.devFixtures;
      if (typeof declared === "string" && declared.length > 0) {
        out.push({ packageName: pkg.name ?? `${vendor}/${slug}`, dir, filePath: join(dir, declared), declared });
      }
    }
  }
  return out;
}

function main() {
  const declared = discoverDeclaredFixtures();
  const findings = [];
  for (const ext of declared) {
    if (!existsSync(ext.filePath)) {
      findings.push(`${ext.packageName}: cinatra.devFixtures points at "${ext.declared}" but the file does not exist`);
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(ext.filePath, "utf8"));
    } catch (err) {
      findings.push(`${ext.packageName}: ${ext.declared} is not valid JSON — ${err.message}`);
      continue;
    }
    for (const e of validateDevFixtureFile(parsed)) findings.push(`${ext.packageName} (${ext.declared}): ${e}`);
  }

  if (findings.length > 0) {
    console.error("dev-fixtures-gate: FAIL — malformed extension dev fixtures:");
    for (const f of findings) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(`dev-fixtures-gate: clean. ${declared.length} extension(s) declare valid dev fixtures.`);
}

// Run only as a CLI, not when imported by the test.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (err) {
    console.error("dev-fixtures-gate: scanner error —", err);
    process.exit(2);
  }
}
