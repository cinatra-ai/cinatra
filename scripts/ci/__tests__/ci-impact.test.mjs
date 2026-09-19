import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
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
