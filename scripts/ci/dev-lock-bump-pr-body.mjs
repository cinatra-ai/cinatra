#!/usr/bin/env node
// Body composer for the rolling dev-lock auto-bump PR (cinatra#2986 gap 2).
//
// WHY THIS EXISTS
// ---------------
// `.github/workflows/dev-lock-auto-bump.yml` force-refreshes ONE rolling PR
// (`auto/dev-lock-bump` -> `main`) and rewrites its description on every push.
// `skills-drift-gate` reads that description for a `Skills-*` acknowledgement,
// so the old whole-body overwrite destroyed any acknowledgement a person had
// added between scheduled runs, and the template never carried one in the first
// place. Both halves reded the bump PR for reasons unrelated to the pins.
//
// THE RULE THIS FILE ENFORCES (maintainer ruling on cinatra#2986, comment
// 5413682084 — Path A):
//   the automation may PRESERVE a human acknowledgement; it may NEVER PRODUCE,
//   reword, or complete one.
// So this composer:
//   - regenerates every OTHER part of the body from the current bump, and
//   - carries ONE marked block verbatim when — and only when — the fingerprint
//     it recorded still matches the one this bump computes.
// "Verbatim" is exact except for line endings: the GitHub API hands back a body
// with CRLF, so the block is normalized to LF before it is carried. No character
// of the acknowledgement text itself is added, dropped, or reordered.
// A body with no valid block states, in prose, that a person must add the
// acknowledgement inside the markers. The PR then stays red on
// `skills-drift-gate`, truthfully, until that person judges.
//
// THE MARKER BLOCK
// ----------------
//   <!-- cinatra:skills-ack v1 fingerprint=<64 lowercase hex> -->
//   ...whatever the person wrote (the acknowledgement)...
//   <!-- /cinatra:skills-ack -->
// The fingerprint is stored INSIDE the opening marker so the pairing of
// "judgment" to "pin set it covered" cannot be broken by an ordinary edit to the
// surrounding body: a person edits the text between the markers, and the marker
// lines themselves are carried verbatim with it.
//
// FINGERPRINT FORMAT (documented so a human can recompute it by hand):
//   sha256( lines.sort().join("\n") ), hex-encoded lowercase, where `lines` is
//   the union of three prefixed families:
//     pin:<packageName>@<resolvedSha>   one per SKILL-LINKED changed pin — a
//                                        package this bump re-pins that a pinned
//                                        SKILL.md declares under `cinatra-watches`
//                                        `packages:`. A REMOVED package carries the
//                                        literal sha `(removed)`, so dropping a
//                                        watched package moves the value too.
//     skills-repo:<owner>/<name>@<sha>  one per skills repo the gate caller pins.
//     watch:<cls>:<surface>@<skill>     one per DECLARED watch surface, all four
//                                        classes, at those pins.
//   Sorting makes the value order-independent. The pin family moves when a
//   covered package is re-pinned; the other two move when the gate's own pinned
//   skills universe moves — either is a reason a recorded judgment stops
//   covering the bump. Both halves come from
//   scripts/ci/skills-drift-watched-packages.mjs, which reads the gate caller.
//
// SCOPE, STATED HONESTLY — THE RESIDUAL THIS CANNOT COVER
// ------------------------------------------------------
// The gate's acknowledgement forms are PR-WIDE: one `Skills-reviewed:` clears
// EVERY finding on the PR, not the one it was written for. So a carried block
// clears whatever the gate finds on the refresh that carried it. The fingerprint
// above moves for every input the maintainer's ruling names — the skill-linked
// package pins — and for every change to the pinned skills universe. It does NOT
// move for an unrelated pin move, and that is deliberate: carrying a judgment
// across an unrelated pin move is exactly what the ruling asks for
// (cinatra#2986, comment 5413682084).
//
// The residual: a NON-skill-linked package's bump can put a watched
// `primitives:`/`routes:` identifier into the regenerated maps or authz
// inventory, or touch a watched `paths:` glob, producing a NEW gate finding
// while the skill-linked package pins are unchanged. A block carried by this
// rule would clear that finding too. Closing it would mean keying the carry on
// the gate's whole finding set, i.e. on the bump's entire diff — which changes
// on every refresh, so nothing would ever carry and the ruling's carry-forward
// property would be gone. The ruling chose carry-forward; this is the price, and
// it is recorded here rather than papered over. Everything else about the
// direction is safe: the gate, not this script, decides green, and no path here
// writes an acknowledgement.
//
// Pure and dependency-free: every export is a total function of its arguments,
// and the CLI at the bottom is a thin file-in/file-out wrapper. Unit-tested in
// scripts/ci/__tests__/dev-lock-bump-pr-body.test.mjs.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

/** Opening marker. Anchored per-line; the fingerprint must be 64 lowercase hex. */
const ACK_BEGIN_RE = /^[ \t]*<!--[ \t]*cinatra:skills-ack[ \t]+v1[ \t]+fingerprint=([0-9a-f]{64})[ \t]*-->[ \t]*$/gm;
/** Closing marker. */
const ACK_END_RE = /^[ \t]*<!--[ \t]*\/cinatra:skills-ack[ \t]*-->[ \t]*$/gm;
/**
 * ANY opening-marker-shaped line, valid fingerprint or not. A body carrying a
 * marker this script cannot read is MALFORMED, never "absent": treating a typo'd
 * fingerprint as "no block" would silently drop a real judgment AND silently
 * append a second marker pair.
 */
const ACK_BEGIN_LOOSE_RE = /^[ \t]*<!--[ \t]*cinatra:skills-ack\b[^\n]*-->[ \t]*$/gm;

/** Normalize CRLF so the line-anchored marker regexes see plain `\n`. */
function lf(text) {
  return String(text ?? "").replace(/\r\n/g, "\n");
}

function allMatches(re, text) {
  re.lastIndex = 0;
  return [...text.matchAll(re)];
}

/**
 * Hash the skill-linked pin set. Order-independent, defined for the empty set.
 * @param {Array<{packageName: string, resolvedSha: string}>} pins
 * @returns {string} 64 lowercase hex chars
 */
export function fingerprintSkillLinkedPins(pins, universe = null) {
  const lines = (pins ?? []).map((p) => `pin:${p.packageName}@${p.resolvedSha}`);
  for (const pin of universe?.pins ?? []) lines.push(`skills-repo:${pin}`);
  for (const surface of universe?.surfaces ?? []) lines.push(`watch:${surface}`);
  return createHash("sha256").update(lines.sort().join("\n"), "utf8").digest("hex");
}

/**
 * Locate the marked acknowledgement block in a PR body.
 *
 * FAIL-CLOSED in every ambiguous direction: two blocks, a marker this script
 * cannot parse, a missing closer, or a closer before its opener all report a
 * non-`found` kind, and the caller then demands a fresh judgment rather than
 * guessing which half of the body a person meant.
 *
 * A block whose inner text is BLANK (empty once trimmed) is reported as
 * `none`, not `found`: it is the empty pair this composer itself places for a
 * person to write into, not a judgment. Reporting it as `found` would let a
 * later refresh carry it forward and claim "written by a person" over nothing.
 *
 * @returns {{kind: "none"}
 *          | {kind: "found", fingerprint: string, raw: string}
 *          | {kind: "malformed"} | {kind: "ambiguous"}}
 */
export function extractAckBlock(body) {
  const text = lf(body);
  const loose = allMatches(ACK_BEGIN_LOOSE_RE, text);
  const ends = allMatches(ACK_END_RE, text);
  if (loose.length === 0 && ends.length === 0) return { kind: "none" };
  if (loose.length > 1 || ends.length > 1) return { kind: "ambiguous" };
  if (loose.length !== 1 || ends.length !== 1) return { kind: "malformed" };

  const begins = allMatches(ACK_BEGIN_RE, text);
  if (begins.length !== 1) return { kind: "malformed" }; // marker present, fingerprint unreadable
  const begin = begins[0];
  const end = ends[0];
  const start = begin.index;
  const stop = end.index + end[0].length;
  if (stop <= start) return { kind: "malformed" }; // closer before opener
  const inner = text.slice(begin.index + begin[0].length, end.index);
  if (inner.trim() === "") return { kind: "none" }; // empty pair, not a judgment
  return { kind: "found", fingerprint: begin[1], raw: text.slice(start, stop) };
}

/** Render the marker pair with no content — the place a person writes into. */
function emptyMarkerPair(fingerprint) {
  return `<!-- cinatra:skills-ack v1 fingerprint=${fingerprint} -->\n\n<!-- /cinatra:skills-ack -->`;
}

/**
 * Prose that tells a person what to do. It deliberately NAMES NO
 * acknowledgement token: `skills-drift-gate` matches those tokens anywhere in
 * the body, so writing one here — even as an example — would make the gate pass
 * on text no person wrote. The gate's own workflow file documents the forms.
 */
const ACK_INSTRUCTIONS = [
  "A person must record that judgment here. Write it between the two marker lines below, in one of the",
  "three acknowledgement forms documented in `.github/workflows/skills-drift-gate.yml`. This workflow",
  "preserves whatever sits between those markers across the branch's force-refreshes, byte for byte, and",
  "never writes, completes, or rewords it. Until a person writes it, `skills-drift-gate` fails — truthfully.",
].join("\n");

/**
 * Prose for a bump with no skill-linked pins. No pin above asks for a
 * judgment, but `skills-drift-gate` can still fail on a declared
 * `primitives:`/`routes:`/`paths:` watch unrelated to these pins — the
 * residual this composer cannot close (see the module header). So the marker
 * pair is still placed, framed as conditional rather than demanded.
 */
const ACK_INSTRUCTIONS_NO_PINS = [
  "`skills-drift-gate` can still fail this PR on a declared `primitives:` / `routes:` / `paths:` watch unrelated to",
  "these pins. If it does, a person must record that judgment here. Write it between the two marker lines below, in",
  "one of the three acknowledgement forms documented in `.github/workflows/skills-drift-gate.yml`. This workflow",
  "preserves whatever sits between those markers across the branch's force-refreshes, byte for byte, and never",
  "writes, completes, or rewords it.",
].join("\n");

const PREAMBLE = [
  "Automated rolling dev-lock bump, opened by `.github/workflows/dev-lock-auto-bump.yml` — see `docs/internals/contracts/extension-clone-pinning.md` for the recipe and the lock partition.",
  "",
  "The full bump recipe in one commit: `cinatra-dev-extensions.lock.json` + `pnpm-lock.yaml` + regenerated `src/lib/generated` maps + the regenerated authz inventory (`src/lib/authz/__generated__/inventory.json`). This PR's own CI run is the integration test for the new pins. The branch is force-updated from the current main head on each scheduled run while the PR is open — review and merge it like any deliberate bump PR.",
].join("\n");

/** `(removed)` is the sentinel a de-listed package carries; never truncate it. */
function pinList(pins) {
  return pins
    .map((p) => {
      const sha = String(p.resolvedSha);
      return `- \`${p.packageName}\`: ${sha.startsWith("(") ? sha : sha.slice(0, 12)}`;
    })
    .join("\n");
}

/**
 * Compose the rolling bump PR's description.
 *
 * @param {object} args
 * @param {string} [args.oldBody] the PR's CURRENT description (empty on open)
 * @param {string} args.pinChanges the markdown pin-change list for this bump
 * @param {Array<{packageName: string, resolvedSha: string}>} [args.skillLinked]
 *        the skill-linked pin set: the packages this bump re-pins that a pinned
 *        SKILL.md declares as a watched dependency
 * @param {{pins: string[], surfaces: string[]}|null} [args.universe]
 *        the gate's pinned skills universe — its repo pins and every declared
 *        watch surface at those pins. Folded into the fingerprint so a re-pin of
 *        the skills universe also drops a block written against the old one.
 * @returns {string} the new description
 */
export function composeBumpPrBody({ oldBody = "", pinChanges = "", skillLinked = [], universe = null } = {}) {
  const pins = [...(skillLinked ?? [])].sort((a, b) => a.packageName.localeCompare(b.packageName));
  const fingerprint = fingerprintSkillLinkedPins(pins, universe);
  const found = extractAckBlock(oldBody);
  const carried = found.kind === "found" && found.fingerprint === fingerprint;

  const sections = [PREAMBLE, "", "## Pin changes", "", lf(pinChanges).trim(), "", "## Skills acknowledgement", ""];

  if (pins.length === 0) {
    sections.push(
      "No package this bump re-pins is a declared `cinatra-watches` `packages:` dependency of the pinned skills " +
        "universe (`skills_repos` in `.github/workflows/skills-drift-gate.yml`), so this refresh asks for no " +
        "judgment on that watch class.",
      "",
      `Skill-linked pin-set fingerprint: \`${fingerprint}\` (the empty set).`,
    );
    // A block recorded against a NON-empty set no longer covers this bump; it is
    // dropped by the same rule as any other moved fingerprint. A block recorded
    // against the empty set still covers it and is carried.
    if (carried) {
      sections.push("", found.raw);
    } else {
      sections.push("", ACK_INSTRUCTIONS_NO_PINS, "", emptyMarkerPair(fingerprint));
    }
    return `${sections.join("\n").trimEnd()}\n`;
  }

  sections.push(
    "These re-pinned packages are declared `cinatra-watches` `packages:` dependencies of the pinned skills " +
      "universe (`skills_repos` in `.github/workflows/skills-drift-gate.yml`), so `skills-drift-gate` asks whether " +
      "the skills that watch them are still correct at the new pins:",
    "",
    pinList(pins),
    "",
    `Skill-linked pin-set fingerprint: \`${fingerprint}\`.`,
    "",
  );

  if (carried) {
    sections.push(
      "The acknowledgement below was written by a person against exactly this pin set, and is carried forward " +
        "unchanged. It is dropped automatically as soon as the fingerprint above moves.",
      "",
      found.raw,
    );
    return `${sections.join("\n").trimEnd()}\n`;
  }

  if (found.kind === "found") {
    sections.push(
      `The previous acknowledgement covered a different skill-linked pin set (it recorded \`${found.fingerprint}\`), ` +
        "so it was dropped: a fresh judgment is required at the pins above.",
      "",
    );
  } else if (found.kind === "ambiguous" || found.kind === "malformed") {
    sections.push(
      "The previous description carried a marker block this workflow could not read unambiguously, so it was " +
        "dropped rather than guessed at: a fresh judgment is required at the pins above.",
      "",
    );
  }

  sections.push(ACK_INSTRUCTIONS, "", emptyMarkerPair(fingerprint));
  return `${sections.join("\n").trimEnd()}\n`;
}

// --------------------------------------------------------------------------
// CLI: file in, file out. Every input is a path so the workflow never
// interpolates PR-author-controlled text into a shell line.
// --------------------------------------------------------------------------
function readOptional(path) {
  if (!path) return "";
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return "";
    throw err;
  }
}

/**
 * Read `--skill-linked`. Unlike `readOptional`, a path that WAS given but does
 * not exist is a hard error: silently treating it as the empty set is the
 * permissive direction — it reads as "nothing to judge" — and this is the one
 * input the workflow's derivation step always produces before calling this
 * composer, so a missing file means something upstream broke.
 */
function readSkillLinkedFile(path) {
  if (!path) return "";
  return readFileSync(path, "utf8");
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    out[key] = argv[i + 1];
    i += 1;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args["pin-changes"]) {
    console.error("usage: dev-lock-bump-pr-body.mjs --pin-changes <md> [--old-body <md>] [--skill-linked <json>] [--out <md>]");
    process.exit(2);
  }
  const skillLinkedRaw = readSkillLinkedFile(args["skill-linked"]).trim();
  let skillLinked = [];
  let universe = null;
  if (skillLinkedRaw) {
    const parsed = JSON.parse(skillLinkedRaw);
    // Accept both the bare array and the derivation script's report envelope.
    skillLinked = Array.isArray(parsed) ? parsed : (parsed.skillLinked ?? []);
    if (!Array.isArray(parsed)) universe = parsed.universe ?? null;
  }
  const body = composeBumpPrBody({
    oldBody: readOptional(args["old-body"]),
    pinChanges: readOptional(args["pin-changes"]),
    skillLinked,
    universe,
  });
  if (args.out) writeFileSync(args.out, body);
  else process.stdout.write(body);
}

if (process.argv[1] && process.argv[1].endsWith("dev-lock-bump-pr-body.mjs")) main();
