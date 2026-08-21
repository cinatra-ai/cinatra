// THE ONE CANONICAL CAPTURE INDEX, PINNED TO ONE PATH.
//
// The defect this pins is not a bug in any one reader; it is that there was no
// reader-independent answer to "which file is the index?". Each half computed
// `join(__dirname, "chat-hitl-capture-index.json")` from its OWN directory, and
// both files existed: `scripts/ci/…` with eight live records, `scripts/audit/…`
// with `records: []`. Each declared itself canonical in its own header. The
// capture driver's default output was the empty one, so an honest capture run
// wrote its records where no gate would ever bind them.
//
// Nothing compared the two constants, because a constant that is *correct in
// its own file* is invisible: the audit gate resolved a real path, loaded a real
// JSON file, and validated it clean. Convergence is therefore not something a
// reader can check about itself — it is a property OF THE SET, and this is the
// test that holds the set.
//
// So: one exported constant, and every reader resolves the identical absolute
// path from it. Split the constant — give any reader its own `join(__dirname,
// …)` back — and this file goes red.

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CAPTURE_INDEX_PATH,
  CAPTURE_INDEX_RELATIVE_PATH,
  RECORDER_ID,
} from "../lib/capture-record-contract.mjs";
import { CAPTURE_INDEX_PATH as EVIDENCE_GATE_PATH } from "../chat-hitl-evidence-gate.mjs";
import { CAPTURE_INDEX_PATH as ACCEPTANCE_GATE_PATH } from "../../audit/chat-hitl-acceptance-gate.mjs";
import { CAPTURE_INDEX_PATH as RECORDER_PATH } from "../../audit/lib/chat-hitl-capture-recorder.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const INDEX_BASENAME = "chat-hitl-capture-index.json";

/** Every module that resolves the index, by the name a reader would look for. */
const READERS = [
  ["the canonical contract (scripts/ci/lib/capture-record-contract.mjs)", CAPTURE_INDEX_PATH],
  ["the CI evidence gate (scripts/ci/chat-hitl-evidence-gate.mjs)", EVIDENCE_GATE_PATH],
  ["the audit acceptance gate (scripts/audit/chat-hitl-acceptance-gate.mjs)", ACCEPTANCE_GATE_PATH],
  ["the audit recorder (scripts/audit/lib/chat-hitl-capture-recorder.mjs)", RECORDER_PATH],
];

describe("ONE canonical capture index, ONE path", () => {
  it("every reader resolves the IDENTICAL absolute path", () => {
    const resolved = READERS.map(([, p]) => resolve(p));
    // Stated as a set so the failure names the disagreement rather than a
    // pairwise mismatch a reader then has to reconstruct.
    expect(new Set(resolved).size, `readers disagree:\n${
      READERS.map(([name], i) => `  ${name}\n    -> ${resolved[i]}`).join("\n")
    }`).toBe(1);
  });

  it("that path is scripts/ci/chat-hitl-capture-index.json, and the file is there", () => {
    expect(resolve(CAPTURE_INDEX_PATH)).toBe(resolve(REPO_ROOT, CAPTURE_INDEX_RELATIVE_PATH));
    expect(CAPTURE_INDEX_RELATIVE_PATH).toBe("scripts/ci/chat-hitl-capture-index.json");
    expect(existsSync(CAPTURE_INDEX_PATH)).toBe(true);
  });

  it("the capture driver's DEFAULT output is that same file", () => {
    // The driver's default is a local in `main()`, so it is pinned through the
    // constant it reads plus the absence of any other index literal in the file.
    // The empty audit index used to be this default, which is how an honest
    // capture run could write records nothing would ever bind.
    const driver = readFileSync(
      join(REPO_ROOT, "scripts/audit/lib/chat-hitl-capture-driver.mjs"),
      "utf8",
    );
    expect(driver).toMatch(/arg\("--out"\) \?\? CAPTURE_INDEX_RELATIVE_PATH/);
    expect(driver).not.toMatch(/join\(\s*"scripts"\s*,\s*"audit"/);
  });

  it("there is exactly ONE such file tracked in the tree", () => {
    // The audit half's second index — `records: []`, its own "THE CANONICAL
    // CHAT-HITL CAPTURE INDEX" header — is retired. A reinstated second file is
    // a second declaration of canonicity, whatever its path constant says.
    const tracked = execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" })
      .split("\n")
      .filter((f) => f.endsWith(`/${INDEX_BASENAME}`) || f === INDEX_BASENAME)
      .sort();
    expect(tracked).toEqual([CAPTURE_INDEX_RELATIVE_PATH]);
  });

  it("no reader recomputes the path from its own directory", () => {
    // The literal is what made two files possible. A reader that spells the
    // basename again has, by definition, stopped sharing the constant.
    for (const rel of [
      "scripts/ci/chat-hitl-evidence-gate.mjs",
      "scripts/audit/chat-hitl-acceptance-gate.mjs",
      "scripts/audit/lib/chat-hitl-capture-recorder.mjs",
    ]) {
      const source = readFileSync(join(REPO_ROOT, rel), "utf8");
      const literals = source.match(new RegExp(`join\\([^)]*${INDEX_BASENAME}`, "g")) ?? [];
      expect(literals, `${rel} builds an index path of its own`).toEqual([]);
    }
  });
});

describe("ONE recorder identity", () => {
  it("the index header and every record's `recordedBy` name the same recorder", () => {
    const index = JSON.parse(readFileSync(CAPTURE_INDEX_PATH, "utf8"));
    expect(index.recorder).toBe(RECORDER_ID);
    for (const record of index.records) {
      expect(record.recordedBy, `record "${record.cell}"`).toBe(RECORDER_ID);
    }
  });

  it("there is one spelling of it in the scripts tree", () => {
    // Three spellings landed independently: this constant, the CI index header's
    // `chat-hitl-capture-recorder@1`, and the audit recorder's own module path.
    // Identity is prose here — neither validator derives anything from it — so
    // the only thing keeping it single is this.
    // `git grep` exits 1 on no match, which is the PASSING case here.
    let hits = "";
    try {
      hits = execFileSync(
        "git",
        // A VALUE spelling, closed by its own quote -- so the constant's doc
        // block can still name the two strings it replaced, in backticks.
        ["grep", "-lE", "chat-hitl-capture-recorder(\\.mjs)?@1[\"']", "--", "scripts"],
        { cwd: REPO_ROOT, encoding: "utf8" },
      ).trim();
    } catch (err) {
      if (err.status !== 1) throw err;
    }
    expect(hits).toBe("");
  });
});
