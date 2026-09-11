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

import { afterEach, describe, expect, it } from "vitest";

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
  it("leaves the real manifest and contract agreeing at the adopted pin", () => {
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, "scripts/audit/chat-hitl-acceptance-manifest.json"), "utf8"),
    );
    const contract = JSON.parse(
      readFileSync(join(REPO_ROOT, "scripts/audit/chat-hitl-anchor-contract.json"), "utf8"),
    );
    expect(contract.specCommit).toBe(manifest.specCommit);
    // The adoption HAS run on this branch, so the re-examination array is
    // recorded — sorted and without a repeat. This suite still writes only to
    // its own temporary trees; what it asserts here is that it left the
    // repository's record alone, not that the record never moved.
    const recorded = contract.anchorsUnresolvedAtPin;
    expect(Array.isArray(recorded)).toBe(true);
    expect(recorded.length).toBeGreaterThan(0);
    expect([...recorded]).toEqual([...new Set(recorded)].sort());
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

// ---------------------------------------------------------------------------
// The seam: adoptDesignPin -> the resolution subprocess
// ---------------------------------------------------------------------------

describe("the resolution subprocess is the real one, and the transaction survives it", () => {
  // Everything below drives the REAL `readUnresolvedAnchorsFrom`, which shells
  // out to `design-anchor-resolution.mjs --print-unresolved` in this checkout.
  // The manifest and the contract are held in memory through `readImpl` and
  // `writeImpl`, so the repository's own two files never move — the suite above
  // asserts that separately.
  const drawings = [];
  const previous = process.env.DESIGN_DRAWINGS_DIR;

  afterEach(() => {
    if (previous === undefined) delete process.env.DESIGN_DRAWINGS_DIR;
    else process.env.DESIGN_DRAWINGS_DIR = previous;
  });

  /** A local design copy carrying exactly the drawing this repository's pin governs. */
  const copyDrawing = (text) => {
    const dir = mkdtempSync(join(tmpdir(), "adopt-seam-drawings-"));
    mkdirSync(join(dir, "specs"), { recursive: true });
    writeFileSync(join(dir, "specs", "app-lifecycle-cards.html"), text, "utf8");
    drawings.push(dir);
    return dir;
  };

  function adoptAgainst(dir) {
    process.env.DESIGN_DRAWINGS_DIR = dir;
    const files = new Map([
      [join(REPO_ROOT, "scripts/audit/chat-hitl-acceptance-manifest.json"), manifestText()],
      [join(REPO_ROOT, "scripts/audit/chat-hitl-anchor-contract.json"), contractText()],
    ]);
    const err = [];
    const result = adoptDesignPin({
      repoRoot: REPO_ROOT,
      pin: `design@${NEW} specs/app-lifecycle-cards.html`,
      write: true,
      readImpl: (path) => {
        if (!files.has(path)) throw new Error(`ENOENT ${path}`);
        return files.get(path);
      },
      writeImpl: (path, text) => files.set(path, text),
      readRecomputedDigest: () => DIGEST_NEW,
      log: () => {},
      logError: (l) => err.push(String(l)),
    });
    return { result, err: err.join("\n"), files };
  }

  it("completes and records what the re-examination found, both recorded forms decided", () => {
    // The drawing draws the widget frame class, and carries the embed
    // declaration WITHOUT the active phase on the same element. So the class
    // selector resolves, the compound predicate does not, and both are
    // DECIDED — which is what lets this transaction finish at all.
    const dir = copyDrawing(
      '<!doctype html><html><body><div class="cw-frame">' +
        "<span data-embed-assistant>the widget</span></div></body></html>",
    );
    const { result, err, files } = adoptAgainst(dir);
    expect(err).toBe("");
    expect(result.exitCode).toBe(0);
    expect(Array.isArray(result.unresolved)).toBe(true);
    expect(result.unresolved).not.toContain(".cw-frame");
    expect(result.unresolved).toContain('[data-embed-assistant][data-phase="active"]');
    const contract = JSON.parse(files.get(join(REPO_ROOT, "scripts/audit/chat-hitl-anchor-contract.json")));
    expect(contract.specCommit).toBe(`design@${NEW} specs/app-lifecycle-cards.html`);
    expect(contract.anchorsUnresolvedAtPin).toEqual(result.unresolved);
    expect(contract.digest).toBe(DIGEST_NEW);
  });

  it("records the class selector as unresolved when the drawing draws no such frame", () => {
    const dir = copyDrawing("<!doctype html><html><body><main>a drawing</main></body></html>");
    const { result } = adoptAgainst(dir);
    expect(result.exitCode).toBe(0);
    expect(result.unresolved).toContain(".cw-frame");
    expect(result.unresolved).toContain('[data-embed-assistant][data-phase="active"]');
  });

  it("still rolls the tree back when the subprocess itself cannot run", () => {
    // The protection is unchanged: a road that cannot answer is still a
    // failure with a rollback, not a partial record.
    process.env.DESIGN_DRAWINGS_DIR = join(tmpdir(), "adopt-seam-does-not-exist");
    const files = new Map([
      [join(REPO_ROOT, "scripts/audit/chat-hitl-acceptance-manifest.json"), manifestText()],
      [join(REPO_ROOT, "scripts/audit/chat-hitl-anchor-contract.json"), contractText()],
    ]);
    const err = [];
    const result = adoptDesignPin({
      repoRoot: REPO_ROOT,
      pin: `design@${NEW} specs/app-lifecycle-cards.html`,
      write: true,
      readImpl: (path) => files.get(path),
      writeImpl: (path, text) => files.set(path, text),
      readRecomputedDigest: () => DIGEST_NEW,
      log: () => {},
      logError: (l) => err.push(String(l)),
    });
    expect(result.exitCode).toBe(1);
    expect(err.join("\n")).toContain("rolled back");
    expect(JSON.parse(files.get(join(REPO_ROOT, "scripts/audit/chat-hitl-acceptance-manifest.json"))).specCommit).toBe(
      oldPin,
    );
  });
});
