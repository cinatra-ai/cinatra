// Parser tests for the actions-pinned-gate (supply-chain SHA-pin format gate).
//
// Uses node's built-in test runner (`node --test`) + `node:assert` so the gate
// and its tests run with ZERO `pnpm install` — keeping the CI gate job lean,
// which matters for a supply-chain-hardening gate. (Most other audit gates in
// this repo use vitest; this one is deliberately dependency-free.)
//
// Contract lives in scripts/audit/actions-pinned-gate.mjs:
//   - remote `uses:` must be owner/repo[/path]@<40-lowercase-hex> with a
//     trailing version comment matching the upstream tag (`# vX.Y.Z`, or
//     `# X.Y.Z` for upstreams that tag without a `v` prefix)
//   - local `./` and `docker://` refs are exempt
//   - the source-LINE shape is enforced (a `#` inside quotes is not a comment)

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync, execFileSync } from "node:child_process";
import { resolve } from "node:path";

import {
  parseUsesLine,
  parseFlowUses,
  residualForAnomaly,
  classifyRef,
  isExemptRef,
  scanWorkflowText,
  PINNED_REF_RE,
  VERSION_COMMENT_RE,
} from "../actions-pinned-gate.mjs";

const SHA = "de0fac2e4500dabe0009e67214ff5f5447ce83dd"; // actions/checkout v6.0.2
const SHA2 = "0e279bb959325dab635dd2c09392533439d90093"; // pnpm/action-setup v6.0.8

// --------------------------------------------------------------------------
// parseUsesLine

test("parseUsesLine: bare `uses:` form", () => {
  const p = parseUsesLine(`      uses: actions/checkout@${SHA} # v6.0.2`);
  assert.deepEqual(p, { ref: `actions/checkout@${SHA}`, comment: "# v6.0.2" });
});

test("parseUsesLine: `- uses:` list-item form", () => {
  const p = parseUsesLine(`      - uses: actions/checkout@${SHA} # v6.0.2`);
  assert.deepEqual(p, { ref: `actions/checkout@${SHA}`, comment: "# v6.0.2" });
});

test("parseUsesLine: trailing whitespace is trimmed", () => {
  const p = parseUsesLine(`  uses: actions/cache@${SHA} # v4.3.0   `);
  assert.equal(p.comment, "# v4.3.0");
});

test("parseUsesLine: single-quoted ref with external comment", () => {
  const p = parseUsesLine(`  uses: 'actions/checkout@${SHA}' # v6.0.2`);
  assert.deepEqual(p, { ref: `actions/checkout@${SHA}`, comment: "# v6.0.2" });
});

test("parseUsesLine: comment INSIDE quotes is part of the string (not a YAML comment)", () => {
  const p = parseUsesLine(`  uses: "actions/checkout@${SHA} # v6.0.2"`);
  // ref carries the spaces+hash -> will fail ref validation downstream
  assert.equal(p.ref, `actions/checkout@${SHA} # v6.0.2`);
  assert.equal(p.comment, "");
});

test("parseUsesLine: non-uses line returns null", () => {
  assert.equal(parseUsesLine("      run: echo uses: foo@bar"), null);
  assert.equal(parseUsesLine("    with:"), null);
});

test("parseUsesLine: commented-out uses line is ignored", () => {
  assert.equal(parseUsesLine(`      # uses: actions/checkout@v6`), null);
});

// --------------------------------------------------------------------------
// isExemptRef

test("isExemptRef: local and docker image refs are exempt", () => {
  assert.equal(isExemptRef("./.github/actions/setup"), true);
  assert.equal(isExemptRef("docker://alpine:3.19"), true);
  assert.equal(isExemptRef("actions/checkout@" + SHA), false);
});

// --------------------------------------------------------------------------
// regexes

test("PINNED_REF_RE: accepts owner/repo and reusable-workflow paths", () => {
  assert.ok(PINNED_REF_RE.test(`actions/checkout@${SHA}`));
  assert.ok(PINNED_REF_RE.test(`pnpm/action-setup@${SHA2}`));
  assert.ok(PINNED_REF_RE.test(`org/repo/.github/workflows/ci.yml@${SHA}`));
  assert.ok(PINNED_REF_RE.test(`docker/build-push-action@${SHA}`));
});

test("PINNED_REF_RE: rejects tags, branches, short/upper SHAs", () => {
  assert.ok(!PINNED_REF_RE.test("actions/checkout@v6"));
  assert.ok(!PINNED_REF_RE.test("actions/checkout@main"));
  assert.ok(!PINNED_REF_RE.test("actions/checkout@abc1234"));
  assert.ok(!PINNED_REF_RE.test(`actions/checkout@${SHA.toUpperCase()}`));
  assert.ok(!PINNED_REF_RE.test(`actions/checkout@${SHA}x`)); // 41 chars
});

test("VERSION_COMMENT_RE: accepts v6 / v6.0 / v6.0.2 / pre-release / build-metadata", () => {
  for (const c of [
    "# v6", "# v6.0", "# v6.0.2", "# v6.0.2-beta.1", "#v6.0.2",
    "# v1.2.3-beta-1", "# v1.2.3+build.7", "# v1.2.3-rc.1+build.2",
  ]) {
    assert.ok(VERSION_COMMENT_RE.test(c), c);
  }
});

// Some upstreams tag WITHOUT a `v` prefix (shivammathur/setup-php tags
// `2.37.2`); the comment must equal the real upstream tag or Renovate's
// tag lookup fails and the dep silently never updates. The `v` is optional.
test("VERSION_COMMENT_RE: accepts the same forms without the v prefix (non-v upstream tags)", () => {
  for (const c of [
    "# 2.37.2", "# 6", "# 6.0", "# 6.0.2", "#2.37.2",
    "# 1.2.3-beta-1", "# 1.2.3+build.7", "# 1.2.3-rc.1+build.2",
  ]) {
    assert.ok(VERSION_COMMENT_RE.test(c), c);
  }
});

test("VERSION_COMMENT_RE: rejects freeform / garbage / empty", () => {
  for (const c of [
    "# latest", "# pin", "", "# sha", "# v", "#", "# main@f0323d2",
    "# version 2", "# vv6.0.2", "# v6.0.2 extra words", "# .2.37",
  ]) {
    assert.ok(!VERSION_COMMENT_RE.test(c), c);
  }
});

// --------------------------------------------------------------------------
// classifyRef

test("classifyRef: a correctly pinned remote ref is ok", () => {
  const c = classifyRef(`actions/checkout@${SHA}`, "# v6.0.2");
  assert.deepEqual(c, { kind: "remote", ok: true, violations: [] });
});

test("classifyRef: a pinned ref with a non-v upstream-tag comment is ok", () => {
  const c = classifyRef(`shivammathur/setup-php@${SHA2}`, "# 2.37.2");
  assert.deepEqual(c, { kind: "remote", ok: true, violations: [] });
});

test("classifyRef: pinned SHA with a garbage comment is a violation", () => {
  const c = classifyRef(`actions/checkout@${SHA}`, "# main@f0323d2");
  assert.equal(c.ok, false);
  assert.equal(c.violations.length, 1);
});

test("classifyRef: local ref is exempt", () => {
  assert.deepEqual(classifyRef("./.github/actions/x", ""), { kind: "exempt" });
});

test("classifyRef: tag ref + missing comment yields two violations", () => {
  const c = classifyRef("actions/checkout@v6", "");
  assert.equal(c.kind, "remote");
  assert.equal(c.ok, false);
  assert.equal(c.violations.length, 2);
});

test("classifyRef: pinned SHA but no comment is a violation", () => {
  const c = classifyRef(`actions/checkout@${SHA}`, "");
  assert.equal(c.ok, false);
  assert.equal(c.violations.length, 1);
});

// --------------------------------------------------------------------------
// scanWorkflowText

test("scanWorkflowText: clean workflow yields no findings", () => {
  const text = [
    "jobs:",
    "  build:",
    "    steps:",
    `      - uses: actions/checkout@${SHA} # v6.0.2`,
    `      - uses: pnpm/action-setup@${SHA2} # v6.0.8`,
    "      - uses: ./.github/actions/local-thing",
    "      - uses: docker://node:24",
    "      - run: echo done",
  ].join("\n");
  assert.deepEqual(scanWorkflowText(text), []);
});

test("scanWorkflowText: flags each offending line with 1-based line numbers", () => {
  const text = [
    "    steps:",
    "      - uses: actions/checkout@v6", // line 2: tag + no comment
    `      - uses: actions/cache@${SHA}`, // line 3: pinned, no comment
    `      - uses: actions/setup-node@${SHA} # v6.4.0`, // line 4: ok
  ].join("\n");
  const findings = scanWorkflowText(text);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].line, 2);
  assert.equal(findings[1].line, 3);
});

// --------------------------------------------------------------------------
// Hardening: quoted/space-before-colon `uses` keys must NOT bypass the gate.

test("parseUsesLine: quoted `uses` key form", () => {
  const p = parseUsesLine(`      - "uses": actions/checkout@v6`);
  assert.deepEqual(p, { ref: "actions/checkout@v6", comment: "" });
});

test("parseUsesLine: space-before-colon `uses :` form", () => {
  const p = parseUsesLine(`      - uses : actions/checkout@v6`);
  assert.deepEqual(p, { ref: "actions/checkout@v6", comment: "" });
});

test("parseUsesLine: does not match a similarly-named key", () => {
  assert.equal(parseUsesLine("      reuses: actions/checkout@v6"), null);
  assert.equal(parseUsesLine("      defuses: x"), null);
});

test("scanWorkflowText: quoted/spaced unpinned uses keys are caught (no bypass)", () => {
  const text = [
    "    steps:",
    `      - "uses": actions/checkout@v6`, // line 2: tag, no comment
    "      - uses : actions/setup-node@v6", // line 3: tag, no comment
  ].join("\n");
  const findings = scanWorkflowText(text);
  assert.equal(findings.length, 2);
  assert.deepEqual(findings.map((f) => f.line), [2, 3]);
});

// --------------------------------------------------------------------------
// Hardening: flow-mapping `uses` must be scanned.

test("parseFlowUses: extracts flow-mapping uses refs", () => {
  const got = parseFlowUses(`      - { uses: actions/checkout@v6, with: { x: 1 } }`);
  assert.equal(got.length, 1);
  assert.equal(got[0].ref, "actions/checkout@v6");
});

test("parseFlowUses: captures the trailing comment after the closing brace", () => {
  const got = parseFlowUses(`      - { uses: actions/checkout@${SHA} } # v6.0.2`);
  assert.equal(got.length, 1);
  assert.deepEqual(got[0], { ref: `actions/checkout@${SHA}`, comment: "# v6.0.2" });
});

test("parseFlowUses: a run: scalar that merely contains braces is NOT a flow step", () => {
  assert.deepEqual(parseFlowUses(`        run: echo '{ uses: actions/checkout@v6 }'`), []);
});

test("scanWorkflowText: unpinned flow-mapping uses is caught", () => {
  const text = `    steps:\n      - { uses: actions/checkout@v6 }`;
  const findings = scanWorkflowText(text);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 2);
});

test("scanWorkflowText: a correctly-pinned flow step with trailing comment passes", () => {
  const text = `    steps:\n      - { uses: actions/checkout@${SHA} } # v6.0.2`;
  assert.deepEqual(scanWorkflowText(text), []);
});

test("scanWorkflowText: run: scalar containing a braced uses string is NOT flagged", () => {
  const text = [
    "    steps:",
    "      - name: noise",
    `        run: echo '{ uses: actions/checkout@v6 }'`,
  ].join("\n");
  assert.deepEqual(scanWorkflowText(text), []);
});

test("scanWorkflowText: block scalar with chomping-before-indent (|-2, >+2) skips its body", () => {
  const text = [
    "    steps:",
    "      - name: a",
    "        run: |-2",
    "          uses: fake/thing@v1", // body — must NOT flag
    "      - name: b",
    "        run: >+2",
    "          uses: other/thing@v2", // body — must NOT flag
    `      - uses: actions/checkout@${SHA} # v6.0.2`, // real, ok
  ].join("\n");
  assert.deepEqual(scanWorkflowText(text), []);
});

// --------------------------------------------------------------------------
// Hardening: a `run: |` block-scalar body must NOT be parsed as a uses: decl.

test("scanWorkflowText: uses-looking line inside a run block is ignored", () => {
  const text = [
    "    steps:",
    `      - uses: actions/checkout@${SHA} # v6.0.2`, // real, ok
    "      - name: echo",
    "        run: |",
    "          echo 'uses: actions/checkout@v6'", // block body — must NOT flag
    "          uses: fake/thing@v1", // block body — must NOT flag",
    "      - name: next step",
  ].join("\n");
  assert.deepEqual(scanWorkflowText(text), []);
});

test("scanWorkflowText: block scalar ends on dedent; later uses still scanned", () => {
  const text = [
    "    steps:",
    "      - name: a",
    "        run: |",
    "          uses: fake/thing@v1", // in block — ignored
    "      - uses: actions/checkout@v6", // dedented real step — flagged
  ].join("\n");
  const findings = scanWorkflowText(text);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 5);
});

// --------------------------------------------------------------------------
// Fail-closed guard: any uses: construct the structured parsers miss becomes a
// loud failure (no silent bypass), while staying false-positive-safe.

test("scanWorkflowText: inline flow SEQUENCE `steps: [{ uses: ... }]` is flagged (no bypass)", () => {
  const text = `    steps: [{ uses: actions/checkout@v6 }]`;
  const findings = scanWorkflowText(text);
  assert.equal(findings.length, 1);
  assert.match(findings[0].violations[0], /unhandled `uses:` construct/);
});

test("scanWorkflowText: even a SHA-pinned inline flow sequence is flagged (fail-closed)", () => {
  const text = `    steps: [{ uses: actions/checkout@${SHA} }] # v6.0.2`;
  const findings = scanWorkflowText(text);
  assert.equal(findings.length, 1);
  assert.match(findings[0].violations[0], /unhandled `uses:` construct/);
});

test("scanWorkflowText: anchored flow step `- &name { uses: ... }` is parsed + flagged for the tag", () => {
  const text = `      - &checkout { uses: actions/checkout@v6 }`;
  const findings = scanWorkflowText(text);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].ref, "actions/checkout@v6");
});

test("residualForAnomaly: strips quoted scalar VALUES and comments", () => {
  assert.equal(residualForAnomaly(`        run: echo '{ uses: x }'`).includes("uses"), false);
  assert.equal(residualForAnomaly(`      # uses: actions/foo@v1`), "      ");
});

test("residualForAnomaly: preserves a quoted KEY (followed by colon)", () => {
  assert.match(residualForAnomaly(`    steps: [{ "uses": actions/checkout@v6 }]`), /"uses"\s*:/);
  assert.match(residualForAnomaly(`    steps: [{ 'uses': actions/checkout@v6 }]`), /'uses'\s*:/);
});

test("scanWorkflowText: quoted-key inline flow sequence does NOT bypass (no silent pass)", () => {
  for (const text of [
    `    steps: [{ "uses": actions/checkout@v6 }]`,
    `    steps: [{ 'uses': actions/checkout@v6 }]`,
    `    steps: [{ uses: actions/checkout@v6 }]`,
  ]) {
    const findings = scanWorkflowText(text);
    assert.equal(findings.length, 1, text);
    assert.match(findings[0].violations[0], /unhandled `uses:` construct/);
  }
});

test("scanWorkflowText: commented-out uses: line is NOT flagged", () => {
  assert.deepEqual(scanWorkflowText(`      # uses: actions/checkout@v6`), []);
});

test("scanWorkflowText: a with-input key like `uses_legacy:` is NOT flagged", () => {
  const text = [
    "    with:",
    "      uses_legacy: true",
    "      reuses: false",
  ].join("\n");
  assert.deepEqual(scanWorkflowText(text), []);
});

// --------------------------------------------------------------------------
// Live smoke — the in-tree workflows must pass the gate (exit 0).

test("live: the actual gate run over .github/workflows exits 0", () => {
  const root = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  const gate = resolve(root, "scripts/audit/actions-pinned-gate.mjs");
  // throws (non-zero exit) if the gate finds any offender.
  // Use execFileSync with an argv array (no shell): `gate` is an absolute path
  // derived from the on-disk checkout location, so passing it as a discrete
  // argument avoids any shell metacharacter interpretation if the clone path
  // ever contains a space or special character (CodeQL js/shell-command-injection).
  const out = execFileSync("node", [gate], { cwd: root, encoding: "utf8" });
  assert.match(out, /all remote `uses:` refs/);
});
