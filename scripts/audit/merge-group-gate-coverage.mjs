#!/usr/bin/env node
// ---------------------------------------------------------------------------
// merge-group-gate-coverage — required-gate merge_group trigger guard
// (engineering#484, part of the merge-train-race epic engineering#482).
//
// GitHub's merge queue (merge_group event) requires EVERY branch-protection
// required status check to actually post on a merge-queue candidate — a
// caller workflow that only triggers on pull_request/push never reports on
// merge_group, and a queue entry then hangs forever ("Expected — Waiting for
// status") instead of failing loud. This gate is the static guard the
// engineering#484 acceptance criteria call for: it fails CI if any of the
// known REQUIRED gate caller workflows in .github/workflows/** does not
// declare a `merge_group:` trigger, so a future edit that drops the trigger
// (or a newly-added required gate that forgets it) is caught before merge —
// not discovered later as a silently-hung queue entry once engineering#485
// enables the queue.
//
// SCOPE: this checks the FIVE required-gate callers this repo's branch
// protection names as `<job> / <job>` contexts (source-leak-gate,
// skills-drift-gate, ui-design-system-gate, secrets-required-gate,
// truthful-attribution-gate) — see REQUIRED_GATE_CALLERS below. It is
// deliberately NOT a general `on:` linter for every workflow in the repo:
// most workflows (tests, deploy, docs) have no business firing on
// merge_group, and requiring it universally would be noise, not signal.
//
// Parser is source-line based (matches the actions-pinned-gate.mjs
// convention in this directory), not a YAML library, so this gate needs zero
// `pnpm install` — a lean surface for a supply-chain-adjacent guard. It reads
// only the top-level `on:` block (the block from the `on:` line up to the
// next line at or below its indentation that is a bare top-level key, e.g.
// `permissions:` or `jobs:`), so a `run: |` shell block-scalar body elsewhere
// in the file that happens to mention "merge_group" cannot false-positive
// this check.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The required-gate callers this repo's branch protection names as required
// status checks (verified against live branch protection 2026-07-05). Keep
// this list in lockstep with branch protection + gate-suite.json: a required
// context added here without a matching caller file is a config bug this
// gate should also catch (missingFile below), not silently skip.
export const REQUIRED_GATE_CALLERS = [
  ".github/workflows/source-leak-gate.yml",
  ".github/workflows/skills-drift-gate.yml",
  ".github/workflows/ui-design-system-gate.yml",
  ".github/workflows/secrets-required-gate.yml",
  ".github/workflows/truthful-attribution-gate.yml",
];

// Extracts the top-level `on:` block from a workflow's raw text. Returns the
// block body (everything strictly after the `on:` line, up to but excluding
// the next top-level key) or null if no top-level `on:` key is found.
export function extractOnBlock(text) {
  const lines = text.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^on:\s*(#.*)?$/.test(lines[i]) || /^on:\s+\S/.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  // Single-line form: `on: [push, pull_request]` or `on: push`.
  const inline = lines[start].match(/^on:\s+(\S.*)$/);
  if (inline) return inline[1];

  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    // A top-level key is un-indented, non-blank, non-comment, `key:` shaped.
    if (/^[A-Za-z_][\w-]*:/.test(line)) break;
    body.push(line);
  }
  return body.join("\n");
}

// Strips a trailing YAML comment from a single line. YAML requires a
// comment-introducing `#` to be preceded by whitespace or be at the start of
// the line (a `#` glued to a non-whitespace value char is not a comment) —
// codex-converge MEDIUM: without this, a commented-out `# merge_group:` line
// or a trailing `pull_request: # merge_group later` note satisfied the guard
// even though no real trigger was declared. Good enough for this file's
// narrow `on:`-block scanning; does not attempt full YAML quoted-scalar
// handling (the trigger keys/lists this gate cares about never need it).
function stripLineComment(line) {
  const m = line.match(/(^|\s)#/);
  if (!m) return line;
  const hashIndex = line.indexOf("#", m.index);
  return line.slice(0, hashIndex);
}

// True iff the workflow's top-level `on:` block declares a `merge_group`
// trigger (bare key `merge_group:` on its own line, or present in an inline
// event-list form) — ignoring anything inside a YAML comment.
export function declaresMergeGroup(onBlock) {
  if (onBlock == null) return false;
  const cleaned = onBlock.split("\n").map(stripLineComment).join("\n");
  return /(^|[\s,[])merge_group(:|\s|,|\]|$)/m.test(cleaned);
}

export function checkFile(path, readFile = readFileSync) {
  let text;
  try {
    text = readFile(path, "utf8");
  } catch (err) {
    return { path, ok: false, reason: `could not read file: ${err.message}` };
  }
  const onBlock = extractOnBlock(text);
  if (onBlock == null) {
    return { path, ok: false, reason: "no top-level `on:` key found" };
  }
  if (!declaresMergeGroup(onBlock)) {
    return {
      path,
      ok: false,
      reason: "`on:` block does not declare a `merge_group` trigger",
    };
  }
  return { path, ok: true };
}

export function runGate(callers = REQUIRED_GATE_CALLERS, readFile = readFileSync) {
  return callers.map((p) => checkFile(p, readFile));
}

function isMain() {
  return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
}

if (isMain()) {
  const results = runGate();
  const failures = results.filter((r) => !r.ok);
  for (const r of results) {
    if (r.ok) {
      console.log(`OK    ${r.path} declares merge_group`);
    } else {
      console.error(`FAIL  ${r.path}: ${r.reason}`);
    }
  }
  if (failures.length > 0) {
    console.error(
      `\nmerge-group-gate-coverage: ${failures.length} of ${results.length} required gate caller(s) missing a merge_group trigger.`,
    );
    process.exit(1);
  }
  console.log(
    `\nmerge-group-gate-coverage: all ${results.length} required gate callers declare merge_group.`,
  );
}
