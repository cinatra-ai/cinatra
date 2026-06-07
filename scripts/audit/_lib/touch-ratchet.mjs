/**
 * Shared touch-ratchet helpers for audit gates.
 *
 * The no-new-rot touch-ratchet pattern:
 *   - findings on lines the PR DID NOT add → tolerated (pre-existing legacy)
 *   - findings on lines the PR ADDED → blocked
 *
 * Each audit gate that adopts this helper:
 *   1. Resolves the diff base via `resolveBaseRef(envVarName)`.
 *      In CI, the workflow sets a per-gate env var to the PR base ref
 *      (e.g. `origin/main`). Locally, the helper falls back to standard
 *      candidates. Returns null in true strict mode (no base resolvable).
 *   2. Builds a rename map via `buildRenameMap(base)` so a moved file is
 *      diffed against its pre-rename path.
 *   3. For each candidate finding, asks `getAddedLineNumbers(file, base,
 *      renameMap)` whether the line was added by the PR. The caller then
 *      filters findings to only the introduced subset.
 *
 * The functions are intentionally lightweight: no parsing of the PR
 * merge-base graph, no submodule support, no rename-similarity tuning.
 * They reuse plain `git diff --unified=0 --find-renames base...HEAD`
 * which captures the same "what did the PR write?" reading the
 * phase-refs gate has used since 2026-05-25.
 *
 * SECURITY: every git invocation uses `execFileSync` (no shell) and
 * `--end-of-options`. Paths come from caller-controlled inputs (legacy
 * allowlists, walk-tree results) so we belt-and-braces avoid shell
 * metacharacters and argument-as-flag misinterpretation.
 */
import { execFileSync } from "node:child_process";

/**
 * Verify that `ref` resolves in the current git repo. Throws if not.
 * @param {string} ref
 */
export function verifyGitRef(ref) {
  execFileSync(
    "git",
    ["rev-parse", "--verify", "--quiet", "--end-of-options", ref],
    { stdio: "ignore" },
  );
}

/**
 * Resolve the base ref for the touch-ratchet diff.
 *
 * Order:
 *   1. `process.env[envVarName]` if set + resolves.
 *   2. local candidates: `origin/main`, `origin/master`, `main`, `master`.
 *   3. null — caller treats as strict mode (no allowlist tolerance).
 *
 * Throws when `process.env[envVarName]` is set but does NOT resolve to a
 * git ref. CI workflows wire the env var explicitly; an unresolvable
 * value almost always means the fetch-depth is wrong, and silently
 * falling back to strict mode would mask the misconfiguration.
 *
 * @param {string} envVarName
 * @returns {string | null}
 */
export function resolveBaseRef(envVarName) {
  const explicit = process.env[envVarName];
  if (explicit) {
    try {
      verifyGitRef(explicit);
      return explicit;
    } catch {
      throw new Error(
        `${envVarName}='${explicit}' does not resolve to a git ref. ` +
          `Check CI fetch-depth and the base ref name.`,
      );
    }
  }
  for (const base of ["origin/main", "origin/master", "main", "master"]) {
    try {
      verifyGitRef(base);
      return base;
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * Map current-path → base-path for files renamed between `base` and HEAD.
 * Returned map keys are repo-relative POSIX paths; lookups return the
 * pre-rename path or undefined if the file was not renamed.
 *
 * @param {string | null} base
 * @returns {Map<string, string>}
 */
export function buildRenameMap(base) {
  const map = new Map();
  if (!base) return map;
  let out;
  try {
    out = execFileSync(
      "git",
      [
        "--literal-pathspecs",
        "diff",
        "--name-status",
        "-z",
        "--find-renames",
        "--end-of-options",
        `${base}...HEAD`,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return map;
  }
  // `--name-status -z` emits: `R<score>\0<oldpath>\0<newpath>\0…`
  // Other statuses (A, M, D) emit `<status>\0<path>\0`.
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; ) {
    const status = parts[i];
    if (!status) {
      i += 1;
      continue;
    }
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = parts[i + 1];
      const newPath = parts[i + 2];
      if (oldPath && newPath) map.set(newPath, oldPath);
      i += 3;
    } else {
      i += 2;
    }
  }
  return map;
}

/**
 * Return the set of new-side line numbers the PR ADDED to `file`.
 *
 * Returns:
 *   - `Set<number>` of 1-indexed added line numbers (may be empty when
 *     the file is touched only by metadata changes / rename)
 *   - `null` when the file did NOT exist at the base (genuinely new) —
 *     caller treats every current finding as introduced.
 *
 * Follows renames via the provided `renameMap` so a moved file is diffed
 * against its pre-rename source.
 *
 * @param {string} file              repo-relative current path
 * @param {string | null} base
 * @param {Map<string, string>} renameMap
 * @returns {Set<number> | null}
 */
export function getAddedLineNumbers(file, base, renameMap) {
  if (!base) return null;
  const basePath = renameMap.get(file) ?? file;
  try {
    execFileSync("git", ["cat-file", "-e", `${base}:${basePath}`], {
      stdio: "ignore",
    });
  } catch {
    return null; // absent at base → every current finding is introduced
  }
  let diff;
  try {
    diff = execFileSync(
      "git",
      [
        "--literal-pathspecs",
        "diff",
        "--find-renames",
        "--unified=0",
        `${base}...HEAD`,
        "--end-of-options",
        "--",
        basePath,
        file,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    // diff failed → safe fallback: treat as no added lines. Combined
    // with "file exists at base" this means "all findings are
    // pre-existing legacy" which is the conservative reading.
    return new Set();
  }
  const added = new Set();
  let newLine = 0;
  for (const line of diff.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      newLine = parseInt(hunk[1], 10);
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) {
      added.add(newLine);
      newLine += 1;
    } else if (line.startsWith("-")) {
      // removed line — does not advance the new-side counter
    } else if (line.startsWith(" ")) {
      newLine += 1;
    }
  }
  return added;
}
