#!/usr/bin/env node
// Identity-surface coupling gate — blocks NEW dangerous name-coupling
// (the identity-surface ruling, "the middle path": accept
// the unavoidable name-references as a documented exempt class, FIX the
// genuinely dangerous kinds, and ADD this lightweight gate so the dangerous
// kinds cannot creep back).
//
// The sibling pinned-empty coupling gates
// (core-extension-instance-coupling-ban, core-extension-import-ban,
// extension-import-ban) pin a LEXEME (a concrete extension package NAME or an
// `extensions/<scope>/<name>` path), not extension IDENTITY. The owner ruling
// sanctioned the unavoidable identity surfaces (env-var names, role-typed
// capability ids shared via a single SDK constant, the connector slug catalog,
// namespaced object-type ids) as an exempt class — see
// scripts/audit/extension-coupling-gates.md. This gate guards the two
// genuinely DANGEROUS subsets the ruling singled out to FIX:
//
//   (A) AUTH-ROUTE-GUARD public-route allowlist naming a concrete extension.
//       The security-adjacent danger: a public-route exemption keyed on a
//       specific extension package name / route segment (the dangling
//       per-extension exception the ruling called out). The legitimate path —
//       widget-stream slugs — is the GENERATED, manifest-derived
//       GENERATED_WIDGET_STREAM_PUBLIC_PATHS list (no extension name in the
//       guard source). This check FAILS if any hand-written string literal in
//       the guard's PUBLIC_* / SETUP_* arrays carries a path SEGMENT that
//       EXACTLY equals a real extension package short-name, or embeds an
//       extension PACKAGE ID — i.e. a NEW hand-pinned per-extension public
//       exemption.
//
//   (B) RE-DECLARED SDK capability constants — HOST CONSUMER side only. The
//       SDK (packages/sdk-extensions) is the single authority for capability
//       ids: it exports them as `*_CAPABILITY` / `*_CAPABILITY_ID` string
//       constants. The HOST (`src/`) is the CONSUMER the constant exists for —
//       a host file that RE-DECLARES one of those exact string values as its
//       own `const`/`let`/`var` (instead of importing the SDK constant), or
//       passes the literal directly to registerCapabilityProvider("…") /
//       resolveCapabilityProviders("…"), silently drifts if the SDK value ever
//       changes. This check FAILS on any such re-declaration / direct-literal
//       call in `src/` — import the SDK constant instead (precedent:
//       src/lib/llm-toolbox-providers.ts imports LLM_TOOLBOX_CAPABILITY;
//       src/lib/email-send-providers.ts now imports EMAIL_SEND_CAPABILITY).
//       SCOPE NOTE: extension PRODUCER serverEntry graphs register via
//       `ctx.capabilities.registerProvider("<id>", …)` using the id LITERAL —
//       by design, NOT scanned here: extension serverEntry imports of the SDK
//       stay TYPE-ONLY (held at 0 by host-peer-value-import-ban), so a producer
//       cannot import the VALUE constant; the producer-side id literal is the
//       frozen serialization contract. See "Identity-surface exempt class" in
//       scripts/audit/extension-coupling-gates.md.
//
// This gate is STATELESS (no baseline): every dangerous-class occurrence is a
// hard failure, so it can never accumulate a tolerated floor. It is read-only
// and self-contained (regex over comment-stripped source); it excludes tests /
// __tests__ / __mocks__ / fixtures and packages/sdk-extensions itself (the
// authority that legitimately DECLARES the constants).
//
// Usage:
//   node scripts/audit/identity-coupling-gate.mjs    # check (default + only mode)

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertExtensionsPresent } from "./lib/assert-extensions-cloned.mjs";
import { stripComments } from "./lib/strip-comments.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const EXTENSIONS_ROOT = join(REPO_ROOT, "extensions");
const SDK_SRC = join(REPO_ROOT, "packages", "sdk-extensions", "src");
const AUTH_GUARD = join(REPO_ROOT, "src", "lib", "auth-route-guard.ts");

function isTestPath(rel) {
  return (
    /\.(test|spec)\.m?[tj]sx?$/.test(rel) ||
    /\/__tests__\//.test(rel) ||
    /\/__mocks__\//.test(rel) ||
    /\/tests?\//.test(rel) ||
    /\/fixtures?\//.test(rel)
  );
}

function walk(dir, acc) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === ".next" || entry === "dist" || entry === "vendor") continue;
      walk(full, acc);
    } else if (/\.(ts|tsx|mts|js|mjs|jsx)$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Real extension identities derived from `extensions/<scope>/<name>/`:
 *   - shortNames: the `<name>` directory leaf (the route-segment / slug form);
 *   - packageIds: the `name` from each extension's package.json (the
 *     `@scope/name` lexeme form).
 * Exported for unit testing.
 */
export function discoverExtensionIdentities(extRoot = EXTENSIONS_ROOT) {
  const shortNames = new Set();
  const packageIds = new Set();
  if (!existsSync(extRoot)) return { shortNames, packageIds };
  for (const scope of readdirSync(extRoot)) {
    const scopeDir = join(extRoot, scope);
    try {
      if (!statSync(scopeDir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const name of readdirSync(scopeDir)) {
      const pkgDir = join(scopeDir, name);
      let isDir = false;
      try {
        isDir = statSync(pkgDir).isDirectory();
      } catch {
        /* ignore */
      }
      if (!isDir) continue;
      shortNames.add(name);
      const manifest = join(pkgDir, "package.json");
      if (existsSync(manifest)) {
        try {
          const pkgName = JSON.parse(readFileSync(manifest, "utf8")).name;
          if (typeof pkgName === "string" && pkgName) packageIds.add(pkgName);
        } catch {
          /* skip unreadable manifest */
        }
      }
    }
  }
  return { shortNames, packageIds };
}

/** Exact-string SDK capability id values exported as `*_CAPABILITY` /
 * `*_CAPABILITY_ID` from packages/sdk-extensions/src. Map<value, constName>.
 * Exported for unit testing. */
export function discoverSdkCapabilityValues(sdkSrc = SDK_SRC) {
  const values = new Map();
  if (!existsSync(sdkSrc)) return values;
  const re = /export\s+const\s+([A-Z0-9_]*CAPABILITY(?:_ID)?)\s*=\s*"([^"]+)"/g;
  for (const file of walk(sdkSrc, [])) {
    const rel = relative(REPO_ROOT, file).split("\\").join("/");
    if (isTestPath(rel)) continue;
    const code = stripComments(readFileSync(file, "utf8"));
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(code)) !== null) {
      // First declaration wins (constants are single-authority); ignore dups.
      if (!values.has(m[2])) values.set(m[2], m[1]);
    }
  }
  return values;
}

/** String literals (single/double-quoted AND no-substitution template literals)
 * in source. Template literals are extracted only when they carry NO `${...}`
 * substitution (a static route string is the dangerous case; a dynamic one
 * cannot be a hand-pinned per-extension exemption). Exported for unit testing. */
export function stringLiterals(code) {
  const out = [];
  const re =
    /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|`([^`\\$]*(?:\\.[^`\\$]*)*)`/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const v = m[1] ?? m[2] ?? m[3] ?? "";
    out.push(v);
  }
  return out;
}

/**
 * (A) Auth-route-guard per-extension public-route exemptions. A literal route
 * is dangerous when one of its `/`-delimited path SEGMENTS EXACTLY equals a
 * real extension short-name, OR when it embeds a real extension PACKAGE ID.
 * Exact-segment matching (not substring) so a host route like
 * `/api/wordpress/bundle.js` is NOT flagged by the `wordpress-mcp-connector`
 * extension. Exported for unit testing.
 */
export function authGuardExtensionRouteFindings(guardCode, identities) {
  const { shortNames, packageIds } = identities;
  const code = stripComments(guardCode);
  const findings = [];
  for (const lit of stringLiterals(code)) {
    if (!lit) continue;
    for (const pkgId of packageIds) {
      if (lit.includes(pkgId)) {
        findings.push(`${lit} — embeds extension package id ${pkgId}`);
      }
    }
    // route segments: split on "/" and ":" (catch /api/<ext>/ and <ext>:cap)
    const segments = lit.split(/[/:]/).filter(Boolean);
    for (const seg of segments) {
      if (shortNames.has(seg)) {
        findings.push(`${lit} — path segment "${seg}" is a real extension short-name`);
      }
    }
  }
  return [...new Set(findings)].sort();
}

/**
 * (B) Re-declared SDK capability constants in a host src file. Returns
 * findings: a `const`/`let`/`var X = "<value>"` whose value is an SDK
 * capability id, or a registerCapabilityProvider("<value>") /
 * resolveCapabilityProviders("<value>") direct-literal call with such a value.
 * `code` must already be comment-stripped. Exported for unit testing.
 */
export function capabilityRedeclarationFindings(rel, code, sdkValues) {
  const findings = [];
  // const/let/var ASSIGNMENT to a string literal that equals an SDK value.
  // Tolerates an optional TS type annotation (`: string`) and BOTH quote
  // styles (`"..."` / `'...'`), so `const X: string = 'email-send'` is caught.
  const declRe = /\b(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::[^=]+)?=\s*(?:"([^"]+)"|'([^']+)')/g;
  let m;
  while ((m = declRe.exec(code)) !== null) {
    const name = m[1];
    const value = m[2] ?? m[3];
    if (sdkValues.has(value)) {
      findings.push(
        `${rel} :: redeclares SDK capability id "${value}" as const ${name} ` +
          `(import ${sdkValues.get(value)} from "@cinatra-ai/sdk-extensions" instead)`,
      );
    }
  }
  // Direct literal calls bypassing the SDK constant (both quote styles).
  const callRe = /\b(?:register|resolve)CapabilityProviders?\(\s*(?:"([^"]+)"|'([^']+)')/g;
  while ((m = callRe.exec(code)) !== null) {
    const value = m[1] ?? m[2];
    if (sdkValues.has(value)) {
      findings.push(
        `${rel} :: passes SDK capability id "${value}" as a string literal to a ` +
          `capability-registry call (import ${sdkValues.get(value)} from "@cinatra-ai/sdk-extensions" instead)`,
      );
    }
  }
  return findings;
}

function scanCapabilityRedeclarations(sdkValues, repoRoot = REPO_ROOT) {
  const findings = [];
  const srcRoot = join(repoRoot, "src");
  if (!existsSync(srcRoot)) return findings;
  for (const file of walk(srcRoot, [])) {
    const rel = relative(repoRoot, file).split("\\").join("/");
    if (isTestPath(rel)) continue;
    const code = stripComments(readFileSync(file, "utf8"));
    findings.push(...capabilityRedeclarationFindings(rel, code, sdkValues));
  }
  return findings.sort();
}

function main() {
  // Fail-closed: the auth-route check needs the cloned-back extension tree to
  // derive the real-extension identity set, or it would pass vacuously.
  assertExtensionsPresent(REPO_ROOT, "identity-coupling-gate");

  const identities = discoverExtensionIdentities();
  const sdkValues = discoverSdkCapabilityValues();

  if (sdkValues.size === 0) {
    console.error(
      "[identity-coupling-gate] FAIL-CLOSED: found ZERO SDK capability constants under " +
        "packages/sdk-extensions/src — the SDK authority is missing or unreadable; refusing to run vacuously.",
    );
    process.exit(1);
  }

  let failed = false;

  // (A) auth-route-guard. Fail CLOSED if the guard file is missing/moved — the
  // public-route allowlist is the security-adjacent surface this half guards;
  // a silently-skipped check would be a protection regression.
  if (!existsSync(AUTH_GUARD)) {
    console.error(
      `[identity-coupling-gate] FAIL-CLOSED: ${relative(REPO_ROOT, AUTH_GUARD)} not found — the auth-route-guard ` +
        `public-route check cannot run. If the guard moved, update AUTH_GUARD in this gate. Refusing to pass vacuously.`,
    );
    process.exit(1);
  }
  {
    const guardFindings = authGuardExtensionRouteFindings(
      readFileSync(AUTH_GUARD, "utf8"),
      identities,
    );
    if (guardFindings.length) {
      failed = true;
      console.error(
        "[identity-coupling-gate] FAIL — auth-route-guard public-route allowlist names a concrete extension " +
          "(route the public widget-stream slugs through the generated GENERATED_WIDGET_STREAM_PUBLIC_PATHS list, " +
          "and enforce auth inside the route handler — never hand-pin a per-extension public exemption):",
      );
      guardFindings.forEach((f) => console.error("  + " + f));
    }
  }

  // (B) re-declared SDK capability constants
  const redecl = scanCapabilityRedeclarations(sdkValues);
  if (redecl.length) {
    failed = true;
    console.error(
      "[identity-coupling-gate] FAIL — host src/ re-declares SDK-owned capability id literal(s) " +
        "(the SDK is the single authority — import the *_CAPABILITY / *_CAPABILITY_ID constant):",
    );
    redecl.forEach((f) => console.error("  + " + f));
  }

  if (failed) process.exit(1);

  console.log(
    `[identity-coupling-gate] OK — no dangerous identity-surface coupling ` +
      `(auth-route-guard names no concrete extension; host src/ re-declares none of the ${sdkValues.size} SDK capability ids — extension producer literals are the sanctioned frozen contract). ` +
      `Sanctioned identity surfaces (env-var names, role-typed capability ids via SDK constants, the connector slug ` +
      `catalog, namespaced object-type ids) are the documented exempt class — see scripts/audit/extension-coupling-gates.md.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
