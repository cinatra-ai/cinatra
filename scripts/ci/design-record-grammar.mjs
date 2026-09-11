#!/usr/bin/env node
// A GRADED RECORD MUST CARRY THE PIN IT WAS GRADED AGAINST (cinatra#3144 G3).
//
// A capture graded against an unnamed drawing cannot be re-checked by anyone
// and cannot be invalidated by a later ratification: a reader cannot tell which
// picture the grade was read from, and a ratification that retires that picture
// cannot reach back and mark the grade stale. So every Fix-leg / graded-capture
// section of a pull request body must carry a literal `design@<40-hex>` equal
// to the pin on that branch.
//
// NO EXTRA CREDENTIAL. The body is already in the workflow event payload at
// GITHUB_EVENT_PATH (`pull_request.body`), which is the same door the
// skills-drift acknowledgement line is read through.
//
// THE GRAMMAR IS DEFINED HERE, not inferred, so a body can neither dodge the
// rule by re-styling a heading nor be failed by a sentence that merely mentions
// a fix leg:
//
//   A GRADED SECTION opens at a Markdown ATX heading (`#` through `######`)
//   whose text, trimmed and read case-insensitively, matches either
//     ^fix leg\b
//   or
//     ^(.*\bcapture\b.*\bgraded\b|.*\bgraded\b.*\bcapture\b)
//   and runs to the next heading of the SAME OR A HIGHER level, or to the end
//   of the body. A deeper heading stays inside it. A bold or emphasised line
//   is not a heading and opens nothing. A heading inside a fenced code block is
//   not a heading either.
//
//   THE WORDS ARE READ EXACTLY AS THE GRAMMAR STATES THEM: `\bcapture\b` and
//   `\bgraded\b`. A plural-only heading ("Captures — graded") therefore opens
//   no section. That is the ratified grammar implemented rather than widened,
//   and its suite pins the consequence in both directions so a body is never
//   failed by a rule the grammar does not carry.
//
// THE VERDICT. Every graded section must carry at least one `design@<40-hex>`,
// and every such value in it must equal the branch's pin. A section carrying
// the right value AND a wrong one is red: a record that names two pins names
// none. The message prints both values that disagree — both are content this
// repository already tracks or that the body itself published, so neither is a
// disclosure.
//
// TRIGGER. The shared map, the shared rule (scripts/ci/lib/design-pin.mjs): a
// pull request touching no mapped lifecycle path is unaffected, and an
// unresolvable diff base means every path is treated as touched — fail-closed,
// the same direction as its two siblings.
//
// Usage:
//   node scripts/ci/design-record-grammar.mjs
//   node scripts/ci/design-record-grammar.mjs --github-annotations
//   node scripts/ci/design-record-grammar.mjs --body-file <path>
//
// Exit codes:
//   0  no graded section is missing or contradicting the branch's pin
//   1  at least one graded section does not carry it
//   2  the gate could not run honestly (the branch's own pin is unreadable, the
//      map is unreadable, the diff base does not resolve)

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GLOBAL_PATHS,
  MAP_PATH,
  RECORD_GRAMMAR_CHECKER_PATH,
  loadGatePathMap,
  parseSpecCommit,
  readCommitBearingPins,
  resolveTouchedPins,
} from "./lib/design-pin.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const CHECKER_PATH = RECORD_GRAMMAR_CHECKER_PATH;
export { GLOBAL_PATHS, MAP_PATH };

// An ATX heading may carry up to three leading spaces (CommonMark); four make
// it an indented code block. A gate that only read a column-0 heading could be
// dodged by indenting one space, which is not a grammar this record ratifies.
const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;
// A fence is opened by three or more backticks or tildes and closed only by a
// run of the SAME character at least as long — so a three-backtick line inside
// a tilde block, or inside a longer backtick block, does not close it.
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const FIX_LEG = /^fix leg\b/i;
const GRADED_CAPTURE = /^(?=.*\bcapture\b)(?=.*\bgraded\b)/i;
const PIN_TOKEN = /design@([0-9a-f]{40})\b/g;

/** Is this heading text the opening of a graded section? */
export function isGradedHeading(text) {
  const trimmed = text.trim();
  return FIX_LEG.test(trimmed) || GRADED_CAPTURE.test(trimmed);
}

/**
 * Every graded section in a body, as `{ level, heading, text }`. Fenced blocks
 * are skipped wholesale: a heading shown inside a code sample is documentation
 * of the grammar, not a use of it.
 */
export function findGradedSections(body) {
  const lines = String(body ?? "").split(/\r?\n/);
  const sections = [];
  let open = null;
  let fence = null;
  for (const line of lines) {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (fence === null) {
        fence = marker;
      } else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null;
      }
      if (open) open.lines.push(line);
      continue;
    }
    const heading = fence !== null ? null : HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      if (open && level <= open.level) {
        sections.push(open);
        open = null;
      }
      if (!open && isGradedHeading(heading[2])) {
        // The heading line is PART of the section — the grammar says the
        // section runs FROM it — so a pin written into the heading itself
        // counts, rather than being reported missing.
        open = { level, heading: heading[2].trim(), lines: [line] };
        continue;
      }
    }
    if (open) open.lines.push(line);
  }
  if (open) sections.push(open);
  return sections.map(({ level, heading, lines: body_ }) => ({
    level,
    heading,
    text: body_.join("\n"),
  }));
}

/**
 * Judge a body against the branch's pin. Pure, so the suite drives exactly what
 * CI drives. `specCommit` is the pin value as the branch's own files carry it.
 */
export function checkBody({ body, specCommit }) {
  const { revision } = parseSpecCommit(specCommit);
  const sections = findGradedSections(body);
  const findings = [];
  for (const section of sections) {
    const found = [...section.text.matchAll(PIN_TOKEN)].map((m) => m[1]);
    if (found.length === 0) {
      findings.push({ heading: section.heading, kind: "missing", found: [] });
      continue;
    }
    const wrong = [...new Set(found.filter((sha) => sha !== revision))];
    if (wrong.length > 0) {
      findings.push({ heading: section.heading, kind: "mismatch", found: wrong });
    }
  }
  return { sections, findings, revision };
}

/** The message. Names the section, and both values when they disagree. */
export function formatFindings(findings, specCommit) {
  const { revision } = parseSpecCommit(specCommit);
  const blocks = findings.map((f) =>
    f.kind === "missing"
      ? [
          `MISSING — the section "${f.heading}" grades a capture and names no design pin.`,
          `  this branch grades against: design@${revision}`,
          "  add that literal to the section, so a later ratification can invalidate the grade.",
        ].join("\n")
      : [
          `MISMATCH — the section "${f.heading}" names a design pin this branch does not carry.`,
          `  the body says:              ${f.found.map((sha) => `design@${sha}`).join(", ")}`,
          `  this branch grades against: design@${revision}`,
          "  a record may not be graded against a drawing the branch does not pin.",
        ].join("\n"),
  );
  return blocks.join("\n\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function annotate(log, level, title, message) {
  log(`::${level} title=${title}::${message.replace(/\r?\n/g, "%0A")}`);
}

/**
 * The body this run judges: an explicit file, or the event payload. Returns
 * `{ kind: "body" | "absent" | "unreadable" }`. The three are kept apart on
 * purpose: an event with no pull request genuinely has no body to read, while
 * a payload that cannot be read or parsed is a question this gate did NOT
 * answer — and answering it "ok, there is no body" would pass a record nobody
 * inspected.
 */
export function readBody({ argv, env, readImpl = readFileSync }) {
  const flag = argv.indexOf("--body-file");
  if (flag !== -1 && argv[flag + 1]) {
    try {
      return { kind: "body", text: readImpl(argv[flag + 1], "utf8") };
    } catch {
      return { kind: "unreadable", why: "the body file named on the command line could not be read" };
    }
  }
  const eventPath = (env.GITHUB_EVENT_PATH ?? "").trim();
  if (eventPath === "") return { kind: "absent" };
  let event;
  try {
    event = JSON.parse(readImpl(eventPath, "utf8"));
  } catch {
    return { kind: "unreadable", why: "the event payload could not be read as data" };
  }
  if (event === null || typeof event !== "object" || !("pull_request" in event)) {
    return { kind: "absent" };
  }
  const body = event.pull_request?.body;
  if (body === null || body === undefined) return { kind: "body", text: "" };
  if (typeof body !== "string") {
    return { kind: "unreadable", why: "the event payload carries a pull request body in no shape this gate reads" };
  }
  return { kind: "body", text: body };
}

export async function runCli({
  argv = [],
  env = {},
  repoRoot = REPO_ROOT,
  pins: pinsInput,
  runGit = git,
  log = console.log,
  logError = console.error,
} = {}) {
  const annotations = argv.includes("--github-annotations");
  const cannotRun = (message) => {
    logError(`ERROR: the gate could not run honestly: ${message}`);
    return 2;
  };

  let pins;
  try {
    pins = typeof pinsInput === "function" ? pinsInput() : (pinsInput ?? readCommitBearingPins(repoRoot));
  } catch {
    return cannotRun("this branch's own design pin could not be read.");
  }
  if (pins.length === 0) return cannotRun("this branch carries no design pin to grade against.");

  const read = readBody({ argv, env });
  if (read.kind === "unreadable") return cannotRun(`${read.why}.`);
  if (read.kind === "absent") {
    log("ok: this event carries no pull request body, so there is no graded record to check.");
    return 0;
  }
  const body = read.text;

  // The trigger. A pull request that adopts none of the mapped lifecycle paths
  // is unaffected — the rule is about records that GRADE this contract's
  // screens, not about every body in the repository.
  let map;
  try {
    map = loadGatePathMap(repoRoot);
  } catch {
    return cannotRun("the path map could not be read.");
  }
  let touchedPinIds = Object.keys(map.pins);
  const base = (env.DESIGN_PIN_DRIFT_DIFF_BASE ?? "").trim();
  if (base === "") {
    log("::notice::no diff base is set — treating every mapped path as touched (fail-closed).");
  } else {
    let touchedPaths;
    try {
      runGit(["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
      touchedPaths = runGit(["diff", "--name-only", `${base}...HEAD`])
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      return cannotRun("the diff base does not resolve to a revision in this checkout.");
    }
    touchedPinIds = resolveTouchedPins({ touchedPaths, map, globalPaths: GLOBAL_PATHS });
  }
  if (touchedPinIds.length === 0) {
    log("ok: this diff touches no path mapped to a design pin, so no graded record is owed.");
    return 0;
  }

  const specCommit = `design@${pins[0].revision} ${pins[0].paths.join(" ")}`;
  const { sections, findings } = checkBody({ body, specCommit });

  log(
    sections.length === 0
      ? "ok: the body carries no Fix leg or graded-capture section."
      : `read ${sections.length} graded section(s): ${sections.map((s) => `"${s.heading}"`).join(", ")}`,
  );

  if (findings.length === 0) {
    if (sections.length > 0) log("ok: every graded section names the pin this branch grades against.");
    return 0;
  }

  const text = formatFindings(findings, specCommit);
  logError("ERROR: a graded record does not carry the design pin it was graded against.");
  logError("");
  logError(text);
  if (annotations) annotate(log, "error", "design-record-grammar", text);
  return 1;
}

const isMain =
  typeof process.argv[1] === "string" &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  process.exit(await runCli({ argv: process.argv.slice(2), env: process.env }));
}
