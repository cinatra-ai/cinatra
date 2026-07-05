#!/usr/bin/env node
// CI guard: every REQUIRED branch-protection status check must be produced by a
// workflow that ALSO triggers on `merge_group`, and every gate-suite.json
// requiredContexts[] entry that declares `allowedEvents` (or a `callerPath`)
// must be merge_group-aware.
//
// WHY (engineering#484): with a GitHub merge queue enabled, a queue *candidate*
// fires the `merge_group` event on a synthetic commit. A required status check
// whose producing workflow does NOT declare an `on: merge_group` trigger never
// reports on that candidate, so the queue entry hangs forever on an
// "Expected — Waiting for status" check and the whole queue stalls. This guard
// is the tripwire that fails CI the moment a required context is added — or a
// producing workflow's `on:` triggers are edited — without merge_group
// coverage, BEFORE a merge queue is enabled, so the invariant can never
// silently regress.
//
// Sources of truth — all COMMITTED, no network and no branch-protection API
// read (a fork PR's GITHUB_TOKEN cannot read live protection):
//   - .github/branch-protections.json  -> required_status_checks.contexts
//   - CONTEXT_WORKFLOW (below)          -> required context -> producing workflow
//   - .github/workflows/<file>          -> the `on:` trigger block
//   - .github/gate-suite.json           -> requiredContexts[].allowedEvents / callerPath
//
// CONTEXT_WORKFLOW is intentionally hand-maintained. Adding a required context
// to branch-protections.json without a mapping entry here FAILS this guard
// (fail-closed) — exactly the friction that forces the author to name the
// producing workflow and confirm its merge_group coverage. Stale entries (a
// mapping key that is no longer a required context) also fail, keeping the map
// honest.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, "..", "..");
const WORKFLOW_DIR = join(REPO_ROOT, ".github", "workflows");
const BRANCH_PROTECTIONS = join(REPO_ROOT, ".github", "branch-protections.json");
const GATE_SUITE = join(REPO_ROOT, ".github", "gate-suite.json");

// Required status context -> the workflow file (basename in .github/workflows)
// that produces it. Keep this EXACTLY in sync with
// .github/branch-protections.json required_status_checks.contexts; the guard
// asserts the two are the same set.
export const CONTEXT_WORKFLOW = {
  // build-image.yml owns the heavy build/test/e2e required jobs.
  "build": "build-image.yml",
  "RBAC browser e2e": "build-image.yml",
  "Workflows browser e2e": "build-image.yml",
  "Release workflows tests": "build-image.yml",
  "RBAC authz unit tests": "build-image.yml",
  "Core-store schema migration gate": "build-image.yml",
  "Perpetual system loops invariants": "build-image.yml",
  // Dedicated single-purpose required workflows.
  "CRM migration gates": "crm-migration-gate.yml",
  "/agents Playwright smoke": "dashboard-live-verify.yml",
  "proof": "works-after-proof.yml",
  // The 5 org-reusable gate callers (context is "<caller job> / <reusable job>").
  "source-leak-gate / source-leak-gate": "source-leak-gate.yml",
  "ui-design-system-gate / ui-design-system-gate": "ui-design-system-gate.yml",
  "skills-drift-gate / skills-drift-gate": "skills-drift-gate.yml",
  "secrets-required-gate / secrets-required-gate": "secrets-required-gate.yml",
  "truthful-attribution-gate / truthful-attribution-gate": "truthful-attribution-gate.yml",
};

// Extract the top-level `on:` mapping/scalar from a workflow YAML as raw text.
// Dependency-free (no YAML parser is a guaranteed root dep): find the top-level
// `on:` key (column 0), then either return its inline value or the block of
// following lines indented deeper than column 0 (up to the next top-level key).
export function extractOnBlock(yamlText) {
  const lines = yamlText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(?:on|['"]on['"]):(.*)$/);
    if (!m) continue;
    const inline = m[1].trim();
    if (inline) return { inline, body: [] };
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      const ln = lines[j];
      if (ln.trim() === "") { body.push(ln); continue; }
      // A non-comment line at column 0 is the next top-level key -> stop.
      if (/^[^\s#]/.test(ln)) break;
      body.push(ln);
    }
    return { inline: null, body };
  }
  return null;
}

// True when the workflow's `on:` triggers include the `merge_group` event, and
// specifically the TOP-LEVEL event (not a `merge_group` key nested under some
// other event's config, e.g. `push:\n    merge_group: ...`).
export function onDeclaresMergeGroup(yamlText) {
  const block = extractOnBlock(yamlText);
  if (!block) return false;
  if (block.inline) {
    // `on: merge_group` or `on: [push, merge_group]` (flow sequence). Strip a
    // trailing YAML line-comment (` # ...`) first so it does not glue onto the
    // last token.
    const inline = block.inline.replace(/\s+#.*$/, "").trim();
    const items = inline
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .split(",")
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ""));
    return items.includes("merge_group");
  }
  // Block mapping: the event keys sit at the SHALLOWEST indentation inside the
  // `on:` block; any deeper `merge_group:` is nested under another event's
  // config and does NOT declare the top-level event. Match `merge_group:` only
  // at that event-key indent. Blank and comment lines are ignored for both the
  // indent computation and the match.
  const keyLines = block.body.filter(
    (ln) => ln.trim() !== "" && !ln.trimStart().startsWith("#"),
  );
  if (keyLines.length === 0) return false;
  const indentOf = (ln) => ln.length - ln.trimStart().length;
  const eventIndent = Math.min(...keyLines.map(indentOf));
  // Accept both YAML mapping keys (`merge_group:`) and block-sequence items
  // (`- merge_group`) at the event-key indent.
  const EVENT_RE = /^(?:-\s+)?["']?merge_group["']?\s*(?::|$)/;
  return keyLines.some(
    (ln) => indentOf(ln) === eventIndent && EVENT_RE.test(ln.trimStart()),
  );
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

// Compute every coverage defect. Pure over the committed files so the test can
// exercise it against scratch fixtures via the exported helpers.
export function computeDefects({
  requiredContexts,
  contextWorkflow,
  workflowText, // (basename) => string | null
  suiteRequiredContexts, // gate-suite.json requiredContexts[]
} = {}) {
  const defects = [];
  const required = new Set(requiredContexts);
  const mapped = new Set(Object.keys(contextWorkflow));

  // 1. Every required context must be mapped (fail-closed on an unmapped add).
  for (const ctx of required) {
    if (!mapped.has(ctx)) {
      defects.push(
        `required context "${ctx}" has no CONTEXT_WORKFLOW mapping — add its ` +
          `producing workflow to scripts/audit/merge-group-coverage-gate.mjs and ` +
          `ensure that workflow declares \`on: merge_group\`.`,
      );
    }
  }
  // 2. The map must not carry stale entries (keeps it honest / in sync).
  for (const ctx of mapped) {
    if (!required.has(ctx)) {
      defects.push(
        `CONTEXT_WORKFLOW maps "${ctx}" but it is not a required status context ` +
          `in .github/branch-protections.json — remove the stale mapping.`,
      );
    }
  }
  // 3. Each mapped workflow must exist and declare an `on: merge_group` trigger.
  for (const ctx of required) {
    const file = contextWorkflow[ctx];
    if (!file) continue; // already reported as unmapped
    const text = workflowText(file);
    if (text == null) {
      defects.push(
        `required context "${ctx}" maps to .github/workflows/${file}, which does not exist.`,
      );
      continue;
    }
    if (!onDeclaresMergeGroup(text)) {
      defects.push(
        `required context "${ctx}" is produced by .github/workflows/${file}, which ` +
          `does not trigger on \`merge_group\` — a merge-queue candidate would hang ` +
          `forever on this check. Add \`merge_group:\` to its \`on:\` block.`,
      );
    }
  }
  // 4. gate-suite.json: any requiredContexts[] entry that declares allowedEvents
  //    must include merge_group; any callerPath must itself be merge_group-aware.
  for (const entry of suiteRequiredContexts || []) {
    if (Array.isArray(entry.allowedEvents) && !entry.allowedEvents.includes("merge_group")) {
      defects.push(
        `gate-suite.json requiredContexts["${entry.context}"].allowedEvents omits ` +
          `"merge_group" — the gate arm would reject a merge-queue candidate event.`,
      );
    }
    if (entry.callerPath) {
      const base = entry.callerPath.replace(/^\.github\/workflows\//, "");
      const text = workflowText(base);
      if (text == null) {
        defects.push(
          `gate-suite.json requiredContexts["${entry.context}"].callerPath ` +
            `${entry.callerPath} does not exist.`,
        );
      } else if (!onDeclaresMergeGroup(text)) {
        defects.push(
          `gate-suite.json requiredContexts["${entry.context}"].callerPath ` +
            `${entry.callerPath} does not trigger on \`merge_group\`.`,
        );
      }
    }
  }
  return defects;
}

function main() {
  let requiredContexts;
  try {
    requiredContexts = readJson(BRANCH_PROTECTIONS).required_status_checks.contexts;
  } catch (err) {
    console.error(`[merge-group-coverage-gate] FATAL: cannot read branch-protections.json: ${err.message}`);
    process.exit(2);
  }
  let suite;
  try {
    suite = readJson(GATE_SUITE);
  } catch (err) {
    console.error(`[merge-group-coverage-gate] FATAL: cannot read gate-suite.json: ${err.message}`);
    process.exit(2);
  }

  const workflowText = (base) => {
    const p = join(WORKFLOW_DIR, base);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  };

  const defects = computeDefects({
    requiredContexts,
    contextWorkflow: CONTEXT_WORKFLOW,
    workflowText,
    suiteRequiredContexts: suite.requiredContexts,
  });

  if (defects.length > 0) {
    console.error(
      `✗ merge-group-coverage-gate: ${defects.length} coverage defect(s):\n`,
    );
    for (const d of defects) console.error(`  - ${d}`);
    console.error(
      `\nSee engineering#484: every required status context must run on \`merge_group\` ` +
        `or a merge-queue candidate hangs on the missing check.`,
    );
    process.exit(1);
  }

  console.log(
    `✓ merge-group-coverage-gate: ${requiredContexts.length} required context(s) all ` +
      `produced by merge_group-triggered workflows; gate-suite.json allowedEvents/callerPath cover merge_group.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
