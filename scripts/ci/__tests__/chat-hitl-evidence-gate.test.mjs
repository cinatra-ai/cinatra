// Fixture tests for the CHAT-HITL EVIDENCE GATE CLI and its WARN-FIRST rollout
// (cinatra#2821, epic #2784 S9h).
//
// Two things are held here that the contract suites cannot hold on their own:
//
//   1. THE GATE FINDS ITS INPUTS. Planted in a fixture tree, the pointer
//      sentence is found in a file the gate DISCOVERED (not one it was handed),
//      and a manifest cell with no record is reported as unbound.
//   2. THE ROLLOUT PROTECTS WHAT THE POLICY DECLARES. A branch that was
//      in flight when the gate landed warns; a branch cut after it fails; and
//      pre-existing findings on main stay warnings even on an enforcing branch,
//      so a new branch is never red for debt it did not create.
//
// The last test runs the real CLI over the REAL tree and asserts it exits 0 —
// that is the warn-first promise made mechanical: landing this gate cannot red
// anybody's in-flight branch.

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  decideOutcome,
  partitionFindings,
  resolveEnforcement,
} from "../lib/evidence-gate-rollout.mjs";
// Namespace imports for what cinatra#3832 adds, so that a tree without it still
// loads this file and fails by assertion.
import * as rolloutLib from "../lib/evidence-gate-rollout.mjs";
import * as gateLib from "../chat-hitl-evidence-gate.mjs";
import {
  discoverDispatchSources,
  extractStringLiterals,
  isProseLiteral,
  runGate,
  scanCaptureEvidence,
  scanDispatchProse,
  POLICY_PATH,
  FLOOR_BASE_VAR,
  FLOOR_FILE,
  checkFloorAgainstBase,
} from "../chat-hitl-evidence-gate.mjs";
import {
  NO_PULL_REQUEST_RUN,
  PULL_REQUEST_RUN,
  UNREADABLE_BASE_RUN,
  envWithoutBase,
  makeFloorRepo,
  makeOneCommitCheckout,
} from "../../audit/__tests__/floor-base-fixture.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const GATE_CLI = join(REPO_ROOT, "scripts", "ci", "chat-hitl-evidence-gate.mjs");

const POLICY = JSON.parse(readFileSync(POLICY_PATH, "utf8"));
const GRANDFATHERED = POLICY.grandfatheredBranches[0];

// ---------------------------------------------------------------------------
// The rollout
// ---------------------------------------------------------------------------

describe("resolveEnforcement — the warn-first rollout rule", () => {
  it("does not enforce on a branch that was in flight when the gate landed", () => {
    const r = resolveEnforcement({
      branch: GRANDFATHERED,
      branchCreatedAt: "2026-08-30T00:00:00Z",
      policy: POLICY,
    });
    expect(r.enforce).toBe(false);
    expect(r.reason).toMatch(/grandfathered/);
  });

  it("does not enforce on a branch whose first commit predates the gate", () => {
    expect(
      resolveEnforcement({
        branch: "feat/some-other-lane",
        branchCreatedAt: "2026-08-15T10:00:00Z",
        policy: POLICY,
      }).enforce,
    ).toBe(false);
  });

  it("ENFORCES on a branch created after the gate landed", () => {
    const r = resolveEnforcement({
      branch: "feat/created-later",
      branchCreatedAt: "2026-09-01T10:00:00Z",
      policy: POLICY,
    });
    expect(r.enforce).toBe(true);
  });

  it("does not enforce on the trunk, where the pre-existing findings live", () => {
    expect(
      resolveEnforcement({
        branch: "main",
        branchCreatedAt: "2026-09-01T10:00:00Z",
        policy: POLICY,
      }).enforce,
    ).toBe(false);
  });

  it("warns rather than guessing when the branch or its age is unknown", () => {
    expect(
      resolveEnforcement({ branch: null, branchCreatedAt: null, policy: POLICY })
        .enforce,
    ).toBe(false);
    expect(
      resolveEnforcement({
        branch: "feat/detached",
        branchCreatedAt: null,
        policy: POLICY,
      }).enforce,
    ).toBe(false);
  });

  it("honours an explicit enforce-all policy", () => {
    expect(
      resolveEnforcement({
        branch: GRANDFATHERED,
        branchCreatedAt: "2026-08-01T00:00:00Z",
        policy: { ...POLICY, enforcement: "enforce-all" },
      }).enforce,
    ).toBe(true);
  });
});

describe("partitionFindings — grandfathering by identity", () => {
  // A FIXTURE key, not the real policy's. The mechanism is permanent; the debt
  // it grandfathers is not, and `knownFindings` is EMPTY on main since
  // cinatra#2791 re-captured the two S7-era chat cells. Deriving the fixture
  // from the live list made these tests pass only while debt existed — i.e. the
  // mechanism went untested exactly when the list was clean, which is the state
  // it is supposed to be in.
  const KNOWN = "capture/unbound-cell:X1__review-card__chat_thread__pending";
  const POLICY_WITH_DEBT = {
    ...POLICY,
    knownFindings: [KNOWN],
    knownFindingNotes: { [KNOWN]: "a fixture entry, cleared by nothing" },
  };
  const findings = [
    { key: KNOWN, code: "capture/unbound-cell", detail: "" },
    { key: "pointer-text:src/new.ts:10", code: "pointer-text", detail: "" },
  ];

  it("keeps pre-existing main debt out of the failing set", () => {
    const { blocking, grandfathered } = partitionFindings(findings, POLICY_WITH_DEBT);
    expect(grandfathered).toHaveLength(1);
    expect(blocking.map((f) => f.code)).toEqual(["pointer-text"]);
  });

  it("fails a NEW finding on an enforcing branch, and only that one", () => {
    const outcome = decideOutcome({
      findings,
      policy: POLICY_WITH_DEBT,
      branch: "feat/created-later",
      branchCreatedAt: "2026-09-01T00:00:00Z",
    });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.failing.map((f) => f.code)).toEqual(["pointer-text"]);
  });

  it("fails nothing on a grandfathered branch, findings and all", () => {
    const outcome = decideOutcome({
      findings,
      policy: POLICY_WITH_DEBT,
      branch: GRANDFATHERED,
      branchCreatedAt: "2026-09-01T00:00:00Z",
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.blocking).toHaveLength(1); // reported, not failed
  });

  it("every known finding names the slice that clears it", () => {
    for (const key of POLICY.knownFindings) {
      expect(POLICY.knownFindingNotes?.[key], key).toBeTruthy();
    }
  });

  it("RATCHET: the live policy grandfathers NOTHING today", () => {
    // Struck by cinatra#2791 (S9g): the two S7-era chat_thread cells were
    // re-driven against a live app and indexed, so there is no debt left to
    // carry. This assertion is the other half of that ratchet — new debt has to
    // be ADDED here deliberately, in the slice that incurs it, and cannot slip
    // in as a quiet edit to the policy file.
    expect(POLICY.knownFindings).toEqual([]);
    expect(POLICY.knownFindingNotes).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Reading the source
// ---------------------------------------------------------------------------

describe("extractStringLiterals", () => {
  it("reads shipped copy and ignores what is only a comment", () => {
    const src = [
      '// approve it on the run page',
      '/* skip it there */',
      'send("text", { content: "Approve this on the review page." });',
    ].join("\n");
    const values = extractStringLiterals(src).map((l) => l.value);
    expect(values).toContain("Approve this on the review page.");
    expect(values.join(" ")).not.toMatch(/run page/);
  });

  it("replaces an interpolation with a neutral placeholder", () => {
    const values = extractStringLiterals("const s = `Dispatched ${pkg} now`;").map(
      (l) => l.value,
    );
    expect(values).toContain("Dispatched VALUE now");
  });

  it("keeps identifiers and paths out of the prose set", () => {
    expect(isProseLiteral("@cinatra-ai/agent-package-name-long")).toBe(false);
    expect(isProseLiteral("/api/chat/explicit-dispatch")).toBe(false);
    expect(isProseLiteral("Approve this change on the review page.")).toBe(true);
  });
});

describe("the real tree", () => {
  it("discovers the shipped chat dispatch sources", () => {
    const sources = discoverDispatchSources(REPO_ROOT);
    // cinatra#2935 (lifecycle-b W5d): the two pre-router modules are gone. The
    // pin that remains is the card, and the assertion is now that the removed
    // pair is NOT silently re-pinned by a stale literal.
    expect(sources).not.toContain("src/app/api/chat/explicit-dispatch-server.ts");
    expect(sources).not.toContain("src/app/api/chat/explicit-dispatch.ts");
    expect(sources).toContain("packages/chat/src/inline-agent-run-card.tsx");
  });

  it("finds no pointer prose in the shipped dispatch surface today", () => {
    // If this ever fails, the sentence #2794 shipped is back in the tree — read
    // the finding, do not relax the contract.
    expect(scanDispatchProse(REPO_ROOT)).toEqual([]);
  });

  it("reports NO unvalidated chat captures on this tree", () => {
    // It used to report two — the S7-era C1 / C2 cells the acceptance manifest
    // cited and no index record answered. cinatra#2791 (S9g) re-drove both
    // against a live app, registered the records, and moved the citations to
    // the new cell names, so the honest expectation is now zero. A cell that
    // comes back unbound is a real regression, not a known state.
    expect(scanCaptureEvidence(REPO_ROOT)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The CLI, end to end
// ---------------------------------------------------------------------------

let fixtureRoot;
/** A policy that still carries debt, so the grandfathering arm has something to
 *  grandfather. The live policy's list is empty since cinatra#2791. */
let fixturePolicyPath;

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "s9h-gate-"));
  fixturePolicyPath = join(fixtureRoot, "rollout.json");
  writeFileSync(
    fixturePolicyPath,
    JSON.stringify({
      ...POLICY,
      knownFindings: ["capture/unbound-cell:X1__review-card__chat_thread__pending"],
      knownFindingNotes: {
        "capture/unbound-cell:X1__review-card__chat_thread__pending": "fixture",
      },
    }),
  );
  mkdirSync(join(fixtureRoot, "src", "app", "api", "chat"), { recursive: true });
  mkdirSync(join(fixtureRoot, "scripts", "audit"), { recursive: true });
  // A dispatch file the gate must DISCOVER (it is not on the pinned list), whose
  // parked answer is #2794's first-round sentence.
  writeFileSync(
    join(fixtureRoot, "src", "app", "api", "chat", "held-answer.ts"),
    [
      "export function answer(send: (k: string, v: unknown) => void) {",
      '  send("text", {',
      '    content: "The run is waiting — confirm or skip the recommended skills on the run card above.",',
      "  });",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(fixtureRoot, "scripts", "audit", "chat-hitl-acceptance-manifest.json"),
    JSON.stringify({
      rows: [
        {
          id: "AC-15",
          proofs: [
            // Deliberately NOT one of the grandfathered cell names: this
            // fixture is the NEW claim a new branch makes, which must fail.
            { file: "test-results/x/README.md", testName: "X9__review-card__chat_thread__pending.png" },
          ],
        },
      ],
    }),
  );
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("runGate over a fixture tree", () => {
  const io = () => ({
    captureIndexPath: join(fixtureRoot, "capture-index.json"),
    manifestPath: join("scripts", "audit", "chat-hitl-acceptance-manifest.json"),
  });

  it("fails the planted pointer sentence and the unbound cell when enforcing", () => {
    writeFileSync(io().captureIndexPath, JSON.stringify({ records: [] }));
    const result = runGate({
      repoRoot: fixtureRoot,
      argv: { enforce: true, branch: "feat/created-later" },
      io: io(),
    });
    expect(result.exitCode).toBe(1);
    const codes = result.failing.map((f) => f.code);
    expect(codes).toContain("pointer-text");
    expect(codes).toContain("capture/unbound-cell");
    expect(result.failing.find((f) => f.code === "pointer-text").detail).toMatch(
      /held-answer\.ts/,
    );
  });

  it("grandfathers a pre-existing cell name even on an enforcing branch", () => {
    // The same fixture tree, citing a cell a policy knows about: the finding is
    // still reported, and it still does not fail. The policy is a FIXTURE one —
    // the live policy's list is empty since cinatra#2791 cleared it, and this
    // arm tests the MECHANISM, which outlives any particular debt.
    writeFileSync(
      join(fixtureRoot, "scripts", "audit", "chat-hitl-acceptance-manifest.json"),
      JSON.stringify({
        rows: [
          {
            criterion: "a pre-existing chat capture",
            proofs: [{ testName: "X1__review-card__chat_thread__pending.png" }],
          },
        ],
      }),
    );
    const result = runGate({
      repoRoot: fixtureRoot,
      argv: { enforce: true, branch: "feat/created-later" },
      io: {
        ...io(),
        policyPath: fixturePolicyPath,
      },
    });
    expect(result.grandfathered.map((f) => f.code)).toContain(
      "capture/unbound-cell",
    );
    expect(result.failing.map((f) => f.code)).toEqual(["pointer-text"]);
  });

  it("finds the same two findings on a grandfathered branch, and fails neither", () => {
    const result = runGate({
      repoRoot: fixtureRoot,
      argv: { branch: GRANDFATHERED, branchCreatedAt: "2026-09-01T00:00:00Z" },
      io: io(),
    });
    expect(result.findings.length).toBeGreaterThanOrEqual(2);
    expect(result.exitCode).toBe(0);
  });
});

describe("the CLI on the real tree", () => {
  it("exits 0 under warn-first, whatever it finds", () => {
    const run = spawnSync(process.execPath, [GATE_CLI, "--json"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.failing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The rollout file is compared with the base branch (cinatra#3832): a pull
// request cannot loosen the gate in its own change.
// ---------------------------------------------------------------------------

describe("chat-hitl-evidence-gate — floor compared with the base", () => {
  const rollout = (over = {}) => ({ ...POLICY, ...over });
  const cleanups = [];
  afterAll(() => cleanups.forEach((c) => c()));

  function guard(base, head, { make = makeFloorRepo, env = PULL_REQUEST_RUN } = {}) {
    expect(typeof checkFloorAgainstBase).toBe("function");
    const f = make({ base: { [FLOOR_FILE]: base }, head: { [FLOOR_FILE]: head } });
    cleanups.push(f.cleanup);
    return checkFloorAgainstBase({ repoRoot: f.root, env });
  }

  it("names its floor file and its own base variable", () => {
    expect(FLOOR_FILE).toBe("scripts/ci/chat-hitl-evidence-gate.rollout.json");
    expect(FLOOR_BASE_VAR).toBe("CHAT_HITL_EVIDENCE_BASE");
  });

  it("a raised floor FAILS: a new grandfathered branch, a new known finding, a lower mode, a later cut", () => {
    // Under warn-first every field is read; under enforce-all only the mode and
    // the known findings are (see the table below for the ignored ones).
    const warn = rollout({ enforcement: "warn-first", knownFindings: [] });
    const enforceAll = rollout({ enforcement: "enforce-all", knownFindings: [] });
    const cases = [
      [warn, rollout({ grandfatheredBranches: [...POLICY.grandfatheredBranches, "feat/mine"] }), /grandfathered branch feat\/mine/],
      [warn, rollout({ knownFindings: ["pointer-text:a.ts:1"] }), /known finding pointer-text:a\.ts:1/],
      [warn, rollout({ gateLandedAt: "2030-01-01T00:00:00Z" }), /gateLandedAt/],
      [warn, rollout({ trunkBranch: "feat/mine" }), /trunkBranch \(main -> feat\/mine\)/],
      [enforceAll, rollout({ enforcement: "warn-first" }), /enforcement \(enforce-all -> warn-first\)/],
      [enforceAll, rollout({ enforcement: "enforce-all", knownFindings: ["pointer-text:a.ts:1"] }), /known finding pointer-text:a\.ts:1/],
    ];
    for (const [base, head, line] of cases) {
      const r = guard(base, head);
      expect(r.status).toBe("grew");
      expect(r.ok).toBe(false);
      expect(r.lines.join("\n")).toMatch(line);
    }
  });

  it("a lowered floor PASSES: an entry removed, a stricter mode, an earlier cut", () => {
    const base = rollout({ knownFindings: ["pointer-text:a.ts:1"], gateLandedAt: "2026-09-01T00:00:00Z" });
    const head = rollout({
      enforcement: "enforce-all",
      grandfatheredBranches: POLICY.grandfatheredBranches.slice(1),
      knownFindings: [],
      gateLandedAt: "2026-08-01T00:00:00Z",
    });
    expect(guard(base, head)).toMatchObject({ ok: true, status: "held" });
    expect(guard(base, base)).toMatchObject({ ok: true, status: "held" });
  });

  it("a base that cannot be read FAILS with its reason: unresolved, not a rollout file", () => {
    const f = makeFloorRepo({ base: { [FLOOR_FILE]: rollout() }, head: { [FLOOR_FILE]: rollout() } });
    cleanups.push(f.cleanup);
    expect(typeof checkFloorAgainstBase).toBe("function");
    const r = checkFloorAgainstBase({ repoRoot: f.root, env: UNREADABLE_BASE_RUN });
    expect(r).toMatchObject({ ok: false, status: "unreadable" });
    expect(r.lines[0]).toMatch(/cannot be compared with the base: the base "origin\/no-such-base-3832" did not resolve/);
    const bad = guard({ grandfatheredBranches: "x" }, rollout());
    expect(bad).toMatchObject({ ok: false, status: "unreadable" });
    expect(bad.lines[0]).toMatch(/not a readable floor \(grandfatheredBranches is not a list of names\)/);
  });

  it("an unreadable rollout file FAILS closed with the field named, on the head and on the base", () => {
    // Only what the check itself cannot read as the list it means: a list field
    // that is a string, a number or an object (read in a mode that reads it).
    const cases = [
      ["grandfatheredBranches", { grandfatheredBranches: "feat/x" }],
      ["grandfatheredBranches", { grandfatheredBranches: 3 }],
      ["knownFindings", { knownFindings: { a: 1 } }],
      ["knownFindings", { knownFindings: "pointer-text" }],
    ];
    for (const [field, over] of cases) {
      // POLICY is warn-first, which reads both lists, so head and base are both refused.
      const head = guard(rollout({ enforcement: "enforce-all" }), rollout(over));
      expect(head.ok, JSON.stringify(over)).toBe(false);
      expect(head.lines.join("\n"), JSON.stringify(over)).toContain(field);
      const base = guard(rollout(over), rollout());
      expect(base.ok, JSON.stringify(over)).toBe(false);
      expect(base.lines.join("\n"), JSON.stringify(over)).toContain(field);
    }
    for (const text of ["not json", "[]", "null", "5"]) {
      const f = makeFloorRepo({ base: { [FLOOR_FILE]: rollout() }, head: { [FLOOR_FILE]: text } });
      cleanups.push(f.cleanup);
      const r = checkFloorAgainstBase({ repoRoot: f.root, env: PULL_REQUEST_RUN });
      expect(r, text).toMatchObject({ ok: false, status: "malformed" });
    }
  });

  it("a run that is no pull request says so and passes", () => {
    const r = guard(rollout(), rollout(), { env: NO_PULL_REQUEST_RUN });
    expect(r).toMatchObject({ ok: true, status: "no-base" });
    expect(r.lines[0]).toContain(FLOOR_BASE_VAR);
  });

  it("in a checkout of one commit the base is fetched: a raised floor FAILS, a lowered one PASSES", () => {
    const loose = rollout({ grandfatheredBranches: [...POLICY.grandfatheredBranches, "feat/mine"] });
    expect(guard(rollout(), loose, { make: makeOneCommitCheckout }).status).toBe("grew");
    expect(guard(loose, rollout(), { make: makeOneCommitCheckout })).toMatchObject({ ok: true, status: "held" });
  });

  it("the gate itself runs the guard first: an unreadable base fails it with the reason", () => {
    const run = spawnSync(process.execPath, [GATE_CLI, "--json"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...envWithoutBase(process.env), ...UNREADABLE_BASE_RUN },
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(
      /\[chat-hitl-evidence-gate\] FAIL — the floor scripts\/ci\/chat-hitl-evidence-gate\.rollout\.json cannot be compared with the base/,
    );
    expect(run.stdout).toBe("");
  });
});

// ---------------------------------------------------------------------------
// ONE READING (cinatra#3832): "looser" is defined on the policy the check
// itself would apply, never on how the file spells it.
// ---------------------------------------------------------------------------

describe("chat-hitl-evidence-gate — the base comparison reads the rollout file the way the check does", () => {
  const R = (over = {}) => ({ ...POLICY, grandfatheredBranches: ["feat/a", "feat/b"], knownFindings: ["k:1"], ...over });
  const parse = (doc) => {
    expect(typeof gateLib.parseRolloutFloor).toBe("function");
    return gateLib.parseRolloutFloor(JSON.stringify(doc));
  };
  const looser = (base, head) => {
    expect(typeof gateLib.loosenings).toBe("function");
    return gateLib.loosenings(parse(base), parse(head));
  };

  it("exports the shared reading and the comparison", () => {
    expect(typeof rolloutLib.effectiveRolloutPolicy).toBe("function");
    expect(typeof rolloutLib.readRolloutPolicy).toBe("function");
    expect(typeof gateLib.parseRolloutFloor).toBe("function");
    expect(typeof gateLib.loosenings).toBe("function");
  });

  it("a switch to enforce-all PASSES whichever field the check ignores there is changed", () => {
    const base = R();
    const changes = [
      { grandfatheredBranches: [...base.grandfatheredBranches, "feat/more"] },
      { grandfatheredBranches: "not a list" },
      { gateLandedAt: "2031-01-01T00:00:00Z" },
      { gateLandedAt: "garbage" },
      { trunkBranch: "feat/other" },
      { trunkBranch: ["x"] },
    ];
    for (const change of changes) {
      expect(looser(base, R({ enforcement: "enforce-all", ...change })), JSON.stringify(change)).toEqual([]);
      // ... and the same under enforce-all on both sides.
      expect(looser(R({ enforcement: "enforce-all" }), R({ enforcement: "enforce-all", ...change })), JSON.stringify(change)).toEqual([]);
    }
  });

  it("an explicit null behaves exactly like an omitted field, in both directions", () => {
    const omit = (key) => {
      const { [key]: _gone, ...rest } = R();
      return rest;
    };
    for (const key of ["enforcement", "trunkBranch", "grandfatheredBranches", "knownFindings", "gateLandedAt"]) {
      const omitted = omit(key);
      const nulled = { ...omitted, [key]: null };
      expect(parse(nulled), key).toEqual(parse(omitted));
      expect(looser(omitted, nulled), key).toEqual([]);
      expect(looser(nulled, omitted), key).toEqual([]);
      // and it is not malformed on the repository road either
      expect(() => parse(nulled), key).not.toThrow();
    }
    // the omitted/null defaults are the check's own
    expect(parse({ gateLandedAt: "2026-08-19T00:00:00Z" })).toMatchObject({ mode: "warn-first", trunk: "main", grandfatheredBranches: [], knownFindings: [] });
  });

  it("a mode the check does not know DISABLES enforcement and is looser: wrapped, number, unknown, inherited name", () => {
    for (const mode of [["warn-first"], ["enforce-all"], 1, 0, true, "strict", "Warn-First", "toString", "constructor", {}, ""]) {
      expect(parse(R({ enforcement: mode })).mode, JSON.stringify(mode)).toBe("disabled");
      expect(looser(R(), R({ enforcement: mode })).join("\n"), JSON.stringify(mode)).toMatch(/enforcement \(warn-first -> disabled\)/);
      expect(looser(R({ enforcement: "enforce-all" }), R({ enforcement: mode })).join("\n"), JSON.stringify(mode)).toMatch(/-> disabled/);
    }
    expect(looser(R(), R({ enforcement: "off" })).join("\n")).toMatch(/enforcement \(warn-first -> off\)/);
    // a base that enforces nothing has nothing to loosen
    expect(looser(R({ enforcement: "off" }), R({ enforcement: ["off"] }))).toEqual([]);
    expect(looser(R({ enforcement: "off" }), R({ enforcement: "off", knownFindings: ["k:1", "k:2"] }))).toEqual([]);
  });

  it("each way to loosen under warn-first FAILS, each way to tighten PASSES", () => {
    const base = R();
    const failing = [
      [{ grandfatheredBranches: ["feat/a", "feat/b", "feat/c"] }, /grandfathered branch feat\/c/],
      [{ knownFindings: ["k:1", "k:2"] }, /known finding k:2/],
      [{ gateLandedAt: "2027-01-01T00:00:00Z" }, /gateLandedAt/],
      [{ gateLandedAt: null }, /gateLandedAt .* -> unset/],
      [{ gateLandedAt: "not a date" }, /gateLandedAt/],
      [{ trunkBranch: "feat/c" }, /trunkBranch \(main -> feat\/c\)/],
    ];
    for (const [change, line] of failing) {
      expect(looser(base, R(change)).join("\n"), JSON.stringify(change)).toMatch(line);
    }
    const passing = [
      { grandfatheredBranches: ["feat/a"] },
      { grandfatheredBranches: [] },
      { knownFindings: [] },
      { gateLandedAt: "2026-01-01T00:00:00Z" },
      { enforcement: "enforce-all" },
      { enforcement: "enforce-all", knownFindings: [] },
      { grandfatheredBranches: ["feat/b", "feat/a", "feat/a"] }, // order and repeats are not growth
      { trunkBranch: "feat/b" }, // an already excepted name is no new exception; "main" drops out
    ];
    for (const change of passing) {
      expect(looser(base, R(change)), JSON.stringify(change)).toEqual([]);
    }
    expect(looser(R({ enforcement: "enforce-all" }), R({ enforcement: "warn-first" })).join("\n")).toMatch(/enforcement \(enforce-all -> warn-first\)/);
  });

  it("a list that holds something that is no name changes nothing: it can equal no branch and no finding", () => {
    expect(looser(R(), R({ grandfatheredBranches: ["feat/a", "feat/b", 3, null, { x: 1 }] }))).toEqual([]);
    expect(looser(R(), R({ knownFindings: ["k:1", null, 5] }))).toEqual([]);
  });

  // The property that makes the two readings impossible to drift apart: the
  // verdict of the comparison equals "the check itself fails on fewer cases".
  it("PROPERTY: the comparison says looser exactly when the check fails on fewer cases", () => {
    const D0 = "2026-08-19T00:00:00Z";
    const D1 = "2026-09-01T00:00:00Z";
    const samples = [
      R(),
      R({ enforcement: "enforce-all" }),
      R({ enforcement: "enforce-all", grandfatheredBranches: ["feat/z"], gateLandedAt: "2035-01-01T00:00:00Z", trunkBranch: "release" }),
      R({ enforcement: "enforce-all", knownFindings: ["k:1", "k:2"] }),
      R({ enforcement: "off" }),
      R({ enforcement: ["warn-first"] }),
      R({ enforcement: 1 }),
      R({ enforcement: null }),
      R({ enforcement: "bogus", knownFindings: ["k:9"] }),
      R({ knownFindings: [] }),
      R({ knownFindings: ["k:1", "k:2"] }),
      R({ grandfatheredBranches: [] }),
      R({ grandfatheredBranches: ["feat/a", "feat/b", "feat/c"] }),
      R({ grandfatheredBranches: ["feat/a", "feat/b", 7, null] }),
      R({ gateLandedAt: D1 }),
      R({ gateLandedAt: "2026-01-01T00:00:00Z" }),
      R({ gateLandedAt: null }),
      R({ gateLandedAt: "garbage" }),
      R({ trunkBranch: "release" }),
      R({ trunkBranch: "feat/a" }),
      R({ trunkBranch: null }),
      R({ trunkBranch: ["main"] }),
      R({ trunkBranch: "release", gateLandedAt: D1, knownFindings: [] }),
    ];
    const names = new Set(["main", "release", "feat/a", "feat/b", "feat/c", "feat/z", "feat/fresh-branch", "zzz"]);
    const keys = new Set(["k:fresh"]);
    const created = new Set([null, "garbage", "2020-01-01T00:00:00Z"]);
    const day = 86_400_000;
    for (const doc of samples) {
      for (const n of [doc.trunkBranch, ...(Array.isArray(doc.grandfatheredBranches) ? doc.grandfatheredBranches : [])]) {
        if (typeof n === "string") names.add(n);
      }
      for (const k of Array.isArray(doc.knownFindings) ? doc.knownFindings : []) if (typeof k === "string") keys.add(k);
      const t = Date.parse(doc.gateLandedAt ?? "");
      if (Number.isFinite(t)) for (const d of [-day, 0, day]) created.add(new Date(t + d).toISOString());
    }
    const NOW = new Date("2100-01-01T00:00:00Z");
    const fails = (policy, branch, branchCreatedAt, key) =>
      rolloutLib.decideOutcome({
        findings: [{ key, code: "x", detail: "" }],
        policy,
        branch,
        branchCreatedAt,
        now: NOW,
      }).failing.length > 0;
    const failsOnFewer = (base, head) => {
      for (const branch of names) for (const at of created) for (const key of keys) {
        if (fails(base, branch, at, key) && !fails(head, branch, at, key)) return true;
      }
      return false;
    };
    let looserPairs = 0;
    for (const base of samples) {
      for (const head of samples) {
        const verdict = looser(base, head).length > 0;
        if (verdict) looserPairs += 1;
        expect(verdict, `${JSON.stringify(base)} -> ${JSON.stringify(head)}`).toBe(failsOnFewer(base, head));
      }
    }
    // the sample set exercises both outcomes
    expect(looserPairs).toBeGreaterThan(20);
    expect(looserPairs).toBeLessThan(samples.length * samples.length - samples.length);
  });
});
