#!/usr/bin/env node
// ---------------------------------------------------------------------------
// CHAT-HITL EVIDENCE GATE — one CLI over the two anti-fraud contracts
// (cinatra#2821, epic #2784 S9h).
//
// It catches the two shapes that passed every gate before it:
//
//   (a) THE TEXT POINTER. A held chat dispatch answered by prose that names
//       another surface as the decision path. This CLI reads the user-visible
//       string literals the chat dispatch surface emits and classifies each one
//       through `lib/decision-pointer-contract.mjs`. The files are DISCOVERED
//       (any non-test file under the chat dispatch roots that emits assistant
//       text) and not only listed, so moving the sentence into a new file does
//       not move it out of scope.
//
//   (b) THE MISLABELED CAPTURE. A screenshot filed under a host it does not
//       show. Every acceptance-manifest cell whose NAME claims a lifecycle host
//       must resolve to a record in the committed capture index that observed
//       that host's anchors, on that host's URL class, with a hash matching the
//       image on disk. `lib/capture-record-contract.mjs` owns those rules.
//
// ROLLOUT. The gate is WARN-FIRST: it enforces only on
// branches created after it landed, and the branches that were in flight are
// grandfathered by name. `lib/evidence-gate-rollout.mjs` owns that decision and
// `chat-hitl-evidence-gate.rollout.json` is its committed policy.
//
// Usage:
//   node scripts/ci/chat-hitl-evidence-gate.mjs
//   node scripts/ci/chat-hitl-evidence-gate.mjs --json
//   node scripts/ci/chat-hitl-evidence-gate.mjs --enforce      # ignore warn-first
//   node scripts/ci/chat-hitl-evidence-gate.mjs --branch X --branch-created-at ISO
//
// Exit 0 -> nothing failing (findings may still be printed as warnings);
// exit 1 -> at least one blocking finding on an enforcing branch;
// exit 2 -> the gate itself could not run.
//
// Zero runtime dependencies (node builtins only) so the caller needs no install.
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyDecisionPointer } from "./lib/decision-pointer-contract.mjs";
import {
  bindEvidenceCells,
  parseCellName,
  validateCaptureIndex,
} from "./lib/capture-record-contract.mjs";
import { decideOutcome } from "./lib/evidence-gate-rollout.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = join(__dirname, "..", "..");
export const POLICY_PATH = join(__dirname, "chat-hitl-evidence-gate.rollout.json");
export const CAPTURE_INDEX_PATH = join(__dirname, "chat-hitl-capture-index.json");
export const ACCEPTANCE_MANIFEST_PATH = join(
  "scripts",
  "audit",
  "chat-hitl-acceptance-manifest.json",
);

/** Where deterministic chat-dispatch prose can live. */
export const DISPATCH_ROOTS = ["src/app/api/chat", "packages/chat/src"];

/** Always in scope, discovered or not. */
export const PINNED_DISPATCH_SOURCES = [
  "src/app/api/chat/explicit-dispatch.ts",
  "src/app/api/chat/explicit-dispatch-server.ts",
  "packages/chat/src/inline-agent-run-card.tsx",
];

/**
 * A file is a dispatch-prose source when it emits assistant-visible text from
 * the dispatch path. These markers are the emit sites themselves, so a new file
 * that starts speaking to the user is discovered the day it is written.
 */
export const DISPATCH_MARKERS = [
  'send("text"',
  "send('text'",
  "SYNTHETIC_TOOL_CALL_ID",
  "detectExplicitDispatchDirective",
];

// ---------------------------------------------------------------------------
// Source reading: one pass that knows about comments and strings, so a phrase
// in a `//` comment is not reported as shipped copy and a `//` inside a string
// does not truncate it.
// ---------------------------------------------------------------------------

/**
 * @returns {Array<{value: string, line: number}>} the string/template literals
 */
export function extractStringLiterals(source) {
  const out = [];
  let i = 0;
  let line = 1;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "\n") {
      line += 1;
      i += 1;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") line += 1;
        i += 1;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      const startLine = line;
      let value = "";
      i += 1;
      while (i < n) {
        const ch = source[i];
        if (ch === "\\") {
          // Keep the escaped character, drop the backslash: `\`` inside a
          // template is a backtick in the shipped string, not a delimiter.
          value += source[i + 1] === "n" ? " " : (source[i + 1] ?? "");
          i += 2;
          continue;
        }
        if (ch === quote) {
          i += 1;
          break;
        }
        if (ch === "\n") {
          line += 1;
          if (quote !== "`") break; // an unterminated non-template literal
        }
        if (quote === "`" && ch === "$" && source[i + 1] === "{") {
          // An interpolation is data, not prose: replace it with a neutral
          // placeholder so `${packageName}` cannot read as a surface noun.
          let depth = 1;
          i += 2;
          while (i < n && depth > 0) {
            if (source[i] === "{") depth += 1;
            else if (source[i] === "}") depth -= 1;
            else if (source[i] === "\n") line += 1;
            i += 1;
          }
          value += "VALUE";
          continue;
        }
        value += ch;
        i += 1;
      }
      out.push({ value, line: startLine });
      continue;
    }
    i += 1;
  }
  return out;
}

const IDENTIFIER_LIKE = /^[\w@/.:$-]+$/;

/** Is this literal plausibly a sentence shown to a person? */
export function isProseLiteral(value) {
  const v = value.trim();
  if (v.length < 25) return false;
  if (IDENTIFIER_LIKE.test(v)) return false;
  if (v.startsWith("/") || v.includes("://")) return false;
  const words = v.split(/\s+/).filter(Boolean);
  return words.length >= 4;
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "__tests__") continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.[tj]sx?$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/** The files whose prose this gate reads. */
export function discoverDispatchSources(repoRoot) {
  const found = new Set();
  for (const rel of PINNED_DISPATCH_SOURCES) {
    if (existsSync(join(repoRoot, rel))) found.add(rel);
  }
  for (const root of DISPATCH_ROOTS) {
    const abs = join(repoRoot, root);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) continue;
    for (const file of walk(abs)) {
      let src;
      try {
        src = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (DISPATCH_MARKERS.some((m) => src.includes(m))) {
        found.add(relative(repoRoot, file));
      }
    }
  }
  return [...found].sort();
}

/** Arm (a): the text pointer. */
export function scanDispatchProse(repoRoot) {
  const findings = [];
  for (const rel of discoverDispatchSources(repoRoot)) {
    let source;
    try {
      source = readFileSync(join(repoRoot, rel), "utf8");
    } catch {
      continue;
    }
    for (const lit of extractStringLiterals(source)) {
      if (!isProseLiteral(lit.value)) continue;
      const { pointer, findings: hits } = classifyDecisionPointer(lit.value);
      if (!pointer) continue;
      findings.push({
        key: `pointer-text:${rel}:${lit.line}`,
        code: "pointer-text",
        detail: `${rel}:${lit.line} presents another surface as the decision path (${hits
          .map((h) => `${h.arm}: "${h.match}"`)
          .join("; ")}). A parked turn owes the CARD, in the turn that parked.`,
      });
    }
  }
  return findings;
}

/** Every cell an acceptance-manifest row cites by name. */
export function collectCitedCells(repoRoot, manifestPath = ACCEPTANCE_MANIFEST_PATH) {
  const abs = join(repoRoot, manifestPath);
  if (!existsSync(abs)) return [];
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(abs, "utf8"));
  } catch {
    return [];
  }
  const cited = [];
  const seen = new Set();
  const visit = (node, rowLabel) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, rowLabel);
      return;
    }
    if (!node || typeof node !== "object") return;
    // The rows carry no id, so a row is named by the criterion it answers --
    // that is what a person reading the finding needs in order to find it.
    const label =
      typeof node.criterion === "string"
        ? `row "${node.criterion.slice(0, 60)}${node.criterion.length > 60 ? "…" : ""}"`
        : rowLabel;
    for (const value of Object.values(node)) {
      if (typeof value === "string") {
        const base = value.split("/").pop() ?? value;
        const claim = parseCellName(base);
        if (!claim) continue;
        const key = `${label}::${claim.cell}`;
        if (seen.has(key)) continue;
        seen.add(key);
        cited.push({
          cell: claim.cell,
          citedBy: `${manifestPath}${label ? ` ${label}` : ""}`,
        });
      } else {
        visit(value, label);
      }
    }
  };
  visit(manifest, null);
  return cited;
}

/** Arm (b): the mislabeled capture. */
export function scanCaptureEvidence(repoRoot, io = {}) {
  const findings = [];
  const indexPath = io.captureIndexPath ?? CAPTURE_INDEX_PATH;
  let index = { records: [] };
  if (existsSync(indexPath)) {
    try {
      index = JSON.parse(readFileSync(indexPath, "utf8"));
    } catch (err) {
      return [
        {
          key: "evidence/index-unreadable",
          code: "evidence/index-unreadable",
          detail: `the capture index could not be parsed: ${err.message}`,
        },
      ];
    }
  }
  const result = validateCaptureIndex(index, { repoRoot });
  for (const v of result.violations) {
    findings.push({
      key: `${v.code}:${v.cell ?? "index"}`,
      code: v.code,
      detail: `${v.cell ? `${v.cell}: ` : ""}${v.detail}`,
    });
  }
  const cited = collectCitedCells(repoRoot, io.manifestPath);
  const seen = new Set(findings.map((f) => f.key));
  for (const v of bindEvidenceCells(cited, result, io)) {
    const key = `${v.code}:${v.cell}`;
    // The same cell is cited by several manifest rows; it is ONE finding.
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ key, code: v.code, detail: `${v.cell}: ${v.detail}` });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Where this run sits in the rollout
// ---------------------------------------------------------------------------

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

export function resolveBranchContext(repoRoot, argv = {}) {
  const branch =
    argv.branch ||
    process.env.GITHUB_HEAD_REF ||
    (process.env.GITHUB_REF_NAME ?? "") ||
    git(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot) ||
    null;
  if (argv.branchCreatedAt) {
    return { branch, branchCreatedAt: argv.branchCreatedAt };
  }
  const trunk = git(["rev-parse", "--verify", "--quiet", "origin/main"], repoRoot)
    ? "origin/main"
    : "main";
  const first = git(
    ["log", "--reverse", "--format=%cI", `${trunk}..HEAD`],
    repoRoot,
  )
    .split("\n")
    .filter(Boolean)[0];
  return { branch, branchCreatedAt: first || null };
}

export function runGate({ repoRoot = DEFAULT_REPO_ROOT, argv = {}, io = {} } = {}) {
  const policyPath = io.policyPath ?? POLICY_PATH;
  let policy;
  try {
    policy = JSON.parse(readFileSync(policyPath, "utf8"));
  } catch (err) {
    throw new Error(`the rollout policy is unreadable: ${err.message}`);
  }
  const findings = [...scanDispatchProse(repoRoot), ...scanCaptureEvidence(repoRoot, io)];
  const ctx = argv.enforce
    ? { branch: argv.branch ?? null, branchCreatedAt: null }
    : resolveBranchContext(repoRoot, argv);
  const outcome = decideOutcome({
    findings,
    policy: argv.enforce ? { ...policy, enforcement: "enforce-all" } : policy,
    branch: ctx.branch,
    branchCreatedAt: ctx.branchCreatedAt,
  });
  return { ...outcome, findings, branch: ctx.branch, branchCreatedAt: ctx.branchCreatedAt };
}

function parseArgv(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--json") out.json = true;
    else if (a === "--enforce") out.enforce = true;
    else if (a === "--github-annotations") out.annotations = true;
    else if (a === "--branch") out.branch = args[++i];
    else if (a === "--branch-created-at") out.branchCreatedAt = args[++i];
  }
  return out;
}

function main() {
  const argv = parseArgv(process.argv.slice(2));
  let result;
  try {
    result = runGate({ argv });
  } catch (err) {
    console.error(`[chat-hitl-evidence-gate] ${err.message}`);
    process.exit(2);
  }
  if (argv.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const mode = result.enforce ? "ENFORCING" : "WARN-ONLY";
    console.log(
      `[chat-hitl-evidence-gate] ${mode} on "${result.branch ?? "(unknown branch)"}" — ${result.reason}`,
    );
    for (const f of result.grandfathered) {
      console.log(`  grandfathered  ${f.code}\n      ${f.detail}`);
    }
    for (const f of result.blocking) {
      const label = result.enforce ? "FAIL" : "warn";
      console.log(`  ${label}  ${f.code}\n      ${f.detail}`);
    }
    if (result.findings.length === 0) {
      console.log("  no findings.");
    }
  }
  if (argv.annotations) {
    for (const f of result.blocking) {
      const level = result.enforce ? "error" : "warning";
      console.log(`::${level} title=${f.code}::${f.detail.replace(/\n/g, " ")}`);
    }
  }
  process.exit(result.exitCode);
}

if (process.argv[1] && process.argv[1].endsWith("chat-hitl-evidence-gate.mjs")) {
  main();
}
