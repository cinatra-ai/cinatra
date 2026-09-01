// THE ADOPTION ROAD (cinatra#3144 G0).
//
// Moving the design pin means moving it in the manifest AND its mirror,
// recording what the re-examination FOUND as data, and re-deriving the digest
// with the canonical script — never by hand, and never by copying a value the
// script did not print on that tree. This suite drives the script that does it,
// against FIXTURE files in a temporary tree. It never runs the adoption against
// this repository's own manifest and contract: G0 lands with or after the pull
// request that already moves those two files, and a suite that mutated them
// would be doing the adoption rather than testing it.

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  adoptDesignPin,
  replaceJsonStringField,
  upsertJsonStringArrayField,
} from "../adopt-design-pin.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const OLD = "1".repeat(40);
const NEW = "2".repeat(40);
const oldPin = `design@${OLD} specs/app-lifecycle-cards.html`;
const newPin = `design@${NEW} specs/app-lifecycle-cards.html specs/app-artifact-review.html`;

const DIGEST_OLD = "f".repeat(64);
const DIGEST_NEW = "e".repeat(64);

const manifestText = (pin = oldPin) =>
  ["{", ' "note": "a manifest",', ` "specCommit": "${pin}",`, ' "version": 7,', ' "rows": []', "}", ""].join(
    "\n",
  );

const contractText = (pin = oldPin, extra = "") =>
  [
    "{",
    ' "note": "a contract",',
    ` "specCommit": "${pin}",`,
    ' "domExpectations": {',
    '  "carriage": {},',
    '  "hostParity": {}',
    " },",
    extra,
    ` "digest": "${DIGEST_OLD}"`,
    "}",
    "",
  ]
    .filter((l) => l !== "")
    .join("\n");

function tree({ manifest = manifestText(), contract = contractText() } = {}) {
  const root = mkdtempSync(join(tmpdir(), "adopt-design-pin-"));
  mkdirSync(join(root, "scripts", "audit"), { recursive: true });
  writeFileSync(join(root, "scripts/audit/chat-hitl-acceptance-manifest.json"), manifest, "utf8");
  writeFileSync(join(root, "scripts/audit/chat-hitl-anchor-contract.json"), contract, "utf8");
  return root;
}

const read = (root, name) => readFileSync(join(root, "scripts/audit", name), "utf8");
const manifestOf = (root) => JSON.parse(read(root, "chat-hitl-acceptance-manifest.json"));
const contractOf = (root) => JSON.parse(read(root, "chat-hitl-anchor-contract.json"));

const runners = ({ unresolved = ['[data-skill-action="skip"]', '[data-conformance-id="run-chip-row"]'], digest = DIGEST_NEW } = {}) => ({
  readUnresolvedAnchors: () => unresolved,
  readRecomputedDigest: () => digest,
});

// ---------------------------------------------------------------------------
// The text edits
// ---------------------------------------------------------------------------

describe("the file edits are textual, so nothing else in the file moves", () => {
  it("replaces one string field and leaves every other byte alone", () => {
    const before = manifestText();
    const after = replaceJsonStringField(before, "specCommit", newPin);
    expect(JSON.parse(after).specCommit).toBe(newPin);
    expect(after.split("\n").length).toBe(before.split("\n").length);
    expect(after).toContain('"note": "a manifest"');
  });

  it("refuses a field that is not there rather than appending one", () => {
    expect(() => replaceJsonStringField("{}\n", "specCommit", newPin)).toThrow();
  });

  it("inserts a string array before a named field, with that field's indentation", () => {
    const after = upsertJsonStringArrayField(contractText(), "anchorsUnresolvedAtPin", ["[data-a]"], {
      before: "digest",
    });
    expect(JSON.parse(after).anchorsUnresolvedAtPin).toEqual(["[data-a]"]);
    expect(JSON.parse(after).digest).toBe(DIGEST_OLD);
    expect(after).toContain(' "anchorsUnresolvedAtPin": [');
  });

  it("replaces an array that is already there instead of adding a second", () => {
    const once = upsertJsonStringArrayField(contractText(), "anchorsUnresolvedAtPin", ["[data-a]"], {
      before: "digest",
    });
    const twice = upsertJsonStringArrayField(once, "anchorsUnresolvedAtPin", ["[data-b]", "[data-c]"], {
      before: "digest",
    });
    expect(JSON.parse(twice).anchorsUnresolvedAtPin).toEqual(["[data-b]", "[data-c]"]);
    expect(twice.match(/anchorsUnresolvedAtPin/g)).toHaveLength(1);
  });

  it("writes an empty array as an empty array", () => {
    const after = upsertJsonStringArrayField(contractText(), "anchorsUnresolvedAtPin", [], {
      before: "digest",
    });
    expect(JSON.parse(after).anchorsUnresolvedAtPin).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The adoption
// ---------------------------------------------------------------------------

describe("adopting a pin", () => {
  it("writes NOTHING without --write, and prints what it would do", () => {
    const root = tree();
    const log = [];
    const result = adoptDesignPin({
      repoRoot: root,
      pin: newPin,
      write: false,
      ...runners(),
      log: (l) => log.push(String(l)),
    });
    expect(result.exitCode).toBe(0);
    expect(manifestOf(root).specCommit).toBe(oldPin);
    expect(contractOf(root).digest).toBe(DIGEST_OLD);
    expect(log.join("\n")).toContain(NEW);
  });

  it("moves both files, records what G4 found, and takes the digest the script printed", () => {
    const root = tree();
    const result = adoptDesignPin({ repoRoot: root, pin: newPin, write: true, ...runners() });
    expect(result.exitCode).toBe(0);
    expect(manifestOf(root).specCommit).toBe(newPin);
    expect(contractOf(root).specCommit).toBe(newPin);
    // Sorted, because the order is part of the digest.
    expect(contractOf(root).anchorsUnresolvedAtPin).toEqual([
      '[data-conformance-id="run-chip-row"]',
      '[data-skill-action="skip"]',
    ]);
    expect(contractOf(root).digest).toBe(DIGEST_NEW);
  });

  it("records a non-empty array truthfully rather than requiring an empty one", () => {
    const root = tree();
    adoptDesignPin({ repoRoot: root, pin: newPin, write: true, ...runners() });
    expect(contractOf(root).anchorsUnresolvedAtPin.length).toBeGreaterThan(0);
  });

  it("is idempotent — a second run replaces the array rather than adding one", () => {
    const root = tree();
    adoptDesignPin({ repoRoot: root, pin: newPin, write: true, ...runners() });
    adoptDesignPin({
      repoRoot: root,
      pin: newPin,
      write: true,
      ...runners({ unresolved: ['[data-a]'], digest: DIGEST_NEW }),
    });
    expect(contractOf(root).anchorsUnresolvedAtPin).toEqual(["[data-a]"]);
    expect(read(root, "chat-hitl-anchor-contract.json").match(/anchorsUnresolvedAtPin/g)).toHaveLength(1);
  });

  it("refuses a pin that does not parse, and writes nothing", () => {
    const root = tree();
    const result = adoptDesignPin({
      repoRoot: root,
      pin: `design@${NEW}`,
      write: true,
      ...runners(),
      logError: () => {},
    });
    expect(result.exitCode).toBe(2);
    expect(manifestOf(root).specCommit).toBe(oldPin);
  });

  it("refuses when the manifest and the mirror do not already agree", () => {
    const root = tree({ contract: contractText(`design@${NEW} specs/app-lifecycle-cards.html`) });
    const result = adoptDesignPin({
      repoRoot: root,
      pin: newPin,
      write: true,
      ...runners(),
      logError: () => {},
    });
    expect(result.exitCode).toBe(2);
    expect(manifestOf(root).specCommit).toBe(oldPin);
  });

  it("never writes a digest the canonical script did not print, and rolls the tree back", () => {
    const root = tree();
    const result = adoptDesignPin({
      repoRoot: root,
      pin: newPin,
      write: true,
      readUnresolvedAnchors: () => [],
      readRecomputedDigest: () => {
        throw new Error("the script printed nothing");
      },
      logError: () => {},
    });
    expect(result.exitCode).toBe(1);
    expect(manifestOf(root).specCommit).toBe(oldPin);
    expect(contractOf(root).specCommit).toBe(oldPin);
    expect(contractOf(root).digest).toBe(DIGEST_OLD);
    expect(contractOf(root).anchorsUnresolvedAtPin).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// This lane does not run it against the repository
// ---------------------------------------------------------------------------

describe("the repository's own pin is untouched by this suite", () => {
  it("leaves the real manifest and contract exactly where the branch found them", () => {
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, "scripts/audit/chat-hitl-acceptance-manifest.json"), "utf8"),
    );
    const contract = JSON.parse(
      readFileSync(join(REPO_ROOT, "scripts/audit/chat-hitl-anchor-contract.json"), "utf8"),
    );
    expect(contract.specCommit).toBe(manifest.specCommit);
    // The adoption has not run here: the re-examination array is not recorded
    // yet, which is exactly the state cinatra#3144 says G0 lands later.
    expect(contract.anchorsUnresolvedAtPin).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The convergence round's findings
// ---------------------------------------------------------------------------

describe("the textual edits will not guess which occurrence is the record", () => {
  it("edits the field on its own line and never one quoted inside a note", () => {
    // Both real documents OPEN with a long prose note. A note that quoted a
    // field in this exact shape sits ABOVE the record, so an unanchored
    // first-match replace would have edited the prose and left the record.
    const text = [
      "{",
      ' "note": "the record is written as \\"digest\\": \\"…\\" and re-derived by the script",',
      ` "digest": "${DIGEST_OLD}"`,
      "}",
      "",
    ].join("\n");
    const after = replaceJsonStringField(text, "digest", DIGEST_NEW);
    expect(JSON.parse(after).digest).toBe(DIGEST_NEW);
    expect(after).toContain('re-derived by the script');
    expect(after.split(DIGEST_OLD)).toHaveLength(1);
  });

  it("refuses a document that carries the field twice at the start of a line", () => {
    const text = ["{", ' "digest": "a",', ' "nested": {', '  "digest": "b"', " }", "}", ""].join("\n");
    expect(() => replaceJsonStringField(text, "digest", DIGEST_NEW)).toThrow(/more than once/);
  });

  it("refuses an array upsert whose anchor field appears twice", () => {
    const text = ["{", ' "digest": "a",', ' "other": {', '  "digest": "b"', " }", "}", ""].join("\n");
    expect(() =>
      upsertJsonStringArrayField(text, "anchorsUnresolvedAtPin", [], { before: "digest" }),
    ).toThrow(/more than once/);
  });

  it("replaces an existing array whose VALUES carry brackets, which every selector does", () => {
    // The values are attribute selectors, so `[` and `]` are inside the JSON
    // strings. A bracket count that did not skip string contents would end the
    // replacement in the wrong place the first time a value was unbalanced.
    const before = contractText(oldPin, [
      ' "anchorsUnresolvedAtPin": [',
      '  "[data-a=\\"]\\"]"',
      " ],",
    ].join("\n"));
    const after = upsertJsonStringArrayField(before, "anchorsUnresolvedAtPin", ['[data-b]'], {
      before: "digest",
    });
    const parsed = JSON.parse(after);
    expect(parsed.anchorsUnresolvedAtPin).toEqual(["[data-b]"]);
    expect(parsed.digest).toBe(DIGEST_OLD);
  });
});

describe("every write is inside the rollback guard", () => {
  it("rolls the tree back when the SECOND of the two opening writes fails", () => {
    // The pin move is two writes. A failure between them left the manifest
    // moved and the mirror behind — the exact disagreement this script refuses
    // to adopt on top of, so a retry would then be refused as well.
    const root = tree();
    const before = {
      manifest: read(root, "chat-hitl-acceptance-manifest.json"),
      contract: read(root, "chat-hitl-anchor-contract.json"),
    };
    let writes = 0;
    const err = [];
    const result = adoptDesignPin({
      repoRoot: root,
      pin: newPin,
      write: true,
      ...runners(),
      writeImpl: (path, text, enc) => {
        writes += 1;
        if (writes === 2) throw new Error("ENOSPC");
        writeFileSync(path, text, enc);
      },
      log: () => {},
      logError: (l) => err.push(String(l)),
    });
    expect(result.exitCode).toBe(1);
    expect(read(root, "chat-hitl-acceptance-manifest.json")).toBe(before.manifest);
    expect(read(root, "chat-hitl-anchor-contract.json")).toBe(before.contract);
    expect(err.join("\n")).toContain("rolled back");
  });

  it("says so loudly when the rollback ITSELF cannot be written", () => {
    const root = tree();
    const err = [];
    const result = adoptDesignPin({
      repoRoot: root,
      pin: newPin,
      write: true,
      readUnresolvedAnchors: () => {
        throw new Error("the resolution check refused");
      },
      readRecomputedDigest: () => DIGEST_NEW,
      writeImpl: (path, text, enc) => {
        if (text === read(root, "chat-hitl-acceptance-manifest.json") || text.includes(OLD)) {
          throw new Error("EROFS");
        }
        writeFileSync(path, text, enc);
      },
      log: () => {},
      logError: (l) => err.push(String(l)),
    });
    expect(result.exitCode).toBe(1);
    expect(err.join("\n")).toContain("could NOT be rolled back");
  });
});
