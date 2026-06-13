#!/usr/bin/env node
// SDK ABI README gate — pins the @cinatra-ai/sdk-extensions author-facing ABI
// version so the docs can never drift from the code (cinatra-engineering#152).
//
// The ABI version lives in THREE places that must agree:
//   1. packages/sdk-extensions/src/register.ts  — `SDK_EXTENSIONS_ABI_VERSION`
//      (the authoritative source of truth the loader actually reads),
//   2. packages/sdk-extensions/package.json      — `cinatra.sdkAbiVersion`
//      (the manifest mirror / future publish metadata),
//   3. packages/sdk-extensions/README.md         — the "The SDK ABI is **`X`**"
//      statement in the `## ABI version` section (the author-facing doc).
//
// This gate asserts all three are byte-equal. The real drift it was born to
// catch (README said 2.0.0 while the const said 2.2.0) is exactly this class.
//
// Extraction is fail-closed and anchored — it never reads a changelog line, a
// comment, or a fenced example:
//   - register.ts: anchored `export const SDK_EXTENSIONS_ABI_VERSION = "X"`,
//   - package.json: PARSED as JSON, read by key (never regex-scanned),
//   - README.md: fenced code blocks stripped, then the single canonical
//     "The SDK ABI is **`X`**" sentence. Each pattern must match EXACTLY ONCE.
//
// Wired in CI by .github/workflows/sdk-abi-doc-gate.yml. Also runnable locally:
//   node scripts/audit/sdk-abi-readme-gate.mjs
//
// Exit codes: 0 pass, 1 gate failure (drift / no-match / ambiguous), 2 internal.

import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

export const REGISTER_REL = "packages/sdk-extensions/src/register.ts";
export const PACKAGE_JSON_REL = "packages/sdk-extensions/package.json";
export const README_REL = "packages/sdk-extensions/README.md";

const SEMVER = String.raw`\d+\.\d+\.\d+`;

// Strip fenced code blocks (``` / ~~~); keep inline `code` spans (the canonical
// statement wraps the version in backticks). Mirrors the org gate's stripper.
export function stripCodeFences(text) {
  const lines = text.split("\n");
  const out = [];
  let fence = null;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (fence === null) {
      const m = trimmed.match(/^(```+|~~~+)/);
      if (m) {
        fence = m[1][0].repeat(m[1].length);
        continue;
      }
      out.push(line);
    } else {
      const m = trimmed.match(/^(```+|~~~+)\s*$/);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
    }
  }
  return out.join("\n");
}

// Extract exactly one capture-group-1 value from `text`; { value } or { error }.
function extractOne(text, pattern, where) {
  const re = new RegExp(pattern, "gm");
  const hits = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    hits.push(m[1]);
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  if (hits.length === 0) return { error: `${where}: pattern did not match (the line moved or was deleted — drift)` };
  if (hits.length > 1) return { error: `${where}: pattern matched ${hits.length} times (ambiguous)` };
  return { value: hits[0] };
}

export function extractRegisterAbi(source) {
  return extractOne(
    source,
    `^export const SDK_EXTENSIONS_ABI_VERSION = "(${SEMVER})" as const;`,
    REGISTER_REL,
  );
}

export function extractPackageAbi(pkgText) {
  let pkg;
  try {
    pkg = JSON.parse(pkgText);
  } catch (e) {
    return { error: `${PACKAGE_JSON_REL}: not valid JSON — ${e.message}` };
  }
  const v = pkg?.cinatra?.sdkAbiVersion;
  if (typeof v !== "string") {
    return { error: `${PACKAGE_JSON_REL}: cinatra.sdkAbiVersion missing or not a string` };
  }
  if (!new RegExp(`^${SEMVER}$`).test(v)) {
    return { error: `${PACKAGE_JSON_REL}: cinatra.sdkAbiVersion ${JSON.stringify(v)} is not X.Y.Z` };
  }
  return { value: v };
}

export function extractReadmeAbi(readmeText) {
  const scanned = stripCodeFences(readmeText);
  return extractOne(scanned, "The SDK ABI is \\*\\*`(" + SEMVER + ")`\\*\\*", README_REL);
}

// Pure: run the three-way assertion over the three file contents.
export function checkAbiSync({ registerSource, packageJson, readme }) {
  const errors = [];
  const reg = extractRegisterAbi(registerSource);
  const pkg = extractPackageAbi(packageJson);
  const doc = extractReadmeAbi(readme);
  for (const r of [reg, pkg, doc]) if (r.error) errors.push(r.error);

  let ok = false;
  const values = { register: reg.value, package: pkg.value, readme: doc.value };
  if (errors.length === 0) {
    ok = reg.value === pkg.value && pkg.value === doc.value;
    if (!ok) {
      errors.push(
        `SDK ABI drift — register.ts=${JSON.stringify(reg.value)}, ` +
          `package.json(cinatra.sdkAbiVersion)=${JSON.stringify(pkg.value)}, ` +
          `README.md=${JSON.stringify(doc.value)} — all three must be byte-equal`,
      );
    }
  }
  return { ok, errors, values };
}

export function runGate(repoRoot) {
  const read = (rel) => readFileSync(resolve(repoRoot, rel), "utf8");
  let inputs;
  try {
    inputs = {
      registerSource: read(REGISTER_REL),
      packageJson: read(PACKAGE_JSON_REL),
      readme: read(README_REL),
    };
  } catch (e) {
    return { ok: false, fatal: true, errors: [`cannot read SDK files — ${e.message}`] };
  }
  return checkAbiSync(inputs);
}

function main() {
  const repoRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  const { ok, errors, fatal, values } = runGate(repoRoot);
  if (ok) {
    console.log(`[sdk-abi-readme-gate] PASS — SDK ABI ${JSON.stringify(values.register)} is in sync across register.ts, package.json, and README.md.`);
    process.exit(0);
  }
  console.error("[sdk-abi-readme-gate] FAIL:");
  for (const e of errors) console.error(`  ${e}`);
  console.error(
    `\nThe SDK ABI version must be byte-equal in:\n` +
      `  - ${REGISTER_REL} (SDK_EXTENSIONS_ABI_VERSION — source of truth)\n` +
      `  - ${PACKAGE_JSON_REL} (cinatra.sdkAbiVersion)\n` +
      `  - ${README_REL} ("The SDK ABI is **\`X.Y.Z\`**" in the ## ABI version section)\n`,
  );
  process.exit(fatal ? 2 : 1);
}

// Robust direct-invocation guard: compare resolved real paths, not a raw
// `file://${argv[1]}` string (symlinks / paths needing URL escaping would
// otherwise skip main() and exit 0 without running the gate).
const isDirect =
  process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
if (isDirect) {
  try {
    main();
  } catch (e) {
    console.error("[sdk-abi-readme-gate] fatal:", e);
    process.exit(2);
  }
}
