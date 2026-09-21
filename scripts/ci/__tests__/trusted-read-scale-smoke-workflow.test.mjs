// Exercise the actual workflow shell with isolated command transports. These
// contracts prove series control flow; they do not simulate live MCP behavior.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "vitest";
import { extractRunBlocks } from "../../audit/ci-pinned-tests-exist.mjs";

const workflow = readFileSync(new URL("../../../.github/workflows/trusted-read-scale-smoke.yml", import.meta.url), "utf8");
const blocks = extractRunBlocks(workflow);
const binding = blocks.filter((b) => b.body.includes("REQUESTED_REPETITIONS"));
const series = blocks.filter((b) => b.body.includes("count=\"$SERIES_REPETITIONS\""));
assert.equal(binding.length, 1);
assert.equal(series.length, 1);
const HEAD = "a".repeat(40);
const FILES = ["src/lib/__tests__/connector-instance-native-read-injection-live-scale-smoke.test.ts", "src/lib/__tests__/connector-instance-invoker-live-scale-smoke.test.ts"];
const SECRET = "synthetic-fixture-credential-never-printed";

function fixture(run, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "hosted-series-"));
  mkdirSync(join(root, "tools"));
  const put = (name, text) => writeFileSync(join(root, name), text);
  put("head", HEAD); put("dirty", options.dirty || ""); put("calls", ""); put("output", ""); put("summary", "");
  const helper = `#!${process.execPath}\nimport fs from 'node:fs';\nimport path from 'node:path';\nconst root=process.env.FIXTURE_ROOT;\nconst read=n=>fs.readFileSync(path.join(root,n),'utf8');\n`;
  writeFileSync(join(root, "tools/git"), helper + `
const args=process.argv.slice(2).join(' ');
if(args==='rev-parse HEAD'){process.stdout.write(read('head')+'\\n');}
else if(args==='diff --quiet'){process.exit(read('dirty')==='worktree'?1:0);}
else if(args==='diff --cached --quiet'){process.exit(read('dirty')==='staged'?1:0);}
else {console.error('unexpected git operation');process.exit(91);}
`, { mode: 0o700 });
  writeFileSync(join(root, "tools/pnpm"), helper + `
const argv=process.argv.slice(2);
if(JSON.stringify(argv.slice(0,6))!==JSON.stringify(['exec','vitest','run','--config','vitest.config.ts','--no-coverage']) || argv.length!==7)process.exit(92);
const count=read('calls').split('\\n').filter(Boolean).length+1;
fs.appendFileSync(path.join(root,'calls'),JSON.stringify({argv,pid:process.pid})+'\\n');
if(count===Number(process.env.DRIFT_AT))fs.writeFileSync(path.join(root,'head'),'b'.repeat(40));
if(count===Number(process.env.DIRTY_AT))fs.writeFileSync(path.join(root,'dirty'),'worktree');
if(count===Number(process.env.FAIL_AT))process.exit(77);
`, { mode: 0o700 });
  const env = { PATH: join(root, "tools") + ":/usr/bin:/bin", HOME: root,
    FIXTURE_ROOT: root, EVENT_NAME: options.event || "workflow_dispatch",
    REQUESTED_REPETITIONS: options.count ?? "1", EXPECTED_HEAD: options.expected ?? "",
    GITHUB_OUTPUT: join(root, "output"), GITHUB_STEP_SUMMARY: join(root, "summary"),
    WP_MCP_BASIC_AUTH: SECRET, WP_BASE_URL: "http://127.0.0.1:1",
    FAIL_AT: String(options.failAt || 0), DRIFT_AT: String(options.driftAt || 0), DIRTY_AT: String(options.dirtyAt || 0) };
  const shell = (body, extra = {}) => spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", body], { cwd: root, env: { ...env, ...extra }, encoding: "utf8", timeout: 20000 });
  const calls = () => readFileSync(join(root, "calls"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const bind = () => shell(binding[0].body);
  const execute = (extra = {}) => {
    const output = Object.fromEntries(readFileSync(join(root, "output"), "utf8").trim().split("\n").map((line) => line.split("=")));
    return shell(series[0].body, { SERIES_REPETITIONS: output.repetitions || "", SERIES_HEAD: output.head || "", ...extra });
  };
  try { return run({ root, put, bind, execute, calls, summary: () => readFileSync(join(root, "summary"), "utf8") }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test("dispatch binding precedes install and fixture boot without changing hosted admission or permissions", () => {
  assert.match(workflow, /repetitions:[\s\S]*?type: choice\n\s+options: \["1", "20"\]\n\s+default: "1"/);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, /name: Live provider-scale proof \(boot pinned fixture\)/);
  assert.match(workflow, /runs-on: ubuntu-latest\n    timeout-minutes: 30/);
  const index = workflow.indexOf("- name: Bind the hosted proof series");
  assert(workflow.indexOf("- uses: actions/checkout@") < index);
  for (const step of ["- name: Set up pnpm", "- name: Install dependencies", "- name: Boot pinned WordPress fixture"]) assert(index < workflow.indexOf(step));
  for (const block of [binding[0], series[0]]) {
    assert.equal(block.nonBlocking, false); assert.equal(block.isStep, true);
    assert.doesNotMatch(block.body, /\$\{\{/);
  }
  assert.match(workflow, /REQUESTED_REPETITIONS: \$\{\{ inputs.repetitions \}\}/);
  assert.match(workflow, /EXPECTED_HEAD: \$\{\{ inputs.expected_head \}\}/);
  assert.match(workflow, /SERIES_REPETITIONS: \$\{\{ steps.series.outputs.repetitions \}\}/);
  assert.match(workflow, /SERIES_HEAD: \$\{\{ steps.series.outputs.head \}\}/);
  for (const file of ["helpers/prepared-mcp-clients.ts", "prepared-mcp-clients.test.ts"]) assert(workflow.includes("src/lib/__tests__/" + file));
});

for (const event of ["pull_request", "schedule"]) test(event + " always runs one complete harness despite dispatch-shaped data", () => fixture((f) => {
  assert.equal(f.bind().status, 0); assert.equal(f.execute().status, 0);
  assert.deepEqual(f.calls().map((call) => call.argv.at(-1)), FILES);
  assert.match(f.summary(), /Completed 1\/1 hosted harness executions/);
}, { event, count: "20; exit 9", expected: "not-an-input-for-this-event" }));

test("manual defaults preserve one execution and separate ordered processes", () => fixture((f) => {
  assert.equal(f.bind().status, 0); const result = f.execute(); assert.equal(result.status, 0);
  const calls = f.calls(); assert.deepEqual(calls.map((call) => call.argv.at(-1)), FILES);
  assert.equal(new Set(calls.map((call) => call.pid)).size, 2);
  assert(!result.stdout.includes(SECRET)); assert(!f.summary().includes(SECRET));
}));

test("manual twenty reports precisely forty sequential file processes on one unchanged fixture", () => fixture((f) => {
  assert.equal(f.bind().status, 0); const result = f.execute(); assert.equal(result.status, 0, result.stderr);
  const calls = f.calls(); assert.equal(calls.length, 40);
  assert.equal(new Set(calls.map((call) => call.pid)).size, 40);
  assert.deepEqual(calls.map((call) => call.argv.at(-1)), Array.from({ length: 20 }, () => FILES).flat());
  assert.equal((result.stdout.match(/SERIES START /g) || []).length, 20);
  assert.equal((result.stdout.match(/SERIES PASS /g) || []).length, 20);
  assert.match(result.stdout, new RegExp("SERIES PASS 20/20 head=" + HEAD));
  assert.match(f.summary(), /Completed 20\/20 hosted harness executions/);
  assert.match(f.summary(), /One unchanged checkout and one fixture boot/);
  assert(!result.stdout.includes(SECRET)); assert(!f.summary().includes(SECRET));
}, { count: "20", expected: HEAD }));

for (const count of ["0", "21", "2", "1.5", "twenty", "20; touch injected", "$(touch injected)"]) test("reject invalid requested count before proof setup: " + count, () => fixture((f) => {
  assert.notEqual(f.bind().status, 0); assert.equal(f.calls().length, 0);
  assert.equal(readFileSync(join(f.root, "output"), "utf8"), "");
  assert(!existsSync(join(f.root, "injected")));
}, { count, expected: HEAD }));

for (const expected of ["", "a".repeat(39), "b".repeat(40), "$(touch injected)"]) test("twenty refuses missing, malformed or different expected head: " + expected, () => fixture((f) => {
  assert.notEqual(f.bind().status, 0); assert.equal(f.calls().length, 0); assert(!existsSync(join(f.root, "injected")));
}, { count: "20", expected }));

for (const dirty of ["worktree", "staged"]) test("tracked " + dirty + " drift refuses before setup", () => fixture((f) => {
  assert.notEqual(f.bind().status, 0); assert.equal(f.calls().length, 0);
}, { dirty }));

test("unknown events and malformed internal series binding refuse", () => {
  fixture((f) => { assert.notEqual(f.bind().status, 0); assert.equal(f.calls().length, 0); }, { event: "push" });
  fixture((f) => { assert.equal(f.bind().status, 0); assert.notEqual(f.execute({ SERIES_REPETITIONS: "0" }).status, 0); assert.notEqual(f.execute({ SERIES_HEAD: "bad" }).status, 0); assert.equal(f.calls().length, 0); });
});

for (const failAt of [1, 14]) test("first failure stops all later files/iterations at invocation " + failAt, () => fixture((f) => {
  assert.equal(f.bind().status, 0); const result = f.execute(); assert.equal(result.status, 77);
  assert.equal(f.calls().length, failAt); assert.equal(f.summary(), "");
  assert.doesNotMatch(result.stdout, /SERIES PASS 20\/20/);
  assert.match(result.stdout, /no complete-series pass/);
}, { count: "20", expected: HEAD, failAt }));

for (const kind of ["head", "tracked"]) test("post-iteration " + kind + " drift refuses a pass and further calls", () => fixture((f) => {
  assert.equal(f.bind().status, 0); const result = f.execute(); assert.notEqual(result.status, 0);
  assert.equal(f.calls().length, 2); assert.equal(f.summary(), ""); assert.doesNotMatch(result.stdout, /SERIES PASS/);
}, { count: "20", expected: HEAD, ...(kind === "head" ? { driftAt: 2 } : { dirtyAt: 2 }) }));

test("head movement after binding but before tests refuses without starting a proof", () => fixture((f) => {
  assert.equal(f.bind().status, 0); f.put("head", "b".repeat(40));
  assert.notEqual(f.execute().status, 0); assert.equal(f.calls().length, 0); assert.equal(f.summary(), "");
}));
