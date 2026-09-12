// merge-readiness-inventory — regenerate / verify `.github/merge-readiness.json`.
//
// engineering#658 item 3. Reviewer's merge-queue recommendation of 2026-09-09.
//
// HOW THE INVENTORY IS REGENERATED (this file IS the record):
//
//   node scripts/ci/merge-readiness-inventory.mjs --write   # rewrite the file
//   node scripts/ci/merge-readiness-inventory.mjs --check    # fail if it drifted
//
//   The expected set is DERIVED from the repository's own workflow files —
//   never hand-listed:
//
//     1. Take every workflow under .github/workflows/ that triggers on BOTH
//        `pull_request` AND `merge_group`: those are exactly the workflows a
//        CANDIDATE runs — a pull-request test merge and a queue entry alike.
//
//        (The card's shorthand for this set is "the check names main's own
//        push produces". That shorthand does not hold in this repository: two
//        currently-required contexts, `proof` and `/agents Playwright smoke`,
//        come from workflows with no `push` arm at all, while main's push
//        additionally produces release/publish names a candidate never
//        reports. Deriving from the candidate events is the same intent —
//        "every check the merge candidate must be green on" — read off the
//        triggers that actually produce them, and it is the only derivation
//        that cannot hang the queue on a name no candidate ever posts.)
//
//     2. Turn each of its jobs into the check-run name GitHub reports:
//          - a normal job          -> the job's `name:` (else its key)
//          - a LOCAL reusable call -> "<caller job> / <called job>", read out
//            of the called workflow file
//          - a REMOTE reusable call -> "<caller job> / <caller job>", the
//            repository's own naming convention for its `uses:` callers (the
//            same convention scripts/ci/merge-group-coverage-guard.mjs
//            resolves required contexts by). A remote reusable's job name
//            cannot be read from this checkout; the convention is asserted by
//            the live required-context set.
//
//     3. Drop the names that cannot be waited on, each recorded with its
//        reason in `excluded`:
//          - "report-only": the job is informational (declares
//            `continue-on-error: true`, or matches a REPORT_ONLY rule below).
//          - "dynamic-name": the job's name is a `${{ }}` expression (a
//            matrix leg), so the check-run name is not knowable statically.
//          - "self": the merge-readiness context itself — the job must never
//            wait on itself.
//
//     4. A job that declares an `if:` guard other than `always()` is marked
//        `skippable: true`: GitHub reports it on the candidate with the
//        `skipped` conclusion when the guard is false, and branch protection
//        counts a skipped required check as satisfied — so the readiness job
//        accepts `skipped` for exactly those contexts and for no others.
//
//     5. Path applicability comes from the workflow's own `pull_request.paths`
//        (else ["**"] for always-on).
//
//   The trusted GitHub App is `github-actions` for every workflow-produced
//   check run in this repository.
//
// The parser is shared with scripts/ci/merge-group-coverage-guard.mjs
// (parseTriggers / parseJobs / displayNameOf), so the two governance readers
// cannot drift apart.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseJobs, parseTriggers, displayNameOf } from "./merge-group-coverage-guard.mjs";
import { INVENTORY_PATH, DEADLINE_MINUTES, validateInventory } from "./merge-readiness.mjs";

export const SELF_CONTEXT = "merge-readiness / merge-readiness";
export const TRUSTED_APP = "github-actions";
export const INVENTORY_VERSION = 1;

/**
 * Names that main's push produces but that must never gate a merge: purely
 * informational reports. Each row carries its reason; a job that declares
 * `continue-on-error: true` is detected automatically and needs no row here.
 */
export const REPORT_ONLY = [
  { match: /-report$/, reason: "report-only workflow (informational; posts findings, never gates)" },
];

const isReportOnlyName = (workflowFile) =>
  REPORT_ONLY.find((r) => r.match.test(workflowFile.replace(/\.ya?ml$/, "")));

const isBlankOrComment = (l) => l.trim() === "" || l.trimStart().startsWith("#");

/** The indented lines of the top-level `on:` block (null when absent). */
function onBlock(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^(['"]?)on\1:\s*(#.*)?$/.test(l));
  if (start === -1) return null;
  const out = [];
  for (let j = start + 1; j < lines.length; j++) {
    const l = lines[j];
    if (l.trim() !== "" && /^\S/.test(l)) break;
    out.push(l);
  }
  return out;
}

/** Read a `key: [a, b]` / `key:\n  - a` list nested under an event. */
function readList(lines, from, keyIndent) {
  const head = lines[from];
  const inline = head.slice(head.indexOf(":") + 1).trim().replace(/\s+#.*$/, "");
  if (inline.startsWith("[")) {
    return inline
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .split(",")
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
  }
  const out = [];
  for (let j = from + 1; j < lines.length; j++) {
    const l = lines[j];
    if (isBlankOrComment(l)) continue;
    const m = l.match(/^(\s*)-\s*(.+?)\s*$/);
    if (!m || m[1].length <= keyIndent) break;
    out.push(m[2].replace(/\s+#.*$/, "").replace(/^['"]|['"]$/g, ""));
  }
  return out;
}

/**
 * Config of one trigger inside the top-level `on:` block:
 * { present, branches, paths }. `present:false` when the event is absent.
 */
export function parseEventConfig(text, event) {
  const block = onBlock(text);
  if (block === null) {
    // Scalar / flow form (`on: push`, `on: [push, pull_request]`) carries no
    // branch or path filters.
    const triggers = parseTriggers(text) ?? [];
    return { present: triggers.includes(event), branches: null, paths: null };
  }
  let baseIndent = null;
  for (const l of block) {
    if (isBlankOrComment(l)) continue;
    baseIndent = l.match(/^(\s*)/)[1].length;
    break;
  }
  if (baseIndent === null) return { present: false, branches: null, paths: null };
  let start = -1;
  for (let i = 0; i < block.length; i++) {
    const l = block[i];
    if (isBlankOrComment(l)) continue;
    const m = l.match(/^(\s*)(['"]?)([A-Za-z_][\w-]*)\2:\s*(.*)$/);
    if (!m || m[1].length !== baseIndent) continue;
    if (m[3] === event) { start = i; break; }
  }
  if (start === -1) return { present: false, branches: null, paths: null };
  let branches = null;
  let paths = null;
  for (let i = start + 1; i < block.length; i++) {
    const l = block[i];
    if (isBlankOrComment(l)) continue;
    const m = l.match(/^(\s*)(['"]?)([A-Za-z_][\w-]*)\2:\s*(.*)$/);
    if (!m) continue;
    if (m[1].length <= baseIndent) break;
    if (m[1].length !== baseIndent + 2) continue;
    if (m[3] === "branches") branches = readList(block, i, m[1].length);
    if (m[3] === "paths") paths = readList(block, i, m[1].length);
  }
  return { present: true, branches, paths };
}

/**
 * Per-job attributes this generator needs beyond parseJobs: the `uses:` target
 * and `continue-on-error:`, read at the job's own indent + 2.
 */
export function parseJobAttrs(text) {
  const lines = text.split(/\r?\n/);
  const attrs = new Map();
  let inJobs = false;
  let jobIndent = null;
  let cur = null;
  for (const l of lines) {
    if (/^jobs:\s*(#.*)?$/.test(l)) { inJobs = true; continue; }
    if (!inJobs) continue;
    if (l.trim() !== "" && /^\S/.test(l)) break;
    if (isBlankOrComment(l)) continue;
    const m = l.match(/^(\s*)(['"]?)([A-Za-z_][\w-]*)\2:\s*(.*?)\s*$/);
    if (!m) continue;
    if ((jobIndent === null || m[1].length === jobIndent) && m[4] === "") {
      if (jobIndent === null) jobIndent = m[1].length;
      cur = { uses: null, continueOnError: false, if: null };
      attrs.set(m[3], cur);
      continue;
    }
    if (cur && jobIndent !== null && m[1].length === jobIndent + 2) {
      if (m[3] === "uses") cur.uses = m[4].replace(/\s+#.*$/, "").replace(/^['"]|['"]$/g, "");
      if (m[3] === "continue-on-error") cur.continueOnError = m[4].replace(/\s+#.*$/, "") === "true";
      if (m[3] === "if") cur.if = m[4].replace(/\s+#.*$/, "");
    }
  }
  return attrs;
}

/**
 * The check-run names a workflow file produces, with the source and the
 * report-only flag of each. `readWorkflow(relPath)` returns the text of a
 * repo-relative workflow path (for local `uses: ./...` calls) or null.
 */
export const ALWAYS_IF = new Set(["always()", "${{ always() }}"]);

/** A job-level `if:` other than always() means the job may not report. */
export const isConditional = (ifExpr) => ifExpr != null && !ALWAYS_IF.has(ifExpr.trim());

/** A `${{ ... }}` job name (a matrix leg) has no statically knowable context. */
export const isDynamicName = (name) => typeof name === "string" && name.includes("${{");

export function contextsOf({ file, text, readWorkflow }) {
  const jobs = parseJobs(text);
  const attrs = parseJobAttrs(text);
  const out = [];
  for (const job of jobs) {
    const caller = displayNameOf(job);
    const a = attrs.get(job.key) ?? { uses: null, continueOnError: false, if: null };
    const flags = { reportOnly: a.continueOnError, conditional: isConditional(a.if) };
    if (a.uses && a.uses.startsWith("./")) {
      const inner = readWorkflow(a.uses.replace(/^\.\//, ""));
      const innerJobs = inner === null ? [] : parseJobs(inner);
      if (innerJobs.length === 0) {
        out.push({ context: `${caller} / ${caller}`, ...flags, unresolved: true });
      } else {
        for (const ij of innerJobs) out.push({ context: `${caller} / ${displayNameOf(ij)}`, ...flags });
      }
    } else if (a.uses) {
      out.push({ context: `${caller} / ${caller}`, ...flags });
    } else {
      out.push({ context: caller, ...flags });
    }
  }
  return out;
}

/** Pure derivation. `workflows` is [{ file, text }] (file = basename). */
export function deriveInventory(workflows) {
  const byFile = new Map(workflows.map((w) => [w.file, w.text]));
  const readWorkflow = (rel) => byFile.get(path.basename(rel)) ?? null;

  const expected = [];
  const excluded = [];
  for (const { file, text } of [...workflows].sort((a, b) => a.file.localeCompare(b.file))) {
    const pr = parseEventConfig(text, "pull_request");
    const queue = parseEventConfig(text, "merge_group");
    if (!pr.present || !queue.present) continue;
    const workflow = `.github/workflows/${file}`;
    const reportOnlyRule = isReportOnlyName(file);
    const paths = pr.paths ?? ["**"];
    for (const c of contextsOf({ file, text, readWorkflow })) {
      const drop = (reason) => excluded.push({ context: c.context, workflow, reason });
      if (c.context === SELF_CONTEXT) drop("self: the merge-readiness context itself — the job never waits on itself");
      else if (isDynamicName(c.context)) drop("dynamic-name: the job name is a ${{ }} expression (a matrix leg), so the check-run name is not knowable statically");
      else if (c.reportOnly) drop("report-only: the job declares continue-on-error: true");
      else if (reportOnlyRule) drop(`report-only: ${reportOnlyRule.reason}`);
      else
        expected.push({
          context: c.context,
          app: TRUSTED_APP,
          workflow,
          paths: paths.length > 0 ? paths : ["**"],
          skippable: c.conditional,
        });
    }
  }
  expected.sort((a, b) => a.context.localeCompare(b.context));
  excluded.sort((a, b) => a.context.localeCompare(b.context));

  return {
    version: INVENTORY_VERSION,
    selfContext: SELF_CONTEXT,
    deadlineMinutes: DEADLINE_MINUTES,
    regeneration: {
      write: "node scripts/ci/merge-readiness-inventory.mjs --write",
      check: "node scripts/ci/merge-readiness-inventory.mjs --check",
      derivedFrom:
        "every .github/workflows/*.yml triggering on BOTH pull_request and merge_group (the checks a candidate produces on either event), minus report-only and dynamically-named jobs — each exclusion recorded in 'excluded' with its reason; a job under an if: guard other than always() carries skippable:true",
      generator: "scripts/ci/merge-readiness-inventory.mjs",
    },
    excluded,
    expected,
  };
}

export function readWorkflows(repoRoot) {
  const dir = path.join(repoRoot, ".github", "workflows");
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((file) => ({ file, text: fs.readFileSync(path.join(dir, file), "utf8") }));
}

export const serialize = (inv) => `${JSON.stringify(inv, null, 2)}\n`;

function run(repoRoot, mode) {
  const derived = deriveInventory(readWorkflows(repoRoot));
  const { ok, problems } = validateInventory(derived);
  if (!ok) {
    for (const p of problems) console.error(`::error::merge-readiness-inventory: derived inventory is invalid: ${p}`);
    return 1;
  }
  const file = path.join(repoRoot, INVENTORY_PATH);
  const next = serialize(derived);
  if (mode === "--write") {
    fs.writeFileSync(file, next);
    console.log(`merge-readiness-inventory: wrote ${INVENTORY_PATH} (${derived.expected.length} expected, ${derived.excluded.length} excluded).`);
    return 0;
  }
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (current === next) {
    console.log(`merge-readiness-inventory: OK — ${INVENTORY_PATH} matches the workflows (${derived.expected.length} expected).`);
    return 0;
  }
  console.error(`::error::merge-readiness-inventory: ${INVENTORY_PATH} has drifted from .github/workflows/ — run 'node scripts/ci/merge-readiness-inventory.mjs --write' and commit the result.`);
  return 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const mode = process.argv.includes("--write") ? "--write" : "--check";
  const repoRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
  process.exit(run(repoRoot, mode));
}
