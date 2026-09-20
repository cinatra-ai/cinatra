// `printf | grep -q` under `pipefail` is a SIGPIPE race (cinatra#3557).
//
// THE FAILURE CLASS. Both guarded scripts run under `set -euo pipefail`.
// `grep -q` exits at its FIRST match and closes the read end of the pipe; when
// the writer (`printf`, and behind it an unbounded capture such as a container
// log or a CLI help banner) is still pushing bytes it takes SIGPIPE and exits
// 141, `pipefail` hands that status to the whole pipeline, and an `if !` then
// reads a FOUND marker as an ABSENT one (or, in the negative direction, a
// FOUND fatal marker as absent, so a broken boot passes the gate). It is a
// timing race that grows with the captured text, which is why it surfaced as a
// red main rather than as a reproducible failure.
//
// THE REPOSITORY ALREADY RULED ON THIS CLASS at
// scripts/upgrade/mariadb-upgrade-major.sh, which carries the same reasoning in
// a comment and avoids `| grep -q` for exactly this reason.
//
// THE INVARIANT this file guards: in the two scripts below the captured text is
// read from a HERE-STRING — `grep -qiE 'pattern' <<<"$VAR"` — which has no
// writer process to break, with the same patterns, the same options and the
// same surrounding control flow. A here-string appends one newline, which moves
// no pattern in either file (the `-x` sites were already fed by `printf '%s\n'`).
//
// Runner: hosted by the vitest include glob `scripts/ci/__tests__/**/*.test.{ts,mjs}`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");

/** The scripts whose captured-text tests must never pipe into `grep -q`. */
export const GUARDED_SCRIPTS = ["scripts/ci/prod-boot-e2e.sh", "scripts/ci/upgrade-proof.sh"];

/** The construction that carries the race. */
const PIPED_QUIET_GREP = /\| *grep -q/;

const HERE_STRING_FORM =
  "use the here-string form instead: grep -qiE 'pattern' <<<\"$VAR\" " +
  "(same patterns, same options, same control flow; a here-string has no writer to SIGPIPE).";

function readScript(rel) {
  return readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

/** Every line of `rel` that pipes into `grep -q`, as "path:line: text". */
function pipedQuietGrepSites(rel) {
  return readScript(rel)
    .split("\n")
    .map((text, index) => ({ line: index + 1, text }))
    .filter((entry) => PIPED_QUIET_GREP.test(entry.text))
    .map((entry) => `${rel}:${entry.line}: ${entry.text.trim()}`);
}

describe("static guard — no captured text is piped into `grep -q`", () => {
  for (const rel of GUARDED_SCRIPTS) {
    it(`${rel} reads captured text from a here-string, never a pipeline into grep -q`, () => {
      const sites = pipedQuietGrepSites(rel);
      const report =
        sites.length === 0
          ? ""
          : [
              `${rel}: ${sites.length} site(s) pipe into \`grep -q\`.`,
              "Under `pipefail` grep -q's early exit SIGPIPEs the still-writing printf (exit 141)",
              "and a FOUND marker reads as a failure (cinatra#3557).",
              HERE_STRING_FORM,
              ...sites,
            ].join("\n");
      expect(report).toBe("");
    });
  }
});

// A 200 KB text built inside bash (no pipe anywhere in the fixture itself):
// 200 filler lines of 1000 characters, with the banner on the FIRST line, so
// the pattern matches at once and the writer would still have ~200 KB to push.
const BUILD_FILLER = [
  "set -o pipefail",
  "printf -v PAD '%*s' 1000 ''",
  "PAD=${PAD// /x}",
  "FILL=''",
  "i=0",
  'while [ "$i" -lt 200 ]; do',
  '  FILL+="$PAD',
  '"',
  "  i=$((i + 1))",
  "done",
];

const LOAD_SCRIPT = [
  ...BUILD_FILLER,
  'T="Cinatra setup CLI',
  '$FILL"',
  "OK=0",
  "n=0",
  'while [ "$n" -lt 200 ]; do',
  "  if grep -qiE 'Cinatra setup CLI|Usage:' <<<\"$T\"; then OK=$((OK + 1)); fi",
  "  n=$((n + 1))",
  "done",
  "printf 'len=%s ok=%s\\n' \"${#T}\" \"$OK\"",
].join("\n");

const ABSENT_SCRIPT = [
  ...BUILD_FILLER,
  'T="$FILL"',
  "grep -qiE 'Cinatra setup CLI|Usage:' <<<\"$T\"",
  "RC=$?",
  "printf 'len=%s rc=%s\\n' \"${#T}\" \"$RC\"",
].join("\n");

function runBash(script) {
  return execFileSync("bash", ["-c", script], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 120_000,
  }).trim();
}

describe("the here-string construction under load", () => {
  it("matches a banner on the first line of a 200 KB text 200 times out of 200", () => {
    const out = runBash(LOAD_SCRIPT);
    const match = /^len=(\d+) ok=(\d+)$/.exec(out);
    expect(match, `unexpected fixture output: ${out}`).not.toBeNull();
    expect(Number(match[1])).toBeGreaterThanOrEqual(200_000);
    expect(Number(match[2])).toBe(200);
  }, 120_000);
});

describe("the absent banner still takes the failure path", () => {
  it("exits 1 on the same 200 KB text with the banner removed", () => {
    const out = runBash(ABSENT_SCRIPT);
    const match = /^len=(\d+) rc=(\d+)$/.exec(out);
    expect(match, `unexpected fixture output: ${out}`).not.toBeNull();
    expect(Number(match[1])).toBeGreaterThanOrEqual(200_000);
    expect(Number(match[2])).toBe(1);
  }, 120_000);

  it("prod-boot-e2e.sh still carries the legacy-forwarder failure message verbatim", () => {
    expect(readScript("scripts/ci/prod-boot-e2e.sh")).toContain(
      "legacy forwarder ran but did not forward to the published CLI (no help banner).",
    );
  });
});
