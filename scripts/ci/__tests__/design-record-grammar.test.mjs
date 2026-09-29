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
//
// cinatra#3670 adds the superseded reading — a section graded under an OLDER
// revision of the same design, under a later section that names the pin — and
// its suites sit at the foot of this file, against a design history the suite
// builds itself.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

// ---------------------------------------------------------------------------
// cinatra#3670: a grade under an OLDER revision of the same design
// ---------------------------------------------------------------------------
//
// A pull request that adopts a newer design pin after its earlier rounds were
// graded keeps those rounds in its body, under the pins they were truly graded
// against. Such a section reads as superseded when the design history shows
// its value as an older revision of the branch's pin AND a later section names
// the pin itself. The newest graded section still owes the pin, and every road
// that cannot prove the ancestry stays red, with its reason.

describe("a grade under an older revision of the same design (cinatra#3670)", () => {
  const made = [];
  const scratch = (prefix) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    made.push(dir);
    return dir;
  };
  // A value no revision of the fixture history carries.
  const UNKNOWN = "b".repeat(40);
  let design;
  let OLDER;
  let CURRENT;
  let NEWER;
  // Copies that each lack something the ancestor test needs.
  let plainFolder;
  let shallowAtPin;
  let copyWithoutPin;

  beforeAll(() => {
    // One line of history: OLDER, then CURRENT (the branch's pin), then NEWER.
    design = scratch("record-grammar-design-");
    const noHooks = join(design, ".no-hooks");
    const git = (...args) => execFileSync("git", args, { cwd: design, encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.email", "t@example.invalid");
    git("config", "user.name", "t");
    git("config", "commit.gpgsign", "false");
    // A FIXTURE, not the product tree: a machine-wide hooks path stays off it.
    git("config", "core.hooksPath", noHooks);
    const draw = (message) => {
      git("commit", "-q", "--allow-empty", "-m", message);
      return git("rev-parse", "HEAD");
    };
    OLDER = draw("an older drawing");
    CURRENT = draw("the drawing the branch pins");
    NEWER = draw("a drawing after the pin");
    git("branch", "older", OLDER);
    git("branch", "pinned", CURRENT);

    const copy = (branch, extra) => {
      const dir = scratch("record-grammar-copy-");
      execFileSync("git", [
        "-c",
        `core.hooksPath=${noHooks}`,
        "clone",
        "-q",
        "--no-checkout",
        "--single-branch",
        "--branch",
        branch,
        ...extra,
        `file://${design}`,
        dir,
      ]);
      return dir;
    };
    plainFolder = scratch("record-grammar-plain-");
    shallowAtPin = copy("pinned", ["--depth", "1"]);
    copyWithoutPin = copy("older", []);
  });

  afterAll(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true });
  });

  async function run(body, { dir, argv = [] } = {}) {
    const file = join(scratch("record-grammar-event-"), "event.json");
    writeFileSync(file, JSON.stringify({ pull_request: { number: 1, body } }), "utf8");
    const out = [];
    const err = [];
    const code = await runCli({
      argv,
      env: {
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: file,
        DESIGN_PIN_DRIFT_DIFF_BASE: "base",
        ...(dir === undefined ? {} : { DESIGN_DRAWINGS_DIR: dir }),
      },
      pins: [{ ...pin(), revision: CURRENT }],
      runGit: (args) => (args[0] === "diff" ? "scripts/audit/chat-hitl-anchor-contract.json" : ""),
      log: (l) => out.push(String(l)),
      logError: (l) => err.push(String(l)),
    });
    return { code, out, err, all: [...out, ...err].join("\n") };
  }

  const whyLine = (all) => all.split("\n").find((l) => l.includes("not read as superseded"));

  // (a)
  it("reads an older section under a newest section at the pin as superseded, with a notice naming the older value", async () => {
    const body = [`## Fix leg 1`, `graded under design@${OLDER}`, `## Fix leg 2`, `graded under design@${CURRENT}`].join(
      "\n",
    );
    const r = await run(body, { dir: design, argv: ["--github-annotations"] });
    expect(r.code).toBe(0);
    const notice = [
      `NOTICE — the section "Fix leg 1" was graded under design@${OLDER} — superseded.`,
      `  that value is an older revision of the pin this branch grades against: design@${CURRENT}`,
      `  the later section "Fix leg 2" names that pin, so the older grade stays in the body as history.`,
    ].join("\n");
    expect(r.out).toEqual([
      `read 2 graded section(s): "Fix leg 1", "Fix leg 2"`,
      notice,
      `::notice title=design-record-grammar::${notice.replace(/\n/g, "%0A")}`,
      "ok: every graded section names the pin this branch grades against, or an older revision of it that a later section supersedes.",
    ]);
    expect(r.err).toEqual([]);
  });

  it("reads EVERY older section under the one newest section at the pin as superseded", async () => {
    const body = [
      `## Fix leg 1`,
      `design@${OLDER}`,
      `## Capture — graded, the first round`,
      `design@${OLDER}`,
      `## Fix leg 2`,
      `design@${OLDER}`,
      `## Capture — graded, at the pin`,
      `design@${CURRENT}`,
    ].join("\n");
    const r = await run(body, { dir: design });
    expect(r.code).toBe(0);
    expect(r.out.filter((l) => l.startsWith("NOTICE — "))).toHaveLength(3);
    expect(r.all).not.toContain("MISMATCH");
  });

  // (b)
  it("keeps the newest graded section to the pin: an older value there fails exactly as before", async () => {
    const body = [`## Fix leg 1`, `design@${CURRENT}`, `## Fix leg 2`, `design@${OLDER}`].join("\n");
    const r = await run(body, { dir: design });
    expect(r.code).toBe(1);
    expect(r.err).toEqual([
      "ERROR: a graded record does not carry the design pin it was graded against.",
      "",
      [
        `MISMATCH — the section "Fix leg 2" names a design pin this branch does not carry.`,
        `  the body says:              design@${OLDER}`,
        `  this branch grades against: design@${CURRENT}`,
        "  a record may not be graded against a drawing the branch does not pin.",
      ].join("\n"),
    ]);
    expect(r.all).not.toContain("NOTICE");
  });

  it("does not let a body pass on an old grade alone", async () => {
    const r = await run(`## Fix leg 1\n\ndesign@${OLDER}`, { dir: design });
    expect(r.code).toBe(1);
    expect(r.all).toContain(`MISMATCH — the section "Fix leg 1" names a design pin this branch does not carry.`);
    expect(r.all).not.toContain("NOTICE");
  });

  // (c)
  it("keeps a value the design history does not know as a mismatch, and says why", async () => {
    const body = [`## Fix leg 1`, `design@${UNKNOWN}`, `## Fix leg 2`, `design@${CURRENT}`].join("\n");
    const r = await run(body, { dir: design });
    expect(r.code).toBe(1);
    expect(r.all).toContain(`MISMATCH — the section "Fix leg 1" names a design pin this branch does not carry.`);
    expect(whyLine(r.all)).toBe(
      "  not read as superseded: the design history does not show that value as an older revision of this branch's pin.",
    );
    expect(r.all).not.toContain("NOTICE");
  });

  // (d)
  it("keeps a NEWER revision than the pin as a mismatch, and says why", async () => {
    const body = [`## Fix leg 1`, `design@${NEWER}`, `## Fix leg 2`, `design@${CURRENT}`].join("\n");
    const r = await run(body, { dir: design });
    expect(r.code).toBe(1);
    expect(r.all).toContain(`MISMATCH — the section "Fix leg 1" names a design pin this branch does not carry.`);
    expect(whyLine(r.all)).toBe(
      "  not read as superseded: the design history does not show that value as an older revision of this branch's pin.",
    );
    expect(r.all).not.toContain("NOTICE");
  });

  // (e)
  for (const [road, dirOf, reason] of [
    ["no copy of the history at all", () => undefined, "no copy of the design history is at hand for this check"],
    ["a folder that is no repository", () => plainFolder, "the design history at hand could not be read"],
    [
      "a shallow copy that does not carry the older value",
      () => shallowAtPin,
      "the design history at hand is shallow and cannot show whether the value is an older revision",
    ],
    [
      "a copy that does not carry the branch's own pin",
      () => copyWithoutPin,
      "the design history at hand does not carry this branch's pin",
    ],
  ]) {
    it(`refuses on ${road}: the section stays a mismatch, with the reason printed`, async () => {
      const body = [`## Fix leg 1`, `design@${OLDER}`, `## Fix leg 2`, `design@${CURRENT}`].join("\n");
      const r = await run(body, { dir: dirOf() });
      expect(r.code).toBe(1);
      expect(r.all).toContain(`MISMATCH — the section "Fix leg 1" names a design pin this branch does not carry.`);
      expect(r.all).not.toContain("NOTICE");
      const why = whyLine(r.all);
      expect(why).toBe(`  not read as superseded: the ancestor test refused, because ${reason}.`);
      // Closed text, like the shared reader's vocabulary: no digit, and not the
      // word this repository's public gate output avoids.
      expect(why).not.toMatch(/\d/);
      expect(why.toLowerCase()).not.toContain("commit");
    });
  }

  // (f)
  it("counts a later Visual proof section that names the pin as the later section", async () => {
    // The newest graded section names no pin, so the body stays red — and the
    // older section reads as superseded under the Visual proof section, not as
    // a mismatch. In a body that passes, the newest graded section is itself
    // the later section, so this is where the Visual proof road decides.
    const body = [
      `## Fix leg 1`,
      `graded under design@${OLDER}`,
      `## Visual proof — the round at the pin`,
      `design@${CURRENT}`,
      `## Fix leg 2`,
      `graded by eye`,
    ].join("\n");
    const r = await run(body, { dir: design });
    expect(r.code).toBe(1);
    expect(r.all).toContain(`NOTICE — the section "Fix leg 1" was graded under design@${OLDER} — superseded.`);
    expect(r.all).toContain(
      `  the later section "Visual proof — the round at the pin" names that pin, so the older grade stays in the body as history.`,
    );
    expect(r.all).toContain(`MISSING — the section "Fix leg 2" grades a capture and names no design pin.`);
    expect(r.all).not.toContain("MISMATCH");
  });

  it("does not count a Visual proof section that sits ABOVE the older section, nor a missing one", async () => {
    for (const body of [
      [`## Visual proof — the round at the pin`, `design@${CURRENT}`, `## Fix leg 1`, `design@${OLDER}`, `## Fix leg 2`, `by eye`],
      [`## Fix leg 1`, `design@${OLDER}`, `## Fix leg 2`, `by eye`],
    ]) {
      const r = await run(body.join("\n"), { dir: design });
      expect(r.code).toBe(1);
      expect(r.all).toContain(`MISMATCH — the section "Fix leg 1" names a design pin this branch does not carry.`);
      expect(whyLine(r.all)).toBe(
        "  not read as superseded: no later graded section or Visual proof section names this branch's pin alone.",
      );
      expect(r.all).not.toContain("NOTICE");
    }
  });

  // (g)
  it("leaves a body whose every section names the pin exactly as before", async () => {
    const body = [`## Fix leg 1`, `design@${CURRENT}`, `## Capture — graded`, `design@${CURRENT}`].join("\n");
    const r = await run(body, { dir: design, argv: ["--github-annotations"] });
    expect(r.code).toBe(0);
    expect(r.out).toEqual([
      `read 2 graded section(s): "Fix leg 1", "Capture — graded"`,
      "ok: every graded section names the pin this branch grades against.",
    ]);
    expect(r.err).toEqual([]);
  });

  it("leaves a section with no pin MISSING, exactly as before", async () => {
    const body = [`## Fix leg 1`, `design@${CURRENT}`, `## Fix leg 2`, `graded by eye`].join("\n");
    const r = await run(body, { dir: design, argv: ["--github-annotations"] });
    expect(r.code).toBe(1);
    const missing = [
      `MISSING — the section "Fix leg 2" grades a capture and names no design pin.`,
      `  this branch grades against: design@${CURRENT}`,
      "  add that literal to the section, so a later ratification can invalidate the grade.",
    ].join("\n");
    expect(r.err).toEqual(["ERROR: a graded record does not carry the design pin it was graded against.", "", missing]);
    expect(r.out).toEqual([
      `read 2 graded section(s): "Fix leg 1", "Fix leg 2"`,
      `::error title=design-record-grammar::${missing.replace(/\n/g, "%0A")}`,
    ]);
  });
});

describe("the superseded reading, driven through checkBody (cinatra#3670)", () => {
  const THIRD = "c".repeat(40);
  const answering = (ancestor) => ({ isAncestor: () => ({ refused: false, ancestor }) });

  it("lists a superseded section with its older value and the later section that names the pin", () => {
    const body = [`## Fix leg 1`, `design@${OTHER}`, `## Fix leg 2`, `design@${PIN}`].join("\n");
    const result = checkBody({ body, specCommit, history: answering(true) });
    expect(result.findings).toEqual([]);
    expect(result.superseded).toEqual([{ heading: "Fix leg 1", older: OTHER, carrier: "Fix leg 2" }]);
  });

  it("refuses the ancestor test when no design history is handed in at all", () => {
    const body = [`## Fix leg 1`, `design@${OTHER}`, `## Fix leg 2`, `design@${PIN}`].join("\n");
    const { findings } = checkBody({ body, specCommit });
    expect(findings.map((f) => [f.heading, f.kind])).toEqual([["Fix leg 1", "mismatch"]]);
    expect(formatFindings(findings, specCommit)).toContain(
      "  not read as superseded: the ancestor test refused, because no copy of the design history is at hand for this check.",
    );
  });

  it("never asks the history about the newest graded section", () => {
    const history = {
      isAncestor: () => {
        throw new Error("the newest graded section consulted the history");
      },
    };
    const body = [`## Fix leg 1`, `design@${PIN}`, `## Fix leg 2`, `design@${OTHER}`].join("\n");
    expect(checkBody({ body, specCommit, history }).findings).toEqual([
      { heading: "Fix leg 2", kind: "mismatch", found: [OTHER] },
    ]);
  });

  it("never reads a section that names two values as superseded, whatever the history says", () => {
    for (const values of [`design@${OTHER} and design@${THIRD}`, `design@${OTHER} and design@${PIN}`]) {
      const body = [`## Fix leg 1`, values, `## Fix leg 2`, `design@${PIN}`].join("\n");
      const result = checkBody({ body, specCommit, history: answering(true) });
      expect(result.findings.map((f) => [f.heading, f.kind]), values).toEqual([["Fix leg 1", "mismatch"]]);
      expect(result.superseded ?? [], values).toEqual([]);
    }
  });

  it("does not take a later section that names the pin AND another value as the later section", () => {
    for (const later of [`## Visual proof — round 2`, `## Fix leg 2`]) {
      const body = [`## Fix leg 1`, `design@${OTHER}`, later, `design@${PIN}, after design@${THIRD}`, `## Fix leg 3`, `by eye`].join(
        "\n",
      );
      const result = checkBody({ body, specCommit, history: answering(true) });
      expect(result.findings.find((f) => f.heading === "Fix leg 1")?.kind, later).toBe("mismatch");
      expect(result.superseded ?? [], later).toEqual([]);
    }
  });

  it("reads a Visual proof heading by its opening words, as the graded grammar reads its own", () => {
    for (const heading of [
      "## Visual proof",
      "## Visual proof: picture round 2",
      "## visual proof — round 1 at the pin",
      "# Visual proof (the frames)",
    ]) {
      const body = [`## Fix leg 1`, `design@${OTHER}`, heading, `design@${PIN}`, `## Fix leg 2`, `by eye`].join("\n");
      const result = checkBody({ body, specCommit, history: answering(true) });
      expect(result.superseded, heading).toEqual([
        { heading: "Fix leg 1", older: OTHER, carrier: heading.replace(/^#+\s+/, "") },
      ]);
    }
    for (const heading of ["## Notes on the visual proof", "**Visual proof**", "## Visual proofs"]) {
      const body = [`## Fix leg 1`, `design@${OTHER}`, heading, `design@${PIN}`, `## Fix leg 2`, `by eye`].join("\n");
      const result = checkBody({ body, specCommit, history: answering(true) });
      expect(result.superseded ?? [], heading).toEqual([]);
    }
  });
});
