#!/usr/bin/env node
// Changed-path detection for a merge-queue candidate (engineering#658 item 1).
//
// WHY: GitHub does not apply a workflow's `paths:` filter to a `merge_group`
// event. A path-filtered suite that declares the trigger therefore fires on
// EVERY queue candidate, including ones that touch nothing it covers. The
// answer cannot be a skipped job — a required check that reports `skipped`
// leaves the queue entry waiting forever — so the workflow answers the path
// question itself, over the group's own base..head range, and ends on a
// deterministic conclusion either way.
//
// The pattern list is READ OUT OF THE WORKFLOW'S OWN `pull_request.paths`
// block rather than copied into a second place: the queue must select on
// exactly the list the pull-request filter selects on, and a hand-copied
// duplicate is a list that drifts (this repo already keeps two such lists in
// lockstep by hand, and that is one too many).
//
// FAIL CLOSED: anything that cannot be read or resolved — an absent pattern
// list, an absent base or head, a git failure — selects the suite. The only
// unacceptable outcome is a candidate that reports success without the suite
// having run on a change the suite covers.
//
// Pre-install-safe: node builtins only (this repo carries no YAML parser, so
// the reader below is a small, unit-tested reader of the workflow subset the
// repo actually uses).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

const isBlankOrComment = (line) => line.trim() === "" || line.trimStart().startsWith("#");
const unquote = (value) => value.trim().replace(/^['"]|['"]$/g, "");

/**
 * The `paths:` list declared under one top-level trigger of a workflow's
 * `on:` block. Returns null when the trigger declares none (the caller then
 * fails closed).
 */
export function parseTriggerPaths(text, trigger) {
  const lines = text.split(/\r?\n/);
  const onIndex = lines.findIndex((line) => /^(['"]?)on\1:\s*$/.test(line));
  if (onIndex === -1) return null;

  let triggerIndent = null;
  let inTrigger = false;
  let inPaths = false;
  let pathsIndent = null;
  const patterns = [];

  for (let i = onIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (isBlankOrComment(line)) continue;
    if (/^\S/.test(line)) break; // dedent to column 0 ends the on: block
    const indent = line.length - line.trimStart().length;
    const key = /^\s*(['"]?)([A-Za-z_][\w-]*)\1:\s*(.*)$/.exec(line);

    if (key && (triggerIndent === null || indent === triggerIndent)) {
      triggerIndent = indent;
      inTrigger = key[2] === trigger;
      inPaths = false;
      continue;
    }
    if (!inTrigger) continue;
    if (key && indent === triggerIndent + 2) {
      inPaths = key[2] === "paths";
      pathsIndent = indent;
      continue;
    }
    if (!inPaths) continue;
    const item = /^\s*-\s+(.+?)\s*$/.exec(line);
    if (item && pathsIndent !== null && indent > pathsIndent) {
      patterns.push(unquote(item[1]));
    }
  }
  return patterns.length > 0 ? patterns : null;
}

/** One GitHub path-filter pattern as a full-match regular expression. */
export function globToRegExp(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i += 1;
      } else {
        out += "[^/]*";
      }
      continue;
    }
    out += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

export const matchesAnyPattern = (file, patterns) =>
  patterns.some((pattern) => globToRegExp(pattern).test(file));

/**
 * The decision. `applies:false` — the deterministic green stub — is returned
 * ONLY for a well-formed file list that matches no pattern in a well-formed
 * pattern list.
 */
export function selectApplies({ changedFiles, patterns }) {
  if (!Array.isArray(patterns) || patterns.length === 0) {
    return { applies: true, matched: [], reason: "no readable paths list — selecting the suite (fail closed)" };
  }
  if (!Array.isArray(changedFiles)) {
    return { applies: true, matched: [], reason: "no readable changed-file list — selecting the suite (fail closed)" };
  }
  const matched = changedFiles.filter((file) => matchesAnyPattern(file, patterns));
  return matched.length > 0
    ? { applies: true, matched, reason: `${matched.length} changed file(s) match the suite's paths` }
    : { applies: false, matched: [], reason: "no changed file matches the suite's paths" };
}

const defaultGit = (args) =>
  execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** The changed files of the group's own base..head range, or null. */
export function changedFilesInRange({ base, head, git = defaultGit }) {
  if (!base || !head) return null;
  try {
    for (const sha of [base, head]) {
      try {
        git(["cat-file", "-e", `${sha}^{commit}`]);
      } catch {
        git(["fetch", "--no-tags", "origin", sha]);
      }
    }
    return git(["diff", "--name-only", base, head])
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

export function decide(env = process.env, git = defaultGit) {
  const workflow = env.MERGE_GROUP_SELECT_WORKFLOW ?? "";
  if ((env.GITHUB_EVENT_NAME ?? "") !== "merge_group") {
    return {
      applies: true,
      matched: [],
      reason: `the event is ${env.GITHUB_EVENT_NAME || "(none)"} — the workflow's own paths filter already decided`,
    };
  }
  let patterns = null;
  try {
    patterns = parseTriggerPaths(fs.readFileSync(path.join(REPO_ROOT, workflow), "utf8"), "pull_request");
  } catch {
    patterns = null;
  }
  const changedFiles = changedFilesInRange({
    base: (env.MERGE_GROUP_BASE_SHA ?? "").trim(),
    head: (env.MERGE_GROUP_HEAD_SHA ?? "").trim(),
    git,
  });
  return selectApplies({ changedFiles, patterns });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const decision = decide();
  const line = `applies=${decision.applies}\nreason=${decision.reason.replace(/\r?\n/g, " ")}\n`;
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, line);
  console.log(`merge-group-path-select: applies=${decision.applies} — ${decision.reason}`);
}
