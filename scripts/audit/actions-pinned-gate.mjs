#!/usr/bin/env node
// ---------------------------------------------------------------------------
// actions-pinned-gate — supply-chain recurrence guard (FORMAT ONLY).
//
// Fails CI if any *remote* `uses:` ref in the repo's GitHub Actions YAML
// (`.github/workflows/**` workflows AND `.github/actions/**` local composite
// actions) is not pinned to an immutable 40-char commit SHA carrying a
// human-readable version comment matching the upstream tag (`# vX.Y.Z`, or
// `# X.Y.Z` for upstreams that tag without a `v` prefix). A moved upstream
// tag (`@v6`) can silently run new code against this repo's `GITHUB_TOKEN`;
// an immutable SHA cannot. This gate keeps the pins from rotting back to tags.
//
// `.github/actions/**` is in scope because a workflow's `uses: ./.github/...`
// (a local, exempt ref) invokes a composite action whose OWN `uses:` refs run
// with the caller's token — an unpinned ref there is exactly as dangerous as
// one in a workflow.
//
// SCOPE: this is a purely-offline *format* check. It deliberately does NOT
// assert SHA<->tag correctness (that the version comment's tag actually
// points at the pinned SHA in the upstream repo) — a local static parser can't
// resolve a SHA to its upstream tag without a network call. SHA<->tag
// correctness is verified at *authoring* time against each upstream repo, and
// refreshed by Renovate's `github-actions` manager, which treats the comment
// as the version-of-record and rewrites SHA + comment together (which is also
// why the comment must equal the REAL upstream tag — see VERSION_COMMENT_RE).
//
// EXEMPTIONS (not "remote actions"):
//   - local actions:        `uses: ./.github/actions/foo`
//   - container image refs:  `uses: docker://alpine:3.19`  (image *digests* are
//     a separate hardening axis and intentionally out of scope here)
//
// Zero runtime dependencies (node: builtins only) so the CI gate job stays lean
// and needs no `pnpm install` — a smaller surface for a supply-chain gate. The
// parser is source-line based (not a YAML library) but is hardened against the
// realistic bypass/false-positive vectors: quoted/space-before-colon `uses`
// keys, single-line flow mappings, and `run: |` block-scalar bodies whose shell
// text may itself contain a `uses:`-looking line.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

// A pinned remote ref: owner/repo, optionally with a sub-path (reusable
// workflow / nested action), `@`, then exactly 40 lowercase hex chars.
export const PINNED_REF_RE =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9._/-]+@[0-9a-f]{40}$/;

// A well-formed version comment: `#`, an OPTIONAL `v`, then 1..3
// dot-separated numbers, with an optional semver pre-release / build-metadata
// suffix (`-beta-1`, `+build.7`). Accepts `# v6`, `# v6.0`, `# v6.0.2`,
// `# v6.0.2-beta.1` — and the same forms without the `v` (`# 2.37.2`),
// because some upstreams tag WITHOUT a `v` prefix (e.g. shivammathur/setup-php
// tags `2.37.2`) and the comment must match the REAL upstream tag for
// Renovate to resolve it (a fabricated `# v2.37.2` makes the dep silently
// never update). The `v` is therefore optional; the comment should mirror the
// upstream tag exactly. The immutable 40-char SHA pin (PINNED_REF_RE) is the
// security control — this comment is human/tooling metadata. One leading
// space after `#` is conventional but optional.
export const VERSION_COMMENT_RE =
  /^#[ \t]*v?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

// Matches a `uses` key at the start of a (block-style) source line, allowing an
// optional `- ` list prefix, optional quotes around the key, and whitespace
// before the colon. Group 3 is everything after the colon.
const USES_LINE_RE = /^(\s*(?:-\s+)?)(["']?)uses\2\s*:[ \t]*(.*?)[ \t]*$/;

// A line whose value is a single-line flow mapping STEP: `- { uses: ... }` or
// an anchored `- &name { uses: ... }`, optionally with a trailing `# comment`.
// Anchored to a leading `{` (after an optional `- ` / anchor) so a scalar like
// `run: echo '{ uses: x }'` — which merely CONTAINS a brace in shell text — is
// NOT treated as a flow step.
const FLOW_STEP_RE = /^\s*-?\s*(?:&[^\s{]+\s+)?\{.*\}[ \t]*(#.*)?$/;

// A `uses` mapping key anywhere on a line, AFTER quoted scalars + comments are
// stripped (see residualForAnomaly). Used by the fail-closed guard to catch any
// `uses:`-bearing construct the structured parsers above did NOT handle (inline
// flow sequences `steps: [{ uses: ... }]`, multi-line flow, etc.) — turning a
// silent bypass into a loud failure rather than trusting a regex to model all
// of YAML.
const ANY_USES_KEY_RE = /(?:^|[\s{,[])(["']?)uses\1\s*:/;
// Extracts each `uses:` ref token from inside a flow mapping.
const FLOW_USES_RE = /[{,]\s*(["']?)uses\1\s*:\s*(["']?)([^\s,}\]"']+)\2/g;

// A line that OPENS a YAML block scalar: `key: |`, `script: >-`, `run: |2`,
// `run: |-2`, `>+2`, etc. The indentation and chomping indicators may appear in
// EITHER order after `|`/`>` (YAML allows `|2-` and `|-2`). Its body lines
// (more-indented) are arbitrary text and must NOT be parsed as `uses:` decls.
const BLOCK_SCALAR_OPEN_RE =
  /^\s*(?:-\s+)?[^:#\n]+:\s*[|>](?:[0-9]|[+-]){0,2}[ \t]*(?:#.*)?$/;

function leadingWidth(line) {
  const m = line.match(/^[ \t]*/);
  return m ? m[0].length : 0;
}

/**
 * A line reduced for the fail-closed `uses:`-key anomaly check: quoted scalars
 * are blanked (so a `run: echo '{ uses: x }'` shell string disappears) and any
 * inline comment is dropped (so a commented-out `# uses: ...` is ignored). What
 * remains is the line's structural skeleton.
 */
export function residualForAnomaly(line) {
  // Blank quoted scalar VALUES, but PRESERVE a quoted KEY (a quoted token
  // immediately followed by `:`) — otherwise `[{ "uses": ... }]` would lose its
  // key and bypass the guard, while `run: echo '{ uses: x }'` must still be
  // blanked (its quoted string is a value, not a key).
  let s = line
    .replace(/'[^']*'(?![ \t]*:)/g, "''")
    .replace(/"[^"]*"(?![ \t]*:)/g, '""');
  const hash = s.indexOf("#");
  if (hash >= 0) s = s.slice(0, hash);
  return s;
}

/**
 * Parse a single (block-style) source line into its `uses:` ref + trailing
 * comment. Returns null when the line is not a `uses:` declaration.
 *
 * Enforces the *source-line* shape rather than trusting a YAML parser: a `#`
 * inside a quoted scalar is part of the string (NOT a YAML comment), so a
 * `uses: "owner/repo@sha # v1.2.3"` form yields a ref containing spaces and is
 * correctly rejected. Handles `- uses:`, quoted (`"uses":`) and
 * space-before-colon (`uses :`) key forms.
 */
export function parseUsesLine(line) {
  const m = line.match(USES_LINE_RE);
  if (!m) return null;
  const rawValue = m[3];
  if (rawValue === "") return { ref: "", comment: "" };

  const quote = rawValue[0];
  if (quote === '"' || quote === "'") {
    const end = rawValue.indexOf(quote, 1);
    if (end === -1) return { ref: rawValue, comment: "" }; // malformed quoting
    const ref = rawValue.slice(1, end);
    const comment = rawValue.slice(end + 1).trim();
    return { ref, comment };
  }

  // Unquoted: a YAML inline comment requires whitespace before `#`.
  const cm = rawValue.match(/^(\S+)(?:[ \t]+(#.*))?$/);
  if (cm) return { ref: cm[1], comment: (cm[2] || "").trim() };
  return { ref: rawValue, comment: "" };
}

/**
 * Extract flow-mapping `uses:` refs from a single-line flow STEP. Returns []
 * for any line that is not a flow step (so a `run:` scalar containing braces is
 * never mis-parsed). The trailing `# comment` after the closing `}` (if any)
 * is attached to every ref found on the line.
 */
export function parseFlowUses(line) {
  if (!FLOW_STEP_RE.test(line)) return [];
  const cm = line.match(/\}[ \t]*(#.*?)[ \t]*$/);
  const comment = cm ? cm[1] : "";
  const out = [];
  for (const m of line.matchAll(FLOW_USES_RE)) out.push({ ref: m[3], comment });
  return out;
}

/** True for refs that are not "remote actions" and thus exempt from pinning. */
export function isExemptRef(ref) {
  return ref.startsWith("./") || ref.startsWith("docker://");
}

/**
 * Classify a parsed `uses:` ref. Returns
 *   { kind: "exempt" }                                  — local / image ref
 *   { kind: "remote", ok: true }                        — correctly pinned
 *   { kind: "remote", ok: false, violations: [...] }    — needs fixing
 */
export function classifyRef(ref, comment) {
  if (isExemptRef(ref)) return { kind: "exempt" };
  const violations = [];
  if (!PINNED_REF_RE.test(ref)) {
    violations.push(
      `ref "${ref}" is not pinned to a 40-char commit SHA (want owner/repo@<40-hex-sha>)`,
    );
  }
  if (!VERSION_COMMENT_RE.test(comment)) {
    violations.push(
      comment
        ? `comment "${comment}" is not a well-formed version comment (want \`# vX.Y.Z\` or \`# X.Y.Z\`, matching the upstream tag)`
        : "missing version comment (want a trailing `# vX.Y.Z` / `# X.Y.Z` matching the upstream tag)",
    );
  }
  return { kind: "remote", ok: violations.length === 0, violations };
}

/**
 * Scan GitHub Actions YAML text. Returns an array of findings, one per
 * offending remote `uses:` ref: { line: <1-based>, ref, comment, violations }.
 *
 * Tracks YAML block-scalar (`run: |`) state so a `uses:`-looking line inside a
 * shell-script body is not mis-parsed as an action declaration, and scans both
 * block-style and single-line flow-mapping `uses:` forms.
 */
export function scanWorkflowText(text) {
  const findings = [];
  const lines = text.split("\n");
  let blockIndent = -1; // -1 = not inside a block scalar

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Inside a block scalar: skip blank lines and more-indented body lines.
    if (blockIndent >= 0) {
      if (line.trim() === "" || leadingWidth(line) > blockIndent) continue;
      blockIndent = -1; // dedented out of the block; fall through to parse
    }

    // Does THIS line open a block scalar? (check before treating as uses:)
    if (BLOCK_SCALAR_OPEN_RE.test(line) && !USES_LINE_RE.test(line)) {
      blockIndent = leadingWidth(line);
      continue;
    }

    const candidates = [];
    const block = parseUsesLine(line);
    if (block) candidates.push(block);
    if (line.includes("{")) candidates.push(...parseFlowUses(line));

    for (const cand of candidates) {
      const c = classifyRef(cand.ref, cand.comment);
      if (c.kind === "remote" && !c.ok) {
        findings.push({
          line: i + 1,
          ref: cand.ref,
          comment: cand.comment,
          violations: c.violations,
        });
      }
    }

    // Fail-closed guard: if the structured parsers found nothing but a `uses:`
    // key still survives quoted-scalar + comment stripping, this is a `uses:`
    // construct the gate cannot reliably verify (e.g. an inline flow sequence
    // `steps: [{ uses: ... }]` or a multi-line flow mapping). Flag it loudly
    // rather than let a possibly-unpinned action slip through.
    if (candidates.length === 0 && ANY_USES_KEY_RE.test(residualForAnomaly(line))) {
      findings.push({
        line: i + 1,
        ref: line.trim(),
        comment: "",
        violations: [
          "unhandled `uses:` construct — the pin gate verifies block-style and " +
            "single-line `- { uses: ... }` flow steps. Rewrite this as a block-style " +
            "step so its SHA pin can be checked.",
        ],
      });
    }
  }
  return findings;
}

/** Resolve the repo root so the gate works from any cwd (and in CI). */
function repoRoot() {
  return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
}

/**
 * List tracked GitHub Actions YAML files via git (local-CI parity with the
 * checkout): every workflow AND every local composite/nested action.
 */
export function listActionYamlFiles(root) {
  const out = execSync("git ls-files .github/workflows .github/actions", {
    cwd: root,
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && /\.ya?ml$/.test(s));
}

function main() {
  const root = repoRoot();
  const files = listActionYamlFiles(root);
  const offenders = [];
  for (const rel of files) {
    const text = readFileSync(`${root}/${rel}`, "utf8");
    for (const f of scanWorkflowText(text)) offenders.push({ rel, ...f });
  }

  if (offenders.length > 0) {
    console.error(
      "✖ actions-pinned-gate: unpinned or malformed remote `uses:` ref(s) found.\n",
    );
    for (const o of offenders) {
      console.error(`  ${o.rel}:${o.line}`);
      console.error(`    uses: ${o.ref}${o.comment ? " " + o.comment : ""}`);
      for (const v of o.violations) console.error(`      - ${v}`);
    }
    console.error(
      "\nPin every remote action to a 40-char commit SHA with a version comment that\n" +
        "matches the upstream tag exactly (`# vX.Y.Z`, or `# X.Y.Z` for upstreams that tag without a `v`).\n" +
        "Resolve the SHA from the upstream repo (e.g. `gh api repos/<owner>/<repo>/commits/<tag> --jq .sha`).\n" +
        "Local `./` and `docker://` refs are exempt.",
    );
    process.exit(1);
  }

  console.log(
    `✓ actions-pinned-gate: all remote \`uses:\` refs across ${files.length} GitHub Actions file(s) are SHA-pinned with version comments.`,
  );
}

// Run only when invoked directly (not when imported by the test file).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
