#!/usr/bin/env node
// THE ADOPTION ROAD (cinatra#3144 G0).
//
// Adopting a ratification is four edits that must happen together or not at
// all: the pin in the acceptance manifest, the mirror in the anchor contract,
// the record of what the re-examination FOUND, and the digest. Doing them by
// hand is how a pin moves with a digest taken over the old one, or with a
// re-ratification note nobody could check. This script does them in one
// transaction, and refuses every shortcut:
//
//   · the digest is READ FROM THE CANONICAL SCRIPT
//     (`chat-hitl-acceptance-gate.mjs --print-anchor-digest`) on the tree AFTER
//     the other three edits are in place. It is never computed here and never
//     copied from anywhere else. If the script does not print one, the tree is
//     ROLLED BACK and nothing is left half-moved;
//   · `anchorsUnresolvedAtPin` is READ FROM THE RESOLUTION CHECK
//     (`design-anchor-resolution.mjs --print-unresolved`) at the new pin,
//     sorted, and recorded as data. A non-empty array is a TRUTHFUL passing
//     state, not a failure to fix: the anchors it lists are retired by the
//     content change that owns them, and until then the array says so;
//   · the manifest and the mirror must already AGREE before anything moves — a
//     tree that disagrees with itself is one this script may not adopt on top
//     of.
//
// THE EDITS ARE TEXTUAL, not a re-serialisation. Both files are hand-authored
// documents whose formatting, key order and long prose notes are part of the
// record; `JSON.stringify` would reformat every line and bury the change.
//
// IT DOES NOT WRITE THE RE-RATIFICATION NOTE. That prose is a claim a person
// makes about what they re-examined, and this script has re-examined nothing.
// It prints where the note goes.
//
// Usage:
//   node scripts/audit/adopt-design-pin.mjs --pin "design@<40-hex> specs/a.html [specs/b.html]"
//   node scripts/audit/adopt-design-pin.mjs --pin "..." --write
//
// Exit codes:
//   0  the plan was printed (no --write), or the adoption is written
//   1  the adoption could not be completed and the tree was rolled back
//   2  the arguments or the tree refuse the adoption; nothing was written

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DesignPinError, parseSpecCommit } from "../ci/lib/design-pin.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const MANIFEST_RELATIVE = "scripts/audit/chat-hitl-acceptance-manifest.json";
export const CONTRACT_RELATIVE = "scripts/audit/chat-hitl-anchor-contract.json";

// ---------------------------------------------------------------------------
// Textual edits
// ---------------------------------------------------------------------------

/**
 * Replace one `"field": "value"` in place. Refuses a field that is absent, and
 * refuses one that appears MORE THAN ONCE at the start of a line — both of
 * these documents open with a long prose note, and a note that quoted a field
 * in this exact shape would otherwise be edited instead of the record. The
 * match is line-anchored for the same reason: the record's fields are written
 * one per line, a mention inside a note's prose is not.
 */
export function replaceJsonStringField(text, field, value) {
  const pattern = new RegExp(`^([ \\t]*"${field}"[ \\t]*:[ \\t]*")((?:[^"\\\\]|\\\\.)*)(")`, "gm");
  const matches = [...text.matchAll(pattern)];
  if (matches.length === 0) {
    throw new DesignPinError(`the file carries no "${field}" field to move`);
  }
  if (matches.length > 1) {
    throw new DesignPinError(
      `the file carries "${field}" more than once — this script will not guess which of them is ` +
        "the record",
    );
  }
  const [match] = matches;
  const encoded = JSON.stringify(value).slice(1, -1);
  const start = match.index;
  return (
    text.slice(0, start) + `${match[1]}${encoded}${match[3]}` + text.slice(start + match[0].length)
  );
}

const indentOf = (line) => /^\s*/.exec(line)[0];

/**
 * Write `"field": [ ... ]` as a string array — replacing the one that is there,
 * or inserting it immediately before the `before` field, with that field's own
 * indentation. Refuses to invent a place when the anchor field is absent.
 */
export function upsertJsonStringArrayField(text, field, values, { before }) {
  const lines = text.split("\n");
  const linesStartingWith = (name) => {
    const indexes = [];
    lines.forEach((l, i) => {
      if (l.trimStart().startsWith(`"${name}"`)) indexes.push(i);
    });
    return indexes;
  };
  const anchors = linesStartingWith(before);
  if (anchors.length === 0) {
    throw new DesignPinError(`the file carries no "${before}" field to write "${field}" before`);
  }
  if (anchors.length > 1) {
    throw new DesignPinError(
      `the file carries "${before}" more than once — this script will not guess which of them is ` +
        "the record",
    );
  }
  const anchorIndex = anchors[0];
  const existing = linesStartingWith(field);
  if (existing.length > 1) {
    throw new DesignPinError(
      `the file carries "${field}" more than once — this script will not guess which of them is ` +
        "the record",
    );
  }
  const indent = indentOf(lines[anchorIndex]);
  const rendered =
    values.length === 0
      ? `${indent}"${field}": [],`
      : [
          `${indent}"${field}": [`,
          ...values.map((v, i) => `${indent} ${JSON.stringify(v)}${i === values.length - 1 ? "" : ","}`),
          `${indent}],`,
        ].join("\n");

  if (existing.length === 0) {
    lines.splice(anchorIndex, 0, rendered);
    return lines.join("\n");
  }
  const start = existing[0];
  // Replace the existing entry, however many lines its array spans. The bracket
  // count SKIPS characters inside JSON strings: every recorded value here is an
  // attribute selector, and an attribute selector is written in brackets.
  let end = start;
  let depth = 0;
  let seen = false;
  let inString = false;
  let escaped = false;
  for (; end < lines.length; end += 1) {
    for (const ch of lines[end]) {
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "[") {
        depth += 1;
        seen = true;
      } else if (ch === "]") depth -= 1;
    }
    if (seen && depth === 0) break;
  }
  lines.splice(start, end - start + 1, rendered);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The canonical readers
// ---------------------------------------------------------------------------

const run = (repoRoot, args) =>
  execFileSync("node", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });

/** The digest, from the canonical script, on this tree. Never computed here. */
export function readRecomputedDigestFrom(repoRoot) {
  const out = run(repoRoot, ["scripts/audit/chat-hitl-acceptance-gate.mjs", "--print-anchor-digest"]);
  const match = /recomputed\s*:\s*([0-9a-f]{64})/.exec(out);
  if (!match) {
    throw new Error("the canonical digest script printed no recomputed value on this tree");
  }
  return match[1];
}

/** The unresolved anchors, from the resolution check, at the pin on this tree. */
export function readUnresolvedAnchorsFrom(repoRoot) {
  const out = run(repoRoot, ["scripts/ci/design-anchor-resolution.mjs", "--print-unresolved"]);
  const line = out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("["))
    .pop();
  const parsed = JSON.parse(line ?? "null");
  if (!Array.isArray(parsed) || parsed.some((s) => typeof s !== "string")) {
    throw new Error("the resolution check printed no unresolved set on this tree");
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// The adoption
// ---------------------------------------------------------------------------

export function adoptDesignPin({
  repoRoot = REPO_ROOT,
  pin,
  write = false,
  readUnresolvedAnchors = readUnresolvedAnchorsFrom,
  readRecomputedDigest = readRecomputedDigestFrom,
  readImpl = readFileSync,
  writeImpl = writeFileSync,
  log = console.log,
  logError = console.error,
} = {}) {
  const manifestPath = join(repoRoot, MANIFEST_RELATIVE);
  const contractPath = join(repoRoot, CONTRACT_RELATIVE);

  let parsed;
  try {
    parsed = parseSpecCommit(pin);
  } catch (err) {
    logError(`ERROR: ${err instanceof DesignPinError ? err.message : "the pin could not be read"}.`);
    return { exitCode: 2 };
  }

  let manifestText;
  let contractText;
  try {
    manifestText = readImpl(manifestPath, "utf8");
    contractText = readImpl(contractPath, "utf8");
  } catch {
    logError("ERROR: the manifest or the anchor contract could not be read.");
    return { exitCode: 2 };
  }

  const before = JSON.parse(manifestText).specCommit;
  if (before !== JSON.parse(contractText).specCommit) {
    logError(
      "ERROR: the acceptance manifest and the anchor contract do not already agree on the pin. " +
        "Reconcile them first — an adoption on top of a disagreement would hide which of the two " +
        "was the record.",
    );
    return { exitCode: 2 };
  }

  const nextPin = `design@${parsed.revision} ${parsed.paths.join(" ")}`;

  if (!write) {
    log("the adoption this would write (nothing has been written):");
    log(`  ${MANIFEST_RELATIVE}  specCommit -> ${nextPin}`);
    log(`  ${CONTRACT_RELATIVE}  specCommit -> ${nextPin}`);
    log("  then, on the moved tree, in this order:");
    log("    anchorsUnresolvedAtPin <- design-anchor-resolution.mjs --print-unresolved");
    log("    digest                 <- chat-hitl-acceptance-gate.mjs --print-anchor-digest");
    log("  and a re-ratification note, written by the person who re-examined the anchors.");
    return { exitCode: 0, pin: nextPin };
  }

  const rollback = () => {
    // A rollback that fails is worse than the failure it answers, because it
    // leaves a half-moved tree and says the tree is clean. It is reported.
    try {
      writeImpl(manifestPath, manifestText, "utf8");
      writeImpl(contractPath, contractText, "utf8");
      return true;
    } catch (err) {
      logError(
        `ERROR: the tree could NOT be rolled back: ${err.message}. Restore ` +
          `${MANIFEST_RELATIVE} and ${CONTRACT_RELATIVE} from version control before running ` +
          "anything else — they may be half-moved.",
      );
      return false;
    }
  };

  // Every write from here down is inside the guard. A failure between the two
  // opening writes would otherwise leave the manifest moved and the mirror
  // behind — the exact disagreement this script refuses to adopt on top of.
  let nextContract;
  try {
    const nextManifest = replaceJsonStringField(manifestText, "specCommit", nextPin);
    nextContract = replaceJsonStringField(contractText, "specCommit", nextPin);
    writeImpl(manifestPath, nextManifest, "utf8");
    writeImpl(contractPath, nextContract, "utf8");
  } catch (err) {
    rollback();
    logError(`ERROR: the pin could not be moved: ${err.message}.`);
    logError("The tree is rolled back; nothing moved.");
    return { exitCode: 1 };
  }

  let unresolved;
  try {
    unresolved = [...readUnresolvedAnchors(repoRoot)].sort();
  } catch (err) {
    rollback();
    logError(`ERROR: the resolution check could not report the unresolved anchors: ${err.message}.`);
    logError("The tree is rolled back; nothing moved.");
    return { exitCode: 1 };
  }

  try {
    nextContract = upsertJsonStringArrayField(nextContract, "anchorsUnresolvedAtPin", unresolved, {
      before: "digest",
    });
    writeImpl(contractPath, nextContract, "utf8");
  } catch (err) {
    rollback();
    logError(`ERROR: the unresolved anchors could not be recorded: ${err.message}.`);
    logError("The tree is rolled back; nothing moved.");
    return { exitCode: 1 };
  }

  let digest;
  try {
    digest = readRecomputedDigest(repoRoot);
  } catch (err) {
    rollback();
    logError(`ERROR: the canonical digest script did not print a value: ${err.message}.`);
    logError("The tree is rolled back; no digest this script did not read is ever written.");
    return { exitCode: 1 };
  }

  try {
    nextContract = replaceJsonStringField(nextContract, "digest", digest);
    writeImpl(contractPath, nextContract, "utf8");
  } catch (err) {
    rollback();
    logError(`ERROR: the digest could not be recorded: ${err.message}.`);
    logError("The tree is rolled back; nothing moved.");
    return { exitCode: 1 };
  }

  log(`adopted ${nextPin}`);
  log(`  anchorsUnresolvedAtPin: ${unresolved.length} recorded (truthful, and a passing state)`);
  log(`  digest: ${digest} (printed by the canonical script on this tree)`);
  log("  still owed: the re-ratification note, in the contract's established form.");
  return { exitCode: 0, pin: nextPin, unresolved, digest };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isMain =
  typeof process.argv[1] === "string" &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  const argv = process.argv.slice(2);
  const flag = argv.indexOf("--pin");
  if (flag === -1 || !argv[flag + 1]) {
    console.error('ERROR: --pin "design@<40-hex> specs/<drawing>.html [...]" is required.');
    process.exit(2);
  }
  process.exit(
    adoptDesignPin({ pin: argv[flag + 1], write: argv.includes("--write") }).exitCode,
  );
}
