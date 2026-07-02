#!/usr/bin/env node
// ---------------------------------------------------------------------------
// normalize-extension-versions — set every cinatra-ai/* extension repo's
// package.json `version` to the canonical v0.1.0 standard (a NON-publishing
// normalization pass).
//
// This tool edits the `version` field in `package.json`. The canonical version
// is `package.json#version`. Agent OAS files no longer carry a self-describing
// `metadata.cinatra.packageVersion` (it was redundant — the loader reads the
// sibling `package.json` only). For LEGACY compatibility, if an agent's
// `cinatra/oas.json` still carries the field, this tool re-syncs it to the
// target so it does not drift; but its ABSENCE is fully expected and is NOT an
// error. It works on each repo's default branch (read → sync the out-of-sync
// file(s) → commit only what changed → optional push). It is *non-publishing by
// construction*:
//   • It NEVER creates a git tag.
//   • It NEVER creates a GitHub Release.
//   • It NEVER calls the marketplace / registry / Verdaccio.
// A version-bump commit on the default branch does NOT fire the per-repo
// `release: published` workflow (only publishing a GitHub Release does), so
// running this tool cannot publish anything. Tagging, releasing, and publishing
// are intentionally OUT OF SCOPE for this tool.
//
// SAFETY: dry-run by default. `--apply` writes the commit into a local clone;
// `--push` (requires `--apply`) pushes the default branch. A runtime guard
// (assertNoPublishingOps) fails closed if any git/gh op argv looks like a
// tag/release/publish — defense in depth against accidental scope creep.
//
// Usage:
//   node scripts/extensions/normalize-extension-versions.mjs                 # dry-run plan
//   node scripts/extensions/normalize-extension-versions.mjs --apply         # commit locally (no push)
//   node scripts/extensions/normalize-extension-versions.mjs --apply --push  # commit + push default branch
//   node scripts/extensions/normalize-extension-versions.mjs --only a,b      # restrict to repos a,b
//   node scripts/extensions/normalize-extension-versions.mjs --target 0.1.0  # override target (default 0.1.0)
//
// Reads repo versions read-only via `gh api` (no clone needed for the plan).
// ---------------------------------------------------------------------------

import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";

export const TARGET_VERSION = "0.1.0";
export const VENDOR = "cinatra-ai";
// Some agent OAS files may still carry a LEGACY self-describing
// `metadata.cinatra.packageVersion`. It is redundant (canonical version is
// package.json#version), but when present this tool keeps it in sync with
// package.json so it does not drift into misleading provenance. A missing field
// is the expected post-cleanup state. Path is relative to the repo root.
export const OAS_REL_PATH = "cinatra/oas.json";

// --- pure helpers (unit-tested; no I/O) -------------------------------------

/** True when a repo's current version is not already the target. */
export function isOutlier(version, target = TARGET_VERSION) {
  return String(version ?? "").trim() !== String(target).trim();
}

/**
 * Build the normalization plan from a list of `{ name, version }` repo records.
 * `version: null` means "unknown / unreadable package.json" — surfaced separately
 * so a missing manifest is never silently bumped.
 * @returns {{ target:string, toBump:Array<{name,from,to}>, alreadyAt:string[], unreadable:string[] }}
 */
export function planNormalization(repos, target = TARGET_VERSION) {
  const toBump = [];
  const alreadyAt = [];
  const unreadable = [];
  for (const r of repos) {
    if (r == null || typeof r.name !== "string") continue;
    // package.json unreadable, OR an agent whose OAS is present-but-unreadable /
    // missing → surface for a manual fix, never silently report "clean".
    if (r.version == null || r.oasUnreadable === true) {
      unreadable.push(r.name);
      continue;
    }
    const pkgNeedsBump = isOutlier(r.version, target);
    // r.oasVersion: undefined = no OAS info (non-agent extension); a string = the
    // OAS's self-describing packageVersion that must track package.json.
    const oasNeedsSync = typeof r.oasVersion === "string" && isOutlier(r.oasVersion, target);
    if (!pkgNeedsBump && !oasNeedsSync) {
      alreadyAt.push(r.name);
      continue;
    }
    const item = { name: r.name, from: String(r.version), to: target };
    // Annotate OAS fields ONLY when the OAS needs syncing — keeps the item shape
    // byte-identical to the package-only case (back-compat with existing output).
    if (oasNeedsSync) {
      item.oasFrom = String(r.oasVersion);
      item.oasTo = target;
    }
    toBump.push(item);
  }
  // stable, deterministic ordering
  toBump.sort((a, b) => a.name.localeCompare(b.name));
  alreadyAt.sort();
  unreadable.sort();
  return { target, toBump, alreadyAt, unreadable };
}

/** Human-readable plan report. */
export function formatPlan(plan) {
  const lines = [];
  lines.push(`v0.1.0 version normalization — target ${plan.target}`);
  lines.push(`  to bump:    ${plan.toBump.length}`);
  lines.push(`  already at: ${plan.alreadyAt.length}`);
  if (plan.unreadable.length) lines.push(`  UNREADABLE: ${plan.unreadable.length} (${plan.unreadable.join(", ")}) — skipped, fix manually`);
  for (const b of plan.toBump) {
    const pkgChanges = b.from !== b.to;
    // Back-compat: a package-only bump renders exactly as before ("name: from → to").
    if (pkgChanges && !b.oasFrom) {
      lines.push(`    • ${b.name}: ${b.from} → ${b.to}`);
    } else {
      const parts = [];
      if (pkgChanges) parts.push(`pkg ${b.from} → ${b.to}`);
      if (b.oasFrom) parts.push(`oas ${b.oasFrom} → ${b.oasTo}`);
      lines.push(`    • ${b.name}: ${parts.join(", ")}`);
    }
  }
  return lines.join("\n");
}

/** Parse argv (after the node + script args). */
export function parseArgs(argv) {
  const apply = argv.includes("--apply");
  const push = argv.includes("--push");
  const onlyIdx = argv.indexOf("--only");
  const only = onlyIdx >= 0 && argv[onlyIdx + 1] ? argv[onlyIdx + 1].split(",").map((s) => s.trim()).filter(Boolean) : null;
  const tIdx = argv.indexOf("--target");
  const target = tIdx >= 0 && argv[tIdx + 1] ? argv[tIdx + 1].trim() : TARGET_VERSION;
  return { apply, push, only, target };
}

/**
 * Set the top-level `version` in a package.json text, preserving formatting as
 * much as practical (re-serialize with 2-space indent + trailing newline — the
 * repo convention). Returns the new text. Throws if there is no version field.
 */
export function setPackageJsonVersion(text, target) {
  const obj = JSON.parse(text);
  if (typeof obj.version !== "string") throw new Error("package.json has no string `version` field");
  obj.version = target;
  return JSON.stringify(obj, null, 2) + "\n";
}

/**
 * Read the agent OAS's self-describing version: `metadata.cinatra.packageVersion`.
 * Returns the string, or `null` when the OAS is unparseable / has no such field.
 */
export function readOasPackageVersion(text) {
  let obj;
  try { obj = JSON.parse(text); } catch { return null; }
  const cinatra = obj && obj.metadata && obj.metadata.cinatra;
  return cinatra && typeof cinatra.packageVersion === "string" ? cinatra.packageVersion : null;
}

/**
 * Set `metadata.cinatra.packageVersion` to `target` with a MINIMAL, SCOPED diff —
 * preserving the OAS's authored formatting (a full re-serialize would reorder/reflow
 * the whole hand-authored spec). The targeted scalar replacement is POST-VALIDATED:
 * the candidate must parse to exactly the original object with ONLY
 * metadata.cinatra.packageVersion changed — so a coincidental `"packageVersion"`
 * elsewhere (a schema, an example, a nested component) can never be edited.
 *
 * @returns {{ ok:boolean, changed:boolean, text?:string, reason?:string }}
 *   ok:false  → an agent OAS that has the field but could not be scoped/parsed
 *               (caller must fail closed, never silently skip).
 *   changed:false, ok:true → no field present (non-agent OAS) OR already at target.
 */
export function setOasPackageVersion(text, target) {
  let obj;
  try { obj = JSON.parse(text); } catch { return { ok: false, changed: false, reason: "unparseable" }; }
  const cinatra = obj && obj.metadata && obj.metadata.cinatra;
  if (!cinatra || typeof cinatra.packageVersion !== "string") {
    return { ok: true, changed: false, text, reason: "no-packageVersion" };
  }
  if (cinatra.packageVersion === target) return { ok: true, changed: false, text, reason: "already-target" };
  // The exact object we intend to produce: original, with ONLY this scalar changed.
  const expected = JSON.parse(text);
  expected.metadata.cinatra.packageVersion = target;
  const expectedJson = JSON.stringify(expected);
  // Try each `"packageVersion": "…"` occurrence; accept the one whose replacement
  // yields precisely `expected` (i.e. the metadata.cinatra one).
  const re = /("packageVersion"\s*:\s*")([^"\\]*)(")/g;
  for (const m of text.matchAll(re)) {
    const trial = text.slice(0, m.index) + m[1] + target + m[3] + text.slice(m.index + m[0].length);
    let parsed;
    try { parsed = JSON.parse(trial); } catch { continue; }
    if (JSON.stringify(parsed) === expectedJson) return { ok: true, changed: true, text: trial };
  }
  // Could not scope a minimal edit to metadata.cinatra.packageVersion — fail closed.
  return { ok: false, changed: false, reason: "unscoped" };
}

// --- no-publish guard (defense in depth) ------------------------------------

// A semver-shaped tag target (e.g. `v0.1.0` / `0.1.0`) used as a bare push ref —
// distinct from a branch like `v629-version-normalize-tool` (NOT a version tag).
const SEMVER_TAG_REF = /^v?\d+\.\d+\.\d+(?:[-+].*)?$/;
// A refspec destination that writes a tag ref, in any position: a bare
// `refs/tags/…`, a force-push `+refs/tags/…`, OR the destination side of a
// `src:dst` refspec (`HEAD:refs/tags/…`, `refs/heads/main:refs/tags/…`,
// `+HEAD:refs/tags/…`).
const TAG_REFSPEC = /(^\+?|:\+?)refs\/tags\//;

/**
 * Fail closed if a git/gh argv would tag, release, or publish. This tool only
 * ever runs `clone --no-tags`, `add`, `commit`, and (with --push) `push
 * --no-follow-tags origin HEAD`. The argv guard is defense-in-depth; the real
 * structural protection against config-driven tag pushes (`push.followTags=true`)
 * is the `--no-tags` clone + `--no-follow-tags` push in normalizeRepos.
 */
export function assertNoPublishingOps(tool, args) {
  const a = args.map((s) => String(s).toLowerCase());
  if (tool === "git") {
    if (a.includes("tag")) throw new Error("guard: this tool must never `git tag` (tagging is out of scope for this tool)");
    if (a.includes("push")) {
      for (const x of a) {
        if (x === "--tags" || x === "--follow-tags") throw new Error("guard: this tool must never push tags (--tags/--follow-tags)");
        if (x === "--mirror") throw new Error("guard: this tool must never `push --mirror` (pushes all refs, incl. tags)");
        if (TAG_REFSPEC.test(x)) throw new Error("guard: this tool must never push a refs/tags/ destination (a tag)");
        if (SEMVER_TAG_REF.test(x)) throw new Error("guard: this tool must never push a version tag ref");
      }
    }
  }
  if (tool === "gh") {
    if (a[0] === "release") throw new Error("guard: this tool must never `gh release` (releasing is out of scope for this tool)");
    if (a.includes("publish")) throw new Error("guard: this tool must never publish");
  }
}

// --- execution (DI'd git/gh ops for testability) ----------------------------

/**
 * Apply the plan. `ops` is the injected I/O surface:
 *   ops.run(tool, args, opts) → { stdout }   (tool ∈ {git, gh})
 *   ops.readFile(path) / ops.writeFile(path, text)
 *   ops.mkdtemp() → tmpdir
 * Returns per-repo results. Pushes only when push===true.
 */
export async function normalizeRepos(toBump, { apply, push, target, ops, log = () => {} }) {
  const results = [];
  for (const { name, from } of toBump) {
    if (!apply) {
      results.push({ name, from, to: target, action: "dry-run" });
      continue;
    }
    const dir = await ops.mkdtemp();
    try {
      // `--no-tags`: never even fetch tags into the clone, so there is nothing to
      // (accidentally) push and no local tag state at all.
      await ops.run("gh", ["repo", "clone", `${VENDOR}/${name}`, dir, "--", "--depth", "1", "--no-tags"], { assert: assertNoPublishingOps });
      // Recompute what is actually out of sync FROM THE CLONE (never trust the plan's
      // earlier read) and write only the files that change — so a re-run after a
      // partial failure is safe and never produces an empty commit.
      const changedFiles = [];

      // package.json — always present in a clone. Parse once for BOTH the version
      // bump and the agent-kind signal (only agents carry an OAS).
      const pkgPath = `${dir}/package.json`;
      const pkgText = await ops.readFile(pkgPath);
      let kind = null;
      if (typeof pkgText === "string") {
        const pkgObj = JSON.parse(pkgText);
        kind = pkgObj && pkgObj.cinatra && typeof pkgObj.cinatra.kind === "string" ? pkgObj.cinatra.kind : null;
        if (typeof pkgObj.version === "string" && isOutlier(pkgObj.version, target)) {
          await ops.writeFile(pkgPath, setPackageJsonVersion(pkgText, target));
          changedFiles.push("package.json");
        }
      }

      // cinatra/oas.json — present ONLY for agents. Read defensively: the real
      // fs.readFile throws ENOENT when absent (a non-agent — fine). An UNPARSEABLE
      // or unscopable OAS on an `agent` is malformed → fail closed. A LEGACY
      // `metadata.cinatra.packageVersion` is re-synced when present, but its
      // ABSENCE is the expected post-cleanup state and is a clean skip (the field
      // is redundant — canonical version is package.json#version).
      const oasPath = `${dir}/${OAS_REL_PATH}`;
      let oasText;
      try { oasText = await ops.readFile(oasPath); } catch { oasText = undefined; }
      if (typeof oasText === "string") {
        const res = setOasPackageVersion(oasText, target);
        if (!res.ok) {
          throw new Error(`${OAS_REL_PATH} could not be normalized safely (${res.reason || "unscoped"}) — fix manually`);
        }
        if (res.changed) {
          await ops.writeFile(oasPath, res.text);
          changedFiles.push(OAS_REL_PATH);
        }
      } else if (kind === "agent") {
        throw new Error(`agent extension is missing ${OAS_REL_PATH} — fix manually`);
      }

      if (changedFiles.length === 0) {
        results.push({ name, from, to: target, action: "already at target (no change)" });
        log(`• ${name}: already at v${target}`);
        continue;
      }

      for (const f of changedFiles) {
        await ops.run("git", ["-C", dir, "add", f], { assert: assertNoPublishingOps });
      }
      await ops.run("git", ["-C", dir, "commit", "-m", `chore: normalize extension version to v${target} (v0.1.0 standard)`], { assert: assertNoPublishingOps });
      if (push) {
        // `--no-follow-tags`: override a user's `push.followTags=true` git config so
        // `push origin HEAD` can NEVER drag a tag along. Structural, config-proof.
        await ops.run("git", ["-C", dir, "push", "--no-follow-tags", "origin", "HEAD"], { assert: assertNoPublishingOps });
        results.push({ name, from, to: target, action: "committed+pushed", files: changedFiles });
      } else {
        results.push({ name, from, to: target, action: "committed (not pushed)", files: changedFiles });
      }
      log(`✓ ${name}: ${changedFiles.join(" + ")} → v${target}`);
    } catch (err) {
      results.push({ name, from, to: target, action: "error", error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

// --- main (real I/O; only when invoked directly) ----------------------------

async function fetchRepoVersions(only) {
  const { execFileSync } = await import("node:child_process");
  const ghReads = (path) =>
    execFileSync("gh", ["api", `repos/${VENDOR}/${path}`, "--jq", ".name"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const ghFile = (name, file) => {
    const b64 = execFileSync("gh", ["api", `repos/${VENDOR}/${name}/contents/${file}`, "--jq", ".content"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return Buffer.from(b64, "base64").toString("utf8");
  };
  // Scope to genuine EXTENSION repos = public repos carrying the per-repo
  // `.github/workflows/release.yml` caller marker. An explicit --only list is
  // trusted as-is.
  let names;
  if (only) {
    names = only;
  } else {
    const all = JSON.parse(
      execFileSync("gh", ["api", `orgs/${VENDOR}/repos?per_page=100&type=public`, "--paginate", "--jq", "[.[].name]"], { encoding: "utf8" }),
    );
    names = all.filter((name) => {
      try { ghReads(`${name}/contents/.github/workflows/release.yml`); return true; }
      catch { return false; } // not an extension (e.g. `docs`) → excluded
    });
  }
  const repos = [];
  for (const name of names) {
    let version = null;
    let kind = null;
    try {
      const pkg = JSON.parse(ghFile(name, "package.json"));
      version = typeof pkg.version === "string" ? pkg.version : null;
      kind = pkg && pkg.cinatra && typeof pkg.cinatra.kind === "string" ? pkg.cinatra.kind : null;
    } catch {
      version = null; // unreadable package.json → surfaced as unreadable below
    }
    // OAS version: only AGENTS carry cinatra/oas.json. `oasVersion: undefined` means
    // "no OAS version to sync" — fine for a non-agent AND for an agent whose OAS no
    // longer carries the (now-redundant, optional) metadata.cinatra.packageVersion.
    // A present LEGACY field is surfaced so it can be re-synced. Two failure modes
    // are STILL surfaced as unreadable for an agent: a totally MISSING OAS FILE, and
    // a present-but-UNPARSEABLE OAS (genuine malformation — never collapse it to
    // "clean" just because there is no readable packageVersion field).
    let oasVersion; // undefined by default
    let oasUnreadable = false;
    let oasText = null;
    try { oasText = ghFile(name, OAS_REL_PATH); } catch { oasText = null; }
    if (oasText != null) {
      let oasParsedOk = true;
      try { JSON.parse(oasText); } catch { oasParsedOk = false; }
      if (!oasParsedOk) {
        // Unparseable OAS on an agent is malformed → surface, never treat as clean.
        if (kind === "agent") oasUnreadable = true;
      } else {
        const v = readOasPackageVersion(oasText);
        // v == null on a PARSEABLE OAS ⇒ no metadata.cinatra.packageVersion
        // (expected post-cleanup) — nothing to sync; leave oasVersion undefined.
        // Only a present field is tracked for re-sync.
        if (v != null) {
          oasVersion = v;
        }
      }
    } else if (kind === "agent") {
      oasUnreadable = true; // an agent with NO OAS at all is malformed
    }
    repos.push({ name, version, oasVersion, oasUnreadable });
  }
  return repos;
}

async function main() {
  const { apply, push, only, target } = parseArgs(process.argv.slice(2));
  if (push && !apply) throw new Error("--push requires --apply");
  process.stderr.write(`Discovering ${VENDOR}/* extension repo versions (read-only)…\n`);
  const repos = await fetchRepoVersions(only);
  const plan = planNormalization(repos, target);
  process.stdout.write(formatPlan(plan) + "\n");
  if (!apply) {
    process.stderr.write("\nDry-run only. Re-run with --apply (commit locally) or --apply --push (push the default branch).\n");
    process.stderr.write("This tool never tags, releases, or publishes — those are out of scope for this tool.\n");
    return;
  }
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { mkdtemp, readFile, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const pexec = promisify(execFile);
  const ops = {
    run: (tool, args, opts = {}) => { (opts.assert || (() => {}))(tool, args); return pexec(tool, args); },
    readFile: (p) => readFile(p, "utf8"),
    writeFile: (p, t) => writeFile(p, t, "utf8"),
    mkdtemp: () => mkdtemp(join(tmpdir(), "cinatra-vnorm-")),
  };
  const results = await normalizeRepos(plan.toBump, { apply, push, target, ops, log: (m) => process.stderr.write(m + "\n") });
  const errs = results.filter((r) => r.action === "error");
  process.stdout.write(`\nDone: ${results.length - errs.length}/${results.length} ${push ? "pushed" : "committed"}.\n`);
  if (errs.length) {
    for (const e of errs) process.stderr.write(`  ✗ ${e.name}: ${e.error}\n`);
    process.exitCode = 1;
  }
}

const invokedDirectly =
  process.argv[1] && resolvePath(process.argv[1]) === resolvePath(fileURLToPath(import.meta.url));
if (invokedDirectly) main().catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
