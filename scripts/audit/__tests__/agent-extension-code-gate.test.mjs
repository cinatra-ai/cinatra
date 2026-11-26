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
  listGrowth,
  missingItems,
  nonContentFiles,
  packFiles,
  parseList,
  toolDeclarationKeys,
} from "../agent-extension-code-gate.mjs";

const GATE_SCRIPT = fileURLToPath(new URL("../agent-extension-code-gate.mjs", import.meta.url));
const INGEST_SOURCE = fileURLToPath(new URL("../../../src/lib/git-native-agent-ingest.ts", import.meta.url));
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
  git(cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", msg, "--allow-empty");
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
      "test/read.test.mjs": "\n",
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
  nonContentFiles: { [READ]: { count: 2, items: ["cinatra/tools/read.mjs", "test/read.test.mjs"] } },
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
  assert.deepEqual(d.nonContentFiles, { fresh: [`${READ}: src/runtime.ts`], stale: [`${READ}: test/read.test.mjs`] });
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
  assert.deepEqual(CLASSES, ["nonContentFiles", "toolDeclarations", "extensionToolSteps", "unreadableSteps"]);
});

test("the agent rule mirrors the product's discovery: the paths its two readers test, at a pack root", () => {
  const ingest = readFileSync(INGEST_SOURCE, "utf8");
  assert.ok(ingest.includes('const oasJson = join(entryPath, sub.name, "cinatra", "oas.json");'), "git-native-agent-ingest.ts no longer probes <vendor>/<slug>/cinatra/oas.json: update AGENT_DEFINITION_PATHS");
  assert.ok(ingest.includes('const transitional = join(entryPath, sub.name, "cinatra", "agent.json");'), "git-native-agent-ingest.ts no longer probes <vendor>/<slug>/cinatra/agent.json: update AGENT_DEFINITION_PATHS");
  assert.ok(ingest.includes("const target = existsSync(oasJson)\n          ? oasJson\n          : existsSync(transitional)\n            ? transitional\n            : null;"), "the ingest's discovery condition changed: update AGENT_DEFINITION_PATHS");
  const seed = readFileSync(SEED_SOURCE, "utf8");
  assert.ok(seed.includes('const cinatraDir = path.join(slugDir, "cinatra");'), "build-required-oas-seed.mjs changed its cinatra/ folder: update AGENT_DEFINITION_PATHS");
  assert.ok(seed.includes('const oasPath = path.join(cinatraDir, "oas.json");\n      if (!existsSync(oasPath)) continue;'), "build-required-oas-seed.mjs changed its condition: update AGENT_DEFINITION_PATHS");
  assert.deepEqual([...AGENT_DEFINITION_PATHS], ["cinatra/agent.json", "cinatra/oas.json"]);
  assert.equal(isAgentPack("agent", []), true);
  assert.equal(isAgentPack("connector", plain("src/index.ts", "cinatra/tools.json")), false);
  assert.equal(isAgentPack("connector", plain("cinatra/oas.json")), true);
  assert.equal(isAgentPack("artifact", plain("cinatra/agent.json")), true);
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
    assert.match(res.out, /4 pinned extension\(s\) scanned; 4 nonContentFiles in 3 key\(s\), 2 toolDeclarations in 2 key\(s\), 2 extensionToolSteps in 2 key\(s\), 0 unreadableSteps/);
    assert.match(res.out, /@example-org\/mail-connector: 1\n    src\/index\.ts\n/);
    assert.match(res.out, /@example-org\/old-connector: 1\n    lib\/x\.mjs\n/);
    assert.doesNotMatch(res.out, /plain-connector: 1|SKILL\.md/);
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
    assert.match(stale.out, /\[nonContentFiles\] recorded items that are gone[\s\S]*- @example-org\/read-agent: test\/read\.test\.mjs/);
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
    git(pack, "rm", "-q", "--cached", "test/read.test.mjs");
    writeFile(join(pack, "src", "new.ts"), "export {};\n");
    git(pack, "add", "src/new.ts");
    const res = runGate(root, ["--report"]);
    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /@example-org\/read-agent: 2\n    cinatra\/tools\/read\.mjs\n    test\/read\.test\.mjs\n/);
    assert.equal(runGate(root).status, 0);
  });
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
    assert.match(refused.out, /the list only shrinks:\n  \+ \[nonContentFiles\] @example-org\/read-agent: test\/read\.test\.mjs/);
  });
  withRoot({ packs: packs(), list: { ...recorded(), nonContentFiles: { [READ]: { count: 3, items: ["cinatra/tools/read.mjs", "src/gone.ts", "test/read.test.mjs"] } } } }, (root) => {
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
    writeJson(join(root, LIST_REL), { ...recorded(), nonContentFiles: { [READ]: { count: 3, items: ["cinatra/tools/read.mjs", "src/more.ts", "test/read.test.mjs"] } } });
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
