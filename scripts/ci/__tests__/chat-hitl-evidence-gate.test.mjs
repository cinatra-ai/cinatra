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
import {
  discoverDispatchSources,
  extractStringLiterals,
  isProseLiteral,
  runGate,
  scanCaptureEvidence,
  scanDispatchProse,
  POLICY_PATH,
} from "../chat-hitl-evidence-gate.mjs";

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
  const findings = [
    { key: POLICY.knownFindings[0], code: "evidence/unbound-cell", detail: "" },
    { key: "pointer-text:src/new.ts:10", code: "pointer-text", detail: "" },
  ];

  it("keeps pre-existing main debt out of the failing set", () => {
    const { blocking, grandfathered } = partitionFindings(findings, POLICY);
    expect(grandfathered).toHaveLength(1);
    expect(blocking.map((f) => f.code)).toEqual(["pointer-text"]);
  });

  it("fails a NEW finding on an enforcing branch, and only that one", () => {
    const outcome = decideOutcome({
      findings,
      policy: POLICY,
      branch: "feat/created-later",
      branchCreatedAt: "2026-09-01T00:00:00Z",
    });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.failing.map((f) => f.code)).toEqual(["pointer-text"]);
  });

  it("fails nothing on a grandfathered branch, findings and all", () => {
    const outcome = decideOutcome({
      findings,
      policy: POLICY,
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
    expect(sources).toContain("src/app/api/chat/explicit-dispatch-server.ts");
    expect(sources).toContain("src/app/api/chat/explicit-dispatch.ts");
  });

  it("finds no pointer prose in the shipped dispatch surface today", () => {
    // If this ever fails, the sentence #2794 shipped is back in the tree — read
    // the finding, do not relax the contract.
    expect(scanDispatchProse(REPO_ROOT)).toEqual([]);
  });

  it("reports the two unvalidated chat captures that are already on main", () => {
    const keys = scanCaptureEvidence(REPO_ROOT).map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(POLICY.knownFindings));
  });
});

// ---------------------------------------------------------------------------
// The CLI, end to end
// ---------------------------------------------------------------------------

let fixtureRoot;

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "s9h-gate-"));
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
            { file: "evidence/x/README.md", testName: "X9__review-card__chat_thread__pending.png" },
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
    expect(codes).toContain("evidence/unbound-cell");
    expect(result.failing.find((f) => f.code === "pointer-text").detail).toMatch(
      /held-answer\.ts/,
    );
  });

  it("grandfathers a pre-existing cell name even on an enforcing branch", () => {
    // The same fixture tree, citing one of the cells the policy already knows
    // about: the finding is still reported, and it still does not fail.
    writeFileSync(
      join(fixtureRoot, "scripts", "audit", "chat-hitl-acceptance-manifest.json"),
      JSON.stringify({
        rows: [
          {
            criterion: "a pre-existing chat capture",
            proofs: [{ testName: "C1__review-card__chat_thread__pending.png" }],
          },
        ],
      }),
    );
    const result = runGate({
      repoRoot: fixtureRoot,
      argv: { enforce: true, branch: "feat/created-later" },
      io: io(),
    });
    expect(result.grandfathered.map((f) => f.code)).toContain(
      "evidence/unbound-cell",
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
