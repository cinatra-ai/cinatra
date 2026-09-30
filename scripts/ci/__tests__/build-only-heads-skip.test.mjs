// Every pull request workflow but the image build skips a build-only head —
// cinatra#3890.
//
// The merge tooling opens pull requests whose head branch, in this
// repository, starts with `merge-queue/` or `merge-batch/`: they exist only to
// run the image workflow on the exact tree main is about to carry and are
// never merged. A fork's branch of the same name is an ordinary head. This test
// reads EVERY file under .github/workflows/ and pins both sides of the one
// condition that skips them (scripts/ci/build-only-heads.mjs):
//
//   1. every workflow triggered by `pull_request`, except `build-image.yml`,
//      skips every one of its jobs on such a head:
//      each job carries the condition, or needs a job that is skipped there
//      and has no status function (always(), !cancelled(), failure(),
//      success()) that would let it run after a skipped need;
//   2. the condition skips the two build-only prefixes on a head of this
//      repository only; it runs for an ordinary head branch, for a fork's head
//      of any name, and for every event that is not a pull request (a push, a
//      merge queue group, a schedule, a run by hand: no head repository, an
//      empty head reference);
//   3. every context the branch rules require is pinned to the job that
//      produces it, and that job and every job it needs run on an ordinary
//      branch as before: a required context skipped on an ordinary pull
//      request cannot pass this test. The contexts produced by
//      `build-image.yml` stay free of the condition: that workflow's run on a
//      build-only head is the proof of the tree.
//
// The workflows are read line-based with the repository's own readers
// (parseTriggers / parseJobs / parseJobAttrs), as the other workflow tests
// read them.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BUILD_ONLY_HEAD_CONDITION,
  IMAGE_WORKFLOW,
  evaluateHeadCondition,
  isBuildOnlyHead,
  splitBuildOnlyHeadGuard,
} from "../build-only-heads.mjs";
import {
  REQUIRED_CONTEXTS as COVERAGE_GUARD_CONTEXTS,
  contextJobName,
  displayNameOf,
  parseJobs,
  parseTriggers,
} from "../merge-group-coverage-guard.mjs";
import { isConditional, parseJobAttrs } from "../merge-readiness-inventory.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const WORKFLOWS_DIR = path.join(REPO_ROOT, ".github", "workflows");

const read = (file) => fs.readFileSync(path.join(WORKFLOWS_DIR, file), "utf8");
const workflowFiles = () =>
  fs
    .readdirSync(WORKFLOWS_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort();

/**
 * Workflows left out of the scope although a pull request starts them, each
 * with its reason. They are pinned to carry no head-branch condition.
 */
const LEFT_OUT = {
  [IMAGE_WORKFLOW]: "the image build must run on a build-only head — its run proves the tree",
  "files-hold.yml":
    "a pull_request_target workflow whose own test pins that its file names no pull request reference, github.head_ref included; it runs a short node script from the default branch",
};

/** The repository the workflows run in, as `github.repository` reads. */
const REPOSITORY = "cinatra-ai/cinatra";
const FORK = "someone/cinatra";

/**
 * Heads and whether the jobs run for them: the head branch, the head
 * repository (null on a push, which has no pull request) and this repository.
 */
const HEADS = [
  { label: "this repository's ordinary branch", headRef: "feat/x", headRepo: REPOSITORY, runs: true },
  { label: "this repository's merge-queue head", headRef: "merge-queue/cinatra-12-g1", headRepo: REPOSITORY, runs: false },
  { label: "this repository's merge-queue head", headRef: "merge-queue/x", headRepo: REPOSITORY, runs: false },
  { label: "this repository's merge-batch head", headRef: "merge-batch/x", headRepo: REPOSITORY, runs: false },
  { label: "a fork's ordinary branch", headRef: "feat/x", headRepo: FORK, runs: true },
  { label: "a fork's head named merge-queue/", headRef: "merge-queue/x", headRepo: FORK, runs: true },
  { label: "a fork's head named merge-batch/", headRef: "merge-batch/x", headRepo: FORK, runs: true },
  { label: "a push", headRef: "", headRepo: null, runs: true },
].map((h) => ({ ...h, repository: REPOSITORY }));

/** The heads a job must run for: every ordinary one, and a push. */
const ORDINARY = HEADS.filter((h) => h.runs);

/** A status function lets a job run after a skipped need. */
const STATUS_FUNCTION = /\b(always|cancelled|failure|success)\s*\(/;

/**
 * The contexts the branch rules of `main` require, each pinned to the job that
 * produces it. Read from the branch protection of `main` and from the
 * repository rulesets (the active baseline and the merge queue ruleset);
 * `.github/branch-protections.json` mirrors the first list and is checked
 * against this table below.
 */
const REQUIRED = [
  { context: "RBAC browser e2e", file: IMAGE_WORKFLOW, job: "e2e-rbac" },
  { context: "RBAC authz unit tests", file: IMAGE_WORKFLOW, job: "rbac-authz-unit" },
  { context: "Core-store schema migration gate", file: IMAGE_WORKFLOW, job: "schema-migration-gate" },
  { context: "Perpetual system loops invariants", file: IMAGE_WORKFLOW, job: "perpetual-loops-invariants" },
  { context: "build", file: IMAGE_WORKFLOW, job: "build" },
  { context: "CRM migration gates", file: "crm-migration-gate.yml", job: "gate" },
  { context: "/agents Playwright smoke", file: "dashboard-live-verify.yml", job: "smoke" },
  { context: "proof", file: "works-after-proof.yml", job: "proof" },
  { context: "gates", file: "gates.yml", job: "gates" },
  { context: "gates-pnpm", file: "gates.yml", job: "gates-pnpm" },
  { context: "design-pin-drift", file: "gates.yml", job: "design-pin-drift" },
  { context: "source-leak-gate / source-leak-gate", file: "source-leak-gate.yml", job: "source-leak-gate" },
  { context: "ui-design-system-gate / ui-design-system-gate", file: "ui-design-system-gate.yml", job: "ui-design-system-gate" },
  { context: "skills-drift-gate / skills-drift-gate", file: "skills-drift-gate.yml", job: "skills-drift-gate" },
  { context: "truthful-attribution-gate / truthful-attribution-gate", file: "truthful-attribution-gate.yml", job: "truthful-attribution-gate" },
  { context: "secrets-required-gate / secrets-required-gate", file: "secrets-required-gate.yml", job: "secrets-required-gate" },
  { context: "toast-banner-gate / toast-banner-gate", file: "toast-banner-gate.yml", job: "toast-banner-gate" },
  { context: "actions-pinned-gate / actions-pinned-gate", file: "actions-pinned-gate.yml", job: "actions-pinned-gate" },
  { context: "gitignore-gate / gitignore-gate", file: "gitignore-gate.yml", job: "gitignore-gate" },
  { context: "secret-scan-gate / secret-scan-gate", file: "secret-scan-gate.yml", job: "secret-scan-gate" },
  { context: "merge-readiness / merge-readiness", file: "merge-readiness.yml", job: "merge-readiness" },
];

/** Split a workflow's `jobs:` block into {job id -> the job's own lines}. */
function jobBlocks(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^jobs:\s*(#.*)?$/.test(l));
  const jobs = new Map();
  if (start === -1) return jobs;
  let current = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() !== "" && /^\S/.test(line)) break;
    const head = line.match(/^ {2}(['"]?)([A-Za-z_][\w-]*)\1:\s*(#.*)?$/);
    if (head) {
      current = [];
      jobs.set(head[2], current);
      continue;
    }
    if (current) current.push(line);
  }
  return jobs;
}

/** The job-level `needs:` in its inline, flow-list or block-list form. */
function needsOf(lines) {
  const at = lines.findIndex((l) => /^ {4}needs:/.test(l));
  if (at === -1) return [];
  const value = lines[at].replace(/^ {4}needs:\s*/, "").replace(/\s+#.*$/, "").trim();
  let raw;
  if (value === "") {
    raw = [];
    for (const l of lines.slice(at + 1)) {
      if (l.trim() === "" || /^\s*#/.test(l)) continue;
      const item = l.match(/^ {6,}-\s*(.+?)\s*$/);
      if (!item) break;
      raw.push(item[1]);
    }
  } else {
    raw = value.startsWith("[") ? value.replace(/^\[|\]$/g, "").split(",") : [value];
  }
  return raw.map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
}

/** One workflow, read: its triggers and {job id -> { if, ifCount, needs, uses, name }}. */
function readWorkflow(text) {
  const blocks = jobBlocks(text);
  const attrs = parseJobAttrs(text);
  const jobs = new Map();
  for (const job of parseJobs(text)) {
    const lines = blocks.get(job.key) ?? [];
    jobs.set(job.key, {
      name: displayNameOf(job),
      if: attrs.get(job.key)?.if ?? null,
      ifCount: lines.filter((l) => /^ {4}if:/.test(l)).length,
      needs: needsOf(lines),
      uses: attrs.get(job.key)?.uses ?? null,
      parsedBlock: blocks.has(job.key),
    });
  }
  return { triggers: parseTriggers(text) ?? [], jobs };
}

const inScope = (file, triggers) => !(file in LEFT_OUT) && triggers.includes("pull_request");

/**
 * The jobs of a workflow that a build-only head skips: a job carrying the
 * condition, or a job with no status function that needs one of them.
 */
function skippedOnBuildHeads(jobs) {
  const memo = new Map();
  const visit = (id, seen) => {
    if (memo.has(id)) return memo.get(id);
    if (seen.has(id)) return false;
    seen.add(id);
    const job = jobs.get(id);
    let result = false;
    if (job) {
      const split = splitBuildOnlyHeadGuard(job.if);
      if (split.carries) result = true;
      else if (!STATUS_FUNCTION.test(job.if ?? "")) result = job.needs.some((n) => visit(n, seen));
    }
    memo.set(id, result);
    return result;
  };
  return new Set([...jobs.keys()].filter((id) => visit(id, new Set())));
}

/** The form a workflow uses, for the messages: every job, or the first jobs only. */
function formOf(jobs) {
  const carrying = [...jobs.values()].filter((j) => splitBuildOnlyHeadGuard(j.if).carries).length;
  if (carrying === 0) return "no job carries the condition";
  return carrying === jobs.size ? "per job" : "first job";
}

/** Problems with the head reference in one job's `if:` (empty when none). */
function headRefProblems(file, id, job) {
  const problems = [];
  if (job.ifCount > 1) problems.push(`${file}: job \`${id}\` declares \`if:\` ${job.ifCount} times`);
  const split = splitBuildOnlyHeadGuard(job.if);
  if (split.carries) {
    if (split.existing?.includes("head_ref")) {
      problems.push(`${file}: job \`${id}\` reads the head branch in its own condition too: ${split.existing}`);
    }
  } else if ((job.if ?? "").includes("head_ref")) {
    problems.push(`${file}: job \`${id}\` reads the head branch outside the one condition: ${job.if}`);
  }
  return problems;
}

const WORKFLOWS = workflowFiles().map((file) => ({ file, ...readWorkflow(read(file)) }));

describe("the condition itself", () => {
  it("is the one expression, written once", () => {
    expect(BUILD_ONLY_HEAD_CONDITION).toBe(
      "!(github.event.pull_request.head.repo.full_name == github.repository && (startsWith(github.head_ref, 'merge-queue/') || startsWith(github.head_ref, 'merge-batch/')))",
    );
  });

  for (const head of HEADS) {
    it(`${head.runs ? "runs" : "skips"} for ${head.label} ${JSON.stringify(head.headRef)}`, () => {
      expect(evaluateHeadCondition(BUILD_ONLY_HEAD_CONDITION, head)).toBe(head.runs);
      expect(isBuildOnlyHead(head)).toBe(!head.runs);
    });
  }

  it("reads the platform's startsWith and == without regard to case", () => {
    const head = { headRef: "Merge-Queue/x", headRepo: "Cinatra-AI/Cinatra", repository: REPOSITORY };
    expect(evaluateHeadCondition(BUILD_ONLY_HEAD_CONDITION, head)).toBe(false);
  });

  it("refuses an expression it does not know instead of taking it as true", () => {
    const head = HEADS[0];
    expect(() => evaluateHeadCondition("github.event_name == 'push'", head)).toThrow();
    expect(() => evaluateHeadCondition("!startsWith(github.base_ref, 'x')", head)).toThrow();
  });

  it("splits the two canonical forms and nothing else", () => {
    expect(splitBuildOnlyHeadGuard(`\${{ ${BUILD_ONLY_HEAD_CONDITION} }}`)).toEqual({ carries: true, existing: null });
    expect(splitBuildOnlyHeadGuard(`\${{ (always()) && ${BUILD_ONLY_HEAD_CONDITION} }}`)).toEqual({
      carries: true,
      existing: "always()",
    });
    // An unparenthesised `a || b` would bind the condition to `b` alone.
    expect(splitBuildOnlyHeadGuard(`\${{ a || b && ${BUILD_ONLY_HEAD_CONDITION} }}`).carries).toBe(false);
    expect(splitBuildOnlyHeadGuard(`\${{ (a) || (b) && ${BUILD_ONLY_HEAD_CONDITION} }}`).carries).toBe(false);
    expect(splitBuildOnlyHeadGuard("${{ !startsWith(github.head_ref, 'merge-queue/') }}").carries).toBe(false);
    expect(splitBuildOnlyHeadGuard(null)).toEqual({ carries: false, existing: null });
  });
});

describe("the merge readiness inventory reads the condition as no guard", () => {
  // A candidate never meets a build-only head, so the condition must not turn
  // a job that has to succeed into one whose `skipped` the readiness accepts.
  it("keeps a job with no other guard, always() or sole !cancelled() a job that must succeed", () => {
    expect(isConditional(`\${{ ${BUILD_ONLY_HEAD_CONDITION} }}`)).toBe(false);
    expect(isConditional(`\${{ (always()) && ${BUILD_ONLY_HEAD_CONDITION} }}`)).toBe(false);
    expect(isConditional(`\${{ (!cancelled()) && ${BUILD_ONLY_HEAD_CONDITION} }}`)).toBe(false);
  });

  it("keeps a job's own selection guard beside it skippable", () => {
    expect(isConditional(`\${{ (needs.changes.outputs.code == 'true') && ${BUILD_ONLY_HEAD_CONDITION} }}`)).toBe(true);
    expect(isConditional(`\${{ (always() && needs.detect.outputs.run == 'true') && ${BUILD_ONLY_HEAD_CONDITION} }}`)).toBe(true);
  });

  it("reads a head-branch test outside the canonical form as a guard", () => {
    expect(isConditional("${{ !startsWith(github.head_ref, 'merge-queue/') }}")).toBe(true);
  });
});

describe("the reading of a workflow's jobs", () => {
  const withCondition = `\${{ ${BUILD_ONLY_HEAD_CONDITION} }}`;
  const jobsOf = (text) => readWorkflow(text).jobs;

  it("counts a job as skipped when it needs a skipped first job without a status function", () => {
    const jobs = jobsOf(`on: pull_request
jobs:
  changes:
    if: ${withCondition}
    runs-on: x
  heavy:
    needs: [changes]
    if: \${{ needs.changes.outputs.code == 'true' }}
    runs-on: x
  later:
    needs:
      - heavy
    runs-on: x
`);
    expect([...skippedOnBuildHeads(jobs)].sort()).toEqual(["changes", "heavy", "later"]);
    expect(formOf(jobs)).toBe("first job");
  });

  it("refuses the first-job form when a dependent job runs after a skipped need", () => {
    for (const guard of ["${{ always() }}", "${{ !cancelled() }}", "${{ failure() }}"]) {
      const jobs = jobsOf(`on: pull_request
jobs:
  detect:
    if: ${withCondition}
    runs-on: x
  verdict:
    needs: detect
    if: ${guard}
    runs-on: x
`);
      expect(skippedOnBuildHeads(jobs).has("verdict"), guard).toBe(false);
    }
  });

  it("flags a head reference outside the one condition", () => {
    const jobs = jobsOf(`on: pull_request
jobs:
  a:
    if: \${{ startsWith(github.head_ref, 'feat/') }}
    runs-on: x
`);
    expect(headRefProblems("x.yml", "a", jobs.get("a"))).not.toEqual([]);
  });
});

describe("every pull request workflow but the image build skips a build-only head", () => {
  const scoped = WORKFLOWS.filter((w) => inScope(w.file, w.triggers));

  it("reads a non-empty set of pull request workflows, and the left-out ones exist", () => {
    expect(scoped.length).toBeGreaterThan(0);
    for (const file of Object.keys(LEFT_OUT)) expect(WORKFLOWS.map((w) => w.file)).toContain(file);
    expect(scoped.map((w) => w.file).filter((f) => f in LEFT_OUT)).toEqual([]);
  });

  for (const { file, jobs } of scoped) {
    it(`${file}: every job is skipped on a build-only head`, () => {
      expect(jobs.size, `${file}: no jobs read`).toBeGreaterThan(0);
      for (const [id, job] of jobs) {
        expect(job.parsedBlock, `${file}: job \`${id}\` is not a two-space job key this reader knows`).toBe(true);
      }
      const skipped = skippedOnBuildHeads(jobs);
      const missing = [...jobs.keys()].filter((id) => !skipped.has(id));
      expect(
        missing,
        `${file} (${formOf(jobs)}): these jobs run on a build-only head — give each \`if: \${{ ${BUILD_ONLY_HEAD_CONDITION} }}\`, joined as \`(EXISTING) && \` after a condition it already has, or let it need a job that carries it without always(), !cancelled(), failure() or success()`,
      ).toEqual([]);
    });

    it(`${file}: the condition is the one expression, and it runs as before on an ordinary branch and on a push`, () => {
      const problems = [];
      for (const [id, job] of jobs) {
        problems.push(...headRefProblems(file, id, job));
        const split = splitBuildOnlyHeadGuard(job.if);
        if (!split.carries) continue;
        const inner = job.if.trim().replace(/^\$\{\{\s*|\s*\}\}$/g, "");
        const condition = inner.slice(inner.length - BUILD_ONLY_HEAD_CONDITION.length);
        for (const head of HEADS) {
          if (evaluateHeadCondition(condition, head) !== head.runs) {
            problems.push(`${file}: job \`${id}\` ${head.runs ? "skips" : "runs"} for ${head.label} ${JSON.stringify(head.headRef)}`);
          }
        }
      }
      expect(problems).toEqual([]);
    });
  }
});

describe("the workflows outside the scope are left alone", () => {
  for (const { file, triggers, jobs } of WORKFLOWS.filter((w) => !inScope(w.file, w.triggers))) {
    it(`${file} carries no head-branch condition`, () => {
      const offenders = [...jobs]
        .filter(([, job]) => splitBuildOnlyHeadGuard(job.if).carries || (job.if ?? "").includes("head_ref"))
        .map(([id]) => id);
      expect(
        offenders,
        file in LEFT_OUT
          ? `${file}: ${LEFT_OUT[file]}`
          : `${file} runs on ${triggers.join(", ")} only: the head branch is always empty there`,
      ).toEqual([]);
    });
  }
});

describe("every required context runs on an ordinary pull request", () => {
  const byFile = new Map(WORKFLOWS.map((w) => [w.file, w]));

  it("the table holds every context of the committed branch-protection mirror and of the coverage guard", () => {
    const mirror = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ".github", "branch-protections.json"), "utf8"));
    const table = REQUIRED.map((r) => r.context);
    const listed = [...mirror.required_status_checks.contexts, ...COVERAGE_GUARD_CONTEXTS];
    expect(listed.filter((c) => !table.includes(c)), "a required context without a row in REQUIRED").toEqual([]);
    expect(new Set(table).size).toBe(table.length);
  });

  for (const row of REQUIRED) {
    it(`${row.context} — ${row.file} job \`${row.job}\``, () => {
      const workflow = byFile.get(row.file);
      expect(workflow, `${row.file} is missing`).toBeDefined();
      const job = workflow.jobs.get(row.job);
      expect(job, `${row.file}: job \`${row.job}\` is missing`).toBeDefined();

      // The job produces the context by its name, and a `caller / called`
      // context comes from a reusable call.
      expect(job.name).toBe(contextJobName(row.context));
      if (row.context.includes(" / ")) {
        expect(job.uses, `${row.context}: job \`${row.job}\` is not a reusable call`).toBeTruthy();
        if (job.uses.startsWith("./")) {
          const called = readWorkflow(read(path.basename(job.uses)));
          expect([...called.jobs.values()].map((j) => j.name)).toContain(row.context.split(" / ")[1]);
        }
      } else {
        expect(job.name).toBe(row.context);
      }

      // The job and every job it needs run on an ordinary branch and on a push.
      const chain = [];
      const walk = (id) => {
        if (chain.includes(id)) return;
        chain.push(id);
        for (const n of workflow.jobs.get(id)?.needs ?? []) walk(n);
      };
      walk(row.job);
      for (const id of chain) {
        const each = workflow.jobs.get(id);
        expect(each, `${row.file}: needed job \`${id}\` is missing`).toBeDefined();
        expect(headRefProblems(row.file, id, each)).toEqual([]);
        const split = splitBuildOnlyHeadGuard(each.if);
        if (row.file === IMAGE_WORKFLOW) {
          expect(split.carries, `${row.file}: job \`${id}\` must run on a build-only head`).toBe(false);
          continue;
        }
        if (!split.carries) continue;
        for (const head of ORDINARY) {
          expect(
            evaluateHeadCondition(BUILD_ONLY_HEAD_CONDITION, head),
            `${row.context}: job \`${id}\` would be skipped for ${head.label} ${JSON.stringify(head.headRef)}`,
          ).toBe(true);
        }
      }

      // Outside the image build, a build-only head skips the context.
      if (row.file !== IMAGE_WORKFLOW) {
        expect(skippedOnBuildHeads(workflow.jobs).has(row.job), `${row.context} runs on a build-only head`).toBe(true);
      }
    });
  }
});
