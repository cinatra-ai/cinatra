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
 *   ABSENT `cinatra/config.json` (HARD-FAIL — the cinatra#955 closing-wave
 *   flip): every synced `kind:"connector"` package MUST ship the config. The
 *   W1 staging WARN existed only until the W4 fleet configs + lock bumps
 *   landed (they did — 29/29 pinned finals ship a declared config); absence
 *   is now a finding, incl. the protected-slug absence case.
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

/**
 * MIRROR of `packages/sdk-extensions/src/extension-protection.ts` — the generic,
 * KIND-AGNOSTIC `protected` declaration domain (cinatra#1927). A TOP-LEVEL
 * boolean sibling of `access` / `assistant`, accepted structurally by BOTH file
 * validators below and interpreted by neither. Fail-closed: present-but-not-a-
 * boolean is a finding (never coerced). Kept self-contained here (a .mjs gate
 * cannot import the package's .ts); the mirror tests pin the two in agreement.
 */
export const EXTENSION_PROTECTION_KEY = "protected";

/** Validate the `protected` domain of a parsed config. Returns error strings. */
export function validateProtectionDeclaration(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  if (!(EXTENSION_PROTECTION_KEY in parsed)) return [];
  const value = parsed[EXTENSION_PROTECTION_KEY];
  if (value === undefined || typeof value === "boolean") return [];
  return [
    `\`${EXTENSION_PROTECTION_KEY}\` must be a boolean (got ${JSON.stringify(value)}) — fail-closed, never coerced`,
  ];
}

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
    if (key !== "formatVersion" && key !== "access" && key !== EXTENSION_PROTECTION_KEY) {
      errors.push(`unknown top-level key "${key}" (fail-closed: unknown domains hard-fail)`);
    }
  }
  // cinatra#1927: the generic protection domain is a known top-level sibling.
  errors.push(...validateProtectionDeclaration(parsed));
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

// ---------------------------------------------------------------------------
// Assistant declaration mirror (cinatra#1874, Epic #1873 W1).
//
// An assistant is an `agent`-kind extension whose cinatra/config.json carries an
// `assistant` block. This gate ALSO scans agent packages and fails RED on a
// MALFORMED assistant block (AC#6). Kept self-contained here (a .mjs gate cannot
// import the package's .ts) — it MIRRORS `safeParseAssistantDeclaration` in
// `packages/sdk-extensions/src/assistant-declaration.ts` (the authoritative zod
// source). `scripts/audit/__tests__/assistant-declaration-gate.test.mjs` pins the
// two in agreement against a shared fixture matrix; do not change one validator
// without the other.
//
// A schema-valid block ALWAYS projects to a valid assistant_config (persona +
// skillBundle are required in both; the strict block strips nothing extra), so
// this file/block mirror is sufficient — no projection re-validation is needed.
// ---------------------------------------------------------------------------

/** The only `formatVersion` / assistant-block `abiVersion` understood. */
export const ASSISTANT_DECLARATION_FORMAT_VERSION = 1;
export const ASSISTANT_DECLARATION_ABI_VERSION = 1;
export const ASSISTANT_LAUNCH_KINDS = ["local", "remote"];
export const ASSISTANT_DELIVERY_KINDS = ["host-runtime", "webhook", "mcp-poll"];
export const ASSISTANT_MCP_RESTRICTIONS = ["org-members", "platform-admins"];
/** A normalized flat namespace token (mirror of the SDK `FLAT_TOKEN_RE`). */
export const FLAT_TOKEN_RE = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/;

/** Cheap presence probe (mirror of the SDK `hasAssistantBlock`): does this parsed
 *  config.json declare an assistant? Does NOT validate the block. */
export function hasAssistantBlock(parsed) {
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    "assistant" in parsed &&
    parsed.assistant !== undefined &&
    parsed.assistant !== null
  );
}

/**
 * Validate a parsed cinatra/config.json's assistant DOMAIN for `packageName`.
 * Returns an array of error strings (empty = ok — i.e. `{ ok:true }` from
 * `safeParseAssistantDeclaration`, whether or not an assistant block is present).
 * MIRRORS `safeParseAssistantDeclaration` — the file schema
 * `{ formatVersion, access?, assistant? }` (`.strict()`) plus the `.strict()`
 * assistant block. Do not change one without the other (the gate test pins
 * agreement). `access` is validated by {@link validateAccessConfig}, not here.
 */
export function validateAssistantConfig(parsed, packageName) {
  const errors = [];
  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  const isNeStr = (v) => typeof v === "string" && v.length > 0;
  const isNeStrArray = (v) => Array.isArray(v) && v.every((x) => isNeStr(x));
  if (!isObj(parsed)) return ["top-level must be a JSON object"];
  if (parsed.formatVersion !== ASSISTANT_DECLARATION_FORMAT_VERSION) {
    errors.push(`\`formatVersion\` must be EXACTLY ${ASSISTANT_DECLARATION_FORMAT_VERSION} (got ${JSON.stringify(parsed.formatVersion)})`);
  }
  for (const key of Object.keys(parsed)) {
    if (
      key !== "formatVersion" &&
      key !== "access" &&
      key !== "assistant" &&
      key !== EXTENSION_PROTECTION_KEY
    ) {
      errors.push(`unknown top-level key "${key}" (fail-closed: unknown domains hard-fail)`);
    }
  }
  // cinatra#1927: the generic protection domain is a known top-level sibling.
  errors.push(...validateProtectionDeclaration(parsed));
  if (!("assistant" in parsed) || parsed.assistant === undefined) return errors;
  const block = parsed.assistant;
  if (!isObj(block)) {
    errors.push("`assistant` must be an object");
    return errors;
  }
  const known = new Set([
    "abiVersion", "displayName", "preferredTag", "persona", "skillBundle",
    "allowedTools", "allowedAgents", "modelPrefs", "mcp", "launch", "delivery",
  ]);
  for (const key of Object.keys(block)) {
    if (!known.has(key)) errors.push(`unknown key "assistant.${key}" (fail-closed: strict)`);
  }
  if (block.abiVersion !== ASSISTANT_DECLARATION_ABI_VERSION) {
    errors.push(`\`assistant.abiVersion\` must be EXACTLY ${ASSISTANT_DECLARATION_ABI_VERSION} (got ${JSON.stringify(block.abiVersion)})`);
  }
  if (!isNeStr(block.displayName)) errors.push("`assistant.displayName` must be a non-empty string");
  if (typeof block.preferredTag !== "string" || !FLAT_TOKEN_RE.test(block.preferredTag)) {
    errors.push(`\`assistant.preferredTag\` must be a normalized flat token (got ${JSON.stringify(block.preferredTag)})`);
  }
  if (!isNeStr(block.persona)) errors.push("`assistant.persona` must be a non-empty string");
  if (!isNeStrArray(block.skillBundle)) errors.push("`assistant.skillBundle` must be an array of non-empty strings");
  if (block.allowedTools !== undefined && !isNeStrArray(block.allowedTools)) {
    errors.push("`assistant.allowedTools` must be an array of non-empty strings");
  }
  if (block.allowedAgents !== undefined && !isNeStrArray(block.allowedAgents)) {
    errors.push("`assistant.allowedAgents` must be an array of non-empty strings");
  }
  if (block.modelPrefs !== undefined) {
    if (!isObj(block.modelPrefs)) {
      errors.push("`assistant.modelPrefs` must be an object");
    } else {
      for (const key of Object.keys(block.modelPrefs)) {
        if (key !== "provider" && key !== "model" && key !== "temperature") {
          errors.push(`unknown key "assistant.modelPrefs.${key}" (fail-closed: strict)`);
        }
      }
      if (block.modelPrefs.provider !== undefined && !isNeStr(block.modelPrefs.provider)) {
        errors.push("`assistant.modelPrefs.provider` must be a non-empty string");
      }
      if (block.modelPrefs.model !== undefined && !isNeStr(block.modelPrefs.model)) {
        errors.push("`assistant.modelPrefs.model` must be a non-empty string");
      }
      if (block.modelPrefs.temperature !== undefined &&
        (typeof block.modelPrefs.temperature !== "number" || block.modelPrefs.temperature < 0 || block.modelPrefs.temperature > 2)) {
        errors.push("`assistant.modelPrefs.temperature` must be a number in [0,2]");
      }
    }
  }
  if (block.mcp !== undefined) {
    if (!isObj(block.mcp)) {
      errors.push("`assistant.mcp` must be an object");
    } else {
      for (const key of Object.keys(block.mcp)) {
        if (key !== "enabled" && key !== "restriction") {
          errors.push(`unknown key "assistant.mcp.${key}" (fail-closed: strict)`);
        }
      }
      if (block.mcp.enabled !== undefined && typeof block.mcp.enabled !== "boolean") {
        errors.push("`assistant.mcp.enabled` must be a boolean");
      }
      if (block.mcp.restriction !== undefined && !ASSISTANT_MCP_RESTRICTIONS.includes(block.mcp.restriction)) {
        errors.push(`\`assistant.mcp.restriction\` must be one of ${JSON.stringify(ASSISTANT_MCP_RESTRICTIONS)}`);
      }
    }
  }
  if (!isObj(block.launch)) {
    errors.push("`assistant.launch` must be an object");
  } else {
    for (const key of Object.keys(block.launch)) {
      if (key !== "kind" && key !== "targetProvider") {
        errors.push(`unknown key "assistant.launch.${key}" (fail-closed: strict)`);
      }
    }
    if (!ASSISTANT_LAUNCH_KINDS.includes(block.launch.kind)) {
      errors.push(`\`assistant.launch.kind\` must be one of ${JSON.stringify(ASSISTANT_LAUNCH_KINDS)}`);
    }
    if (block.launch.targetProvider !== undefined && !isNeStr(block.launch.targetProvider)) {
      errors.push("`assistant.launch.targetProvider` must be a non-empty string");
    }
  }
  if (!isObj(block.delivery)) {
    errors.push("`assistant.delivery` must be an object");
  } else {
    for (const key of Object.keys(block.delivery)) {
      if (key !== "kind") errors.push(`unknown key "assistant.delivery.${key}" (fail-closed: strict)`);
    }
    if (!ASSISTANT_DELIVERY_KINDS.includes(block.delivery.kind)) {
      errors.push(`\`assistant.delivery.kind\` must be one of ${JSON.stringify(ASSISTANT_DELIVERY_KINDS)}`);
    }
  }
  return errors;
}

function listPackagesByKind(root, kind) {
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
      if (pkg?.cinatra?.kind !== kind) continue;
      out.push({ dir, rel: `extensions/${scope}/${slug}`, pkg });
    }
  }
  return out;
}

function listConnectorPackages(root) {
  return listPackagesByKind(root, "connector");
}

function listAgentPackages(root) {
  return listPackagesByKind(root, "agent");
}

function main() {
  const findings = [];

  for (const { dir, rel, pkg } of listConnectorPackages(EXTENSIONS_ROOT)) {
    const name = pkg.name ?? rel;
    const configPath = join(dir, "cinatra", "config.json");
    const present = existsSync(configPath);

    if (!present) {
      // HARD-FAIL on absence (cinatra#955 closing wave): the W1 staged WARN is
      // deleted — the fleet ships configs, so a config-less connector is a
      // regression, not a known gap.
      const slug = accessSlugFromPackageName(name);
      const note = PROTECTED_SLUGS[slug] ? " (PROTECTED slug — must declare only:\"admin\")" : "";
      findings.push(`${rel}: cinatra/config.json is MISSING for kind=connector${note}`);
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

  // AGENT packages (cinatra#1874 W1): a config.json is OPTIONAL, but one that
  // declares an `assistant` block MUST be well-formed (AC#6). A malformed block
  // fails the gate RED. A block-less agent config is validated only for its file
  // shape when it declares an assistant; a package with no assistant block is
  // left to the other domains' gates (this gate owns the assistant domain here).
  for (const { dir, rel, pkg } of listAgentPackages(EXTENSIONS_ROOT)) {
    const name = pkg.name ?? rel;
    const configPath = join(dir, "cinatra", "config.json");
    if (!existsSync(configPath)) continue; // agents need not ship a config.json

    let parsed;
    try {
      parsed = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (err) {
      // Only a concern here if it was meant to carry an assistant block; JSON
      // integrity in general is another gate's job.
      findings.push(`${rel}: cinatra/config.json is not valid JSON: ${err.message}`);
      continue;
    }
    if (!hasAssistantBlock(parsed)) continue; // not an assistant — nothing to enforce

    // PACKLIST: a shipped assistant config MUST be packaged.
    if (Array.isArray(pkg.files) && !pkg.files.includes("cinatra")) {
      findings.push(
        `${rel}: package.json#files does not include "cinatra" — the shipped assistant cinatra/config.json would be dropped from the published tarball`,
      );
    }
    for (const e of validateAssistantConfig(parsed, name)) {
      findings.push(`${rel}: cinatra/config.json assistant block — ${e}`);
    }
  }

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
