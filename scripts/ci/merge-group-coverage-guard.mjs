#!/usr/bin/env node
// merge-group coverage guard (engineering#484 — merge-train race fix stage 3).
//
// WHY: a GitHub merge-queue candidate runs required checks under the
// `merge_group` event. A branch-protection REQUIRED context whose workflow
// does not trigger on `merge_group` never reports on the candidate, so the
// queue entry hangs forever on "Expected — Waiting for status" (engineering#482
// calls this the hard stall). This guard makes it impossible to (re)introduce
// such a context silently:
//
//   1. Every context in REQUIRED_CONTEXTS (the committed mirror of the `main`
//      branch-protection required-status-check set) must resolve to exactly ONE
//      workflow in .github/workflows/ whose `on:` triggers include
//      `merge_group` (and `pull_request` — a required context that never runs
//      on PRs blocks every merge outright).
//   2. Every `.github/gate-suite.json` requiredContexts entry must ALSO be
//      merge_group-covered: its caller workflow (declared `callerPath`, or
//      resolved by the "<caller-job> / <reusable-job>" context convention)
//      must trigger on `merge_group`, and a declared `allowedEvents` must be a
//      well-formed non-empty string array that INCLUDES "merge_group"
//      (mirroring the truthful-attribution engine's fail-closed WF-id F1
//      semantics: a present-but-malformed declaration is an error, never a
//      silent skip). Suite contexts must appear in the mirror too, so the two
//      lists cannot drift apart unnoticed.
//
// SCOPE / HONEST LIMIT: branch protection lives in the GitHub API, which a PR
// CI run cannot read (admin-only endpoint), so REQUIRED_CONTEXTS is a
// committed MIRROR — grounded against
// GET /repos/cinatra-ai/cinatra/branches/main/protection on 2026-07-06.
// Adding/removing a required context in branch protection requires updating
// the mirror here in the same change (this file is .github-adjacent
// governance and rides the high-risk review lane via its callers). The guard
// fails CLOSED on anything it cannot resolve or parse.
//
// Enforcement surface: scripts/ci/__tests__/merge-group-coverage-guard.test.mjs
// runs this guard against the real repo inside the root Vitest suite (the
// "gate of record" step of the required `Perpetual system loops invariants`
// job), so a coverage regression reds a required check. The CLI form below is
// for local runs: `node scripts/ci/merge-group-coverage-guard.mjs`.
//
// Pre-install-safe: node builtins only (no YAML dependency — the trigger/job
// extraction below is a deliberately small, unit-tested reader of the
// workflow-file subset this repo uses: top-level `on:` block/flow/scalar and
// top-level `jobs:` keys with an optional first-level `name:`).

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Mirror of the `main` branch-protection required_status_checks.contexts —
// grounded 2026-07-06 (engineering#484). Keep in lockstep with branch
// protection: a context added there without a row here is invisible to this
// guard (see HONEST LIMIT above); a row here without live protection is
// harmless (the guard is a superset check).
export const REQUIRED_CONTEXTS = [
  "RBAC browser e2e",
  "RBAC authz unit tests",
  "CRM migration gates",
  "/agents Playwright smoke",
  "source-leak-gate / source-leak-gate",
  "Core-store schema migration gate",
  "Perpetual system loops invariants",
  "build",
  "ui-design-system-gate / ui-design-system-gate",
  "skills-drift-gate / skills-drift-gate",
  "truthful-attribution-gate / truthful-attribution-gate",
  "proof",
  "secrets-required-gate / secrets-required-gate",
];

const KEY_RE = /^(\s*)(['"]?)([A-Za-z_][\w-]*)\2:\s*(.*?)\s*$/;

const stripComment = (s) => {
  // Good enough for trigger/job lines in this repo: none embed '#' inside a
  // quoted scalar on the lines this parser reads.
  const i = s.indexOf(" #");
  return (i === -1 ? s : s.slice(0, i)).trimEnd();
};

const isBlankOrComment = (l) => l.trim() === "" || l.trimStart().startsWith("#");

/**
 * Extract the set of trigger event names from a workflow file's top-level
 * `on:`. Supports the three forms GitHub accepts: scalar (`on: push`), flow
 * list (`on: [push, pull_request]`) and a block mapping (keys at one indent
 * level; nested config keys/list items are ignored). Returns null when no
 * top-level `on:` is found (caller fails closed).
 */
export function parseTriggers(text) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(['"]?)on\1:\s*(.*)$/);
    if (!m) continue;
    const rest = stripComment(m[2]).trim();
    if (rest !== "") {
      if (rest.startsWith("[")) {
        const inner = rest.replace(/^\[/, "").replace(/\]\s*$/, "");
        return inner
          .split(",")
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
          .filter(Boolean);
      }
      return [rest.replace(/^['"]|['"]$/g, "")];
    }
    // Block mapping: collect keys at the first (shallowest) indent level.
    const triggers = [];
    let indent = null;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (isBlankOrComment(l)) continue;
      if (/^\S/.test(l)) break; // dedent to column 0 => end of the on: block
      const km = stripComment(l).match(KEY_RE);
      if (!km) continue; // list items / scalars nested under a trigger
      const kIndent = km[1].length;
      if (indent === null) indent = kIndent;
      if (kIndent === indent) triggers.push(km[3]);
    }
    return triggers;
  }
  return null;
}

/**
 * Extract top-level jobs as { key, name } (name null when the job declares
 * none). The check-run name GitHub reports — and branch protection matches —
 * is the job `name:` when present, else the job key; `displayNameOf` returns
 * that.
 */
export function parseJobs(text) {
  const lines = text.split(/\r?\n/);
  const jobs = [];
  let inJobs = false;
  let jobIndent = null;
  let cur = null;
  for (const l of lines) {
    if (/^jobs:\s*(#.*)?$/.test(l)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    if (/^\S/.test(l) && l.trim() !== "") break; // next top-level section
    if (isBlankOrComment(l)) continue;
    const km = stripComment(l).match(KEY_RE);
    if (km && (jobIndent === null || km[1].length === jobIndent) && km[4] === "") {
      if (jobIndent === null) jobIndent = km[1].length;
      cur = { key: km[3], name: null };
      jobs.push(cur);
      continue;
    }
    const nm = stripComment(l).match(/^(\s+)name:\s*(.+)$/);
    if (nm && cur && jobIndent !== null && nm[1].length === jobIndent + 2 && cur.name === null) {
      cur.name = nm[2].trim().replace(/^['"]|['"]$/g, "");
    }
  }
  return jobs;
}

export const displayNameOf = (job) => job.name ?? job.key;

/** The job-name portion a required context matches: "x / y" -> caller job "x". */
export const contextJobName = (context) => context.split(" / ")[0];

/**
 * Pure core. `workflows` is [{ file, text }] (file = basename under
 * .github/workflows/). `gateSuite` is the parsed gate-suite.json object (or
 * null to skip suite checks). Returns { ok, problems: string[] }.
 */
export function checkMergeGroupCoverage({ requiredContexts, workflows, gateSuite }) {
  const problems = [];
  const parsed = workflows.map(({ file, text }) => ({
    file,
    triggers: parseTriggers(text),
    jobs: parseJobs(text),
  }));

  const resolve = (context) => {
    const jobName = contextJobName(context);
    const hits = parsed.filter((w) => w.jobs.some((j) => displayNameOf(j) === jobName));
    if (hits.length === 0) {
      problems.push(
        `required context '${context}': no workflow in .github/workflows/ defines a job named '${jobName}' — cannot prove merge_group coverage (failing closed; if the job was renamed, update REQUIRED_CONTEXTS and branch protection together)`,
      );
      return null;
    }
    if (hits.length > 1) {
      problems.push(
        `required context '${context}': job name '${jobName}' is ambiguous across ${hits.map((w) => w.file).join(", ")} — cannot prove which workflow posts the required check (failing closed)`,
      );
      return null;
    }
    return hits[0];
  };

  const requireEvents = (context, wf) => {
    if (wf.triggers === null) {
      problems.push(`required context '${context}': could not parse a top-level 'on:' in ${wf.file} (failing closed)`);
      return;
    }
    for (const ev of ["merge_group", "pull_request"]) {
      if (!wf.triggers.includes(ev)) {
        problems.push(
          `required context '${context}': workflow ${wf.file} does not trigger on '${ev}' — a merge-queue candidate${ev === "pull_request" ? " / PR" : ""} would hang forever on this missing required check (engineering#484)`,
        );
      }
    }
  };

  for (const context of requiredContexts) {
    const wf = resolve(context);
    if (wf) requireEvents(context, wf);
  }

  if (gateSuite != null) {
    const entries = Array.isArray(gateSuite.requiredContexts) ? gateSuite.requiredContexts : [];
    if (!Array.isArray(gateSuite.requiredContexts)) {
      problems.push("gate-suite.json: requiredContexts is not an array (failing closed)");
    }
    for (const entry of entries) {
      const context = typeof entry?.context === "string" ? entry.context : JSON.stringify(entry);
      if (typeof entry?.context !== "string" || entry.context === "") {
        problems.push(`gate-suite.json: entry ${context} has no usable 'context' (failing closed)`);
        continue;
      }
      if (!requiredContexts.includes(entry.context)) {
        problems.push(
          `gate-suite.json: context '${entry.context}' is not in the guard's REQUIRED_CONTEXTS mirror — update the mirror and branch protection together so suite contexts cannot drift uncovered`,
        );
      }
      const wf = resolve(entry.context);
      if (wf) {
        requireEvents(entry.context, wf);
        if (entry.callerPath !== undefined) {
          if (typeof entry.callerPath !== "string" || entry.callerPath === "") {
            problems.push(`gate-suite.json: context '${entry.context}' declares a malformed 'callerPath' (failing closed, WF-id F1 semantics)`);
          } else if (entry.callerPath !== `.github/workflows/${wf.file}`) {
            problems.push(
              `gate-suite.json: context '${entry.context}' declares callerPath '${entry.callerPath}' but the job resolves to .github/workflows/${wf.file} — the suite and the workflows disagree (failing closed)`,
            );
          }
        }
      }
      if (entry.allowedEvents !== undefined) {
        const ae = entry.allowedEvents;
        const wellFormed = Array.isArray(ae) && ae.length > 0 && ae.every((e) => typeof e === "string" && e !== "");
        if (!wellFormed) {
          problems.push(
            `gate-suite.json: context '${entry.context}' declares a malformed 'allowedEvents' (must be a non-empty array of non-empty strings — failing closed, WF-id F1 semantics)`,
          );
        } else if (!ae.includes("merge_group")) {
          problems.push(
            `gate-suite.json: context '${entry.context}' allowedEvents ${JSON.stringify(ae)} excludes 'merge_group' — the gate arm would reject a merge-queue-produced check-run (engineering#484)`,
          );
        }
      }
    }
  }

  return { ok: problems.length === 0, problems };
}

/** IO wrapper: run the guard against a repo checkout. */
export function runGuard(repoRoot) {
  const wfDir = path.join(repoRoot, ".github", "workflows");
  const workflows = fs
    .readdirSync(wfDir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((file) => ({ file, text: fs.readFileSync(path.join(wfDir, file), "utf8") }));
  const gateSuite = JSON.parse(fs.readFileSync(path.join(repoRoot, ".github", "gate-suite.json"), "utf8"));
  return checkMergeGroupCoverage({ requiredContexts: REQUIRED_CONTEXTS, workflows, gateSuite });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const repoRoot = process.argv[2] ?? path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
  const { ok, problems } = runGuard(repoRoot);
  if (ok) {
    console.log(`merge-group-coverage-guard: OK — all ${REQUIRED_CONTEXTS.length} mirrored required contexts (+ gate-suite.json requiredContexts) are merge_group-covered.`);
  } else {
    for (const p of problems) console.error(`::error::merge-group-coverage-guard: ${p}`);
    process.exit(1);
  }
}
