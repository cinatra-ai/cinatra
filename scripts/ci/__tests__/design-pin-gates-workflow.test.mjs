// THE THREE DESIGN-PIN GATES MUST ACTUALLY RUN (cinatra#3144 G3, G4).
//
// scripts/ci/lib/design-pin.mjs names three checkers that read the one pin:
// design-pin-freshness (is the pin still the current one), the anchor
// resolution gate (do the anchors the contract records resolve in the drawings
// the pin governs) and the record-grammar gate (does a graded record name the
// pin it was graded against). A checker that exists and is never invoked is a
// gate only on paper: it decides nothing, it turns nothing red, and the state
// it was built to make visible stays exactly as silent as before it was
// written. Both G3 and G4 are landed WARN-FIRST, which means the job runs and
// the context is not required — so the job running is the whole of what
// "visible" is, and it is pinned here.
//
// The workflow is read LINE-BASED rather than through a yaml dependency: these
// gate jobs are pure-node and install nothing, the convention
// scripts/audit/archive-acceptance-gate.mjs states for this file class.
//
// What each gate is held to:
//
//   1. exactly ONE job in .github/workflows/gates.yml invokes the checker —
//      its own job, not a step folded into a neighbour whose red would be read
//      as somebody else's;
//   2. that job invokes it with `node` directly, and installs nothing, so it
//      costs a runner slot and nothing else;
//   3. the three jobs are three DIFFERENT jobs.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ANCHOR_RESOLUTION_CHECKER_PATH,
  FRESHNESS_CHECKER_PATH,
  RECORD_GRAMMAR_CHECKER_PATH,
  WORKFLOW_PATH,
} from "../lib/design-pin.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const workflow = () => readFileSync(resolve(REPO_ROOT, WORKFLOW_PATH), "utf8");

/**
 * The workflow's top-level job blocks, as `name -> body`. A job header is a
 * two-space-indented key under a column-0 `jobs:`; everything indented deeper
 * belongs to it, up to the next such header or the end of the mapping.
 *
 * A run of comment and blank lines sitting immediately BEFORE a job header
 * belongs to the job it documents, not to the one above it: these jobs carry
 * their reasoning in a comment block over the header, and reading that block as
 * the previous job's would let a neighbour's prose satisfy this suite instead of
 * a real invocation.
 */
function jobBlocks(text) {
  const blocks = new Map();
  let inJobs = false;
  let name = null;
  let body = [];
  let pending = [];
  const flush = () => {
    if (name !== null) blocks.set(name, body.join("\n"));
    name = null;
    body = [];
  };
  for (const line of text.split("\n")) {
    if (!inJobs) {
      if (/^jobs:\s*$/.test(line)) inJobs = true;
      continue;
    }
    if (line.trim() !== "" && /^\S/.test(line)) {
      // A column-0 key ends the `jobs:` mapping.
      body.push(...pending);
      pending = [];
      flush();
      inJobs = false;
      continue;
    }
    const header = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line);
    if (header) {
      flush();
      name = header[1];
      body = pending;
      pending = [];
      continue;
    }
    if (line.trim() === "" || /^\s*#/.test(line)) {
      pending.push(line);
      continue;
    }
    if (name !== null) {
      body.push(...pending);
      body.push(line);
    }
    pending = [];
  }
  body.push(...pending);
  flush();
  return blocks;
}

/** Anything that would turn one of these jobs into an installing job. */
const INSTALLS = [
  "pnpm install",
  "npm install",
  "npm ci",
  "yarn install",
  "pnpm/action-setup",
];

const GATES = [
  ["the spec-freshness gate", FRESHNESS_CHECKER_PATH],
  ["the anchor-resolution gate", ANCHOR_RESOLUTION_CHECKER_PATH],
  ["the record-grammar gate", RECORD_GRAMMAR_CHECKER_PATH],
];

describe("every design-pin gate runs as its own job in the workflow", () => {
  for (const [label, checker] of GATES) {
    it(`${label} is invoked by exactly one job`, () => {
      const running = [...jobBlocks(workflow())].filter(([, block]) => block.includes(checker));
      expect(running.map(([job]) => job), label).toHaveLength(1);
    });

    it(`${label} is run with node directly, with no install step`, () => {
      const running = [...jobBlocks(workflow())].filter(([, block]) => block.includes(checker));
      expect(running, label).toHaveLength(1);
      const [, block] = running[0];
      expect(block, label).toContain(`node ${checker}`);
      for (const install of INSTALLS) {
        expect(block, `${label} — ${install}`).not.toContain(install);
      }
    });
  }

  it("gives each of the three its own job", () => {
    const blocks = jobBlocks(workflow());
    const jobs = GATES.map(([, checker]) => {
      const running = [...blocks].filter(([, block]) => block.includes(checker));
      expect(running).toHaveLength(1);
      return running[0][0];
    });
    expect(new Set(jobs).size).toBe(GATES.length);
  });
});
