import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { spawnSync } from "node:child_process";
import { selectCiImpact } from "../ci-impact.mjs";
const pick = (files, draft = false) => selectCiImpact({ event: "pull_request", files, draft });

test("docs-only omits work; mixed and unknown/global paths retain full gates", () => {
  assert.equal(pick(["docs/guide.md"]).skip, true);
  for (const p of ["src/app/layout.tsx", "pnpm-lock.yaml", "packages/new/src/index.ts", "new.config.mjs", ".github/workflows/build-image.yml", "tests/e2e/config/base.ts"]) {
    const plan = pick(["docs/guide.md", p]);
    assert.equal(plan.skip_runtime, false, p);
    assert.equal(plan.skip_unit, false, p);
    assert.equal(plan.skip_notifications, false, p);
  }
});
test("drafts get type and unit feedback while runtime jobs stay deferred", () => {
  const plan = pick(["src/app/page.tsx"], true);
  assert.equal(plan.skip, true);
  assert.equal(plan.skip_runtime, true);
  assert.equal(plan.skip_unit, true);
  assert.equal(plan.skip_feedback, false);
  assert.equal(plan.skip_agents, false);
});
test("independently wired design and static audit tests avoid unrelated builds", () => {
  assert.equal(pick(["tests/e2e/design/functional-acceptance.spec.ts"]).skip_runtime, true);
  const plan = pick(["scripts/audit/__tests__/gate.test.mjs"]);
  assert.equal(plan.skip_runtime, true);
  assert.equal(plan.skip_unit, false);
});
test("notification test changes retain their browser suite", () => {
  const plan = pick(["tests/e2e/notifications/inbox.spec.ts"]);
  assert.equal(plan.skip_notifications, false);
  assert.equal(plan.skip_runtime, true);
});
test("missing inventories and non-PR events retain full verification", () => {
  for (const files of [null, undefined, {}, [23], [""]]) assert.equal(pick(files).skip_runtime, false);
  for (const event of ["push", "merge_group", "workflow_dispatch"]) {
    const plan = selectCiImpact({ event, draft: true, files: [] });
    assert.equal(plan.skip_runtime, false);
    assert.equal(plan.skip_unit, false);
  }
});
test("workflow gates consume impact and design receives every widening input", () => {
  const read = (name) => readFileSync(new URL(`../../../.github/workflows/${name}`, import.meta.url), "utf8");
  const build = read("build-image.yml");
  assert.match(build, /test:\n[\s\S]*?if: \$\{\{ needs.detect.outputs.skip_feedback != 'true' \}\}/);
  assert.match(build, /GITHUB_TOKEN: \$\{\{ github.token \}\}/);
  assert.match(read("e2e-app-suites.yml"), /needs.detect.outputs.skip_notifications/);
  assert.match(read("design-visual-verify.yml"), /pull_request:\n(?!    paths:)/);
});


test("the required aggregate refuses failures, cancellations, accidental skips and missing decisions", async () => {
  const { prerequisiteFailures } = await import("../ci-result-gate.mjs");
  const jobs = ["image", "test", "skills-unit", "a2a-unit", "execution-plane-unit", "package-unit-suites", "hosted-mcp-wire-gate", "chat-hitl-held-turn-e2e"];
  const needs = (decision, result) => ({ detect: { result: "success", outputs: { skip: decision, skip_feedback: decision, skip_runtime: decision } }, ...Object.fromEntries(jobs.map((j) => [j, { result }])) });
  assert.deepEqual(prerequisiteFailures(needs("false", "success")), []);
  assert.deepEqual(prerequisiteFailures(needs("true", "skipped")), []);
  for (const decision of ["true", "false"]) for (const result of ["failure", "cancelled", undefined]) assert.ok(prerequisiteFailures(needs(decision, result)).length);
  assert.ok(prerequisiteFailures(needs("false", "skipped")).length);
  assert.ok(prerequisiteFailures(needs(undefined, "success")).length);
  const mixed = needs("false", "success");
  mixed.detect.outputs.skip_runtime = "true";
  mixed.image.result = "skipped";
  mixed.test.result = "failure";
  assert.ok(prerequisiteFailures(mixed).some((f) => f.startsWith("test:")));
});


test("renamed runtime inputs and deletions retain full gates", async () => {
  const { changedPrPaths } = await import("../ci-impact.mjs");
  const event = { pull_request: { number: 1, head: { sha: "abc" }, base: { sha: "base" } } };
  const metadata = { head: { sha: "abc" }, base: { sha: "base" }, changed_files: 1 };
  const collect = (row) => changedPrPaths({ event, repository: "org/repo", request: async (url) => url.includes("/files?") ? [row] : metadata });
  const renamed = await collect({ status: "renamed", filename: "docs/retired.md", previous_filename: "src/app/page.tsx" });
  assert.equal(pick(renamed).skip_runtime, false);
  const deleted = await collect({ status: "removed", filename: "src/app/page.tsx" });
  assert.equal(pick(deleted).skip_runtime, false);
  assert.equal(await collect({ status: "renamed", filename: "docs/retired.md" }), undefined);
});
test("empty, truncated, stale and over-limit inventories cannot omit work", async () => {
  const { changedPrPaths } = await import("../ci-impact.mjs");
  const event = { pull_request: { number: 1, head: { sha: "abc" }, base: { sha: "base" } } };
  for (const metadata of [{ head: { sha: "abc" }, base: { sha: "base" }, changed_files: 0 }, { head: { sha: "abc" }, base: { sha: "base" }, changed_files: 3001 }, { head: { sha: "stale" }, changed_files: 1 }, { head: { sha: "abc" }, base: { sha: "base" }, changed_files: 2 }]) {
    const result = await changedPrPaths({ event, repository: "org/repo", request: async (url) => url.includes("/files?") ? [] : metadata });
    assert.equal(result, undefined);
    assert.equal(pick(result).skip_runtime, false);
  }
  assert.equal(pick([]).skip_runtime, false);
});


test("partition preflight rejects another server and an unreserved/shared Redis before tests", async () => {
  const { verifyDesignPartition } = await import("../design-partition-preflight.mjs");
  const partition = { current: 1, total: 2, runId: "trial-p1", runBase: "trial", headSha: "a".repeat(40), database: "cinatra_design_trial_p1", port: 3007, baseURL: "http://127.0.0.1:3007", redisOrigin: "redis://127.0.0.1:6398", redisDatabase: 1 };
  const input = { partition, token: "a".repeat(40), redisUrl: "redis://127.0.0.1:6398/1", request: async () => ({ ok: true, json: async () => ({ partition }) }), readRedisOwner: async () => "trial" };
  await verifyDesignPartition(input);
  for (const owner of [null, "other-run"]) await assert.rejects(() => verifyDesignPartition({ ...input, readRedisOwner: async () => owner }), /not reserved/);
  for (const field of ["runId", "database", "headSha", "redisOrigin"]) await assert.rejects(() => verifyDesignPartition({ ...input, request: async () => ({ ok: true, json: async () => ({ partition: { ...partition, [field]: "other" } }) }) }), /does not match/);
  await assert.rejects(() => verifyDesignPartition({ ...input, request: async () => ({ ok: false, status: 404 }) }), /probe failed/);
});


// Exercise the committed Actions conditions, not a second copy of their logic.
// These expressions use the common GitHub/JavaScript boolean subset; status
// functions are supplied explicitly so a dependency failure is not confused
// with cancellation of the workflow itself.
function buildJob(id) {
  const workflow = readFileSync(new URL("../../../.github/workflows/build-image.yml", import.meta.url), "utf8");
  const blocks = workflow.slice(workflow.indexOf("\njobs:\n") + 7).split(/^  (?=[a-z0-9_-]+:\s*$)/m);
  const block = blocks.find((value) => value.startsWith(id + ":\n"));
  assert.ok(block, `missing workflow job ${id}`);
  return block;
}
function condition(block) {
  const matches = [...block.matchAll(/^    if: \$\{\{ (.+) \}\}$/gm)];
  assert.equal(matches.length, 1, "expected one explicit job condition");
  return matches[0][1];
}
function evaluate(expression, needs, cancelled = false) {
  return runInNewContext(expression, { needs, always: () => true, cancelled: () => cancelled }, { timeout: 100 });
}
const cancellableJobs = ["rbac-authz-unit", "schema-migration-gate", "archive-acceptance-gate",
  "perpetual-core", "perpetual-extension-suites", "e2e-rbac", "chat-hitl-held-turn-e2e", "image"];
const detected = (result, skip = "false") => ({ detect: { result, outputs: { skip, skip_runtime: skip } } });

test("execution jobs stop after cancellation but still admit failed detection for a red guard", () => {
  for (const job of cancellableJobs) {
    const expression = condition(buildJob(job));
    assert.match(expression, /cancelled\(\)/, "explicit status function preserves failure handling");
    for (const result of ["success", "failure", "cancelled", "skipped", undefined]) {
      for (const skip of ["false", "true", undefined]) {
        const needs = detected(result, skip);
        if (skip === undefined) needs.detect.outputs = {};
        assert.equal(evaluate(expression, needs, true), false, `${job}: cancelled workflow`);
        if (result !== "success" || skip !== "true") {
          assert.equal(evaluate(expression, needs), true, `${job}: prerequisite ${result}`);
        } else {
          assert.equal(evaluate(expression, needs),
            ["rbac-authz-unit", "e2e-rbac", "chat-hitl-held-turn-e2e"].includes(job),
            `${job}: preserve the declared docs-only stub or intentional skip`);
        }
      }
    }
    assert.match(buildJob(job), /name: Guard[^\n]*\n[\s\S]*?exit 1/,
      `${job}: prerequisite failures must retain a hard-fail guard`);
  }
});

test("cancellation blocks the actual late archive fan-out after its dependencies settle", () => {
  const block = buildJob("archive-acceptance-gate");
  const dependencies = block.match(/^    needs: \[([^\]]+)\]$/m)[1].split(",").map((id) => id.trim());
  assert.deepEqual(dependencies, ["detect", "test", "extension-lifecycle-db-tests",
    "perpetual-loops-invariants", "agents-integration-db", "e2e-rbac"]);
  const needs = { ...Object.fromEntries(dependencies.map((id) => [id, { result: "success" }])),
    ...detected("success") };
  assert.equal(evaluate(condition(block), needs), true);
  assert.equal(evaluate(condition(block), needs, true), false,
    "completed prerequisites must not start fresh work for a cancelled old head");
  needs["e2e-rbac"].result = "failure";
  assert.equal(evaluate(condition(block), needs), true, "ordinary failure still reaches the red guard");
  const guard = block.match(/^        if: \$\{\{ (.+) \}\}$/m)[1];
  assert.equal(evaluate(guard, needs), true);
  assert.equal(evaluate(condition(block), needs, true), false);
});

test("both short fan-ins still report selected failed or cancelled dependencies as red", async () => {
  const { prerequisiteFailures } = await import("../ci-result-gate.mjs");
  const required = ["image", "test", "skills-unit", "a2a-unit", "execution-plane-unit",
    "package-unit-suites", "hosted-mcp-wire-gate", "chat-hitl-held-turn-e2e"];
  const build = buildJob("build");
  assert.match(build, /run: node scripts\/ci\/ci-result-gate\.mjs/);
  const loops = buildJob("perpetual-loops-invariants");
  const run = loops.match(/^        run: \|\n((?:^          .*\n|^\n)+)/m)[1]
    .split("\n").map((line) => line.slice(10)).join("\n");
  for (const result of ["success", "failure", "cancelled", "skipped"]) {
    const needs = { ...detected("success"), ...Object.fromEntries(required.map((id) => [id, { result }])) };
    needs.detect.outputs.skip_feedback = "false";
    for (const cancelled of [false, true]) assert.equal(evaluate(condition(build), needs, cancelled), true);
    assert.equal(prerequisiteFailures(needs).length === 0, result === "success");
    const shards = { ...detected("success"), "perpetual-core": { result },
      "perpetual-extension-suites": { result: "success" } };
    for (const cancelled of [false, true]) assert.equal(evaluate(condition(loops), shards, cancelled), true);
    const rendered = run.replace(/\$\{\{ (.+?) \}\}/g, (_, expression) => String(evaluate(expression, shards)));
    const executed = spawnSync("bash", ["-c", rendered], { encoding: "utf8", timeout: 5000 });
    assert.equal(executed.status, result === "success" ? 0 : 1, executed.stderr);
  }
});

test("the inventory treats sole cancellation guards as required reporting, not intentional skips", async () => {
  const { deriveInventory, isConditional } = await import("../merge-readiness-inventory.mjs");
  for (const expression of ["always()", "${{ always() }}", "!cancelled()", "${{ !cancelled() }}",
    "${{  ! cancelled ( )  }}", "${{ !cancelled() && needs.detect.outputs.skip != 'true' }}"]) {
    assert.equal(isConditional(expression), expression.includes("&&"), expression);
    if (expression === "!cancelled()") continue; // YAML uses the expression wrapper for leading !.
    const text = `on:
  pull_request:
  merge_group:
jobs:
  verify:
    if: ${expression}
    runs-on: ubuntu-latest
    steps:
      - run: echo validation
`;
    const derived = deriveInventory([{ file: "fixture.yml", text }]);
    assert.equal(derived.expected.length, 1);
    assert.equal(derived.expected[0].skippable, expression.includes("&&"), expression);
  }
});

test("required cancellation-only contexts reject skipped and cancelled even when build is green", async () => {
  const { evaluateReadiness } = await import("../merge-readiness.mjs");
  const inventory = JSON.parse(readFileSync(new URL("../../../.github/merge-readiness.json", import.meta.url)));
  const required = ["Chat-HITL held-turn dev-runtime e2e", "RBAC authz unit tests", "RBAC browser e2e"];
  const green = inventory.expected.map((entry) => ({
    name: entry.context, app: entry.app, workflow: entry.workflow,
    workflowResolved: true, status: "completed", conclusion: "success",
  }));
  const verdict = (checks) => evaluateReadiness({
    inventory, checks, changedPaths: ["src/app/page.tsx"], eventName: "pull_request",
  });
  assert.equal(verdict(green).verdict, "PASS");
  for (const name of required) {
    assert.equal(inventory.expected.find((entry) => entry.context === name).skippable, false);
    for (const conclusion of ["skipped", "cancelled"]) {
      const result = verdict(green.map((check) => check.name === name ? { ...check, conclusion } : check));
      assert.equal(result.verdict, "FAIL", `${name}: ${conclusion}, all other contexts green`);
      assert.ok(result.failures.some((message) => message.includes(name)));
    }
  }
  assert.equal(inventory.expected.find((entry) => entry.context === "image").skippable, true);
  const intentional = green.map((check) => check.name === "image" ? { ...check, conclusion: "skipped" } : check);
  assert.equal(verdict(intentional).verdict, "PASS", "compound impact-selection guards keep their existing skip policy");
  const redAggregate = intentional.map((check) => check.name === "build" ? { ...check, conclusion: "failure" } : check);
  assert.equal(verdict(redAggregate).verdict, "FAIL", "intentional skips cannot hide a red required aggregate");
});
