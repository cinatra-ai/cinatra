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
// and every such value in it must equal the branch's pin, save for the one
// reading below. A section carrying the right value AND a wrong one is red: a
// record that names two pins names none. The message prints both values that
// disagree — both are content this repository already tracks or that the body
// itself published, so neither is a disclosure.
//
// A SUPERSEDED GRADE (cinatra#3670). A pull request that adopts a newer pin
// after its earlier rounds were graded keeps those rounds under the pins they
// were truly graded against. A graded section that is NOT the newest one, and
// whose one value is an OLDER revision of the branch's pin — an ancestor of it
// in the design history — reads as "graded under design@<old> — superseded"
// and passes with a notice, provided a LATER section names the branch's pin and
// no other value: a later graded section, or a later Visual proof section (an
// ATX heading whose text opens with the words `visual proof`, read by the same
// heading and fence rules). The newest graded section still owes the pin
// itself, so a body cannot pass on old grades alone. The design history is the
// local copy of the design source that DESIGN_DRAWINGS_DIR names, read with git
// and never fetched. When there is no copy, it is no repository, it lacks the
// branch's pin, or it is too shallow to decide, the ancestor test refuses and
// the section stays a mismatch with that reason printed. A value the history
// does not show as an ancestor — a foreign or unknown one, or a descendant —
// stays a mismatch.
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
// Environment:
//   DESIGN_DRAWINGS_DIR   a local copy of the design history, for the superseded
//                         reading; without one, that reading refuses
//
// Exit codes:
//   0  every graded section names the branch's pin, or an older revision of it
//      that a later section supersedes
//   1  at least one graded section does not carry it
//   2  the gate could not run honestly (the branch's own pin is unreadable, the
//      map is unreadable, the diff base does not resolve)

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DRAWINGS_DIR_ENV,
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
const VISUAL_PROOF = /^visual proof\b/i;
const PIN_TOKEN = /design@([0-9a-f]{40})\b/g;

/** Is this heading text the opening of a graded section? */
export function isGradedHeading(text) {
  const trimmed = text.trim();
  return FIX_LEG.test(trimmed) || GRADED_CAPTURE.test(trimmed);
}

/** Is this heading text the opening of a Visual proof section? */
export function isVisualProofHeading(text) {
  return VISUAL_PROOF.test(text.trim());
}

/** Every `design@<40-hex>` value a piece of text names, in order. */
function pinsIn(text) {
  return [...text.matchAll(PIN_TOKEN)].map((m) => m[1]);
}

/**
 * Every section a heading rule opens, as `{ level, heading, at, text }`, where
 * `at` is the heading's line index in the body. Fenced blocks are skipped
 * wholesale: a heading shown inside a code sample is documentation of the
 * grammar, not a use of it.
 */
function findSections(body, opens) {
  const lines = String(body ?? "").split(/\r?\n/);
  const sections = [];
  let open = null;
  let fence = null;
  for (const [at, line] of lines.entries()) {
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
      if (!open && opens(heading[2])) {
        // The heading line is PART of the section — the grammar says the
        // section runs FROM it — so a pin written into the heading itself
        // counts, rather than being reported missing.
        open = { level, heading: heading[2].trim(), at, lines: [line] };
        continue;
      }
    }
    if (open) open.lines.push(line);
  }
  if (open) sections.push(open);
  return sections.map(({ level, heading, at, lines: body_ }) => ({
    level,
    heading,
    at,
    text: body_.join("\n"),
  }));
}

/** Every graded section in a body, in body order. */
export function findGradedSections(body) {
  return findSections(body, isGradedHeading);
}

/** Every Visual proof section in a body, in body order. */
export function findVisualProofSections(body) {
  return findSections(body, isVisualProofHeading);
}

// ---------------------------------------------------------------------------
// The design history (cinatra#3670)
// ---------------------------------------------------------------------------

/** The whole vocabulary a refused ancestor test may be described with. No digits. */
export const HISTORY_REASONS = Object.freeze({
  "no-copy": "no copy of the design history is at hand for this check",
  unreadable: "the design history at hand could not be read",
  "no-pin": "the design history at hand does not carry this branch's pin",
  shallow: "the design history at hand is shallow and cannot show whether the value is an older revision",
});

/** The public sentence for a refusal: CLOSED text, never what git printed. */
function historyReason(reason) {
  return HISTORY_REASONS[reason] ?? HISTORY_REASONS.unreadable;
}

// Variables that could point git at a repository other than the copy named.
const REDIRECTING_GIT_VARIABLES = Object.freeze([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
]);

/**
 * The ancestor test, over a LOCAL copy of the design history: the copy that
 * DESIGN_DRAWINGS_DIR names, the same one design-anchor-resolution may read
 * its drawings from. It never fetches. `isAncestor(older, newer)` answers
 * `{ refused: false, ancestor }` — `ancestor` true only for a STRICT ancestor —
 * or `{ refused: true, reason }` with a key of HISTORY_REASONS. A refusal is
 * never a pass: the caller keeps the section a mismatch and prints the reason.
 */
export function createDesignHistory({ dir } = {}) {
  const refuse = (reason) => ({ refused: true, reason });
  const root = typeof dir === "string" ? dir.trim() : "";
  if (root === "") return { isAncestor: () => refuse("no-copy") };

  const copy = resolve(root);
  const env = {
    ...process.env,
    // The copy must be a repository in its own right, not one it sits inside.
    GIT_CEILING_DIRECTORIES: dirname(copy),
    // Never fetch a missing object, never let a replacement stand in for the
    // history, and never wait on a prompt.
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const name of REDIRECTING_GIT_VARIABLES) delete env[name];
  const git = (args) => {
    const r = spawnSync("git", ["-C", copy, ...args], { encoding: "utf8", env, timeout: 60_000 });
    return { status: r.error ? null : r.status, stdout: String(r.stdout ?? "") };
  };
  const carries = (revision) => git(["cat-file", "-e", `${revision}^{commit}`]).status === 0;

  let shallow; // undefined until read; null when the copy is no repository
  const decide = (older, newer) => {
    if (older === newer) return { refused: false, ancestor: false };
    if (shallow === undefined) {
      const probe = git(["rev-parse", "--is-shallow-repository"]);
      shallow = probe.status === 0 ? probe.stdout.trim() === "true" : null;
    }
    if (shallow === null) return refuse("unreadable");
    if (!carries(newer)) return refuse("no-pin");
    // A complete history that carries the pin carries every ancestor of it, so
    // a value it lacks is none. A shallow one may only have cut the value off.
    if (!carries(older)) return shallow ? refuse("shallow") : { refused: false, ancestor: false };
    const { status } = git(["merge-base", "--is-ancestor", older, newer]);
    if (status === 0) return { refused: false, ancestor: true };
    if (status === 1) return shallow ? refuse("shallow") : { refused: false, ancestor: false };
    return refuse("unreadable");
  };

  const answers = new Map();
  return {
    isAncestor(older, newer) {
      const key = `${older} ${newer}`;
      if (!answers.has(key)) answers.set(key, decide(older, newer));
      return answers.get(key);
    },
  };
}

/** Why an older value was not read as superseded. Closed text, no digits. */
const NOT_SUPERSEDED = Object.freeze({
  "no-later-section": "no later graded section or Visual proof section names this branch's pin alone",
  "not-older": "the design history does not show that value as an older revision of this branch's pin",
});

/**
 * Judge a body against the branch's pin. Pure but for the design history it is
 * handed, so the suite drives exactly what CI drives. `specCommit` is the pin
 * value as the branch's own files carry it; `history` answers the ancestor
 * test (createDesignHistory), and without one that test refuses.
 */
export function checkBody({ body, specCommit, history = createDesignHistory() }) {
  const { revision } = parseSpecCommit(specCommit);
  const sections = findGradedSections(body);
  const findings = [];
  const superseded = [];
  // The sections that may stand as the LATER one: graded or Visual proof, and
  // naming the branch's pin and no other value.
  const namesThePinAlone = (s) => {
    const found = pinsIn(s.text);
    return found.length > 0 && found.every((sha) => sha === revision);
  };
  const later = [...sections, ...findVisualProofSections(body)]
    .filter(namesThePinAlone)
    .sort((a, b) => a.at - b.at);

  for (const [index, section] of sections.entries()) {
    const found = pinsIn(section.text);
    if (found.length === 0) {
      findings.push({ heading: section.heading, kind: "missing", found: [] });
      continue;
    }
    const wrong = [...new Set(found.filter((sha) => sha !== revision))];
    if (wrong.length === 0) continue;
    const mismatch = (why) =>
      findings.push({ heading: section.heading, kind: "mismatch", found: wrong, ...(why ? { why } : {}) });
    // The newest graded section owes the pin itself, and a section that names
    // two values names none: neither is ever read as superseded.
    if (index === sections.length - 1 || new Set(found).size > 1) {
      mismatch();
      continue;
    }
    const [older] = wrong;
    const carrier = later.find((s) => s.at > section.at);
    if (!carrier) {
      mismatch(NOT_SUPERSEDED["no-later-section"]);
      continue;
    }
    const answer = history.isAncestor(older, revision);
    if (answer.refused) {
      mismatch(`the ancestor test refused, because ${historyReason(answer.reason)}`);
    } else if (answer.ancestor !== true) {
      mismatch(NOT_SUPERSEDED["not-older"]);
    } else {
      superseded.push({ heading: section.heading, older, carrier: carrier.heading });
    }
  }
  return { sections, findings, superseded, revision };
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
          ...(f.why ? [`  not read as superseded: ${f.why}.`] : []),
        ].join("\n"),
  );
  return blocks.join("\n\n");
}

/** The notice. Names the section, the older value, the pin and the later section. */
export function formatSuperseded(superseded, specCommit) {
  const { revision } = parseSpecCommit(specCommit);
  return superseded
    .map((s) =>
      [
        `NOTICE — the section "${s.heading}" was graded under design@${s.older} — superseded.`,
        `  that value is an older revision of the pin this branch grades against: design@${revision}`,
        `  the later section "${s.carrier}" names that pin, so the older grade stays in the body as history.`,
      ].join("\n"),
    )
    .join("\n\n");
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
  const history = createDesignHistory({ dir: env[DRAWINGS_DIR_ENV] });
  const { sections, findings, superseded } = checkBody({ body, specCommit, history });

  log(
    sections.length === 0
      ? "ok: the body carries no Fix leg or graded-capture section."
      : `read ${sections.length} graded section(s): ${sections.map((s) => `"${s.heading}"`).join(", ")}`,
  );

  for (const entry of superseded) {
    const text = formatSuperseded([entry], specCommit);
    log(text);
    if (annotations) annotate(log, "notice", "design-record-grammar", text);
  }

  if (findings.length === 0) {
    if (sections.length > 0) {
      log(
        superseded.length === 0
          ? "ok: every graded section names the pin this branch grades against."
          : "ok: every graded section names the pin this branch grades against, or an older revision of it that a later section supersedes.",
      );
    }
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
