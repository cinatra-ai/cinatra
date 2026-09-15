// A GRADED RECORD MUST CARRY THE PIN IT WAS GRADED AGAINST (cinatra#3144 G3).
//
// A capture graded against an unnamed drawing cannot be re-checked by anyone
// and cannot be invalidated by a later ratification. This gate reads the pull
// request body out of the workflow event payload — no extra credential — and
// requires every Fix-leg / graded-capture section to name the pin the branch
// grades against.
//
// The five acceptance items of cinatra#3144 G3, in order:
//
//   1. A body with such a section and no `design@<40-hex>` is red; the same
//      body carrying the branch's own value is green.
//   2. A body carrying a DIFFERENT value is red, and the message names the two
//      values that disagree.
//   3. A body with no graded section, or a diff touching no mapped path, is
//      unaffected.
//   4. Several sections: red unless EVERY one carries the matching value.
//   5. The heading grammar is pinned in both directions — a matching heading at
//      each of the six levels, a section terminated by a same-level and by a
//      higher-level heading, a bolded non-heading line that is NOT a section,
//      and a prose sentence containing the words "fix leg" that is NOT one.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  checkBody,
  findGradedSections,
  formatFindings,
  runCli,
} from "../design-record-grammar.mjs";


const PIN = "a".repeat(40);
const OTHER = "b".repeat(40);
const specCommit = `design@${PIN} specs/app-lifecycle-cards.html`;

const pin = () => ({
  id: "chat-hitl-lifecycle",
  authority: "scripts/audit/chat-hitl-acceptance-manifest.json",
  mirror: "scripts/audit/chat-hitl-anchor-contract.json",
  revision: PIN,
  paths: ["specs/app-lifecycle-cards.html"],
});

// ---------------------------------------------------------------------------
// 5. The grammar
// ---------------------------------------------------------------------------

describe("what counts as a graded section", () => {
  it("recognises a Fix leg heading at each of the six levels", () => {
    for (let level = 1; level <= 6; level += 1) {
      const body = `${"#".repeat(level)} Fix leg 1 — the floor\n\nsomething`;
      const sections = findGradedSections(body);
      expect(sections, `level ${level}`).toHaveLength(1);
      expect(sections[0].level).toBe(level);
    }
  });

  it("recognises a graded-capture heading in either word order", () => {
    for (const heading of [
      "## Capture — graded",
      "## The capture, graded against the drawing",
      "## Graded capture",
      "### graded — capture pair",
    ]) {
      expect(findGradedSections(`${heading}\n\nx`), heading).toHaveLength(1);
    }
  });

  it("reads the ratified grammar's words exactly — a plural-only heading is not one", () => {
    // cinatra#3144 defines the clause as `\bcapture\b` and `\bgraded\b`, and
    // this gate implements the grammar it was given rather than a wider one it
    // invented. The consequence is pinned here rather than left to be
    // discovered: "Captures — graded" opens no section, and the docs page says
    // so, so a body is never failed by a rule the issue did not state.
    expect(findGradedSections("## Captures — graded\n\nx")).toHaveLength(0);
  });

  it("ends a section at the next heading of the same or a higher level", () => {
    const body = [
      "## Fix leg one",
      "in one",
      "## Fix leg two",
      "in two",
      "# A higher heading",
      "outside",
    ].join("\n");
    const sections = findGradedSections(body);
    expect(sections).toHaveLength(2);
    expect(sections[0].text).toContain("in one");
    expect(sections[0].text).not.toContain("in two");
    expect(sections[1].text).toContain("in two");
    expect(sections[1].text).not.toContain("outside");
  });

  it("keeps a DEEPER heading inside the section it opened", () => {
    const body = ["## Fix leg one", "in one", "### a sub-heading", "still in one", "## Elsewhere", "out"].join(
      "\n",
    );
    const sections = findGradedSections(body);
    expect(sections).toHaveLength(1);
    expect(sections[0].text).toContain("still in one");
    expect(sections[0].text).not.toContain("out");
  });

  it("does NOT treat a bolded line as a section", () => {
    expect(findGradedSections("**Fix leg 1**\n\nbody text")).toHaveLength(0);
    expect(findGradedSections("*capture — graded*\n\nbody text")).toHaveLength(0);
  });

  it("does NOT treat a prose sentence mentioning a fix leg as a section", () => {
    const body = "This pull request has no fix leg, and the capture below is not graded yet.";
    expect(findGradedSections(body)).toHaveLength(0);
  });

  it("does NOT read a heading inside a fenced block", () => {
    const body = ["```", "## Fix leg 1", "```", "prose"].join("\n");
    expect(findGradedSections(body)).toHaveLength(0);
  });

  it("requires the words at the START of the heading, not anywhere in it", () => {
    expect(findGradedSections("## Notes on how we fix leg drift")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 1/2/4. The rule
// ---------------------------------------------------------------------------

describe("every graded section carries the branch's pin", () => {
  it("is green when the section names the branch's value", () => {
    const body = `## Fix leg 1\n\nGraded against design@${PIN}.`;
    expect(checkBody({ body, specCommit }).findings).toHaveLength(0);
  });

  it("is red when the section names no value at all", () => {
    const findings = checkBody({ body: "## Fix leg 1\n\nlooks right to me", specCommit }).findings;
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("missing");
    expect(formatFindings(findings, specCommit)).toContain("Fix leg 1");
  });

  it("is red when the section names a DIFFERENT value, and names both", () => {
    const body = `## Capture — graded\n\nGraded against design@${OTHER}.`;
    const findings = checkBody({ body, specCommit }).findings;
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("mismatch");
    const message = formatFindings(findings, specCommit);
    expect(message).toContain(OTHER);
    expect(message).toContain(PIN);
  });

  it("is red unless EVERY section carries the matching value", () => {
    const body = [
      `## Fix leg 1`,
      `Graded against design@${PIN}.`,
      `## Fix leg 2`,
      `Graded by eye.`,
      `## Capture — graded`,
      `design@${OTHER}`,
    ].join("\n");
    const findings = checkBody({ body, specCommit }).findings;
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.kind).sort()).toEqual(["mismatch", "missing"]);
  });

  it("refuses a section that carries the right value AND a wrong one", () => {
    const body = `## Fix leg 1\n\ndesign@${PIN} then, design@${OTHER} now.`;
    expect(checkBody({ body, specCommit }).findings[0].kind).toBe("mismatch");
  });

  it("is unaffected by a body with no graded section", () => {
    expect(checkBody({ body: "## Summary\n\nA change.", specCommit }).findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. The CLI and the trigger
// ---------------------------------------------------------------------------

describe("the CLI", () => {
  const eventFile = (body) => {
    const dir = mkdtempSync(join(tmpdir(), "record-grammar-"));
    const file = join(dir, "event.json");
    writeFileSync(file, JSON.stringify({ pull_request: { number: 1, body } }), "utf8");
    return file;
  };

  const gitStub =
    (touched = []) =>
    (args) => {
      if (args[0] === "rev-parse") return "";
      if (args[0] === "diff") return touched.join("\n");
      throw new Error(`unexpected git ${args.join(" ")}`);
    };

  async function run({ body, touched = [], env = {}, argv = [] }) {
    const out = [];
    const err = [];
    const code = await runCli({
      argv,
      env: {
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: body === undefined ? "" : eventFile(body),
        DESIGN_PIN_DRIFT_DIFF_BASE: "base",
        ...env,
      },
      pins: [pin()],
      runGit: gitStub(touched),
      log: (l) => out.push(String(l)),
      logError: (l) => err.push(String(l)),
    });
    return { code, all: [...out, ...err].join("\n") };
  }

  const MAPPED = "scripts/audit/chat-hitl-anchor-contract.json";

  it("is red on a mapped-path pull request whose graded section names no pin", async () => {
    const r = await run({ body: "## Fix leg 1\n\ndone", touched: [MAPPED] });
    expect(r.code).toBe(1);
    expect(r.all).toContain("Fix leg 1");
  });

  it("is green on the same body once it names the branch's pin", async () => {
    const r = await run({ body: `## Fix leg 1\n\ndesign@${PIN}`, touched: [MAPPED] });
    expect(r.code).toBe(0);
  });

  it("leaves a pull request touching no mapped path alone", async () => {
    const r = await run({ body: "## Fix leg 1\n\ndone", touched: ["README.md"] });
    expect(r.code).toBe(0);
  });

  it("leaves a mapped pull request with no graded section alone", async () => {
    const r = await run({ body: "## Summary\n\nA change.", touched: [MAPPED] });
    expect(r.code).toBe(0);
  });

  it("is red on a mapped pull request whose section names the wrong pin, naming both", async () => {
    const r = await run({ body: `## Capture — graded\n\ndesign@${OTHER}`, touched: [MAPPED] });
    expect(r.code).toBe(1);
    expect(r.all).toContain(OTHER);
    expect(r.all).toContain(PIN);
  });

  it("treats an unresolvable diff base as every path touched (fail-closed)", async () => {
    const r = await run({
      body: "## Fix leg 1\n\ndone",
      touched: ["README.md"],
      env: { DESIGN_PIN_DRIFT_DIFF_BASE: "" },
    });
    expect(r.code).toBe(1);
  });

  it("passes when there is no pull request body to read", async () => {
    const r = await run({ body: undefined, touched: [MAPPED], env: { GITHUB_EVENT_NAME: "push" } });
    expect(r.code).toBe(0);
  });

  it("reads a body from a file for a local run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "record-grammar-body-"));
    const file = join(dir, "body.md");
    writeFileSync(file, "## Fix leg 1\n\ndone", "utf8");
    const out = [];
    const code = await runCli({
      argv: ["--body-file", file],
      env: { GITHUB_EVENT_NAME: "pull_request", DESIGN_PIN_DRIFT_DIFF_BASE: "base" },
      pins: [pin()],
      runGit: gitStub([MAPPED]),
      log: (l) => out.push(String(l)),
      logError: (l) => out.push(String(l)),
    });
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("Fix leg 1");
  });

  it("exits 2 when the branch's own pin cannot be read", async () => {
    const out = [];
    const code = await runCli({
      argv: [],
      env: { GITHUB_EVENT_NAME: "pull_request", DESIGN_PIN_DRIFT_DIFF_BASE: "base" },
      pins: () => {
        throw new Error("no pin");
      },
      runGit: gitStub([MAPPED]),
      log: (l) => out.push(String(l)),
      logError: (l) => out.push(String(l)),
    });
    expect(code).toBe(2);
    expect(out.join("\n")).toContain("could not run");
  });
});

// ---------------------------------------------------------------------------
// The convergence round's findings
// ---------------------------------------------------------------------------

describe("the ATX grammar, at its edges", () => {
  it("reads a heading indented by one to three spaces — the grammar's own bound", () => {
    // CommonMark allows up to three leading spaces before an ATX heading and
    // treats four as an indented code block. A gate that only read column 0
    // could be dodged by typing one space, which no ratified grammar allows.
    for (const indent of ["", " ", "  ", "   "]) {
      const sections = findGradedSections(`${indent}## Fix leg 1\n\ndone`);
      expect(sections, JSON.stringify(indent)).toHaveLength(1);
    }
  });

  it("does NOT read a heading indented by four spaces — that is a code block", () => {
    expect(findGradedSections("    ## Fix leg 1\n\ndone")).toHaveLength(0);
  });

  it("counts a pin written into the graded heading itself", () => {
    // The grammar says the section runs FROM the heading, so the heading is
    // part of it. Excluding it reported a record that DOES name its pin as
    // missing one.
    const body = `## Fix leg 1 — graded at design@${PIN}\n\ndone`;
    expect(checkBody({ body, specCommit }).findings).toEqual([]);
  });

  it("is not closed by a shorter or differently marked fence", () => {
    // A three-backtick line inside a tilde block, or inside a longer backtick
    // block, does not close it — so the heading below stays inside the sample.
    const body = [
      "~~~",
      "## Fix leg 1",
      "```",
      "## Fix leg 2",
      "~~~",
      "",
      "prose",
    ].join("\n");
    expect(findGradedSections(body)).toHaveLength(0);
  });

  it("closes a fence with a run of the same marker at least as long", () => {
    const body = ["````", "## Fix leg 1", "````", "", "## Fix leg 2", "", "done"].join("\n");
    const sections = findGradedSections(body);
    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe("Fix leg 2");
  });
});

describe("a body this gate could not read is not a body it passed", () => {
  const eventFileWith = (contents) => {
    const dir = mkdtempSync(join(tmpdir(), "record-grammar-bad-"));
    const file = join(dir, "event.json");
    writeFileSync(file, contents, "utf8");
    return file;
  };

  async function runWith({ env = {}, argv = [] }) {
    const out = [];
    const code = await runCli({
      argv,
      env: { GITHUB_EVENT_NAME: "pull_request", DESIGN_PIN_DRIFT_DIFF_BASE: "base", ...env },
      pins: [pin()],
      runGit: (args) => (args[0] === "rev-parse" ? "" : "scripts/audit/chat-hitl-anchor-contract.json"),
      log: (l) => out.push(String(l)),
      logError: (l) => out.push(String(l)),
    });
    return { code, all: out.join("\n") };
  }

  it("exits 2 on an event payload that is not readable as data", async () => {
    // This collapsed to "there is no body" and exited 0 — a green result on a
    // record nobody inspected.
    const r = await runWith({ env: { GITHUB_EVENT_PATH: eventFileWith("{ not json") } });
    expect(r.code).toBe(2);
    expect(r.all).toContain("could not run");
  });

  it("exits 2 on an event payload file that is not there", async () => {
    const r = await runWith({ env: { GITHUB_EVENT_PATH: join(tmpdir(), "no-such-event-file.json") } });
    expect(r.code).toBe(2);
  });

  it("exits 2 on a --body-file that cannot be read, rather than throwing", async () => {
    const r = await runWith({ argv: ["--body-file", join(tmpdir(), "no-such-body.md")] });
    expect(r.code).toBe(2);
    expect(r.all).toContain("could not run");
  });

  it("still passes an event that genuinely carries no pull request", async () => {
    const r = await runWith({ env: { GITHUB_EVENT_PATH: eventFileWith(JSON.stringify({ ref: "main" })) } });
    expect(r.code).toBe(0);
  });

  it("reads a pull request whose body is null as an empty body, not as an absent one", async () => {
    const r = await runWith({
      env: { GITHUB_EVENT_PATH: eventFileWith(JSON.stringify({ pull_request: { body: null } })) },
    });
    expect(r.code).toBe(0);
    expect(r.all).toContain("no Fix leg or graded-capture section");
  });

  it("exits 2 when the diff itself fails, not only when the base does not resolve", async () => {
    const dir = mkdtempSync(join(tmpdir(), "record-grammar-diff-"));
    const file = join(dir, "body.md");
    writeFileSync(file, "## Fix leg 1\n\ndone", "utf8");
    const out = [];
    const code = await runCli({
      argv: ["--body-file", file],
      env: { GITHUB_EVENT_NAME: "pull_request", DESIGN_PIN_DRIFT_DIFF_BASE: "base" },
      pins: [pin()],
      runGit: (args) => {
        if (args[0] === "rev-parse") return "";
        throw new Error("fatal: bad revision");
      },
      log: (l) => out.push(String(l)),
      logError: (l) => out.push(String(l)),
    });
    expect(code).toBe(2);
  });
});
