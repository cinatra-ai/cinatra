#!/usr/bin/env node
// ---------------------------------------------------------------------------
// oas-banned-primitives-gate
//
// Companion to scripts/audit/crm-pointer-gate.mjs. That gate skips every
// `/cinatra/oas.json` file (it must not fight the OAS regenerator pipeline),
// which leaves a blind spot: a live agent OAS prompt can still instruct the
// LLM to call a retired primitive at runtime. This gate closes that gap.
//
// It recursively walks every `extensions/**/cinatra/oas.json`, descends into
// the JSON, and inspects the LLM-VISIBLE string fields only — `system`,
// `user`, `description` (the fields the bridge feeds to the model). It fails
// if any of those strings contains:
//   - an exact retired MCP primitive name (lists_* / accounts_* / contacts_*)
//   - an exact legacy entity typeHint (@cinatra-ai/entity-{accounts,contacts}:*)
//   - an `objects_list` call whose nearby text names a CRM entity type
//     (the heavy-field read path the CRM migration retired)
//
// It does NOT ban `objects_get` — campaign bundle flows (the
// @cinatra-ai/campaigns:recipients / email-draft bundles) legitimately read
// their refs via objects_get, and those are not CRM entity reads.
//
// Usage:
//   node scripts/audit/oas-banned-primitives-gate.mjs           # scan, exit 1 on any hit
//   node scripts/audit/oas-banned-primitives-gate.mjs --json    # JSON output
//
// Exit codes: 0 clean · 1 one or more violations.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { assertExtensionsPresent } from "./lib/assert-extensions-cloned.mjs";

const REPO_ROOT = resolve(new URL("../..", import.meta.url).pathname);

// LLM-visible string fields inside an OAS ApiNode / FlowNode. Only these are
// fed to the model, so only these can drive a runtime primitive call.
const LLM_VISIBLE_FIELDS = new Set(["system", "user", "description"]);

// Exact retired MCP primitive names. Word-boundary matched.
const BANNED_PRIMITIVES = [
  "lists_list",
  "lists_get",
  "lists_create",
  "lists_update",
  "lists_delete",
  "lists_members_add",
  "lists_members_remove",
  "lists_members_count",
  "accounts_list",
  "accounts_get",
  "accounts_create",
  "accounts_update",
  "accounts_delete",
  "contacts_list",
  "contacts_get",
  "contacts_create",
  "contacts_update",
  "contacts_delete",
  "contacts_sources_list",
];

// Exact legacy entity typeHints. Substring matched (they're unique enough).
const BANNED_TYPEHINTS = [
  "@cinatra-ai/entity-accounts:account",
  "@cinatra-ai/entity-contacts:contact",
];

function wordBoundary(token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`);
}

const PRIMITIVE_PATTERNS = BANNED_PRIMITIVES.map((token) => ({
  token,
  re: wordBoundary(token),
  reason: `${token} is retired — route through the crm_* facade`,
}));

// objects_list paired with a CRM entity type in the SAME string = the heavy-
// field read path. objects_list on its own (non-CRM type) is fine.
const OBJECTS_LIST_CRM_RE =
  /objects_list[\s\S]{0,120}@cinatra-ai\/entity-(accounts:account|contacts:contact)/;

const SKIP_DIRS = new Set([
  ".git",
  ".next",
  ".turbo",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".pnpm-store",
]);

// Returns absolute paths of every per-agent generated OAS file under
// extensions (the `cinatra/oas.json` files).
async function findOasFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...(await findOasFiles(resolve(dir, entry.name))));
    } else if (entry.isFile() && entry.name === "oas.json") {
      const abs = resolve(dir, entry.name);
      const rel = relative(REPO_ROOT, abs).split(sep).join("/");
      // Only the per-agent generated OAS under a `cinatra/` dir.
      if (rel.includes("/cinatra/oas.json")) out.push(abs);
    }
  }
  return out;
}

/**
 * Recursively walk a parsed JSON value, invoking `onString(fieldName, value)`
 * for every string that sits at a key in LLM_VISIBLE_FIELDS.
 */
function walkLlmStrings(node, onString) {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walkLlmStrings(item, onString);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === "string" && LLM_VISIBLE_FIELDS.has(key)) {
      onString(key, value);
    } else if (value && typeof value === "object") {
      walkLlmStrings(value, onString);
    }
  }
}

/**
 * Scan a single parsed OAS object (or any JSON value) and return findings.
 * Exported for the recurrence-guard test. `label` is the file/path label
 * attached to each finding.
 */
export function scanOasObject(parsed, label = "<oas>") {
  const findings = [];
  walkLlmStrings(parsed, (field, text) =>
    scanString(field, text, label, findings),
  );
  return findings;
}

export { BANNED_PRIMITIVES, BANNED_TYPEHINTS };

function scanString(field, text, relPath, findings) {
  for (const { token, re, reason } of PRIMITIVE_PATTERNS) {
    if (re.test(text)) {
      findings.push({ file: relPath, field, token, reason });
    }
  }
  for (const hint of BANNED_TYPEHINTS) {
    if (text.includes(hint)) {
      findings.push({
        file: relPath,
        field,
        token: hint,
        reason: `legacy entity typeHint ${hint} — CRM entities live in Twenty; use the crm_* facade`,
      });
    }
  }
  if (OBJECTS_LIST_CRM_RE.test(text)) {
    findings.push({
      file: relPath,
      field,
      token: "objects_list(<crm-entity-type>)",
      reason:
        "objects_list over a CRM entity type is the retired heavy-field read path — use crm_account_search / crm_contact_search",
    });
  }
}

async function main() {
  const jsonOut = process.argv.includes("--json");
  // Fail-closed (source-relocation cutover): the extension tree must be cloned
  // back before this gate runs, or it scans zero oas.json and passes vacuously.
  assertExtensionsPresent(REPO_ROOT, "oas-banned-primitives-gate");
  const extDir = resolve(REPO_ROOT, "extensions");
  const oasFiles = await findOasFiles(extDir);

  /** @type {Array<{file:string,field:string,token:string,reason:string}>} */
  const findings = [];

  for (const abs of oasFiles) {
    const relPath = relative(REPO_ROOT, abs).split(sep).join("/");
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(abs, "utf8"));
    } catch (err) {
      findings.push({
        file: relPath,
        field: "<parse>",
        token: "<invalid-json>",
        reason: `OAS JSON failed to parse: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    walkLlmStrings(parsed, (field, text) =>
      scanString(field, text, relPath, findings),
    );
  }

  if (jsonOut) {
    process.stdout.write(JSON.stringify({ findings, scanned: oasFiles.length }, null, 2) + "\n");
    process.exit(findings.length > 0 ? 1 : 0);
  }

  if (findings.length === 0) {
    console.log(
      `oas-banned-primitives-gate: clean. Scanned ${oasFiles.length} OAS file(s).`,
    );
    process.exit(0);
  }

  console.error(
    `oas-banned-primitives-gate: FAIL — ${findings.length} retired-primitive reference(s) in live agent OAS prompts:`,
  );
  for (const f of findings) {
    console.error(`  ${f.file}  [${f.field}]  ${f.token}`);
    console.error(`    ${f.reason}`);
  }
  console.error(
    "\nThe crm-pointer-gate skips OAS files; this companion gate covers the\n" +
      "LLM-visible OAS prompt strings. Migrate the prompt to the crm_* facade.",
  );
  process.exit(1);
}

// Only run the scan when invoked directly (node scripts/audit/...), not when
// imported by the recurrence-guard test.
const invokedDirectly =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  main().catch((err) => {
    console.error("oas-banned-primitives-gate: unexpected error", err);
    process.exit(1);
  });
}
