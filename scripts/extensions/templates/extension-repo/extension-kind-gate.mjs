#!/usr/bin/env node
// ---------------------------------------------------------------------------
// extension-kind-gate — self-contained, zero-dependency per-kind CI gate for an
// extracted Cinatra extension repo.
//
// This file is shipped INTO each extracted agent/workflow repo by the
// extraction script (scripts/extensions/extract-extension-repos.mjs) and run by the
// repo's standalone CI (`node extension-kind-gate.mjs --package-root .`).
//
// It MUST stay self-contained — only Node builtins, no `@cinatra-ai/*`
// dependency, no `pnpm dlx`. A public extracted repo's CI runs unauthenticated
// and BEFORE the @cinatra-ai registry is reachable, so a gate that resolves a
// published tool (the retired `pnpm dlx @cinatra-ai/extension-tools` form) would
// fail closed on a registry 404 for every agent/workflow repo. This gate has no
// such dependency.
//
// Scope (intentionally a LIGHT pre-publish sanity gate — the authoritative
// Profile-1.0 BPMN compile + full OAS runtime-invariant validation re-run
// marketplace-side at publish/install):
//   - kind:"agent"    → cinatra/oas.json parses + no retired CRM primitive in
//                        LLM-visible prompt strings (mirrors the monorepo
//                        scripts/audit/oas-banned-primitives-gate.mjs rules).
//   - kind:"workflow" → package.json shape (mirrors
//                        validateWorkflowExtensionPackage) + exactly one
//                        cinatra/workflow.bpmn that is well-formed XML with a
//                        bpmn:definitions root and ≥1 bpmn:process.
//   - any other kind  → pass (no kind-specific gate).
//
// Usage:
//   node extension-kind-gate.mjs                  # gate cwd
//   node extension-kind-gate.mjs --package-root . # gate an explicit dir
//
// Exit codes: 0 clean / pass · 1 one or more violations.
// ---------------------------------------------------------------------------

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join, basename, dirname, relative } from "node:path";

// --------------------------------------------------------------------------
// arg parsing
// --------------------------------------------------------------------------
export function parseArgs(argv) {
  let packageRoot = ".";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--package-root") {
      const value = argv[i + 1];
      if (!value) throw new Error("--package-root requires a value");
      packageRoot = value;
      i++;
    } else if (arg.startsWith("--package-root=")) {
      packageRoot = arg.slice("--package-root=".length);
    }
  }
  return { packageRoot: resolve(packageRoot) };
}

// --------------------------------------------------------------------------
// agent gate — retired-CRM-primitive scan over LLM-visible OAS prompt strings.
// Ported verbatim (rules only) from scripts/audit/oas-banned-primitives-gate.mjs
// so the extracted-repo gate and the monorepo gate stay in lock-step.
// --------------------------------------------------------------------------
const LLM_VISIBLE_FIELDS = new Set(["system", "user", "description"]);

const BANNED_PRIMITIVES = [
  "lists_list", "lists_get", "lists_create", "lists_update", "lists_delete",
  "lists_members_add", "lists_members_remove", "lists_members_count",
  "accounts_list", "accounts_get", "accounts_create", "accounts_update", "accounts_delete",
  "contacts_list", "contacts_get", "contacts_create", "contacts_update", "contacts_delete",
  "contacts_sources_list",
];

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

const OBJECTS_LIST_CRM_RE =
  /objects_list[\s\S]{0,120}@cinatra-ai\/entity-(accounts:account|contacts:contact)/;

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

function scanOasString(field, text, findings) {
  for (const { token, re, reason } of PRIMITIVE_PATTERNS) {
    if (re.test(text)) findings.push({ field, token, reason });
  }
  for (const hint of BANNED_TYPEHINTS) {
    if (text.includes(hint)) {
      findings.push({
        field,
        token: hint,
        reason: `legacy entity typeHint ${hint} — CRM entities live in Twenty; use the crm_* facade`,
      });
    }
  }
  if (OBJECTS_LIST_CRM_RE.test(text)) {
    findings.push({
      field,
      token: "objects_list(<crm-entity-type>)",
      reason:
        "objects_list over a CRM entity type is the retired heavy-field read path — use crm_account_search / crm_contact_search",
    });
  }
}

/** Validate an agent extension at packageRoot. Pure: returns string[] errors. */
export function validateAgent(packageRoot) {
  const errors = [];
  const oasPath = join(packageRoot, "cinatra", "oas.json");
  // The OAS is optional at this gate: an agent without a generated OAS has no
  // LLM-visible prompt strings to scan, so there is nothing to fail on. The
  // marketplace-side validation owns the "agent MUST ship an OAS" contract.
  if (!existsSync(oasPath)) return errors;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(oasPath, "utf8"));
  } catch (err) {
    errors.push(`cinatra/oas.json failed to parse: ${err instanceof Error ? err.message : String(err)}`);
    return errors;
  }
  const findings = [];
  walkLlmStrings(parsed, (field, text) => scanOasString(field, text, findings));
  for (const f of findings) {
    errors.push(`cinatra/oas.json [${f.field}] ${f.token}: ${f.reason}`);
  }
  return errors;
}

// --------------------------------------------------------------------------
// workflow gate — package shape + a single well-formed cinatra/workflow.bpmn.
// Package-shape rules mirror packages/workflows/src/manifest.ts
// (validateWorkflowExtensionPackage). The full Profile-1.0 compile is NOT run
// here (it needs bpmn-moddle + the host compiler); the marketplace re-runs it
// at publish/install. This gate catches the gross errors a public repo CI must
// not miss: wrong kind, missing/inline workflow, missing/duplicate/malformed
// BPMN sidecar.
// --------------------------------------------------------------------------
const WORKFLOW_PACKAGE_NAME_RE = /^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*-workflow$/;

/** Mirror of validateWorkflowExtensionPackage (package.json shape only). */
export function validateWorkflowPackageShape(pkg) {
  const errors = [];
  const cinatra = (pkg && pkg.cinatra) || {};
  if (typeof pkg?.name !== "string" || !WORKFLOW_PACKAGE_NAME_RE.test(pkg.name)) {
    errors.push(`package name must match @<scope>/<slug>-workflow (got ${JSON.stringify(pkg?.name)})`);
  }
  if (cinatra.kind !== "workflow") {
    errors.push(`package.json must declare cinatra.kind: "workflow" (got ${JSON.stringify(cinatra.kind)})`);
  }
  if (cinatra.workflow !== undefined) {
    errors.push("inline cinatra.workflow is forbidden; ship a cinatra/workflow.bpmn sidecar");
  }
  if (typeof cinatra.workflowVersion !== "number" || !Number.isInteger(cinatra.workflowVersion) || cinatra.workflowVersion <= 0) {
    errors.push(`cinatra.workflowVersion must be a positive integer (got ${JSON.stringify(cinatra.workflowVersion)})`);
  }
  const allowed = new Set(["kind", "apiVersion", "workflowVersion", "dependencies"]);
  for (const k of Object.keys(cinatra)) {
    if (!allowed.has(k)) errors.push(`unexpected cinatra key "${k}"`);
  }
  return errors;
}

// The OMG BPMN 2.0 MODEL namespace URI — a real BPMN sidecar MUST declare it.
// Requiring its presence (plus a `definitions` ROOT) rejects look-alike XML such
// as `<x:definitions><x:process/></x:definitions>` that isn't actually BPMN.
const BPMN_MODEL_NS = "http://www.omg.org/spec/BPMN/20100524/MODEL";

/**
 * Light XML well-formedness + BPMN-shape check. Pure (string in → string[] out).
 * Not a full XML parser — a tag-balance walk that catches truncation/malformed
 * markup, and asserts the document is actually BPMN: the BPMN 2.0 MODEL
 * namespace URI is declared, the ROOT element's local name is `definitions`, and
 * there is ≥1 `process` element. The authoritative Profile-1.0 compile re-runs
 * marketplace-side.
 */
export function validateBpmnSanity(xml) {
  const errors = [];
  if (typeof xml !== "string" || xml.trim() === "") {
    errors.push("cinatra/workflow.bpmn is empty");
    return errors;
  }
  // Strip comments, CDATA, declarations, and processing instructions so they do
  // not perturb the tag-balance walk.
  const stripped = xml
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "");

  const prefixOf = (qname) => (qname.includes(":") ? qname.split(":")[0] : "");
  const localOf = (qname) => (qname.includes(":") ? qname.split(":")[1] : qname);

  const tagRe = /<(\/?)([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)((?:[^<>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  const stack = [];
  let m;
  let rootName = null;
  let rootAttrs = "";
  // Process elements counted ONLY when their prefix is bound to the BPMN MODEL
  // namespace (resolved below) — a bare local-name count let look-alikes pass.
  const openTags = []; // { prefix, local } for every opening element
  while ((m = tagRe.exec(stripped)) !== null) {
    const isClose = m[1] === "/";
    const name = m[2];
    const attrs = m[3] || "";
    const selfClose = m[4] === "/";
    if (!isClose) {
      if (rootName === null) {
        rootName = name;
        rootAttrs = attrs;
      }
      openTags.push({ prefix: prefixOf(name), local: localOf(name) });
    }
    if (selfClose) continue;
    if (isClose) {
      const top = stack.pop();
      if (top !== name) {
        errors.push(`malformed BPMN XML: closing </${name}> does not match <${top ?? "(none)"}>`);
        return errors;
      }
    } else {
      stack.push(name);
    }
  }
  if (stack.length > 0) {
    errors.push(`malformed BPMN XML: unclosed element <${stack[stack.length - 1]}>`);
    return errors;
  }
  if (rootName === null) {
    errors.push("BPMN has no root element");
    return errors;
  }

  // Resolve the xmlns declarations ON THE ROOT ELEMENT (not anywhere in the
  // document — a URI in a comment or an unused prefix must not count). The set
  // of prefixes ("" = default ns) bound to the BPMN MODEL namespace.
  const bpmnPrefixes = new Set();
  // Accept BOTH double- and single-quoted attribute values (XML permits either).
  const nsRe = /xmlns(?::([A-Za-z_][\w.-]*))?\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let nm;
  while ((nm = nsRe.exec(rootAttrs)) !== null) {
    const prefix = nm[1] ?? ""; // default ns when no prefix
    const uri = nm[2] ?? nm[3]; // double- or single-quoted value
    if (uri === BPMN_MODEL_NS) bpmnPrefixes.add(prefix);
  }

  if (bpmnPrefixes.size === 0) {
    errors.push(`not a BPMN document: root element does not bind the BPMN 2.0 MODEL namespace (${BPMN_MODEL_NS})`);
    return errors;
  }
  if (localOf(rootName) !== "definitions" || !bpmnPrefixes.has(prefixOf(rootName))) {
    errors.push(`BPMN root must be <definitions> in the BPMN MODEL namespace (got <${rootName}>)`);
  }
  const processCount = openTags.filter((t) => t.local === "process" && bpmnPrefixes.has(t.prefix)).length;
  if (processCount < 1) errors.push("BPMN must declare at least one <process> in the BPMN MODEL namespace");
  return errors;
}

/**
 * Recursively collect every `workflow.bpmn` whose PARENT dir is named `cinatra`
 * (mirrors packages/workflows/src/bpmn/sidecar.ts findAllSidecars). A nested
 * `**​/cinatra/workflow.bpmn` beyond the canonical one is a duplicate.
 */
export function findWorkflowSidecars(packageRoot) {
  const out = [];
  const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        walk(full);
      } else if (e.name === "workflow.bpmn" && basename(dirname(full)) === "cinatra") {
        out.push(full);
      }
    }
  };
  walk(packageRoot);
  return out;
}

/** Validate a workflow extension at packageRoot. Pure-ish: returns string[]. */
export function validateWorkflow(packageRoot) {
  const errors = [];
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  } catch (err) {
    errors.push(`could not read package.json: ${err instanceof Error ? err.message : String(err)}`);
    return errors;
  }
  errors.push(...validateWorkflowPackageShape(pkg));

  const bpmnPath = join(packageRoot, "cinatra", "workflow.bpmn");
  if (!existsSync(bpmnPath)) {
    errors.push("missing required sidecar cinatra/workflow.bpmn");
    return errors;
  }
  // Exactly ONE cinatra/workflow.bpmn (mirror the host duplicate scan) — a nested
  // extra sidecar passes a naive canonical-only check but fails the marketplace parser.
  const allSidecars = findWorkflowSidecars(packageRoot);
  if (allSidecars.length > 1) {
    errors.push(
      `expected exactly one cinatra/workflow.bpmn, found ${allSidecars.length}: ${allSidecars.map((p) => relative(packageRoot, p)).join(", ")}`,
    );
    return errors;
  }
  let xml;
  try {
    xml = readFileSync(bpmnPath, "utf8");
  } catch (err) {
    errors.push(`could not read cinatra/workflow.bpmn: ${err instanceof Error ? err.message : String(err)}`);
    return errors;
  }
  errors.push(...validateBpmnSanity(xml));
  return errors;
}

// --------------------------------------------------------------------------
// dispatch
// --------------------------------------------------------------------------
/** Run the gate for the package at packageRoot. Returns { kind, errors }. */
export function runGate(packageRoot) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  } catch (err) {
    return { kind: undefined, errors: [`could not read package.json at ${packageRoot}: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const kind = pkg?.cinatra?.kind;
  if (kind === "agent") return { kind, errors: validateAgent(packageRoot) };
  if (kind === "workflow") return { kind, errors: validateWorkflow(packageRoot) };
  return { kind, errors: [] };
}

function main() {
  const { packageRoot } = parseArgs(process.argv.slice(2));
  const { kind, errors } = runGate(packageRoot);
  if (errors.length === 0) {
    console.log(
      kind === "agent" || kind === "workflow"
        ? `✓ extension-kind-gate: ${kind} extension passed.`
        : `extension-kind-gate: no kind-specific gate for kind ${JSON.stringify(kind)}.`,
    );
    process.exit(0);
  }
  console.error(`\n✗ extension-kind-gate: ${errors.length} ${kind} violation(s):\n`);
  for (const e of errors) console.error(`  • ${e}`);
  process.exit(1);
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    console.error("extension-kind-gate: unexpected error", err);
    process.exit(1);
  }
}
