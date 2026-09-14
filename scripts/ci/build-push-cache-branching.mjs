#!/usr/bin/env node
// Buildx cache-backend branching guard (cinatra#3267).
//
// WHY: the GitHub Actions cache backend (`cache-from`/`cache-to: type=gha`) is
// served by a per-run Actions cache service that only answers GitHub-hosted
// runners. On the self-hosted runner class this repo routes its image builds
// to, buildx dies inside the build at "importing cache manifest from gha" with
// an HTML error page where a cache manifest belongs, and the whole image build
// fails. A build that caches must therefore choose its cache backend from the
// runner it landed on: `type=gha` on a GitHub-hosted runner (unchanged
// behaviour), a runner-local `type=local` directory otherwise.
//
// WHAT THIS GUARDS: every `cache-from:`/`cache-to:` on every
// `docker/build-push-action` step in .github/workflows must be an EXPRESSION
// carrying BOTH arms — the exact `type=gha...` string for
// `runner.environment == 'github-hosted'`, and a `type=local...` fallback for
// everything else — so a new build step (or an edit flattening one back to a
// literal) cannot silently reintroduce the failure on the self-hosted class.
// It also checks the coupling that makes the local arm work: each workflow
// declares one self-hosted-only preparer step per cached build step, and that
// preparer is what computes and exports the cache directory.
//
// Enforcement surface: scripts/ci/__tests__/build-push-cache-branching.test.mjs
// runs this guard against the real repo inside the root Vitest suite, so a
// regression reds a required check. The CLI form is for local runs:
// `node scripts/ci/build-push-cache-branching.mjs`.
//
// Pre-install-safe: node builtins only (no YAML dependency — the step reader
// below is a deliberately small, unit-tested reader of the block-sequence
// subset these workflow files use), matching the merge-group coverage guard.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** The env var each workflow's self-hosted preparer step exports. */
export const CACHE_DIR_ENV = "LOCAL_BUILDX_CACHE_DIR";

/**
 * Read every `docker/build-push-action` step out of a workflow file, with the
 * cache-from/cache-to lines inside it. Block-sequence reader: a step starts at
 * a `- ` item and ends at the next non-blank line indented at or below that
 * item's own column (a sibling item, or the key that closes the sequence).
 */
export function parseBuildPushSteps(text) {
  const lines = text.split("\n");
  const steps = [];
  let i = 0;
  while (i < lines.length) {
    const m = /^(\s*)- (?=\S)/.exec(lines[i]);
    if (!m) {
      i += 1;
      continue;
    }
    const indent = m[1].length;
    let j = i + 1;
    while (j < lines.length) {
      const line = lines[j];
      if (line.trim() !== "" && line.search(/\S/) <= indent) break;
      j += 1;
    }
    const block = lines.slice(i, j);
    if (block.some((l) => /^\s*(?:- )?uses:\s*docker\/build-push-action@/.test(l))) {
      const nameLine = block.find((l) => /^\s*(?:- )?name:\s*\S/.test(l));
      const name = nameLine ? /name:\s*(.+?)\s*$/.exec(nameLine)[1] : "(unnamed step)";
      const cacheSites = [];
      block.forEach((line, k) => {
        const c = /^\s*(cache-from|cache-to):\s*(\S.*?)\s*$/.exec(line);
        if (c) cacheSites.push({ key: c[1], value: c[2], line: i + k + 1 });
      });
      steps.push({ name, line: i + 1, cacheSites });
    }
    i = j;
  }
  return steps;
}

/** How many self-hosted preparer steps a workflow declares (one per cached build step). */
export function countCacheDirPreparers(text) {
  return text.split("\n").filter((l) => l.includes(`${CACHE_DIR_ENV}=`) && l.includes("GITHUB_ENV")).length;
}

/**
 * The shape rules, per cache site. Fails CLOSED: anything the reader cannot
 * recognise as a two-armed expression is a problem, never a silent pass.
 */
export function checkCacheSite({ file, step, key, value, line }) {
  const where = `${file}:${line} ${key} on step '${step}'`;
  const problems = [];
  if (!/^\$\{\{.*\}\}$/.test(value)) {
    problems.push(
      `${where}: value is a literal (${value}) — it must be an expression choosing the cache backend from runner.environment (cinatra#3267: type=gha is not served to the self-hosted runner class)`,
    );
    return problems;
  }
  if (!/runner\.environment\s*==\s*'github-hosted'/.test(value)) {
    problems.push(`${where}: expression does not branch on runner.environment == 'github-hosted'`);
  }
  if (!/'type=gha[^']*'/.test(value)) {
    problems.push(`${where}: expression has no quoted type=gha arm — the GitHub-hosted behaviour must be preserved verbatim`);
  }
  if (!/type=local/.test(value)) {
    problems.push(`${where}: expression has no type=local arm for the self-hosted runner class`);
  } else if (key === "cache-from" && !/type=local,src=/.test(value)) {
    problems.push(`${where}: the type=local import arm must read a directory (src=)`);
  } else if (key === "cache-to" && !/type=local,dest=[^']*mode=max/.test(value)) {
    problems.push(`${where}: the type=local export arm must write a directory (dest=) with mode=max, mirroring the gha arm`);
  }
  if (value.includes("type=local") && !value.includes(`env.${CACHE_DIR_ENV}`)) {
    problems.push(`${where}: the type=local arm must read the directory the preparer step exported as env.${CACHE_DIR_ENV}`);
  }
  return problems;
}

/** Check one workflow file: every cache site, plus the preparer-step coupling. */
export function checkWorkflow({ file, text }) {
  const steps = parseBuildPushSteps(text);
  const problems = [];

  const rawUses = (text.match(/uses:\s*docker\/build-push-action@/g) || []).length;
  if (rawUses !== steps.length) {
    problems.push(
      `${file}: the step reader found ${steps.length} docker/build-push-action step(s) but the file names the action ${rawUses} time(s) — refusing to pass a file it cannot read (fail closed)`,
    );
    return problems;
  }
  if (steps.length === 0) return problems;

  for (const step of steps) {
    for (const site of step.cacheSites) problems.push(...checkCacheSite({ file, step: step.name, ...site }));
  }

  const cached = steps.filter((s) => s.cacheSites.length > 0).length;
  const preparers = countCacheDirPreparers(text);
  if (preparers !== cached) {
    problems.push(
      `${file}: ${cached} cached build step(s) but ${preparers} step(s) exporting ${CACHE_DIR_ENV} — every cached build needs its own self-hosted preparer step, or the type=local arm resolves to an empty path`,
    );
  }
  return problems;
}

/** IO wrapper: run the guard against a repo checkout. */
export function runGuard(repoRoot) {
  const wfDir = path.join(repoRoot, ".github", "workflows");
  const problems = [];
  for (const file of fs.readdirSync(wfDir).sort()) {
    if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
    const text = fs.readFileSync(path.join(wfDir, file), "utf8");
    if (!text.includes("docker/build-push-action@")) continue;
    problems.push(...checkWorkflow({ file: `.github/workflows/${file}`, text }));
  }
  return { ok: problems.length === 0, problems };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const repoRoot = process.argv[2] ?? path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
  const { ok, problems } = runGuard(repoRoot);
  if (ok) {
    console.log("build-push-cache-branching: OK — every build-push-action cache site branches on runner.environment.");
  } else {
    for (const p of problems) console.error(`::error::build-push-cache-branching: ${p}`);
    process.exit(1);
  }
}
