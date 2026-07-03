#!/usr/bin/env node
/**
 * Connector access-config + packlist static gate (cinatra#951, W1 of the
 * access-scoping epic #950).
 *
 * For every synced extension with `cinatra.kind === "connector"`
 * (extensions/<scope>/<slug>/):
 *
 *   PRESENT `cinatra/config.json` (fail-closed, ALWAYS enforced):
 *     - must parse as JSON and validate against the access-config schema —
 *       formatVersion EXACTLY 1; unknown top-level domains AND unknown keys
 *       inside known domains hard-fail (a misspelled `scpoe` never silently
 *       falls back); `access.scope` declares EXACTLY ONE of default|only; the
 *       scope token ∈ {user,project,team,organization,workspace,admin};
 *     - protected slugs (openai/anthropic/gemini) must declare only:"admin";
 *     - PACKLIST: `package.json#files`, when declared, must include
 *       "cinatra" — a shipped config missing from the packlist would be
 *       silently dropped from the published tarball (worse than absence).
 *
 *   ABSENT `cinatra/config.json` (staged, cinatra#951):
 *     - default: WARN (fleet completeness) — the pinned extension SHAs
 *       predate the W1 stub sweep, so absence cannot hard-fail until the W4
 *       fleet configs + lock bumps land;
 *     - `--require-present`: hard-fail on absence (the closing-wave flip,
 *       cinatra#955) — incl. the protected-slug absence case.
 *
 * The validation rules MIRROR `parseConnectorAccessConfig` in
 * `packages/sdk-extensions/src/access-config.ts` (the single authoritative
 * zod source the host install pipeline + registration reader use). Kept
 * self-contained here (a .mjs gate cannot import the package's .ts) —
 * `scripts/audit/__tests__/connector-access-config-gate.test.mjs` pins the
 * two in agreement against shared proof fixtures (the dev-fixtures-gate
 * precedent).
 *
 * Exit codes: 0 = clean, 1 = findings, 2 = scanner error.
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = process.cwd();
const EXTENSIONS_ROOT = join(REPO_ROOT, "extensions");

export const ACCESS_SCOPES = ["user", "project", "team", "organization", "workspace", "admin"];
export const PROTECTED_SLUGS = { openai: "admin", anthropic: "admin", gemini: "admin" };

/** `@scope/x-connector` / `x-connector` / `x` → `x` (mirror of the SDK normalizer). */
export function accessSlugFromPackageName(packageName) {
  const base = String(packageName).startsWith("@")
    ? String(packageName).split("/")[1] ?? String(packageName)
    : String(packageName);
  return base.endsWith("-connector") ? base.slice(0, -"-connector".length) : base;
}

/**
 * Validate a parsed cinatra/config.json for `packageName`. Returns an array
 * of error strings (empty = ok). MIRRORS parseConnectorAccessConfig — do not
 * change one without the other (the gate test pins agreement).
 */
export function validateAccessConfig(parsed, packageName) {
  const errors = [];
  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  if (!isObj(parsed)) return ["top-level must be a JSON object"];
  if (parsed.formatVersion !== 1) {
    errors.push(`\`formatVersion\` must be EXACTLY 1 (got ${JSON.stringify(parsed.formatVersion)})`);
  }
  for (const key of Object.keys(parsed)) {
    if (key !== "formatVersion" && key !== "access") {
      errors.push(`unknown top-level key "${key}" (fail-closed: unknown domains hard-fail)`);
    }
  }
  let declared = null; // { mode, scope }
  if ("access" in parsed && parsed.access !== undefined) {
    if (!isObj(parsed.access)) {
      errors.push("`access` must be an object");
    } else {
      for (const key of Object.keys(parsed.access)) {
        if (key !== "scope") {
          errors.push(`unknown key "access.${key}" (a misspelled \`scpoe\` never silently falls back)`);
        }
      }
      const scope = parsed.access.scope;
      if (scope !== undefined) {
        if (!isObj(scope)) {
          errors.push("`access.scope` must be an object");
        } else {
          for (const key of Object.keys(scope)) {
            if (key !== "default" && key !== "only") {
              errors.push(`unknown key "access.scope.${key}" (fail-closed)`);
            }
          }
          const hasDefault = scope.default !== undefined;
          const hasOnly = scope.only !== undefined;
          if (hasDefault && hasOnly) errors.push("`access.scope` declares BOTH default and only (XOR)");
          if (!hasDefault && !hasOnly) errors.push("`access.scope` declares NEITHER default nor only (XOR)");
          for (const [k, v] of [["default", scope.default], ["only", scope.only]]) {
            if (v !== undefined && !ACCESS_SCOPES.includes(v)) {
              errors.push(`\`access.scope.${k}\` must be one of ${JSON.stringify(ACCESS_SCOPES)} (got ${JSON.stringify(v)})`);
            }
          }
          if (errors.length === 0 && (hasDefault !== hasOnly)) {
            declared = hasOnly ? { mode: "only", scope: scope.only } : { mode: "default", scope: scope.default };
          }
        }
      }
    }
  }
  // A valid file with no access.scope resolves default:"admin" — then the
  // protected-slug rule still applies (mirrors the SDK).
  if (errors.length === 0 && declared === null) declared = { mode: "default", scope: "admin" };
  const slug = accessSlugFromPackageName(packageName);
  const forced = PROTECTED_SLUGS[slug];
  if (errors.length === 0 && forced && (declared.mode !== "only" || declared.scope !== forced)) {
    errors.push(
      `protected slug "${slug}" must declare access.scope.only:"${forced}" (got ${declared.mode}:"${declared.scope}")`,
    );
  }
  return errors;
}

function listConnectorPackages(root) {
  const out = [];
  if (!existsSync(root)) return out;
  for (const scope of readdirSync(root)) {
    const scopeDir = join(root, scope);
    if (!statSync(scopeDir).isDirectory()) continue;
    for (const slug of readdirSync(scopeDir)) {
      const dir = join(scopeDir, slug);
      const pkgPath = join(dir, "package.json");
      if (!existsSync(pkgPath)) continue;
      let pkg;
      try {
        pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      } catch {
        continue; // other gates own package.json integrity
      }
      if (pkg?.cinatra?.kind !== "connector") continue;
      out.push({ dir, rel: `extensions/${scope}/${slug}`, pkg });
    }
  }
  return out;
}

function main() {
  const requirePresent = process.argv.includes("--require-present");
  const findings = [];
  const warnings = [];

  for (const { dir, rel, pkg } of listConnectorPackages(EXTENSIONS_ROOT)) {
    const name = pkg.name ?? rel;
    const configPath = join(dir, "cinatra", "config.json");
    const present = existsSync(configPath);

    if (!present) {
      const slug = accessSlugFromPackageName(name);
      const note = PROTECTED_SLUGS[slug] ? " (PROTECTED slug — must declare only:\"admin\")" : "";
      if (requirePresent) {
        findings.push(`${rel}: cinatra/config.json is MISSING for kind=connector${note}`);
      } else {
        warnings.push(`${rel}: cinatra/config.json not yet shipped${note} — the W1 stub sweep / W4 fleet configs close this`);
      }
      continue;
    }

    // PACKLIST: a shipped config MUST be packaged.
    if (Array.isArray(pkg.files) && !pkg.files.includes("cinatra")) {
      findings.push(
        `${rel}: package.json#files does not include "cinatra" — the shipped cinatra/config.json would be dropped from the published tarball`,
      );
    }

    let parsed;
    try {
      parsed = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (err) {
      findings.push(`${rel}: cinatra/config.json is not valid JSON: ${err.message}`);
      continue;
    }
    for (const e of validateAccessConfig(parsed, name)) {
      findings.push(`${rel}: cinatra/config.json — ${e}`);
    }
  }

  for (const w of warnings) console.warn(`[connector-access-config-gate] WARN ${w}`);
  if (findings.length > 0) {
    for (const f of findings) console.error(`[connector-access-config-gate] FAIL ${f}`);
    console.error(`[connector-access-config-gate] ${findings.length} finding(s).`);
    process.exit(1);
  }
  console.log("[connector-access-config-gate] OK");
}

const isDirectRun = (() => {
  try {
    return import.meta.url === new URL(`file://${process.argv[1]}`).href ||
      process.argv[1]?.endsWith("connector-access-config-gate.mjs");
  } catch {
    return false;
  }
})();
if (isDirectRun) {
  try {
    main();
  } catch (err) {
    console.error("[connector-access-config-gate] scanner error:", err);
    process.exit(2);
  }
}
