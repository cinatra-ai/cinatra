// Agent extension code gate (cinatra#4885) — unit and live tests.
// Zero-dep (node:test) to match the gate. Fixture packs live under a neutral
// `example-org` scope folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  FINDING_CLASSES,
  PROGRAM_CODE_EXTENSIONS,
  agentCodeFiles,
  flowToolSteps,
  listGrowth,
  parseList,
  readFilesList,
  shippedBy,
  toolDeclarationKeys,
} from "../agent-extension-code-gate.mjs";

const GATE_SCRIPT = fileURLToPath(new URL("../agent-extension-code-gate.mjs", import.meta.url));
const LIST_REL = join("scripts", "audit", "agent-extension-code-gate.baseline.json");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function writeFile(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const writeJson = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + "\n");

const SHA = "0123456789abcdef0123456789abcdef01234567";

const extensionToolFlow = (nodeId) => ({
  flow: {
    nodes: [
      { component_type: "ApiNode", id: nodeId, url: "{{host}}/api/agents/passthrough", data: { tool: "extension_tool", input: { name: "x" } } },
      { component_type: "ApiNode", id: "save", url: "{{host}}/api/agents/passthrough", data: { tool: "objects_save" } },
      { component_type: "LlmNode", id: "think" },
    ],
  },
});

/**
 * A repository root holding the pinned universe: `packs` maps a directory name
 * under extensions/example-org to `{ packageJson, files: { rel: text }, flow }`.
 * `pinned` (default: every pack) names the packages the locks and
 * devExtensions pin; `list` is the recorded list to write.
 */
function makeRoot({ packs, pinned, list }) {
  const root = mkdtempSync(join(tmpdir(), "agent-extension-code-gate-"));
  const names = pinned ?? Object.values(packs).map((p) => p.packageJson.name);
  const [first, ...rest] = names;
  writeJson(join(root, "cinatra-required-extensions.lock.json"), {
    packages: first ? [{ packageName: first, resolvedSha: SHA }] : [],
  });
  writeJson(join(root, "cinatra-dev-extensions.lock.json"), {
    packages: rest.map((packageName) => ({ packageName, resolvedSha: SHA })),
  });
  writeJson(join(root, "package.json"), {
    name: "fixture-root",
    cinatra: { devExtensions: Object.fromEntries(names.map((n) => [n, "https://example.invalid/x.git"])) },
  });
  for (const [dir, pack] of Object.entries(packs)) {
    const base = join(root, "extensions", "example-org", dir);
    writeJson(join(base, "package.json"), pack.packageJson);
    for (const [rel, text] of Object.entries(pack.files ?? {})) writeFile(join(base, rel), text);
    if (pack.flow) writeJson(join(base, "cinatra", "oas.json"), pack.flow);
  }
  if (list) writeJson(join(root, LIST_REL), list);
  return root;
}

const emptyList = () => Object.fromEntries(FINDING_CLASSES.map((c) => [c, {}]));

/** `list` without the class `cls`. */
const dropClass = (list, cls) => Object.fromEntries(Object.entries(list).filter(([k]) => k !== cls));

const agent = (name, extra = {}) => ({ name: `@example-org/${name}`, files: ["cinatra"], cinatra: { kind: "agent" }, ...extra });

function runGate(root, args = [], env = {}) {
  try {
    const out = execFileSync(process.execPath, [GATE_SCRIPT, ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GITHUB_BASE_REF: "", GITHUB_EVENT_NAME: "", AGENT_EXTENSION_CODE_BASE: "", ...env },
    });
    return { status: 0, out };
  } catch (err) {
    return { status: err.status, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

function gitCommitAll(root, message) {
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  git("add", "-A");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", message);
  return git("rev-parse", "HEAD").trim();
}

function gitInit(root) {
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
}

// ---------------------------------------------------------------------------
// What counts
// ---------------------------------------------------------------------------

test("the program-code extensions are exactly the stated list", () => {
  assert.deepEqual([...PROGRAM_CODE_EXTENSIONS].sort(), [".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".py", ".sh", ".ts", ".tsx"]);
});

test("a code file in an agent pack is a finding, wherever it sits", () => {
  const found = agentCodeFiles({
    relPaths: ["cinatra/tools/read.mjs", "src/lib/x.ts", "cinatra/oas.json", "README.md", "bin/run.sh", "tools/a.py"],
    packageJson: agent("a"),
  });
  assert.deepEqual(found, ["bin/run.sh", "cinatra/tools/read.mjs", "src/lib/x.ts", "tools/a.py"]);
  // Paths that differ only in case (one file on a case-insensitive disk) are two keys, never one.
  assert.deepEqual(agentCodeFiles({ relPaths: ["src/Index.ts", "src/index.ts"], packageJson: agent("a") }), ["src/Index.ts", "src/index.ts"]);
});

test("the same file inside a skill folder is no finding; SKILL.md at the pack root exempts nothing", () => {
  const inSkill = agentCodeFiles({
    relPaths: ["skills/pick/SKILL.md", "skills/pick/scripts/read.mjs", "skills/pick/read.py"],
    packageJson: agent("a"),
  });
  assert.deepEqual(inSkill, []);
  const rootSkill = agentCodeFiles({ relPaths: ["SKILL.md", "cinatra/tools/read.mjs"], packageJson: agent("a") });
  assert.deepEqual(rootSkill, ["cinatra/tools/read.mjs"]);
});

test("an unshipped test file is no finding; a shipped one is", () => {
  const relPaths = ["test/read.test.mjs", "src/__tests__/x.test.ts", "src/x.ts", "vitest.config.ts", "scripts/build.mjs"];
  assert.deepEqual(agentCodeFiles({ relPaths, packageJson: agent("a", { files: ["cinatra"] }) }), ["src/x.ts"]);
  assert.deepEqual(agentCodeFiles({ relPaths, packageJson: agent("a", { files: ["cinatra", "src", "!src/__tests__"] }) }), ["src/x.ts"]);
  assert.deepEqual(agentCodeFiles({ relPaths, packageJson: agent("a", { files: ["cinatra", "src"] }) }), [
    "src/__tests__/x.test.ts",
    "src/x.ts",
  ]);
  assert.deepEqual(agentCodeFiles({ relPaths, packageJson: agent("a", { files: ["cinatra", "test"] }) }), ["src/x.ts", "test/read.test.mjs"]);
});

test("a files list that cannot be read ships everything, so test files count", () => {
  for (const files of [undefined, "cinatra", ["cinatra/**"], ["cinatra", 3], ["../x"]]) {
    const pkg = agent("a");
    if (files === undefined) delete pkg.files;
    else pkg.files = files;
    assert.equal(readFilesList(pkg).readable, false, JSON.stringify(files));
    assert.deepEqual(agentCodeFiles({ relPaths: ["test/a.test.mjs"], packageJson: pkg }), ["test/a.test.mjs"]);
  }
  assert.equal(shippedBy(readFilesList(agent("a", { files: ["./cinatra/"] })), "cinatra/tools/x.mjs"), true);
  assert.equal(shippedBy(readFilesList(agent("a", { files: ["cinatra"] })), "cinatrax/x.mjs"), false);
});

test("a code file a manifest names counts, shipped or not, whatever the key", () => {
  const relPaths = ["register.mjs", "check.mjs", "cinatra/oas.json"];
  // A runtime entry at the root, outside `files`, named by cinatra.serverEntry.
  assert.deepEqual(
    agentCodeFiles({ relPaths, packageJson: agent("a", { cinatra: { kind: "agent", serverEntry: "./register.mjs" } }) }),
    ["register.mjs"],
  );
  // Named by npm `main` (npm also always packs it), without the extension, and with a query.
  assert.deepEqual(agentCodeFiles({ relPaths, packageJson: agent("a", { main: "register.mjs" }) }), ["register.mjs"]);
  assert.deepEqual(agentCodeFiles({ relPaths, packageJson: agent("a", { main: "./register" }) }), ["register.mjs"]);
  assert.deepEqual(agentCodeFiles({ relPaths, packageJson: agent("a", { bin: { run: "register.mjs?x=1#y" } }) }), ["register.mjs"]);
  // Named by a key no reader knows yet, deep under cinatra.
  assert.deepEqual(
    agentCodeFiles({
      relPaths,
      packageJson: agent("a", { cinatra: { kind: "agent", future: { entries: [{ at: "register.mjs" }] } } }),
    }),
    ["register.mjs"],
  );
  // Named by a cinatra/ JSON file, relative to that file or to the pack root.
  assert.deepEqual(
    agentCodeFiles({ relPaths, packageJson: agent("a"), manifestJson: { "cinatra/screens.json": { entry: "../check.mjs" } } }),
    ["check.mjs"],
  );
  assert.deepEqual(
    agentCodeFiles({ relPaths, packageJson: agent("a"), manifestJson: { "cinatra/screens.json": { entry: "/check.mjs" } } }),
    ["check.mjs"],
  );
  // Unshipped and unnamed, a root check script is a build file and stays out.
  assert.deepEqual(agentCodeFiles({ relPaths, packageJson: agent("a") }), []);
  // A skill script stays out until a manifest names it.
  const skill = ["skills/pick/SKILL.md", "skills/pick/run.mjs"];
  assert.deepEqual(agentCodeFiles({ relPaths: skill, packageJson: agent("a") }), []);
  assert.deepEqual(
    agentCodeFiles({ relPaths: skill, packageJson: agent("a", { cinatra: { kind: "agent", serverEntry: "skills/pick/run.mjs" } }) }),
    ["skills/pick/run.mjs"],
  );
});

test("cinatra.tools is a finding, one key per declared tool", () => {
  assert.deepEqual(toolDeclarationKeys({ cinatra: { kind: "agent" } }), []);
  assert.deepEqual(toolDeclarationKeys({ cinatra: { tools: null } }), []);
  assert.deepEqual(
    toolDeclarationKeys({ cinatra: { tools: [{ name: "b", module: "./b.mjs" }, { name: "a" }, { module: "./c.mjs" }] } }),
    ["a", "b", "cinatra.tools[2]"],
  );
  assert.deepEqual(toolDeclarationKeys({ cinatra: { tools: {} } }), ["cinatra.tools"]);
  assert.deepEqual(toolDeclarationKeys({ cinatra: { tools: [] } }), []);
});

test("cinatra.tools: a repeated name, a bare string and an object map are each their own findings", () => {
  // The second declaration of a name is a second key, so it cannot hide behind a recorded one.
  assert.deepEqual(
    toolDeclarationKeys({ cinatra: { tools: [{ name: "a", module: "./a.mjs" }, { name: "a", module: "./b.mjs" }] } }),
    ["a", "cinatra.tools[1]"],
  );
  assert.deepEqual(toolDeclarationKeys({ cinatra: { tools: ["a", { name: "a" }] } }), ["a", "cinatra.tools[0]"]);
  // A name outside the product's vocabulary never becomes a key that could collide with another.
  assert.deepEqual(toolDeclarationKeys({ cinatra: { tools: [{ name: "cinatra.tools[1]" }, { name: "b" }] } }), ["b", "cinatra.tools[0]"]);
  assert.deepEqual(toolDeclarationKeys({ cinatra: { tools: { a: "./a.mjs", b: "./b.mjs" } } }), ["cinatra.tools.a", "cinatra.tools.b"]);
  assert.deepEqual(toolDeclarationKeys({ cinatra: { tools: "./a.mjs" } }), ["cinatra.tools"]);
});

test("a flow step that calls extension_tool is a finding; every step naming a tool is counted", () => {
  const { extensionToolSteps, unreadable, toolSteps } = flowToolSteps(extensionToolFlow("read_text"));
  assert.deepEqual(extensionToolSteps, [{ path: "$.flow.nodes[0]", id: "read_text", module: "x" }]);
  assert.deepEqual(unreadable, []);
  assert.deepEqual(toolSteps, ["read_text -> extension_tool", "save -> objects_save"]);
});

const step = (id, extra = {}) => ({ component_type: "ApiNode", id, url: "{{host}}/api/agents/passthrough", data: { tool: "extension_tool" }, ...extra });
const stepIds = (flow) => flowToolSteps(flow).extensionToolSteps.map((s) => s.id);

test("a nested step with the same id as another is a second step, keyed by its position", () => {
  const flow = { $referenced_components: { read: step("read"), child: { $referenced_components: { read: step("read") } } } };
  const steps = flowToolSteps(flow).extensionToolSteps;
  assert.equal(steps.length, 2);
  assert.deepEqual(steps.map((s) => s.path).sort(), ["$.$referenced_components.child.$referenced_components.read", "$.$referenced_components.read"]);
});

test("the URL is never read: a templated route path, any URL or none still counts", () => {
  for (const url of ["{{host}}/api/agents/{{route}}", "{{host}}{{passthrough_path}}", "https://elsewhere.example.invalid/x", undefined]) {
    const s = step("s");
    if (url === undefined) delete s.url;
    else s.url = url;
    assert.deepEqual(stepIds({ nodes: [s] }), ["s"], String(url));
  }
});

test("a JSON-string data block selecting extension_tool counts as the object it parses to", () => {
  const s = step("s", { data: JSON.stringify({ tool: "extension_tool", input: { name: "m" } }) });
  assert.deepEqual(flowToolSteps({ nodes: [s] }).extensionToolSteps, [{ path: "$.nodes[0]", id: "s", module: "m" }]);
});

test("an unparsable string data block naming extension_tool is an unreadable step", () => {
  const { extensionToolSteps, unreadable } = flowToolSteps({ nodes: [step("s", { data: '{"tool": "extension_tool", {{ rest }} }' })] });
  assert.deepEqual(extensionToolSteps, []);
  assert.equal(unreadable?.length, 1);
  assert.match(unreadable?.[0]?.reason ?? "", /unreadable step data/);
  // A string that names no such tool is no step at all.
  assert.deepEqual(flowToolSteps({ nodes: [step("s", { data: "{{ payload }}" })] }).unreadable ?? null, []);
});

test("a templated or non-string tool name in an ApiNode-shaped object is an unreadable step", () => {
  for (const tool of ["{{ which_tool }}", "extension_{{ x }}", ["extension_tool"], { name: "extension_tool" }, 7]) {
    const { extensionToolSteps, unreadable } = flowToolSteps({ nodes: [step("s", { data: { tool } })] });
    assert.deepEqual(extensionToolSteps, [], JSON.stringify(tool));
    assert.equal(unreadable?.length, 1, JSON.stringify(tool));
    assert.match(unreadable?.[0]?.reason ?? "", /unreadable tool name/);
  }
  // Outside an ApiNode shape, a template is not read as a step.
  assert.deepEqual(flowToolSteps({ meta: { data: { tool: "{{ x }}" } } }).unreadable ?? null, []);
});

// ---------------------------------------------------------------------------
// The recorded list
// ---------------------------------------------------------------------------

test("list growth: a new entry and a removed class are growth; a shrink is not", () => {
  const base = parseList(JSON.stringify({ ...emptyList(), codeFiles: { "@example-org/a": ["x.mjs", "y.mjs"] } }));
  assert.deepEqual(listGrowth(base, parseList(JSON.stringify({ ...emptyList(), codeFiles: { "@example-org/a": ["x.mjs"] } }))), []);
  assert.deepEqual(
    listGrowth(base, parseList(JSON.stringify({ ...emptyList(), codeFiles: { "@example-org/a": ["x.mjs", "y.mjs", "z.mjs"] } }))),
    ["[codeFiles] @example-org/a :: z.mjs"],
  );
  const withoutClass = dropClass(emptyList(), "toolDeclarations");
  assert.deepEqual(listGrowth(base, withoutClass), ["[toolDeclarations] the class is removed (a class is never removed)"]);
  assert.throws(() => parseList(JSON.stringify(withoutClass)), /toolDeclarations/);
});

test("list growth of extension_tool steps reads the count per pack and flow file, never the ids", () => {
  const steps = (count, ids) => ({ "@example-org/a": { "cinatra/oas.json": { count, steps: ids } } });
  // red-first-expect: the entry extensionToolSteps.@example-org/a is not an array of strings
  const base = parseList(JSON.stringify({ ...emptyList(), extensionToolSteps: steps(1, ["read -> m"]) }));
  // Same count with another id: no growth. A higher count, whatever the ids: growth.
  assert.deepEqual(listGrowth(base, parseList(JSON.stringify({ ...emptyList(), extensionToolSteps: steps(1, ["other -> m"]) }))), []);
  assert.deepEqual(listGrowth(base, parseList(JSON.stringify({ ...emptyList(), extensionToolSteps: steps(2, ["read -> m", "read -> m"]) }))), [
    "[extensionToolSteps] @example-org/a :: cinatra/oas.json: 2 step(s), the base holds 1",
  ]);
  assert.throws(() => parseList(JSON.stringify({ ...emptyList(), extensionToolSteps: { "@example-org/a": ["read"] } })), /extensionToolSteps/);
});

// ---------------------------------------------------------------------------
// Live runs over fixture trees
// ---------------------------------------------------------------------------

const packsWithCode = () => ({
  "read-agent": {
    packageJson: agent("read-agent", { cinatra: { kind: "agent", tools: [{ name: "read_text", module: "./cinatra/tools/read.mjs" }] } }),
    files: { "cinatra/tools/read.mjs": "export default 1;\n", "test/read.test.mjs": "\n", "extension-kind-gate.mjs": "\n" },
    flow: extensionToolFlow("read_text"),
  },
  "skilled-agent": {
    packageJson: agent("skilled-agent"),
    files: { "skills/pick/SKILL.md": "# pick\n", "skills/pick/scripts/pick.py": "print(1)\n" },
  },
  "mail-connector": {
    packageJson: { name: "@example-org/mail-connector", cinatra: { kind: "connector" } },
    files: { "src/index.ts": "export {};\n" },
  },
});

const readAgentSteps = () => ({ "@example-org/read-agent": { "cinatra/oas.json": { count: 1, steps: ["read_text -> x"] } } });

const recordedList = () => ({
  ...emptyList(),
  codeFiles: { "@example-org/read-agent": ["cinatra/tools/read.mjs"] },
  toolDeclarations: { "@example-org/read-agent": ["read_text"] },
  extensionToolSteps: readAgentSteps(),
});

test("live: --report names each class and leaves the connector, the skill and the unshipped test out", () => {
  const root = makeRoot({ packs: packsWithCode() });
  try {
    const res = runGate(root, ["--report"]);
    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /3 pinned extension\(s\) scanned; 1 codeFiles, 1 toolDeclarations, 1 extensionToolSteps/);
    assert.match(res.out, /@example-org\/read-agent :: cinatra\/tools\/read\.mjs \(1 lines\)/);
    assert.doesNotMatch(res.out, /mail-connector ::/);
    assert.doesNotMatch(res.out, /pick\.py|read\.test\.mjs|extension-kind-gate/);
    assert.match(res.out, /@example-org\/read-agent: 2 \(read_text -> extension_tool, save -> objects_save\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live: a list holding today's findings passes; a new code file fails; a gone entry fails as stale", () => {
  const root = makeRoot({ packs: packsWithCode(), list: recordedList() });
  try {
    assert.equal(runGate(root).status, 0);
    writeFile(join(root, "extensions", "example-org", "read-agent", "src", "more.ts"), "export {};\n");
    const grown = runGate(root);
    assert.equal(grown.status, 1);
    assert.match(grown.out, /\[codeFiles\] not on the recorded list/);
    assert.match(grown.out, /\+ @example-org\/read-agent :: src\/more\.ts/);
    rmSync(join(root, "extensions", "example-org", "read-agent", "src"), { recursive: true });
    rmSync(join(root, "extensions", "example-org", "read-agent", "cinatra", "tools"), { recursive: true });
    const stale = runGate(root);
    assert.equal(stale.status, 1);
    assert.match(stale.out, /\[codeFiles\] on the list but gone/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live: a new cinatra.tools declaration and a new extension_tool step fail in any pinned pack", () => {
  const packs = packsWithCode();
  packs["mail-connector"].packageJson.cinatra.tools = [{ name: "send", module: "./src/index.ts" }];
  packs["mail-connector"].flow = extensionToolFlow("send_now");
  const root = makeRoot({ packs, list: recordedList() });
  try {
    const res = runGate(root);
    assert.equal(res.status, 1);
    assert.match(res.out, /\+ @example-org\/mail-connector :: send/);
    assert.match(res.out, /\[extensionToolSteps\] not on the recorded list[\s\S]*\+ @example-org\/mail-connector :: cinatra\/oas\.json: 1 step\(s\), the list holds 0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live: a nested extension_tool step with the id of a recorded step grows the count and fails", () => {
  const packs = packsWithCode();
  packs["read-agent"].flow.flow.child = { $referenced_components: { read_text: step("read_text") } };
  const root = makeRoot({ packs, list: recordedList() });
  try {
    const res = runGate(root);
    assert.equal(res.status, 1, res.out);
    assert.match(res.out, /\+ @example-org\/read-agent :: cinatra\/oas\.json: 2 step\(s\), the list holds 1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live: an unreadable step fails even with the list holding every count", () => {
  const packs = packsWithCode();
  packs["read-agent"].flow.flow.nodes.push(step("later", { data: { tool: "{{ which }}" } }));
  const root = makeRoot({ packs, list: recordedList() });
  try {
    const res = runGate(root);
    assert.equal(res.status, 1, res.out);
    assert.match(res.out, /a step the check cannot read[\s\S]*@example-org\/read-agent :: cinatra\/oas\.json :: \$\.flow\.nodes\[3\] \(later\): unreadable tool name/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live: a pinned pack that is not in the tree is a scanner error (exit 2)", () => {
  const root = makeRoot({
    packs: packsWithCode(),
    pinned: ["@example-org/read-agent", "@example-org/skilled-agent", "@example-org/mail-connector", "@example-org/missing-agent"],
    list: recordedList(),
  });
  try {
    const res = runGate(root);
    assert.equal(res.status, 2);
    assert.match(res.out, /the pinned pack @example-org\/missing-agent is not in the extensions\/ tree/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live: a pinned pack whose kind cannot be read is a scanner error (exit 2)", () => {
  const packs = packsWithCode();
  delete packs["skilled-agent"].packageJson.cinatra.kind;
  const root = makeRoot({ packs, list: recordedList() });
  try {
    const res = runGate(root);
    assert.equal(res.status, 2);
    assert.match(res.out, /@example-org\/skilled-agent .* has no readable cinatra\.kind/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live: --write-baseline refuses a list that grows and writes a shrink", () => {
  const root = makeRoot({ packs: packsWithCode(), list: emptyList() });
  try {
    const refused = runGate(root, ["--write-baseline"]);
    assert.equal(refused.status, 1);
    assert.match(refused.out, /REFUSING --write-baseline/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const root2 = makeRoot({
    packs: packsWithCode(),
    list: { ...recordedList(), codeFiles: { "@example-org/read-agent": ["cinatra/tools/read.mjs", "src/gone.ts"] } },
  });
  try {
    assert.equal(runGate(root2, ["--write-baseline"]).status, 0);
    assert.equal(runGate(root2).status, 0);
  } finally {
    rmSync(root2, { recursive: true, force: true });
  }
});

test("live base guard: the list seeds once, a shrink passes, growth and a removed class fail", () => {
  // The base holds neither the list nor the gate: the introducing change seeds.
  const root = makeRoot({ packs: packsWithCode() });
  try {
    gitInit(root);
    const before = gitCommitAll(root, "base without the gate");
    writeJson(join(root, LIST_REL), recordedList());
    // The fixture's stand-in for the gate's own file, so later bases hold it.
    writeFile(join(root, "scripts", "audit", "agent-extension-code-gate.mjs"), "// the gate\n");
    const seed = runGate(root, [], { AGENT_EXTENSION_CODE_BASE: before });
    assert.equal(seed.status, 0, seed.out);
    assert.match(seed.out, /this change introduces the gate, and its list is the seed/);
    const seeded = gitCommitAll(root, "seed");

    // Growth against the base fails, even when the findings would match.
    writeFile(join(root, "extensions", "example-org", "read-agent", "src", "more.ts"), "export {};\n");
    writeJson(join(root, LIST_REL), {
      ...recordedList(),
      codeFiles: { "@example-org/read-agent": ["cinatra/tools/read.mjs", "src/more.ts"] },
    });
    const grew = runGate(root, [], { AGENT_EXTENSION_CODE_BASE: seeded });
    assert.equal(grew.status, 1);
    assert.match(grew.out, /GREW against the base/);
    assert.match(grew.out, /\[codeFiles\] @example-org\/read-agent :: src\/more\.ts/);
    rmSync(join(root, "extensions", "example-org", "read-agent", "src"), { recursive: true });

    // A shrink passes: the code left and the list lost its entries.
    rmSync(join(root, "extensions", "example-org", "read-agent", "cinatra", "tools"), { recursive: true });
    writeJson(join(root, LIST_REL), {
      ...emptyList(),
      toolDeclarations: { "@example-org/read-agent": ["read_text"] },
      extensionToolSteps: readAgentSteps(),
    });
    const shrank = runGate(root, [], { AGENT_EXTENSION_CODE_BASE: seeded });
    assert.equal(shrank.status, 0, shrank.out);
    assert.match(shrank.out, /does not grow against the base/);

    // A removed class fails (the base copy holds it; the head cannot be read without it).
    writeJson(
      join(root, LIST_REL),
      dropClass(
        {
          ...emptyList(),
          toolDeclarations: { "@example-org/read-agent": ["read_text"] },
          extensionToolSteps: readAgentSteps(),
        },
        "codeFiles",
      ),
    );
    const removed = runGate(root, [], { AGENT_EXTENSION_CODE_BASE: seeded });
    assert.notEqual(removed.status, 0);
    assert.match(removed.out, /codeFiles/);

    // A base that holds the gate but no list fails closed, never seeds again.
    rmSync(join(root, LIST_REL));
    const noList = gitCommitAll(root, "list deleted");
    writeJson(join(root, LIST_REL), recordedList());
    const reseed = runGate(root, [], { AGENT_EXTENSION_CODE_BASE: noList });
    assert.equal(reseed.status, 1, reseed.out);
    assert.match(reseed.out, /cannot be compared with the base/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
