// Agent extension code gate (cinatra#4885) — unit and live tests.
// Zero-dep (node:test) to match the gate. Fixture packs live under a neutral
// `example-org` scope folder; each is a git repository of its own, and the
// locks pin each to a commit, as the CI clone makes them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  AGENT_DEFINITION_PATHS,
  CLASSES,
  CONTENT,
  diffWithList,
  flowSteps,
  isAgentPack,
  isContent,
  isSkippedDir,
  isTestFile,
  listGrowth,
  missingItems,
  nonContentFiles,
  packFiles,
  parseList,
  toolDeclarationKeys,
} from "../agent-extension-code-gate.mjs";

const GATE_SCRIPT = fileURLToPath(new URL("../agent-extension-code-gate.mjs", import.meta.url));
const INGEST_SOURCE = fileURLToPath(new URL("../../../src/lib/git-native-agent-ingest.ts", import.meta.url));
const PLACES_SOURCE = fileURLToPath(new URL("../../../packages/agents/src/agent-source-dirs.ts", import.meta.url));
const SEED_SOURCE = fileURLToPath(new URL("../../extensions/build-required-oas-seed.mjs", import.meta.url));
const LIST_REL = join("scripts", "audit", "agent-extension-code-gate.baseline.json");
const ABSENT_SHA = "0123456789abcdef0123456789abcdef01234567";

function writeFile(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
const writeJson = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + "\n");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const commitAll = (cwd, msg) => {
  git(cwd, "add", "-A");
  git(cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "core.hooksPath=/dev/null", "commit", "-qm", msg, "--allow-empty");
  return git(cwd, "rev-parse", "HEAD").trim();
};
const plain = (...rels) => rels.map((rel) => ({ rel, link: false }));

const step = (id, data) => ({ component_type: "ApiNode", id, url: "{{host}}/api/agents/passthrough", data });
const callFlow = (id) => ({ flow: { nodes: [step(id, { tool: "extension_tool", input: { name: "read" } }), step("save", { tool: "objects_save" })] } });

const LOCKS = ["cinatra-required-extensions.lock.json", "cinatra-dev-extensions.lock.json"];
const packDir = (root, dir) => join(root, "extensions", "example-org", dir);

/** Point the lock entry of `name` at `sha`. */
function pin(root, name, sha) {
  for (const f of LOCKS) {
    const lock = JSON.parse(readFileSync(join(root, f), "utf8"));
    for (const p of lock.packages) if (p.packageName === name) p.resolvedSha = sha;
    writeJson(join(root, f), lock);
  }
}
/** Commit everything in the pack at `dir` and pin `name` to that commit. */
const repin = (root, dir, name) => pin(root, name, commitAll(packDir(root, dir), "change"));

/**
 * packs: dir -> { packageJson, files: { rel: text } }, each committed in its own
 * git repository and pinned to that commit; `pinned` defaults to every pack
 * (a pinned name with no pack is pinned to a commit nobody has).
 */
function makeRoot({ packs, pinned, list }) {
  const root = mkdtempSync(join(tmpdir(), "agent-extension-code-gate-"));
  const shas = new Map();
  for (const [dir, pack] of Object.entries(packs)) {
    const base = packDir(root, dir);
    writeJson(join(base, "package.json"), pack.packageJson);
    for (const [rel, text] of Object.entries(pack.files ?? {})) writeFile(join(base, rel), text);
    git(base, "init", "-q");
    shas.set(pack.packageJson.name, commitAll(base, "pin"));
  }
  const names = pinned ?? [...shas.keys()];
  const entry = (packageName) => ({ packageName, resolvedSha: shas.get(packageName) ?? ABSENT_SHA });
  const [first, ...rest] = names;
  writeJson(join(root, LOCKS[0]), { packages: first ? [entry(first)] : [] });
  writeJson(join(root, LOCKS[1]), { packages: rest.map(entry) });
  writeJson(join(root, "package.json"), { name: "fixture-root", cinatra: { devExtensions: Object.fromEntries(names.map((n) => [n, "https://example.invalid/x.git"])) } });
  writeFile(join(root, ".gitignore"), "extensions/\n");
  if (list) writeJson(join(root, LIST_REL), list);
  return root;
}

const packs = () => ({
  "read-agent": {
    packageJson: { name: "@example-org/read-agent", cinatra: { kind: "agent", tools: [{ name: "read", module: "./cinatra/tools/read.mjs" }] } },
    files: {
      "README.md": "#\n",
      "cinatra/oas.json": JSON.stringify(callFlow("read_text")),
      "cinatra/tools/read.mjs": "export {};\n",
      "skills/pick/SKILL.md": "# pick\n",
      "test/helper.mjs": "\n",
    },
  },
  "mail-connector": {
    packageJson: { name: "@example-org/mail-connector", cinatra: { kind: "connector" } },
    files: { "src/index.ts": "export {};\n" },
  },
});

const READ = "@example-org/read-agent";
const FLOW_KEY = `${READ} :: cinatra/oas.json`;
const recorded = () => ({
  nonContentFiles: { [READ]: { count: 2, items: ["cinatra/tools/read.mjs", "test/helper.mjs"] } },
  toolDeclarations: { [READ]: { count: 1, items: ["read"] } },
  extensionToolSteps: { [FLOW_KEY]: { count: 1, items: ["read_text -> read"] } },
  unreadableSteps: {},
});

function runGate(root, args = [], env = {}) {
  try {
    const out = execFileSync(process.execPath, [GATE_SCRIPT, ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GITHUB_BASE_REF: "", GITHUB_EVENT_NAME: "", AGENT_EXTENSION_CODE_BASE: "", ...env },
    });
    return { status: 0, out };
  } catch (e) {
    return { status: e.status, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function withRoot(opts, fn) {
  const root = makeRoot(opts);
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the content list is exactly the stated closed list", () => {
  assert.deepEqual([...CONTENT.extensions].sort(), [".csv", ".gif", ".ico", ".jpeg", ".jpg", ".json", ".md", ".png", ".svg", ".txt", ".webp", ".yaml", ".yml"]);
  assert.deepEqual([...CONTENT.names].sort(), [".editorconfig", ".gitattributes", ".gitignore", ".npmignore", "LICENSE", "NOTICE"]);
  assert.deepEqual([...CONTENT.topDirs], [".github"]);
});

test("files under a skills/ folder count like any other file: an agent pack ships no skill", () => {
  const files = plain("skills/pick/SKILL.md", "skills/pick/scripts/pick.py", "skills/pick/deep/run", "skills/top.mjs", "main.mjs");
  assert.deepEqual(nonContentFiles(files), ["main.mjs", "skills/pick/deep/run", "skills/pick/scripts/pick.py", "skills/top.mjs"]);
});

test("every file outside the content rule counts: source of any language, extension-less, config scripts, lock files", () => {
  const files = plain("bin/run", "cli", "a.rb", "vitest.config.ts", "pnpm-lock.yaml", "package-lock.json", ".npmrc", "x.d.ts", "Makefile", "LICENSE", ".github/workflows/ci.yml", ".github/check.mjs", "docs/a.md", "logo.PNG");
  assert.deepEqual(nonContentFiles(files), [".npmrc", "Makefile", "a.rb", "bin/run", "cli", "vitest.config.ts", "x.d.ts"]);
  assert.equal(isContent("nested/.github/x.mjs"), false);
});

test("a file is left out as a test only by its base name (*.test.<ext>, *.spec.<ext>); no folder name decides, .git aside", () => {
  for (const rel of ["src/a.test.ts", "a.spec.mjs", "test/x.test.mjs", "cinatra/tools/test/z.spec.sh"]) assert.equal(isTestFile(rel), true, rel);
  for (const rel of ["test/helper.mjs", "tests/a.mjs", "src/__tests__/a.ts", "cinatra/tools/test/delivery.mjs", "src/contest.ts", "a.test", "a.tests.mjs", "test.mjs"]) assert.equal(isTestFile(rel), false, rel);
  for (const rel of ["a/.git/hook.sh", ".git/x"]) assert.equal(isSkippedDir(rel), true, rel);
  for (const rel of ["node_modules/dep/index.js", "a/node_modules/b.js", ".git", "src/build/selection.ts", "dist/run.js", "out/x.js", "coverage/c.js", "venv/bin/x", ".env"]) assert.equal(isSkippedDir(rel), false, rel);
  const all = plain("test/x.test.mjs", "tests/a.spec.ts", "test/helper.mjs", "cinatra/tools/test/delivery.mjs", "src/build/selection.ts", "dist/run.js", "node_modules/dep/index.js", "a/.git/hook.sh");
  assert.deepEqual(nonContentFiles(all), ["cinatra/tools/test/delivery.mjs", "dist/run.js", "node_modules/dep/index.js", "src/build/selection.ts", "test/helper.mjs"]);
});

test("a symbolic link or a gitlink always counts, even with a content extension", () => {
  assert.deepEqual(nonContentFiles([{ rel: "skills/pick/SKILL.md", link: false }, { rel: "skills/pick/data.json", link: true }, { rel: "a.md", link: true }]), ["a.md", "skills/pick/data.json"]);
});

test("the file list is the pinned commit's tree: modes kept, links and gitlinks marked, the working tree and the index never read", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-extension-code-git-"));
  try {
    git(dir, "init", "-q");
    writeFile(join(dir, "a.mjs"), "\n");
    writeFile(join(dir, "kept.mjs"), "\n");
    symlinkSync("a.mjs", join(dir, "b.md"));
    git(dir, "add", "-A");
    git(dir, "update-index", "--add", "--cacheinfo", `160000,${ABSENT_SHA},vendored`);
    git(dir, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "x");
    const sha = git(dir, "rev-parse", "HEAD").trim();
    writeFile(join(dir, "untracked.mjs"), "\n");
    writeFile(join(dir, "staged.mjs"), "\n");
    git(dir, "add", "staged.mjs");
    git(dir, "rm", "-q", "--cached", "kept.mjs");
    const listed = packFiles(dir, sha, "git").map(({ rel, mode, link }) => `${mode} ${link} ${rel}`);
    assert.deepEqual(listed, ["100644 false a.mjs", "120000 true b.md", "100644 false kept.mjs", "160000 true vendored"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cinatra.tools: every value counts in every form", () => {
  assert.deepEqual(toolDeclarationKeys({ cinatra: { tools: [{ name: "b" }, { name: "a" }] } }), ["a", "b"]);
  assert.deepEqual(toolDeclarationKeys({ cinatra: { tools: [{ name: "a" }, { name: "a" }, "x", { name: "Bad" }] } }), ["a", "cinatra.tools[1]", "cinatra.tools[2]", "cinatra.tools[3]"]);
  assert.deepEqual(toolDeclarationKeys({ cinatra: { tools: { a: {}, b: {} } } }), ["cinatra.tools.a", "cinatra.tools.b"]);
  assert.deepEqual(toolDeclarationKeys({ cinatra: { tools: "x" } }), ["cinatra.tools"]);
  assert.deepEqual(toolDeclarationKeys({ cinatra: { tools: null } }), []);
  assert.deepEqual(toolDeclarationKeys({ cinatra: {} }), []);
});

test("flow steps: object or JSON-string data selecting extension_tool count, each object once, nested same ids twice", () => {
  const flow = callFlow("read_text");
  flow.flow.child = { inner: step("read_text", JSON.stringify({ tool: "extension_tool", input: { name: "deep" } })) };
  flow.flow.nodes.push({ id: "plain", data: { tool: "extension_tool" } });
  assert.deepEqual(flowSteps(flow), { steps: ["plain -> (no module name)", "read_text -> deep", "read_text -> read"], unreadable: [] });
});

test("unreadable step data: a fully or partly templated string, a templated or non-string tool, in ApiNode shape only", () => {
  const flow = {
    nodes: [
      step("full", "{{ payload }}"),
      step("part", '{"tool": "{{ t }}", "input": {{ x }}}'),
      step("tmpl", { tool: "{{ which }}" }),
      { http_method: "POST", id: "obj", data: { tool: { name: "x" } } },
      { id: "llm", data: "{{ not an api node }}" },
      { id: "llm2", data: { tool: "{{ t }}" } },
    ],
  };
  assert.deepEqual(flowSteps(flow), {
    steps: [],
    unreadable: ["full: data is a string that does not parse as JSON", "obj: data.tool is not a plain name", "part: data is a string that does not parse as JSON", "tmpl: data.tool is not a plain name"],
  });
});

test("the ratchet compares items as a multiset: a same-count substitution fails in every class, a duplicate fails, a gone item is stale; growth vs base and a removed class", () => {
  assert.deepEqual(missingItems(["a", "a", "b"], ["a", "c"]), ["a", "b"]);
  const list = parseList(JSON.stringify(recorded()));
  const found = parseList(JSON.stringify(recorded()));
  found.nonContentFiles[READ] = { count: 2, items: ["cinatra/tools/read.mjs", "src/runtime.ts"] };
  found.toolDeclarations[READ] = { count: 1, items: ["renamed"] };
  found.extensionToolSteps[FLOW_KEY] = { count: 1, items: ["read_text -> other"] };
  found.unreadableSteps[FLOW_KEY] = { count: 1, items: ["x: data.tool is not a plain name"] };
  const d = diffWithList(found, list);
  assert.deepEqual(d.nonContentFiles, { fresh: [`${READ}: src/runtime.ts`], stale: [`${READ}: test/helper.mjs`] });
  assert.deepEqual(d.toolDeclarations, { fresh: [`${READ}: renamed`], stale: [`${READ}: read`] });
  assert.deepEqual(d.extensionToolSteps, { fresh: [`${FLOW_KEY}: read_text -> other`], stale: [`${FLOW_KEY}: read_text -> read`] });
  assert.deepEqual(d.unreadableSteps, { fresh: [`${FLOW_KEY}: x: data.tool is not a plain name`], stale: [] });
  assert.deepEqual(listGrowth(list, found), [
    `[extensionToolSteps] ${FLOW_KEY}: read_text -> other (the base does not hold it)`,
    `[nonContentFiles] ${READ}: src/runtime.ts (the base does not hold it)`,
    `[toolDeclarations] ${READ}: renamed (the base does not hold it)`,
    `[unreadableSteps] ${FLOW_KEY}: x: data.tool is not a plain name (the base does not hold it)`,
  ]);
  const dup = parseList(JSON.stringify(recorded()));
  dup.extensionToolSteps[FLOW_KEY] = { count: 2, items: ["read_text -> read", "read_text -> read"] };
  assert.deepEqual(diffWithList(dup, list).extensionToolSteps.fresh, [`${FLOW_KEY}: read_text -> read`]);
  assert.deepEqual(listGrowth(list, dup), [`[extensionToolSteps] ${FLOW_KEY}: read_text -> read (the base does not hold it)`]);
  const rest = recorded();
  delete rest.nonContentFiles;
  assert.deepEqual(listGrowth(list, rest), ["[nonContentFiles] the class is removed (a class is never removed)"]);
});

test("a malformed list is refused; parsed maps carry no prototype", () => {
  assert.throws(() => parseList(JSON.stringify({ ...recorded(), unreadableSteps: undefined })), /unreadableSteps is missing/);
  assert.throws(() => parseList(JSON.stringify({ ...recorded(), toolDeclarations: { [READ]: ["read"] } })), /not \{ count, items \}/);
  assert.throws(() => parseList(JSON.stringify({ ...recorded(), toolDeclarations: { [READ]: { count: -1, items: [] } } })), /not \{ count, items \}/);
  assert.throws(() => parseList(JSON.stringify({ ...recorded(), toolDeclarations: { [READ]: { count: 2, items: ["read"] } } })), /not \{ count, items \}/);
  const parsed = parseList(JSON.stringify({ ...recorded(), toolDeclarations: { __proto__: { count: 1, items: ["a"] }, constructor: { count: 1, items: ["b"] } } }));
  assert.equal(Object.getPrototypeOf(parsed.toolDeclarations), null);
  assert.deepEqual(CLASSES, ["nonContentFiles", "toolDeclarations", "extensionToolSteps", "unreadableSteps", "uiDependencies", "rendererComponents", "hitlDeclarations", "jsxFiles"]);
});

test("the agent rule mirrors the product's discovery: the paths its two readers test, at a pack root", () => {
  const ingest = readFileSync(INGEST_SOURCE, "utf8");
  assert.ok(ingest.includes('const { DEFINITION_PLACES, classifyAgentSourceDirs } = await import("@cinatra-ai/agents/agent-source-dirs");'), "git-native-agent-ingest.ts no longer takes its definition places from agent-source-dirs: update AGENT_DEFINITION_PATHS");
  assert.ok(ingest.includes("const presentIn = (dir: string) => DEFINITION_PLACES.filter((place) => existsSync(join(dir, place)));"), "the ingest's discovery condition changed: update AGENT_DEFINITION_PATHS");
  const places = readFileSync(PLACES_SOURCE, "utf8");
  assert.ok(places.includes('export const DEFINITION_PLACES = ["cinatra/oas.json", "cinatra/agent.json", "agent.json"] as const;'), "agent-source-dirs.ts changed the places a definition is looked for: update AGENT_DEFINITION_PATHS");
  const seed = readFileSync(SEED_SOURCE, "utf8");
  assert.ok(seed.includes('const cinatraDir = path.join(slugDir, "cinatra");'), "build-required-oas-seed.mjs changed its cinatra/ folder: update AGENT_DEFINITION_PATHS");
  assert.ok(seed.includes('const oasPath = path.join(cinatraDir, "oas.json");\n      if (!existsSync(oasPath)) continue;'), "build-required-oas-seed.mjs changed its condition: update AGENT_DEFINITION_PATHS");
  // Since #4920 the product reads only cinatra/oas.json; an old definition file is reported, not loaded (the gate fails it, see below).
  assert.deepEqual([...AGENT_DEFINITION_PATHS], ["cinatra/oas.json"]);
  assert.equal(isAgentPack("agent", []), true);
  assert.equal(isAgentPack("agent", plain("cinatra/agent.json")), true);
  assert.equal(isAgentPack("connector", plain("src/index.ts", "cinatra/tools.json")), false);
  assert.equal(isAgentPack("connector", plain("cinatra/oas.json")), true);
  assert.equal(isAgentPack("artifact", plain("cinatra/agent.json")), false);
  assert.equal(isAgentPack("skill", plain("cinatra/oas.json/x")), true);
  assert.equal(isAgentPack("connector", plain("x/cinatra/oas.json", "oas.json", "agent.json")), false);
});

test("live: --report records each class; a pack of any kind that ships a flow the product discovers is judged as an agent", () => {
  const p = packs();
  p["mail-connector"].packageJson.cinatra.tools = [{ name: "send" }];
  p["mail-connector"].files["cinatra/oas.json"] = JSON.stringify(callFlow("send_now"));
  p["old-connector"] = { packageJson: { name: "@example-org/old-connector", cinatra: { kind: "connector" } }, files: { "cinatra/agent.json": "{}", "lib/x.mjs": "\n" } };
  p["plain-connector"] = { packageJson: { name: "@example-org/plain-connector", cinatra: { kind: "connector" } }, files: { "src/index.ts": "export {};\n", "cinatra/tools.json": "{}" } };
  withRoot({ packs: p }, (root) => {
    const res = runGate(root, ["--report"]);
    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /4 pinned extension\(s\) scanned; 3 nonContentFiles in 2 key\(s\), 2 toolDeclarations in 2 key\(s\), 2 extensionToolSteps in 2 key\(s\), 0 unreadableSteps/);
    assert.match(res.out, /@example-org\/mail-connector: 1\n    src\/index\.ts\n/);
    // #4920: a pack with only the old cinatra/agent.json is no agent; the report names the file to move.
    assert.match(res.out, /old definition file[^\n]*\n  @example-org\/old-connector: move cinatra\/agent\.json to cinatra\/oas\.json\n/);
    assert.doesNotMatch(res.out, /old-connector: 1|plain-connector: 1|SKILL\.md/);
  });
});

test("live: a pinned pack that holds an old definition file and no cinatra/oas.json fails and names the file to move (#4920)", () => {
  const p = packs();
  p["old-agent"] = { packageJson: { name: "@example-org/old-agent", cinatra: { kind: "agent" } }, files: { "cinatra/agent.json": "{}", "agent.json": "{}" } };
  withRoot({ packs: p, list: recorded() }, (root) => {
    const res = runGate(root);
    assert.equal(res.status, 1, res.out);
    assert.match(res.out, /\n  @example-org\/old-agent: move cinatra\/agent\.json and agent\.json to cinatra\/oas\.json\n/);
    assert.doesNotMatch(res.out, /OK —/);
    assert.equal(runGate(root, ["--write-baseline"]).status, 1);
  });
});

test("live: a connector that adds a flow fails with its program files until they are recorded", () => {
  withRoot({ packs: packs(), list: recorded() }, (root) => {
    assert.equal(runGate(root).status, 0);
    writeFile(join(packDir(root, "mail-connector"), "cinatra", "oas.json"), JSON.stringify({ nodes: [] }));
    repin(root, "mail-connector", "@example-org/mail-connector");
    const res = runGate(root);
    assert.equal(res.status, 1, res.out);
    assert.match(res.out, /\[nonContentFiles\] items the list does not hold[\s\S]*\+ @example-org\/mail-connector: src\/index\.ts/);
  });
});

test("live: a committed same-count substitution fails in every class once the pin moves to it", () => {
  const before = packs();
  before["read-agent"].files["cinatra/oas.json"] = JSON.stringify({ nodes: [...callFlow("read_text").flow.nodes, step("later", "{{ payload }}")] });
  const list = { ...recorded(), unreadableSteps: { [FLOW_KEY]: { count: 1, items: ["later: data is a string that does not parse as JSON"] } } };
  withRoot({ packs: before, list }, (root) => {
    assert.equal(runGate(root).status, 0, runGate(root).out);
    const pack = packDir(root, "read-agent");
    rmSync(join(pack, "test"), { recursive: true });
    writeFile(join(pack, "src", "runtime.ts"), "export {};\n");
    writeJson(join(pack, "package.json"), { name: READ, cinatra: { kind: "agent", tools: [{ name: "write" }] } });
    writeFile(join(pack, "cinatra", "oas.json"), JSON.stringify({ nodes: [step("read_text", { tool: "extension_tool", input: { name: "write" } }), step("other", { tool: "{{ t }}" })] }));
    repin(root, "read-agent", READ);
    const res = runGate(root);
    assert.equal(res.status, 1, res.out);
    assert.match(res.out, /\[nonContentFiles\] items the list does not hold[^\n]*\n  \+ @example-org\/read-agent: src\/runtime\.ts/);
    assert.match(res.out, /\[toolDeclarations\] items the list does not hold[^\n]*\n  \+ @example-org\/read-agent: write/);
    assert.match(res.out, /\[extensionToolSteps\] items the list does not hold[^\n]*\n  \+ @example-org\/read-agent :: cinatra\/oas\.json: read_text -> write/);
    assert.match(res.out, /\[unreadableSteps\] items the list does not hold[^\n]*\n  \+ @example-org\/read-agent :: cinatra\/oas\.json: other: data\.tool is not a plain name/);
    assert.doesNotMatch(res.out, /OK —/);
  });
});

test("live: a committed duplicate step fails at the pin", () => {
  withRoot({ packs: packs(), list: recorded() }, (root) => {
    const pack = packDir(root, "read-agent");
    const flow = callFlow("read_text");
    flow.flow.nodes.push(step("read_text", { tool: "extension_tool", input: { name: "read" } }));
    writeFile(join(pack, "cinatra", "oas.json"), JSON.stringify(flow));
    repin(root, "read-agent", READ);
    const res = runGate(root);
    assert.equal(res.status, 1, res.out);
    assert.match(res.out, /\+ @example-org\/read-agent :: cinatra\/oas\.json: read_text -> read/);
  });
});

test("live: the recorded list passes; one more committed and pinned file fails; a removed one is stale", () => {
  withRoot({ packs: packs(), list: recorded() }, (root) => {
    assert.equal(runGate(root).status, 0);
    const pack = packDir(root, "read-agent");
    writeFile(join(pack, "bin", "run"), "#!/bin/sh\n");
    repin(root, "read-agent", READ);
    const grown = runGate(root);
    assert.equal(grown.status, 1);
    assert.match(grown.out, /\[nonContentFiles\] items the list does not hold[\s\S]*\+ @example-org\/read-agent: bin\/run/);
    rmSync(join(pack, "bin"), { recursive: true });
    rmSync(join(pack, "test"), { recursive: true });
    repin(root, "read-agent", READ);
    const stale = runGate(root);
    assert.equal(stale.status, 1);
    assert.match(stale.out, /\[nonContentFiles\] recorded items that are gone[\s\S]*- @example-org\/read-agent: test\/helper\.mjs/);
  });
});

test("live: a file in the working tree or the index but not in the pinned commit is not counted; neither is a changed manifest on disk", () => {
  withRoot({ packs: packs(), list: recorded() }, (root) => {
    const pack = packDir(root, "read-agent");
    writeFile(join(pack, "src", "untracked.ts"), "export {};\n");
    writeFile(join(pack, "src", "staged.ts"), "export {};\n");
    git(pack, "add", "src/staged.ts");
    writeJson(join(pack, "package.json"), { name: READ, cinatra: { kind: "agent" } });
    writeFile(join(pack, "cinatra", "oas.json"), "{}");
    const res = runGate(root);
    assert.equal(res.status, 0, res.out);
  });
});

test("live: a file removed from the index but present at the pinned commit is still counted (no offset of a new file)", () => {
  withRoot({ packs: packs(), list: recorded() }, (root) => {
    const pack = packDir(root, "read-agent");
    git(pack, "rm", "-q", "--cached", "test/helper.mjs");
    writeFile(join(pack, "src", "new.ts"), "export {};\n");
    git(pack, "add", "src/new.ts");
    const res = runGate(root, ["--report"]);
    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /@example-org\/read-agent: 2\n    cinatra\/tools\/read\.mjs\n    test\/helper\.mjs\n/);
    assert.equal(runGate(root).status, 0);
  });
});

test("live: a *.test.mjs file is not counted; test/helper.mjs, cinatra/tools/test/delivery.mjs, src/build/selection.ts and a committed node_modules/dep/index.js each are", () => {
  withRoot({ packs: packs(), list: recorded() }, (root) => {
    writeFile(join(packDir(root, "read-agent"), "test", "x.test.mjs"), "\n");
    repin(root, "read-agent", READ);
    assert.equal(runGate(root).status, 0);
  });
  for (const rel of ["test/other.mjs", "cinatra/tools/test/delivery.mjs", "src/build/selection.ts", "node_modules/dep/index.js"]) {
    withRoot({ packs: packs(), list: recorded() }, (root) => {
      writeFile(join(packDir(root, "read-agent"), ...rel.split("/")), "export {};\n");
      git(packDir(root, "read-agent"), "add", "-f", "--", rel); // a global ignore file may list node_modules; the fixture commits it on purpose
      repin(root, "read-agent", READ);
      const grown = runGate(root);
      assert.equal(grown.status, 1, rel);
      assert.ok(grown.out.includes(`+ @example-org/read-agent: ${rel}`), rel);
    });
  }
});

test("live: a later commit with one more code file counts only once the lock moves to it", () => {
  withRoot({ packs: packs(), list: recorded() }, (root) => {
    const pack = packDir(root, "read-agent");
    writeFile(join(pack, "src", "later.ts"), "export {};\n");
    const later = commitAll(pack, "later");
    assert.equal(runGate(root).status, 0);
    pin(root, READ, later);
    const grown = runGate(root);
    assert.equal(grown.status, 1);
    assert.match(grown.out, /\+ @example-org\/read-agent: src\/later\.ts/);
  });
});

test("live: a lock at a commit the checkout lacks, a manifest naming another package at the pin, a pack without its own git checkout and an unpinned dev extension are scanner errors", () => {
  withRoot({ packs: packs(), list: recorded() }, (root) => {
    pin(root, READ, ABSENT_SHA);
    const res = runGate(root);
    assert.equal(res.status, 2, res.out);
    assert.match(res.out, /does not contain the pinned commit/);
  });
  withRoot({ packs: packs(), list: recorded() }, (root) => {
    const pack = packDir(root, "read-agent");
    writeJson(join(pack, "package.json"), { ...packs()["read-agent"].packageJson, name: "@example-org/other-agent" });
    repin(root, "read-agent", READ);
    const res = runGate(root);
    assert.equal(res.status, 2, res.out);
    assert.match(res.out, /names the package "@example-org\/other-agent", not @example-org\/read-agent/);
  });
  withRoot({ packs: packs(), list: recorded() }, (root) => {
    rmSync(join(packDir(root, "mail-connector"), ".git"), { recursive: true, force: true });
    const res = runGate(root);
    assert.equal(res.status, 2, res.out);
    assert.match(res.out, /is not a git checkout of its own/);
  });
  withRoot({ packs: packs(), list: recorded() }, (root) => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    pkg.cinatra.devExtensions["@example-org/unpinned-agent"] = "https://example.invalid/x.git";
    writeJson(join(root, "package.json"), pkg);
    const res = runGate(root);
    assert.equal(res.status, 2, res.out);
    assert.match(res.out, /which no lock pins to a commit/);
  });
});

test("live: an unreadable step is a counted finding of its own class", () => {
  const p = packs();
  p["read-agent"].files["cinatra/oas.json"] = JSON.stringify({ nodes: [...callFlow("read_text").flow.nodes, step("later", "{{ payload }}")] });
  withRoot({ packs: p, list: recorded() }, (root) => {
    const res = runGate(root);
    assert.equal(res.status, 1, res.out);
    assert.match(res.out, /\[unreadableSteps\] items the list does not hold[\s\S]*cinatra\/oas\.json: later: data is a string that does not parse as JSON/);
    assert.equal(runGate(root, [], {}).status, 1);
  });
});

test("live: scanner errors exit 2 — a missing pinned pack, an unreadable kind, a flow that does not parse, a malformed list", () => {
  withRoot({ packs: packs(), pinned: [READ, "@example-org/mail-connector", "@example-org/missing-agent"], list: recorded() }, (root) => {
    assert.match(runGate(root).out, /missing-agent is not checked out at extensions\/example-org\/missing-agent/);
    assert.equal(runGate(root).status, 2);
  });
  const p = packs();
  delete p["mail-connector"].packageJson.cinatra.kind;
  withRoot({ packs: p, list: recorded() }, (root) => assert.equal(runGate(root).status, 2));
  const q = packs();
  q["read-agent"].files["cinatra/config.json"] = "{ nope";
  withRoot({ packs: q, list: recorded() }, (root) => assert.equal(runGate(root).status, 2));
  withRoot({ packs: packs(), list: { ...recorded(), unreadableSteps: [] } }, (root) => assert.equal(runGate(root, ["--write-baseline"]).status, 2));
});

test("live: the writer refuses a missing list and growth (a substituted item too), removes gone items; --seed writes only a first list", () => {
  withRoot({ packs: packs() }, (root) => {
    assert.match(runGate(root, ["--write-baseline"]).out, /REFUSING --write-baseline — .* is missing/);
    mkdirSync(join(root, dirname(LIST_REL)), { recursive: true });
    assert.equal(runGate(root, ["--seed"]).status, 0);
    assert.equal(runGate(root).status, 0);
    assert.match(runGate(root, ["--seed"]).out, /REFUSING --seed/);
  });
  withRoot({ packs: packs(), list: { ...recorded(), nonContentFiles: {} } }, (root) => {
    const refused = runGate(root, ["--write-baseline"]);
    assert.equal(refused.status, 1);
    assert.match(refused.out, /the list only shrinks/);
  });
  withRoot({ packs: packs(), list: { ...recorded(), nonContentFiles: { [READ]: { count: 2, items: ["cinatra/tools/read.mjs", "src/gone.ts"] } } } }, (root) => {
    const refused = runGate(root, ["--write-baseline"]);
    assert.equal(refused.status, 1);
    assert.match(refused.out, /the list only shrinks:\n  \+ \[nonContentFiles\] @example-org\/read-agent: test\/helper\.mjs/);
  });
  withRoot({ packs: packs(), list: { ...recorded(), nonContentFiles: { [READ]: { count: 3, items: ["cinatra/tools/read.mjs", "src/gone.ts", "test/helper.mjs"] } } } }, (root) => {
    assert.equal(runGate(root).status, 1);
    assert.equal(runGate(root, ["--write-baseline"]).status, 0);
    assert.equal(runGate(root).status, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(root, LIST_REL), "utf8")).nonContentFiles[READ], recorded().nonContentFiles[READ]);
  });
});

test("live base guard: seeds once, an added item fails (a same-count substitution too), a removed item passes, a list-less base never reseeds", () => {
  withRoot({ packs: packs() }, (root) => {
    git(root, "init", "-q");
    const before = commitAll(root, "base without the gate");
    writeJson(join(root, LIST_REL), recorded());
    writeFile(join(root, "scripts", "audit", "agent-extension-code-gate.mjs"), "// the gate\n");
    const seed = runGate(root, [], { AGENT_EXTENSION_CODE_BASE: before });
    assert.equal(seed.status, 0, seed.out);
    assert.match(seed.out, /this change introduces the gate/);
    const seeded = commitAll(root, "seed");

    const pack = packDir(root, "read-agent");
    writeFile(join(pack, "src", "more.ts"), "export {};\n");
    repin(root, "read-agent", READ);
    writeJson(join(root, LIST_REL), { ...recorded(), nonContentFiles: { [READ]: { count: 3, items: ["cinatra/tools/read.mjs", "src/more.ts", "test/helper.mjs"] } } });
    const grew = runGate(root, [], { AGENT_EXTENSION_CODE_BASE: seeded });
    assert.equal(grew.status, 1);
    assert.match(grew.out, /GREW against the base[\s\S]*\[nonContentFiles\] @example-org\/read-agent: src\/more\.ts \(the base does not hold it\)/);

    rmSync(join(pack, "test"), { recursive: true });
    repin(root, "read-agent", READ);
    writeJson(join(root, LIST_REL), { ...recorded(), nonContentFiles: { [READ]: { count: 2, items: ["cinatra/tools/read.mjs", "src/more.ts"] } } });
    const swapped = runGate(root, [], { AGENT_EXTENSION_CODE_BASE: seeded });
    assert.equal(swapped.status, 1, swapped.out);
    assert.match(swapped.out, /GREW against the base[\s\S]*\[nonContentFiles\] @example-org\/read-agent: src\/more\.ts \(the base does not hold it\)/);

    rmSync(join(pack, "src"), { recursive: true });
    repin(root, "read-agent", READ);
    writeJson(join(root, LIST_REL), { ...recorded(), nonContentFiles: { [READ]: { count: 1, items: ["cinatra/tools/read.mjs"] } } });
    const shrank = runGate(root, [], { AGENT_EXTENSION_CODE_BASE: seeded });
    assert.equal(shrank.status, 0, shrank.out);

    rmSync(join(root, LIST_REL));
    const noList = commitAll(root, "list deleted");
    writeJson(join(root, LIST_REL), { ...recorded(), nonContentFiles: { [READ]: { count: 1, items: ["cinatra/tools/read.mjs"] } } });
    const reseed = runGate(root, [], { AGENT_EXTENSION_CODE_BASE: noList });
    assert.equal(reseed.status, 1, reseed.out);
    assert.match(reseed.out, /cannot be compared with the base/);
  });
});

// The role rule (cinatra#4532): an agent, skill or workflow pack declares no
// dependency on a UI package. Read through the module namespace so this file
// still loads where the gate has no such export.
const gate = await import(GATE_SCRIPT);
const BUNDLE_SOURCE = fileURLToPath(new URL("../../../packages/sdk-extensions/src/artifact-client-bundle.ts", import.meta.url));
const INVENTORY_SOURCE = fileURLToPath(new URL("../../extensions/inventory.mjs", import.meta.url));

const rolePacks = () => ({
  ...packs(),
  "pick-skill": { packageJson: { name: "@example-org/pick-skill", cinatra: { kind: "skill" }, peerDependencies: { react: "^19.0.0" } }, files: { "SKILL.md": "# pick\n" } },
  "post-workflow": { packageJson: { name: "@example-org/post-workflow", cinatra: { kind: "workflow" }, dependencies: { "ui-kit": "npm:@cinatra-ai/sdk-ui@^1.0.0" } } },
  "note-artifact": { packageJson: { name: "@example-org/note-artifact", cinatra: { kind: "artifact" }, peerDependencies: { react: "^19.0.0", "@cinatra-ai/sdk-ui": "^1.0.0" } } },
});
const SKILL = "@example-org/pick-skill";
const WORKFLOW = "@example-org/post-workflow";
const roleRecorded = () => ({
  ...recorded(),
  uiDependencies: {
    [SKILL]: { count: 1, items: ["peerDependencies: react"] },
    [WORKFLOW]: { count: 1, items: ["dependencies: ui-kit -> @cinatra-ai/sdk-ui"] },
  },
});

test("the role rule: a UI package is a key of dependencies, peerDependencies, optionalDependencies or devDependencies, an npm: or workspace: alias target there, or a bundled dependency name; look-alikes, overrides and resolutions are not; a field that is not an object is refused", () => {
  assert.equal(typeof gate.uiDependencyItems, "function", "the gate has no uiDependencyItems");
  assert.deepEqual([...gate.UI_PACKAGES], ["react", "react-dom", "@cinatra-ai/sdk-ui", "@cinatra-ai/design-primitives"]);
  assert.ok(readFileSync(BUNDLE_SOURCE, "utf8").includes('export const HOST_DESIGN_PRIMITIVES_MODULE = "@cinatra-ai/design-primitives";'), "the host-served primitives module changed its name: update UI_PACKAGES");
  const inventory = readFileSync(INVENTORY_SOURCE, "utf8");
  assert.ok(inventory.includes("...(pkg?.dependencies ?? {}),\n    ...(pkg?.peerDependencies ?? {}),\n    ...(pkg?.optionalDependencies ?? {}),"), "inventory.mjs changed the fields it reads as dependencies: update DEPENDENCY_FIELDS");
  assert.deepEqual(
    gate.uiDependencyItems({
      dependencies: { "react-dom": "^19.0.0", "ui-kit": "npm:@cinatra-ai/design-primitives@1.2.3", "@types/react": "^19.0.0", "react-markdown": "^9.0.0" },
      peerDependencies: { react: "*", "@cinatra-ai/sdk-ui": "^1.0.0", "my-react": "npm:react" },
      optionalDependencies: { "@cinatra-ai/sdk-extensions": "^1.0.0", "other-ui": "npm:@cinatra-ai/sdk-ui-extra@1" },
      devDependencies: { react: "^19.0.0", "dev-ui": "workspace:@cinatra-ai/sdk-ui@*", "local-ui": "file:../ui", "@cinatra-ai/sdk-extensions": "workspace:*" },
      bundleDependencies: ["react-dom", "lodash"],
      bundledDependencies: ["@cinatra-ai/design-primitives"],
      overrides: { react: "19.0.0" },
      resolutions: { "react-dom": "19.0.0" },
    }),
    [
      "bundleDependencies: react-dom",
      "bundledDependencies: @cinatra-ai/design-primitives",
      "dependencies: react-dom",
      "dependencies: ui-kit -> @cinatra-ai/design-primitives",
      "devDependencies: dev-ui -> @cinatra-ai/sdk-ui",
      "devDependencies: react",
      "peerDependencies: @cinatra-ai/sdk-ui",
      "peerDependencies: my-react -> react",
      "peerDependencies: react",
    ],
  );
  assert.deepEqual(gate.uiDependencyItems({ dependencies: null, devDependencies: { "@types/react": "1" }, bundleDependencies: true }), []);
  assert.throws(() => gate.uiDependencyItems({ devDependencies: ["react"] }), /devDependencies is not an object/);
  assert.throws(() => gate.uiDependencyItems({ bundleDependencies: "react" }), /bundleDependencies is not a list of names/);
  assert.throws(() => gate.uiDependencyItems({ bundledDependencies: [7] }), /bundledDependencies is not a list of names/);
  assert.throws(() => gate.uiDependencyItems({ peerDependencies: ["react"] }), /peerDependencies is not an object/);
  assert.throws(() => gate.uiDependencyItems({ dependencies: "react" }), /dependencies is not an object/);
  assert.equal(gate.isRolePack("skill", []), true);
  assert.equal(gate.isRolePack("workflow", []), true);
  assert.equal(gate.isRolePack("agent", []), true);
  assert.equal(gate.isRolePack("connector", plain("cinatra/oas.json")), true);
  assert.equal(gate.isRolePack("connector", plain("src/index.ts")), false);
  assert.equal(gate.isRolePack("artifact", []), false);
});

test("live: a UI dependency of a skill or workflow pack fails until it is recorded, a devDependency too; an artifact's is not counted; an unreadable dependency field is a scanner error", () => {
  const p = rolePacks();
  p["read-agent"].packageJson.devDependencies = { react: "^19.0.0" };
  withRoot({ packs: p, list: recorded() }, (root) => {
    const res = runGate(root);
    assert.equal(res.status, 1, res.out);
    assert.match(res.out, /\[uiDependencies\] items the list does not hold \(an agent, skill or workflow extension depends on no UI package\):\n  \+ @example-org\/pick-skill: peerDependencies: react\n  \+ @example-org\/post-workflow: dependencies: ui-kit -> @cinatra-ai\/sdk-ui\n  \+ @example-org\/read-agent: devDependencies: react\n/);
    assert.doesNotMatch(res.out, /note-artifact/);
    assert.match(runGate(root, ["--report"]).out, /3 uiDependencies in 3 key\(s\)/);
  });
  withRoot({ packs: rolePacks(), list: roleRecorded() }, (root) => {
    const ok = runGate(root);
    assert.equal(ok.status, 0, ok.out);
    const pack = packDir(root, "read-agent");
    const pkg = JSON.parse(readFileSync(join(pack, "package.json"), "utf8"));
    writeJson(join(pack, "package.json"), { ...pkg, peerDependencies: { "react-dom": "^19.0.0" } });
    repin(root, "read-agent", READ);
    const grew = runGate(root);
    assert.equal(grew.status, 1, grew.out);
    assert.match(grew.out, /\+ @example-org\/read-agent: peerDependencies: react-dom/);
  });
  const q = rolePacks();
  q["pick-skill"].packageJson.peerDependencies = ["react"];
  withRoot({ packs: q, list: roleRecorded() }, (root) => {
    const res = runGate(root);
    assert.equal(res.status, 2, res.out);
    assert.match(res.out, /pick-skill\/package\.json at the pinned commit [0-9a-f]{40}: peerDependencies is not an object/);
  });
});

test("live base guard: a base list without the uiDependencies class seeds it once; then a UI dependency the base does not hold fails, and a removed class fails", () => {
  withRoot({ packs: rolePacks(), list: recorded() }, (root) => {
    writeFile(join(root, "scripts", "audit", "agent-extension-code-gate.mjs"), "// the gate\n");
    git(root, "init", "-q");
    const before = commitAll(root, "base with a list of four classes");
    writeJson(join(root, LIST_REL), roleRecorded());
    const seed = runGate(root, [], { AGENT_EXTENSION_CODE_BASE: before });
    assert.equal(seed.status, 0, seed.out);
    const seeded = commitAll(root, "seed the class");

    const pack = packDir(root, "pick-skill");
    const pkg = JSON.parse(readFileSync(join(pack, "package.json"), "utf8"));
    writeJson(join(pack, "package.json"), { ...pkg, peerDependencies: { react: "^19.0.0", "react-dom": "^19.0.0" } });
    repin(root, "pick-skill", SKILL);
    writeJson(join(root, LIST_REL), { ...roleRecorded(), uiDependencies: { ...roleRecorded().uiDependencies, [SKILL]: { count: 2, items: ["peerDependencies: react", "peerDependencies: react-dom"] } } });
    const grew = runGate(root, [], { AGENT_EXTENSION_CODE_BASE: seeded });
    assert.equal(grew.status, 1, grew.out);
    assert.match(grew.out, /GREW against the base[\s\S]*\[uiDependencies\] @example-org\/pick-skill: peerDependencies: react-dom \(the base does not hold it\)/);

    writeJson(join(pack, "package.json"), pkg);
    repin(root, "pick-skill", SKILL);
    writeJson(join(root, LIST_REL), recorded());
    const removed = runGate(root, [], { AGENT_EXTENSION_CODE_BASE: seeded });
    assert.equal(removed.status, 1, removed.out);
    assert.match(removed.out, /\[uiDependencies\] the class is removed/);
  });
});

// The renderer rule (cinatra#4532): an agent, skill or workflow pack declares no
// `cinatra.fieldRenderers` entry that carries a `component`. Read through the
// module namespace (`gate`) so this file still loads where the gate has no such
// export.
const BINDING_KINDS_SOURCE = fileURLToPath(new URL("../../extensions/agent-binding-kinds.mjs", import.meta.url));
const product = await import(BINDING_KINDS_SOURCE);

const renderer = (id, extra = {}) => ({ id, kind: "final-list-review", priority: 50, ...extra });
const withComponent = (id) => renderer(id, { component: { entry: "./src/review.tsx", propsApiVersion: 1 } });
const declares = (fieldRenderers) => ({ name: "@example-org/p", cinatra: { kind: "agent", fieldRenderers } });

const rendererPacks = () => {
  const p = packs();
  p["read-agent"].packageJson.cinatra.fieldRenderers = [withComponent(`${READ}:review`), renderer(`${READ}:plain`)];
  p["pick-skill"] = { packageJson: { name: SKILL, cinatra: { kind: "skill", fieldRenderers: [withComponent(`${SKILL}:shape`)] } }, files: { "SKILL.md": "# pick\n" } };
  p["post-workflow"] = { packageJson: { name: WORKFLOW, cinatra: { kind: "workflow", fieldRenderers: [renderer(`${WORKFLOW}:cta`, { component: null })] } } };
  p["note-artifact"] = { packageJson: { name: "@example-org/note-artifact", cinatra: { kind: "artifact", fieldRenderers: [withComponent("@example-org/note-artifact:show")] } } };
  p["mail-connector"].packageJson.cinatra.fieldRenderers = [withComponent("@example-org/mail-connector:setup")];
  return p;
};
const CONNECTOR = "@example-org/mail-connector";
const rendererRecorded = () => ({
  ...recorded(),
  rendererComponents: {
    [READ]: { count: 1, items: [`fieldRenderers: ${READ}:review`] },
    [SKILL]: { count: 1, items: [`fieldRenderers: ${SKILL}:shape`] },
    [WORKFLOW]: { count: 1, items: [`fieldRenderers: ${WORKFLOW}:cta`] },
  },
  // The HITL rule (below) reads the fixture's skill, workflow and connector too.
  hitlDeclarations: {
    [CONNECTOR]: { count: 1, items: [`fieldRenderers: ${CONNECTOR}:setup`] },
    [SKILL]: { count: 1, items: [`fieldRenderers: ${SKILL}:shape`] },
    [WORKFLOW]: { count: 1, items: [`fieldRenderers: ${WORKFLOW}:cta`] },
  },
});

test("the renderer rule: an entry counts by its component key, in an array of plain objects as the product reads it; any other shape is refused and names the package", () => {
  assert.equal(typeof gate.rendererComponentItems, "function", "the gate has no rendererComponentItems");
  const A = "@example-org/a-agent:review";
  const B = "@example-org/a-agent:plain";
  const C = "@example-org/a-agent:confirm";
  const items = (fieldRenderers) => gate.rendererComponentItems(declares(fieldRenderers));

  // The product's reading is the reference: it takes a component from `component` of an object entry of an array.
  const good = [withComponent(C), renderer(B), withComponent(A)];
  const read = product.validateFieldRendererDeclarations("@example-org/p", good);
  assert.deepEqual(read.errors, []);
  assert.deepEqual(read.entries.filter((e) => e.component !== undefined).map((e) => `fieldRenderers: ${e.id}`).sort(), items(good));
  assert.deepEqual(items(good), [`fieldRenderers: ${C}`, `fieldRenderers: ${A}`]);
  assert.deepEqual(items([renderer(B), renderer(A, { params: { a: 1 }, midRunHitl: true })]), []);
  assert.deepEqual(items([withComponent(A), withComponent(A)]), [`fieldRenderers: ${A}`, `fieldRenderers: ${A}`]);

  // Only the key `component` is read: no other key name stands for a component.
  assert.deepEqual(items([renderer(A, { renderer: "./r.tsx", entry: "./r.tsx", module: "./r.tsx", components: [] })]), []);
  // A `component` the product rejects is no good declaration and is counted; an entry without a string id is named by its position.
  for (const component of [null, "./r.tsx", {}, [], 7, false]) {
    assert.notDeepEqual(product.validateFieldRendererDeclarations("@example-org/p", [renderer(A, { component })]).errors, []);
    assert.deepEqual(items([renderer(A, { component })]), [`fieldRenderers: ${A}`], JSON.stringify(component));
  }
  assert.deepEqual(items([renderer(B), { kind: "cta", component: { entry: "./r.tsx" } }]), ["fieldRenderers: [1]"]);

  // Absent and null declare nothing, as in the product.
  for (const value of [undefined, null, []]) {
    assert.deepEqual(product.validateFieldRendererDeclarations("@example-org/p", value), { entries: [], errors: [] });
    assert.deepEqual(items(value), []);
  }
  assert.deepEqual(gate.rendererComponentItems({ name: "@example-org/p" }), []);
  assert.deepEqual(gate.rendererComponentItems({ name: "@example-org/p", cinatra: { kind: "skill" } }), []);

  // A shape the product does not read fails closed, with the label that names the package.
  const LABEL = "@example-org/p (extensions/example-org/p/package.json at the pinned commit abc)";
  for (const value of ["react", 7, true, { [A]: { kind: "cta", priority: 1, component: { entry: "./r.tsx" } } }, { component: { entry: "./r.tsx" } }]) {
    assert.match(product.validateFieldRendererDeclarations("@example-org/p", value).errors[0], /must be an array/);
    assert.throws(() => gate.rendererComponentItems(declares(value), LABEL), (e) => e.message === `${LABEL}: cinatra.fieldRenderers is not an array`, JSON.stringify(value));
  }
  for (const entry of ["./r.tsx", null, 7, [], [{ component: { entry: "./r.tsx" } }]]) {
    assert.match(product.validateFieldRendererDeclarations("@example-org/p", [renderer(B), entry]).errors[0], /entry must be an object/);
    assert.throws(() => gate.rendererComponentItems(declares([renderer(B), entry]), LABEL), (e) => e.message === `${LABEL}: cinatra.fieldRenderers[1] is not an object`);
  }

  // The logic names no package: no key of the list appears in the gate's source.
  const source = readFileSync(GATE_SCRIPT, "utf8");
  for (const key of Object.keys(JSON.parse(readFileSync(join(dirname(GATE_SCRIPT), "agent-extension-code-gate.baseline.json"), "utf8")).rendererComponents ?? {})) assert.ok(!source.includes(key), key);
  assert.deepEqual(CLASSES.at(-3), "rendererComponents");
  assert.ok(gate.LATER_CLASSES.has("rendererComponents"));
});

test("live: a field renderer component of an agent, skill or workflow pack fails until it is recorded; an artifact's or a plain connector's is not counted; a declaration the product does not read is a scanner error that names the package", () => {
  withRoot({ packs: rendererPacks(), list: recorded() }, (root) => {
    const res = runGate(root);
    assert.equal(res.status, 1, res.out);
    assert.match(res.out, /\[rendererComponents\] items the list does not hold \(an agent, skill or workflow extension declares no field renderer component\):\n  \+ @example-org\/pick-skill: fieldRenderers: @example-org\/pick-skill:shape\n  \+ @example-org\/post-workflow: fieldRenderers: @example-org\/post-workflow:cta\n  \+ @example-org\/read-agent: fieldRenderers: @example-org\/read-agent:review\n/);
    // A connector's declaration is read by the HITL rule, not by this one: look at this class's lines only.
    assert.doesNotMatch(res.out.slice(0, res.out.indexOf("[hitlDeclarations]")), /note-artifact|mail-connector|read-agent:plain/);
    assert.match(runGate(root, ["--report"]).out, /3 rendererComponents in 3 key\(s\)/);
  });
  withRoot({ packs: rendererPacks(), list: rendererRecorded() }, (root) => {
    const ok = runGate(root);
    assert.equal(ok.status, 0, ok.out);

    const agent = packDir(root, "read-agent");
    const pkg = JSON.parse(readFileSync(join(agent, "package.json"), "utf8"));
    writeJson(join(agent, "package.json"), { ...pkg, cinatra: { ...pkg.cinatra, fieldRenderers: [...pkg.cinatra.fieldRenderers, withComponent(`${READ}:more`)] } });
    repin(root, "read-agent", READ);
    const grew = runGate(root);
    assert.equal(grew.status, 1, grew.out);
    assert.match(grew.out, /\+ @example-org\/read-agent: fieldRenderers: @example-org\/read-agent:more/);

    writeJson(join(agent, "package.json"), pkg);
    repin(root, "read-agent", READ);
    const skill = packDir(root, "pick-skill");
    const skillPkg = JSON.parse(readFileSync(join(skill, "package.json"), "utf8"));
    writeJson(join(skill, "package.json"), { ...skillPkg, cinatra: { kind: "skill" } });
    repin(root, "pick-skill", SKILL);
    const stale = runGate(root);
    assert.equal(stale.status, 1, stale.out);
    assert.match(stale.out, /\[rendererComponents\] recorded items that are gone[^\n]*\n  - @example-org\/pick-skill: fieldRenderers: @example-org\/pick-skill:shape/);

    writeJson(join(skill, "package.json"), skillPkg);
    for (const bad of ["./renderer.tsx", { [`${SKILL}:shape`]: withComponent(`${SKILL}:shape`) }, [withComponent(`${SKILL}:shape`), "./renderer.tsx"]]) {
      writeJson(join(skill, "package.json"), { ...skillPkg, cinatra: { kind: "skill", fieldRenderers: bad } });
      repin(root, "pick-skill", SKILL);
      const res = runGate(root);
      assert.equal(res.status, 2, res.out);
      assert.match(res.out, /@example-org\/pick-skill \(extensions\/example-org\/pick-skill\/package\.json at the pinned commit [0-9a-f]{40}\): cinatra\.fieldRenderers(?: is not an array|\[1\] is not an object)/);
    }
  });
});

test("live base guard: a base list without the rendererComponents class seeds it once; then a component the base does not hold fails, and a removed class fails", () => {
  withRoot({ packs: rendererPacks(), list: recorded() }, (root) => {
    writeFile(join(root, "scripts", "audit", "agent-extension-code-gate.mjs"), "// the gate\n");
    git(root, "init", "-q");
    const before = commitAll(root, "base with a list of four classes");
    writeJson(join(root, LIST_REL), rendererRecorded());
    const seed = runGate(root, [], { AGENT_EXTENSION_CODE_BASE: before });
    assert.equal(seed.status, 0, seed.out);
    const seeded = commitAll(root, "seed the class");

    const pack = packDir(root, "pick-skill");
    const pkg = JSON.parse(readFileSync(join(pack, "package.json"), "utf8"));
    writeJson(join(pack, "package.json"), { ...pkg, cinatra: { ...pkg.cinatra, fieldRenderers: [...pkg.cinatra.fieldRenderers, withComponent(`${SKILL}:more`)] } });
    repin(root, "pick-skill", SKILL);
    const skillItems = { count: 2, items: [`fieldRenderers: ${SKILL}:more`, `fieldRenderers: ${SKILL}:shape`] };
    writeJson(join(root, LIST_REL), { ...rendererRecorded(), rendererComponents: { ...rendererRecorded().rendererComponents, [SKILL]: skillItems }, hitlDeclarations: { ...rendererRecorded().hitlDeclarations, [SKILL]: skillItems } });
    const grew = runGate(root, [], { AGENT_EXTENSION_CODE_BASE: seeded });
    assert.equal(grew.status, 1, grew.out);
    assert.match(grew.out, /GREW against the base[\s\S]*\[rendererComponents\] @example-org\/pick-skill: fieldRenderers: @example-org\/pick-skill:more \(the base does not hold it\)/);

    writeJson(join(pack, "package.json"), pkg);
    repin(root, "pick-skill", SKILL);
    writeJson(join(root, LIST_REL), recorded());
    const removed = runGate(root, [], { AGENT_EXTENSION_CODE_BASE: seeded });
    assert.equal(removed.status, 1, removed.out);
    assert.match(removed.out, /\[rendererComponents\] the class is removed/);
  });
});

// The HITL rule (cinatra#4532): a pack of kind skill, workflow or connector that
// is not an agent declares no `cinatra.fieldRenderers` entry; an agent and an
// artifact pack (ruling 133-1: it hosts agents' HITL renderers) are not read by
// it, and the shapes are read for every pinned pack. Read through the module
// namespace (`gate`) so this file still loads where the gate has no such export.
const NOTE_ARTIFACT = "@example-org/note-artifact";
const OAS_CONNECTOR = "@example-org/oas-connector";

const hitlPacks = () => {
  const p = packs();
  p["read-agent"].packageJson.cinatra.fieldRenderers = [renderer(`${READ}:review`), renderer(`${READ}:edit`)];
  p["note-artifact"] = { packageJson: { name: NOTE_ARTIFACT, cinatra: { kind: "artifact", fieldRenderers: [withComponent(`${NOTE_ARTIFACT}:show`), renderer(`${NOTE_ARTIFACT}:plain`)] } } };
  p["pick-skill"] = { packageJson: { name: SKILL, cinatra: { kind: "skill", fieldRenderers: [renderer(`${SKILL}:shape`)] } }, files: { "SKILL.md": "# pick\n" } };
  p["post-workflow"] = { packageJson: { name: WORKFLOW, cinatra: { kind: "workflow", fieldRenderers: [withComponent(`${WORKFLOW}:cta`), renderer(`${WORKFLOW}:plain`)] } } };
  // A connector with an entry that has an id, and one that has none (named by its position).
  p["mail-connector"].packageJson.cinatra.fieldRenderers = [renderer(`${CONNECTOR}:setup`), { kind: "cta", priority: 5 }];
  // A connector whose pinned tree holds `cinatra/oas.json` is an agent by the check's own rule: not read.
  p["oas-connector"] = { packageJson: { name: OAS_CONNECTOR, cinatra: { kind: "connector", fieldRenderers: [renderer(`${OAS_CONNECTOR}:review`)] } }, files: { "cinatra/oas.json": "{}\n" } };
  return p;
};
const hitlRecorded = () => ({
  ...recorded(),
  rendererComponents: { [WORKFLOW]: { count: 1, items: [`fieldRenderers: ${WORKFLOW}:cta`] } },
  hitlDeclarations: {
    [CONNECTOR]: { count: 2, items: [`fieldRenderers: ${CONNECTOR}:setup`, "fieldRenderers: [1]"] },
    [SKILL]: { count: 1, items: [`fieldRenderers: ${SKILL}:shape`] },
    [WORKFLOW]: { count: 2, items: [`fieldRenderers: ${WORKFLOW}:cta`, `fieldRenderers: ${WORKFLOW}:plain`] },
  },
});

test("the HITL rule: a skill, workflow or connector that is no agent declares no entry, each entry is one item keyed as in the renderer rule; an agent and an artifact are not read; a shape the product does not read is refused and names the package", () => {
  assert.equal(typeof gate.hitlDeclarationItems, "function", "the gate has no hitlDeclarationItems");
  assert.equal(typeof gate.isHitlFreePack, "function", "the gate has no isHitlFreePack");
  assert.deepEqual([...gate.HITL_FREE_KINDS], ["skill", "workflow", "connector"]);

  // The kind is decided as the check decides it: the manifest kind, and the agent rule on the pinned tree.
  for (const kind of ["skill", "workflow", "connector"]) {
    assert.equal(gate.isHitlFreePack(kind, []), true, kind);
    assert.equal(gate.isHitlFreePack(kind, plain("src/index.ts", "SKILL.md")), true, kind);
    assert.equal(gate.isHitlFreePack(kind, plain("cinatra/oas.json")), false, `${kind} with a definition file is an agent`);
  }
  for (const kind of ["agent", "artifact", "registry"]) assert.equal(gate.isHitlFreePack(kind, []), false, kind);
  assert.equal(gate.isHitlFreePack("artifact", plain("cinatra/oas.json")), false);
  assert.equal(isAgentPack("connector", plain("cinatra/oas.json")), true);

  const A = "@example-org/a-connector:setup";
  const B = "@example-org/a-connector:chat";
  const items = (fieldRenderers) => gate.hitlDeclarationItems(declares(fieldRenderers));

  // The product's reading is the reference: every entry it reads is one item, with or without a component.
  const good = [withComponent(B), renderer(A), renderer(A, { params: { a: 1 }, midRunHitl: true })];
  const read = product.validateFieldRendererDeclarations("@example-org/p", good);
  assert.deepEqual(read.errors, []);
  assert.deepEqual(read.entries.map((e) => `fieldRenderers: ${e.id}`).sort(), items(good));
  assert.deepEqual(items(good), [`fieldRenderers: ${B}`, `fieldRenderers: ${A}`, `fieldRenderers: ${A}`].sort());
  // An entry without a string id is named by its position, as in the renderer rule.
  assert.deepEqual(items([renderer(A), { kind: "cta", priority: 1 }]), [`fieldRenderers: ${A}`, "fieldRenderers: [1]"].sort());
  assert.deepEqual(items([{ id: 7, kind: "cta" }]), ["fieldRenderers: [0]"]);

  // Absent, null and an empty array declare nothing, as in the product.
  for (const value of [undefined, null, []]) {
    assert.deepEqual(product.validateFieldRendererDeclarations("@example-org/p", value), { entries: [], errors: [] });
    assert.deepEqual(items(value), []);
  }
  assert.deepEqual(gate.hitlDeclarationItems({ name: "@example-org/p" }), []);
  assert.deepEqual(gate.hitlDeclarationItems({ name: "@example-org/p", cinatra: { kind: "connector" } }), []);

  // A shape the product does not read fails closed, with the label that names the package.
  const LABEL = "@example-org/p (extensions/example-org/p/package.json at the pinned commit abc)";
  for (const value of ["react", 7, true, { [A]: { kind: "cta", priority: 1 } }, { id: A }]) {
    assert.match(product.validateFieldRendererDeclarations("@example-org/p", value).errors[0], /must be an array/);
    assert.throws(() => gate.hitlDeclarationItems(declares(value), LABEL), (e) => e.message === `${LABEL}: cinatra.fieldRenderers is not an array`, JSON.stringify(value));
  }
  for (const entry of ["./r.tsx", null, 7, [], [renderer(A)]]) {
    assert.match(product.validateFieldRendererDeclarations("@example-org/p", [renderer(B), entry]).errors[0], /entry must be an object/);
    assert.throws(() => gate.hitlDeclarationItems(declares([renderer(B), entry]), LABEL), (e) => e.message === `${LABEL}: cinatra.fieldRenderers[1] is not an object`);
  }

  // The logic names no package: no key of the list appears in the gate's source.
  const source = readFileSync(GATE_SCRIPT, "utf8");
  for (const key of Object.keys(JSON.parse(readFileSync(join(dirname(GATE_SCRIPT), "agent-extension-code-gate.baseline.json"), "utf8")).hitlDeclarations ?? {})) assert.ok(!source.includes(key), key);
  assert.deepEqual(CLASSES.at(-2), "hitlDeclarations");
  assert.ok(gate.LATER_CLASSES.has("hitlDeclarations"));
});

test("live: an entry of a skill, workflow or connector pack fails until it is recorded; an agent's, an artifact's and a connector-with-definition's is not counted; both rules apply to a component of a skill or workflow; a shape the product does not read is a scanner error that names the package, in any kind", () => {
  withRoot({ packs: hitlPacks(), list: recorded() }, (root) => {
    const res = runGate(root);
    assert.equal(res.status, 1, res.out);
    assert.match(res.out, /\[hitlDeclarations\] items the list does not hold \(a skill, workflow or connector extension declares no HITL field renderer\):\n  \+ @example-org\/mail-connector: fieldRenderers: @example-org\/mail-connector:setup\n  \+ @example-org\/mail-connector: fieldRenderers: \[1\]\n  \+ @example-org\/pick-skill: fieldRenderers: @example-org\/pick-skill:shape\n  \+ @example-org\/post-workflow: fieldRenderers: @example-org\/post-workflow:cta\n  \+ @example-org\/post-workflow: fieldRenderers: @example-org\/post-workflow:plain\n/);
    assert.doesNotMatch(res.out.slice(res.out.indexOf("[hitlDeclarations]")), /read-agent|note-artifact|oas-connector/);
    // A component of the workflow is one finding of the renderer rule and one of this rule.
    assert.match(res.out, /\[rendererComponents\] items the list does not hold[^\n]*\n  \+ @example-org\/post-workflow: fieldRenderers: @example-org\/post-workflow:cta\n/);
    assert.match(runGate(root, ["--report"]).out, /5 hitlDeclarations in 3 key\(s\)/);
  });
  withRoot({ packs: hitlPacks(), list: hitlRecorded() }, (root) => {
    const ok = runGate(root);
    assert.equal(ok.status, 0, ok.out);

    // More entries in an agent or an artifact pack are not this rule's concern.
    for (const [dir, name] of [["read-agent", READ], ["note-artifact", NOTE_ARTIFACT]]) {
      const pack = packDir(root, dir);
      const pkg = JSON.parse(readFileSync(join(pack, "package.json"), "utf8"));
      writeJson(join(pack, "package.json"), { ...pkg, cinatra: { ...pkg.cinatra, fieldRenderers: [...pkg.cinatra.fieldRenderers, renderer(`${name}:more`)] } });
      repin(root, dir, name);
      const res = runGate(root);
      assert.equal(res.status, 0, res.out);
    }

    const skill = packDir(root, "pick-skill");
    const skillPkg = JSON.parse(readFileSync(join(skill, "package.json"), "utf8"));
    writeJson(join(skill, "package.json"), { ...skillPkg, cinatra: { ...skillPkg.cinatra, fieldRenderers: [...skillPkg.cinatra.fieldRenderers, renderer(`${SKILL}:more`)] } });
    repin(root, "pick-skill", SKILL);
    const grew = runGate(root);
    assert.equal(grew.status, 1, grew.out);
    assert.match(grew.out, /\+ @example-org\/pick-skill: fieldRenderers: @example-org\/pick-skill:more/);

    writeJson(join(skill, "package.json"), { ...skillPkg, cinatra: { kind: "skill", fieldRenderers: [] } });
    repin(root, "pick-skill", SKILL);
    const stale = runGate(root);
    assert.equal(stale.status, 1, stale.out);
    assert.match(stale.out, /\[hitlDeclarations\] recorded items that are gone[^\n]*\n  - @example-org\/pick-skill: fieldRenderers: @example-org\/pick-skill:shape/);
    writeJson(join(skill, "package.json"), skillPkg);
    repin(root, "pick-skill", SKILL);
    assert.equal(runGate(root).status, 0);

    // The shape is read for every pinned pack, whatever its kind: a value the product does not read names the package.
    for (const [dir, name] of [["pick-skill", SKILL], ["read-agent", READ], ["note-artifact", NOTE_ARTIFACT], ["mail-connector", CONNECTOR]]) {
      const pack = packDir(root, dir);
      const pkg = JSON.parse(readFileSync(join(pack, "package.json"), "utf8"));
      for (const bad of ["./renderer.tsx", { [`${name}:x`]: renderer(`${name}:x`) }, [renderer(`${name}:x`), "./renderer.tsx"]]) {
        writeJson(join(pack, "package.json"), { ...pkg, cinatra: { ...pkg.cinatra, fieldRenderers: bad } });
        repin(root, dir, name);
        const res = runGate(root);
        assert.equal(res.status, 2, `${name} ${res.out}`);
        assert.match(res.out, new RegExp(`${name} \\(extensions/example-org/${dir}/package\\.json at the pinned commit [0-9a-f]{40}\\): cinatra\\.fieldRenderers(?: is not an array|\\[1\\] is not an object)`));
      }
      writeJson(join(pack, "package.json"), pkg);
      repin(root, dir, name);
      assert.equal(runGate(root).status, 0);
    }
  });
  // A pack of a kind no rule reads is read for its shape too.
  const other = hitlPacks();
  other["misc-pack"] = { packageJson: { name: "@example-org/misc-pack", cinatra: { kind: "registry", fieldRenderers: "./renderer.tsx" } } };
  withRoot({ packs: other, list: hitlRecorded() }, (root) => {
    const res = runGate(root);
    assert.equal(res.status, 2, res.out);
    assert.match(res.out, /@example-org\/misc-pack \(extensions\/example-org\/misc-pack\/package\.json at the pinned commit [0-9a-f]{40}\): cinatra\.fieldRenderers is not an array/);
  });
});

test("live base guard: a base list without the hitlDeclarations class seeds it once; then an entry the base does not hold fails, and a removed class fails", () => {
  withRoot({ packs: hitlPacks(), list: recorded() }, (root) => {
    writeFile(join(root, "scripts", "audit", "agent-extension-code-gate.mjs"), "// the gate\n");
    git(root, "init", "-q");
    const before = commitAll(root, "base with a list of four classes");
    writeJson(join(root, LIST_REL), hitlRecorded());
    const seed = runGate(root, [], { AGENT_EXTENSION_CODE_BASE: before });
    assert.equal(seed.status, 0, seed.out);
    const seeded = commitAll(root, "seed the classes");

    const pack = packDir(root, "mail-connector");
    const pkg = JSON.parse(readFileSync(join(pack, "package.json"), "utf8"));
    writeJson(join(pack, "package.json"), { ...pkg, cinatra: { ...pkg.cinatra, fieldRenderers: [...pkg.cinatra.fieldRenderers, renderer(`${CONNECTOR}:more`)] } });
    repin(root, "mail-connector", CONNECTOR);
    const held = hitlRecorded().hitlDeclarations;
    writeJson(join(root, LIST_REL), { ...hitlRecorded(), hitlDeclarations: { ...held, [CONNECTOR]: { count: 3, items: [`fieldRenderers: ${CONNECTOR}:more`, ...held[CONNECTOR].items] } } });
    const grew = runGate(root, [], { AGENT_EXTENSION_CODE_BASE: seeded });
    assert.equal(grew.status, 1, grew.out);
    assert.match(grew.out, /GREW against the base[\s\S]*\[hitlDeclarations\] @example-org\/mail-connector: fieldRenderers: @example-org\/mail-connector:more \(the base does not hold it\)/);

    writeJson(join(pack, "package.json"), pkg);
    repin(root, "mail-connector", CONNECTOR);
    const { hitlDeclarations: _dropped, ...withoutClass } = hitlRecorded();
    writeJson(join(root, LIST_REL), withoutClass);
    const removed = runGate(root, [], { AGENT_EXTENSION_CODE_BASE: seeded });
    assert.equal(removed.status, 1, removed.out);
    assert.match(removed.out, /\[hitlDeclarations\] the class is removed/);
  });
});

// The screen-file rule (cinatra#4532): an agent, skill or workflow pack (the role
// packs, decided as the other rules decide) ships no `.tsx` or `.jsx` file. What
// a pack ships is its manifest `files` list, read by `isInScope` of the
// conformance gate; a pack without a usable list is read by its tracked files.
// Test files are left out by the check's own `isTestFile`. Read through the
// module namespaces so this file still loads where the gate has no such export.
const CONFORMANCE_SOURCE = fileURLToPath(new URL("../../extensions/conformance-gate.mjs", import.meta.url));
const conformance = await import(CONFORMANCE_SOURCE);

const KEPT_SKILL = "@example-org/kept-skill";
const SCREEN = "export {};\n";

const jsxPacks = () => {
  const p = packs();
  p["read-agent"].packageJson.files = ["cinatra", "src", "!src/__tests__"];
  Object.assign(p["read-agent"].files, {
    "src/review.tsx": SCREEN,
    "src/legacy-view.JSX": SCREEN,
    "src/__tests__/review.test.tsx": SCREEN,
    "tests/doubles/stub.tsx": SCREEN,
  });
  p["pick-skill"] = {
    packageJson: { name: SKILL, cinatra: { kind: "skill" }, files: ["SKILL.md", "src"] },
    files: { "SKILL.md": "# pick\n", "src/panel.tsx": SCREEN, "src/panel.test.tsx": SCREEN, "src/panel-helper.ts": SCREEN, "scripts/preview.tsx": SCREEN },
  };
  // No `files` list: every tracked file is read, and no folder name decides.
  p["post-workflow"] = { packageJson: { name: WORKFLOW, cinatra: { kind: "workflow" } }, files: { "lib/step-view.jsx": SCREEN, "lib/step-view.spec.jsx": SCREEN, "tests/helper.tsx": SCREEN } };
  p["kept-skill"] = { packageJson: { name: KEPT_SKILL, cinatra: { kind: "skill" }, files: ["SKILL.md"] }, files: { "SKILL.md": "# kept\n", "dev/preview.tsx": SCREEN } };
  p["note-artifact"] = { packageJson: { name: NOTE_ARTIFACT, cinatra: { kind: "artifact" }, files: ["src"] }, files: { "src/renderers/detail.tsx": SCREEN } };
  p["mail-connector"].files["src/setup-page.tsx"] = SCREEN;
  // A connector whose pinned tree holds `cinatra/oas.json` is an agent by the check's own rule.
  p["oas-connector"] = { packageJson: { name: OAS_CONNECTOR, cinatra: { kind: "connector" }, files: ["src", "cinatra"] }, files: { "cinatra/oas.json": "{}\n", "src/view.tsx": SCREEN } };
  return p;
};
const jsxRecorded = () => ({
  ...recorded(),
  // Class 1 reads every non-test file of an agent, so a screen of an agent is an item of both classes.
  nonContentFiles: {
    [OAS_CONNECTOR]: { count: 1, items: ["src/view.tsx"] },
    [READ]: { count: 5, items: ["cinatra/tools/read.mjs", "src/legacy-view.JSX", "src/review.tsx", "test/helper.mjs", "tests/doubles/stub.tsx"] },
  },
  jsxFiles: {
    [OAS_CONNECTOR]: { count: 1, items: ["src/view.tsx"] },
    [SKILL]: { count: 1, items: ["src/panel.tsx"] },
    [WORKFLOW]: { count: 2, items: ["lib/step-view.jsx", "tests/helper.tsx"] },
    [READ]: { count: 2, items: ["src/legacy-view.JSX", "src/review.tsx"] },
  },
});
const jsxWithoutClass = () => {
  const { jsxFiles: _dropped, ...rest } = jsxRecorded();
  return rest;
};

test("the screen-file rule: a .tsx or .jsx file is an item unless the check's own test-file predicate leaves it out; a pack ships what its files list says, as the conformance gate reads it, and every tracked file without a usable list; a list that cannot be read where it decides is refused", () => {
  assert.equal(typeof gate.jsxFileItems, "function", "the gate has no jsxFileItems");
  assert.equal(typeof conformance.isInScope, "function", "conformance-gate.mjs does not export isInScope");
  const LABEL = "@example-org/p (extensions/example-org/p/package.json at the pinned commit abc)";
  const items = (rels, files) => gate.jsxFileItems(plain(...rels), files === undefined ? { name: "@example-org/p" } : { name: "@example-org/p", files }, LABEL);

  // The file kinds: `.tsx` and `.jsx`, whatever the case of the extension; no other kind.
  assert.deepEqual(items(["a.tsx", "b.jsx", "C.TSX", "d.JSX", "e.ts", "f.js", "g.mjs", "h.mdx", "i.tsx.map", "j.json", "tsx", "src/k.jsx.ts"]), ["C.TSX", "a.tsx", "b.jsx", "d.JSX"]);

  // Test files: by the check's own predicate, the base name only; a folder never decides.
  const names = ["a.test.tsx", "b.spec.jsx", "src/c.test.tsx", "src/__tests__/d.spec.jsx", "tests/helper.tsx", "__tests__/e.tsx", "test/f.jsx", "g.tests.tsx", "h.test.tsx.bak"];
  for (const n of names) assert.deepEqual(items([n]), isTestFile(n) || !/\.(?:tsx|jsx)$/i.test(n) ? [] : [n], n);
  assert.deepEqual(items(names), ["__tests__/e.tsx", "g.tests.tsx", "test/f.jsx", "tests/helper.tsx"]);

  // "Ships": the manifest files list, read by the conformance gate's own `isInScope`.
  const tree = ["src/a.tsx", "src/__tests__/b.tsx", "cinatra/c.jsx", "lib/d.tsx", "tests/e.tsx", "root.tsx", "src2/f.tsx", "src/deep/g.jsx"];
  for (const files of [["src"], ["src", "!src/__tests__"], ["src/", "!src/__tests__/"], ["cinatra", "lib"], ["root.tsx"], ["src/a.tsx"], ["src", "!src"]]) {
    assert.deepEqual(items(tree, files), tree.filter((r) => conformance.isInScope(r, files)).sort(), JSON.stringify(files));
  }
  assert.deepEqual(items(tree, ["src", "!src/__tests__"]), ["src/a.tsx", "src/deep/g.jsx"]);
  assert.deepEqual(items(tree, ["cinatra", "lib"]), ["cinatra/c.jsx", "lib/d.tsx"]);
  // Without a usable list npm packs every file that is not ignored: every tracked file is read.
  for (const files of [undefined, null, []]) assert.deepEqual(items(tree, files), [...tree].sort(), JSON.stringify(files));

  // Fail closed where the list decides: a value that is no list of paths, and an entry the plain-path reading cannot place.
  for (const files of ["src", 7, true, { src: true }, ["src", 7], ["src", null], [["src"]]]) {
    assert.throws(() => items(tree, files), (e) => e instanceof Error && e.message === `${LABEL}: files is not a list of paths`, JSON.stringify(files));
  }
  for (const odd of ["src/**/*.tsx", "*.tsx", "!src/*.test.tsx", "src/{a,b}", "src/[ab]", "src/(a)", "src/a?", "./src", "/src", ".", "..", "../x", "!", "", "a\\b", "!!src"]) {
    assert.throws(() => items(tree, ["src", odd]), (e) => e instanceof Error && e.message === `${LABEL}: files entry ${JSON.stringify(odd)} is not a plain relative path; the check cannot tell what it ships`, JSON.stringify(odd));
  }
  // ... and only there: the list is not read for a pack that holds no file this rule could count.
  assert.deepEqual(items(["src/a.ts", "a.test.tsx", "README.md"], ["src/**"]), []);
  assert.deepEqual(items([], 7), []);

  // The logic names no package: no key of the list appears in the gate's source.
  const source = readFileSync(GATE_SCRIPT, "utf8");
  for (const key of Object.keys(JSON.parse(readFileSync(join(dirname(GATE_SCRIPT), "agent-extension-code-gate.baseline.json"), "utf8")).jsxFiles ?? {})) assert.ok(!source.includes(key), key);
  assert.deepEqual(CLASSES.at(-1), "jsxFiles");
  assert.ok(gate.LATER_CLASSES.has("jsxFiles"));
});

test("live: a .tsx or .jsx file that an agent, skill or workflow pack ships fails until it is recorded; a test file, a file outside the files list and another kind's screens are not counted; the pinned commit decides", () => {
  withRoot({ packs: jsxPacks(), list: recorded() }, (root) => {
    const res = runGate(root);
    assert.equal(res.status, 1, res.out);
    // Class 1 already reads every non-test file of an agent: a screen of an agent is in both classes.
    assert.match(res.out, /\[nonContentFiles\] items the list does not hold[^\n]*\n(?:  [+-] [^\n]*\n)*  \+ @example-org\/read-agent: src\/review\.tsx\n/);
    const own = res.out.slice(res.out.indexOf("[jsxFiles]"));
    assert.match(own, /^\[jsxFiles\] items the list does not hold \(an agent, skill or workflow extension ships no \.tsx or \.jsx file\):\n  \+ @example-org\/oas-connector: src\/view\.tsx\n  \+ @example-org\/pick-skill: src\/panel\.tsx\n  \+ @example-org\/post-workflow: lib\/step-view\.jsx\n  \+ @example-org\/post-workflow: tests\/helper\.tsx\n  \+ @example-org\/read-agent: src\/legacy-view\.JSX\n  \+ @example-org\/read-agent: src\/review\.tsx\n\[agent-extension-code\] Fix:/);
    assert.doesNotMatch(own, /kept-skill|note-artifact|mail-connector|test\.tsx|spec\.jsx|stub\.tsx|preview\.tsx|panel-helper/);
    assert.match(runGate(root, ["--report"]).out, /6 jsxFiles in 4 key\(s\)/);
  });
  withRoot({ packs: jsxPacks(), list: jsxRecorded() }, (root) => {
    const ok = runGate(root);
    assert.equal(ok.status, 0, ok.out);
    assert.match(ok.out, /6 jsxFiles in 4 key\(s\)/);

    // Another kind's screens, and a test file or a file outside the files list of a role pack, are not counted.
    for (const [dir, rel] of [["note-artifact", "src/renderers/list-row.tsx"], ["mail-connector", "src/widget.jsx"], ["pick-skill", "src/more.test.jsx"], ["pick-skill", "docs/more.tsx"], ["read-agent", "src/__tests__/more.spec.tsx"]]) {
      writeFile(join(packDir(root, dir), rel), SCREEN);
    }
    repin(root, "note-artifact", NOTE_ARTIFACT);
    repin(root, "mail-connector", CONNECTOR);
    repin(root, "pick-skill", SKILL);
    const kept = runGate(root);
    // The agent's own new test file is no item of class 1 or of this class.
    repin(root, "read-agent", READ);
    assert.equal(runGate(root).status, 0, `${kept.out}\n${runGate(root).out}`);

    // The manifest decides what ships: once its list names the folder, the file ships.
    const skill = packDir(root, "pick-skill");
    const pkg = JSON.parse(readFileSync(join(skill, "package.json"), "utf8"));
    writeJson(join(skill, "package.json"), { ...pkg, files: [...pkg.files, "docs"] });
    repin(root, "pick-skill", SKILL);
    const shipped = runGate(root);
    assert.equal(shipped.status, 1, shipped.out);
    assert.match(shipped.out, /\+ @example-org\/pick-skill: docs\/more\.tsx\n/);
    writeJson(join(skill, "package.json"), pkg);
    repin(root, "pick-skill", SKILL);
    assert.equal(runGate(root).status, 0);

    // The pinned commit decides: a later commit counts only once the lock moves to it, and the working tree and the index are never read.
    writeFile(join(skill, "src/late.tsx"), SCREEN);
    git(skill, "add", "-A");
    const late = runGate(root);
    assert.equal(late.status, 0, late.out);
    const lateSha = commitAll(skill, "late");
    assert.equal(runGate(root).status, 0);
    pin(root, SKILL, lateSha);
    const moved = runGate(root);
    assert.equal(moved.status, 1, moved.out);
    assert.match(moved.out, /\[jsxFiles\] items the list does not hold[^\n]*\n  \+ @example-org\/pick-skill: src\/late\.tsx\n/);

    // A file in a nested folder is one more item; a recorded item that is gone is stale.
    rmSync(join(skill, "src/late.tsx"));
    writeFile(join(skill, "src/deep/panel.tsx"), SCREEN);
    repin(root, "pick-skill", SKILL);
    assert.match(runGate(root).out, /\+ @example-org\/pick-skill: src\/deep\/panel\.tsx\n/);
    rmSync(join(skill, "src/deep"), { recursive: true });
    rmSync(join(skill, "src/panel.tsx"));
    repin(root, "pick-skill", SKILL);
    const stale = runGate(root);
    assert.equal(stale.status, 1, stale.out);
    assert.match(stale.out, /\[jsxFiles\] recorded items that are gone[^\n]*\n  - @example-org\/pick-skill: src\/panel\.tsx\n/);
  });
});

test("live: a role pack whose file list cannot be read, and a files list that cannot be read where it decides, are scanner errors that name the package; a list nothing depends on is not read", () => {
  const BAD = ["src", { src: true }, ["src", 7], ["src/**/*.tsx"], ["src", "!src/*.test.tsx"], ["./src"], ["/src"], ["src", "{a,b}"]];
  withRoot({ packs: jsxPacks(), list: jsxRecorded() }, (root) => {
    assert.equal(runGate(root).status, 0);
    // A pinned role pack whose tree cannot be read is never skipped.
    const kept = packDir(root, "kept-skill");
    const tree = git(kept, "rev-parse", "HEAD^{tree}").trim();
    rmSync(join(kept, ".git", "objects", tree.slice(0, 2), tree.slice(2)));
    const unreadable = runGate(root);
    assert.equal(unreadable.status, 2, unreadable.out);
    assert.match(unreadable.out, /scanner error: git ls-tree of [0-9a-f]{40} failed in extensions\/example-org\/kept-skill: /);
  });
  withRoot({ packs: jsxPacks(), list: jsxRecorded() }, (root) => {
    for (const [dir, name] of [["pick-skill", SKILL], ["read-agent", READ], ["oas-connector", OAS_CONNECTOR]]) {
      const pack = packDir(root, dir);
      const pkg = JSON.parse(readFileSync(join(pack, "package.json"), "utf8"));
      for (const files of BAD) {
        writeJson(join(pack, "package.json"), { ...pkg, files });
        repin(root, dir, name);
        const res = runGate(root);
        assert.equal(res.status, 2, `${name} ${JSON.stringify(files)} ${res.out}`);
        assert.match(res.out, new RegExp(`${name} \\(extensions/example-org/${dir}/package\\.json at the pinned commit [0-9a-f]{40}\\): files(?: is not a list of paths| entry "[^"]*" is not a plain relative path; the check cannot tell what it ships)`));
      }
      writeJson(join(pack, "package.json"), pkg);
      repin(root, dir, name);
      assert.equal(runGate(root).status, 0);
    }
    // Other kinds are not judged, so their files list is not read.
    for (const [dir, name] of [["note-artifact", NOTE_ARTIFACT], ["mail-connector", CONNECTOR]]) {
      const pack = packDir(root, dir);
      const pkg = JSON.parse(readFileSync(join(pack, "package.json"), "utf8"));
      writeJson(join(pack, "package.json"), { ...pkg, files: ["src/**"] });
      repin(root, dir, name);
      assert.equal(runGate(root).status, 0);
    }
    // A role pack with no file this rule could count is not read for its files list: the stale item is the only failure.
    const skill = packDir(root, "pick-skill");
    const skillPkg = JSON.parse(readFileSync(join(skill, "package.json"), "utf8"));
    writeJson(join(skill, "package.json"), { ...skillPkg, files: ["src/**"] });
    rmSync(join(skill, "src/panel.tsx"));
    rmSync(join(skill, "scripts"), { recursive: true });
    repin(root, "pick-skill", SKILL);
    const res = runGate(root);
    assert.equal(res.status, 1, res.out);
    assert.doesNotMatch(res.out, /scanner error/);
    assert.match(res.out, /\[jsxFiles\] recorded items that are gone[^\n]*\n  - @example-org\/pick-skill: src\/panel\.tsx\n/);
  });
});

test("live base guard: a base list without the jsxFiles class seeds it once; then a file the base does not hold fails, and a removed class fails", () => {
  withRoot({ packs: jsxPacks(), list: jsxWithoutClass() }, (root) => {
    writeFile(join(root, "scripts", "audit", "agent-extension-code-gate.mjs"), "// the gate\n");
    git(root, "init", "-q");
    const before = commitAll(root, "base with a list of seven classes");
    writeJson(join(root, LIST_REL), jsxRecorded());
    const seed = runGate(root, [], { AGENT_EXTENSION_CODE_BASE: before });
    assert.equal(seed.status, 0, seed.out);
    assert.match(seed.out, /6 jsxFiles in 4 key\(s\)/);
    const seeded = commitAll(root, "seed the class");

    const pack = packDir(root, "pick-skill");
    writeFile(join(pack, "src/more.tsx"), SCREEN);
    repin(root, "pick-skill", SKILL);
    writeJson(join(root, LIST_REL), { ...jsxRecorded(), jsxFiles: { ...jsxRecorded().jsxFiles, [SKILL]: { count: 2, items: ["src/more.tsx", "src/panel.tsx"] } } });
    const grew = runGate(root, [], { AGENT_EXTENSION_CODE_BASE: seeded });
    assert.equal(grew.status, 1, grew.out);
    assert.match(grew.out, /GREW against the base[\s\S]*\[jsxFiles\] @example-org\/pick-skill: src\/more\.tsx \(the base does not hold it\)/);

    rmSync(join(pack, "src/more.tsx"));
    repin(root, "pick-skill", SKILL);
    writeJson(join(root, LIST_REL), jsxWithoutClass());
    const removed = runGate(root, [], { AGENT_EXTENSION_CODE_BASE: seeded });
    assert.equal(removed.status, 1, removed.out);
    assert.match(removed.out, /\[jsxFiles\] the class is removed/);
  });
});
