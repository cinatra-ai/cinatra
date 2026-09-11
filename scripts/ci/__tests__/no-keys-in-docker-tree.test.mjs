// The "no provider credential under docker/" gate.
//
// Runs in the root Vitest suite like its siblings in this directory
// (`scripts/ci/__tests__/**` is in the root include), while the GATE ITSELF
// stays dependency-free (node + git only) so the pure-node `gates` job can run
// it without an install.
//
// THE POINT OF THE FIXTURE. Every negative case here is built in a TEMPORARY
// tree, never in the real checkout: a test that proves "a credential under
// docker/ is caught" by writing one into the repository would be writing the
// defect it is testing for. So the fixture tree gets a `docker/` of its own and
// the gate is pointed at it with `--root`.
//
// Both halves of the gate are pinned, because the difference is the whole
// design: the TRACKED half is what CI can see, and the ON-DISK half is what
// catches the actual defect — `.graphiti.env` was gitignored, so a
// tracked-tree-only gate (product-tree-hygiene's deliberate design) would have
// reported a clean tree while the credential sat there.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MAX_FILE_BYTES,
  SKIPPED_DIRS,
  findHits,
  onDiskPaths,
  scanFiles,
} from "../no-keys-in-docker-tree.mjs";
import { containsKeyShapedValue, findKeyShapedMatches } from "../../lib/key-shaped-values.mjs";
import {
  GRAPHITI_NO_LLM_SENTINEL,
  HOSTED_EMBEDDER_MODEL,
  LOCAL_EMBEDDER_API_URL,
  LOCAL_EMBEDDER_MODEL,
  LOCAL_EMBEDDER_PLACEHOLDER_KEY,
} from "../../gen-graphiti-env.mjs";

const GATE = fileURLToPath(new URL("../no-keys-in-docker-tree.mjs", import.meta.url));
const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");

// Obviously fake, and long enough to clear the pattern's false-positive floor.
// Assembled from fragments so this literal is not itself a key-shaped string in
// the repository — the gate scans docker/ only, but a scanner that ever widens
// should not trip over its own test.
const FAKE_OPENAI_KEY = ["sk", "fake", "not", "a", "real", "credential", "0001"].join("-");
const FAKE_ANTHROPIC_KEY = ["sk", "ant", "fake", "not", "a", "real", "credential"].join("-");

let root;

/** Write `contents` to `rel` inside the fixture tree, creating parents. */
function write(rel, contents) {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents);
  return full;
}

/** Run the gate as a process against the fixture tree. */
function runGate(extraArgs = []) {
  return spawnSync("node", [GATE, "--root", root, ...extraArgs], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 30_000,
  });
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "no-keys-docker-"));
  mkdirSync(path.join(root, "docker"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the key shape itself", () => {
  it("matches the provider prefixes this repo's own redactors strip", () => {
    for (const sample of [
      FAKE_OPENAI_KEY,
      FAKE_ANTHROPIC_KEY,
      `sk_live_${"a".repeat(20)}`,
      `ghp_${"A".repeat(24)}`,
      `github_pat_${"A".repeat(24)}`,
      `npm_${"a".repeat(24)}`,
      `AKIA${"ABCDEFGH12345678"}`,
      `AIza${"A".repeat(20)}`,
    ]) {
      expect(containsKeyShapedValue(sample), sample.slice(0, 8)).toBe(true);
    }
  });

  it("does NOT match the named non-credentials this product deliberately ships", () => {
    // Both live in docker/graphiti/config.yaml and in the generated container
    // env. They are named for what they mean precisely so they never read as a
    // credential — here and to a human. If either ever starts matching, the
    // gate turns into noise and gets disabled, which is how a gate dies.
    // Taken from the generator itself, not retyped: these are the exact strings
    // that reach a container, and a copy here could drift into a value that
    // does match while the real one still does not.
    for (const sample of [
      GRAPHITI_NO_LLM_SENTINEL,
      LOCAL_EMBEDDER_PLACEHOLDER_KEY,
      LOCAL_EMBEDDER_API_URL,
      LOCAL_EMBEDDER_MODEL,
      HOSTED_EMBEDDER_MODEL,
      "https://api.openai.com/v1",
      "# the sk- prefix in prose is not a key",
    ]) {
      expect(containsKeyShapedValue(sample), sample).toBe(false);
    }
  });

  it("reports the SHAPE and never the matched text", () => {
    const matches = findKeyShapedMatches(`OPENAI_API_KEY=${FAKE_OPENAI_KEY}\n`);
    expect(matches.length).toBeGreaterThan(0);
    for (const match of matches) {
      expect(Object.keys(match).sort()).toEqual(["index", "label", "length"]);
      expect(JSON.stringify(match)).not.toContain("fake");
    }
  });
});

describe("a clean docker tree", () => {
  it("passes, and says how many files it read", () => {
    write("docker/graphiti/config.yaml", `llm:\n  api_key: ${GRAPHITI_NO_LLM_SENTINEL}\n`);
    write("docker/graphiti/Dockerfile", "FROM python:3.13-slim\n");
    const result = runGate();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("0 key-shaped values");
  });
});

describe("a generated, gitignored credential under docker/", () => {
  it("FAILS the gate — the half a tracked-tree scan cannot see", () => {
    // This is the defect, reproduced exactly: the file the bring-up used to
    // write, at the path it used to write it to, with the shape it used to
    // write in clear.
    write("docker/graphiti/.graphiti.env", `OPENAI_API_KEY=${FAKE_OPENAI_KEY}\n`);
    const result = runGate();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docker/graphiti/.graphiti.env:1");
    expect(result.stderr).toContain("openai-api-key");
  });

  it("names the file and the line but never prints the credential", () => {
    write("docker/graphiti/.graphiti.env", `# header\nOPENAI_API_KEY=${FAKE_OPENAI_KEY}\n`);
    const result = runGate();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(":2");
    expect(`${result.stdout}${result.stderr}`).not.toContain(FAKE_OPENAI_KEY);
  });

  it("catches an Anthropic key on its own variable", () => {
    write("docker/graphiti/.graphiti.env", `LLM__PROVIDERS__ANTHROPIC__API_KEY=${FAKE_ANTHROPIC_KEY}\n`);
    const result = runGate();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("anthropic-api-key");
  });

  it("catches one nested anywhere under docker/, not just in graphiti/", () => {
    write("docker/some-future-service/.env", `TOKEN=ghp_${"A".repeat(24)}\n`);
    const { hits } = findHits(root);
    expect(hits.map((h) => h.path)).toEqual(["docker/some-future-service/.env"]);
  });

  it("emits machine-readable findings for --json", () => {
    write("docker/graphiti/.graphiti.env", `OPENAI_API_KEY=${FAKE_OPENAI_KEY}\n`);
    const result = runGate(["--json"]);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hits).toEqual([
      { path: "docker/graphiti/.graphiti.env", line: 1, label: "openai-api-key" },
    ]);
  });
});

describe("what the walk deliberately skips", () => {
  it("does not walk a dependency install (that is the hygiene gate's finding)", () => {
    write(`docker/graphiti/node_modules/pkg/index.js`, `const k = "${FAKE_OPENAI_KEY}";\n`);
    expect(SKIPPED_DIRS.has("node_modules")).toBe(true);
    expect(onDiskPaths(root)).toEqual([]);
    expect(findHits(root).hits).toEqual([]);
  });

  it("does not scan a binary blob", () => {
    write("docker/graphiti/model.bin", Buffer.concat([Buffer.from([0]), Buffer.from(FAKE_OPENAI_KEY)]));
    expect(scanFiles(root, ["docker/graphiti/model.bin"])).toEqual([]);
    expect(MAX_FILE_BYTES).toBeGreaterThan(0);
  });

  // …but "too big to read whole" must never mean "not scanned at all": a file
  // large enough to skip would otherwise be a documented way past this gate.
  // The first MAX_FILE_BYTES are read and scanned.
  it("STILL scans a file too large to read whole", () => {
    write(
      "docker/graphiti/huge.log",
      `LLM__PROVIDERS__OPENAI__API_KEY=${FAKE_OPENAI_KEY}\n${"x".repeat(MAX_FILE_BYTES + 1024)}\n`,
    );
    expect(scanFiles(root, ["docker/graphiti/huge.log"])).toEqual([
      { path: "docker/graphiti/huge.log", line: 1, label: "openai-api-key" },
    ]);
  });
});

describe("the shapes stay in step with the runtime redactors", () => {
  // The module says a value scrubbed at runtime is also refused at rest. That
  // is only true while the floors agree: `src/lib/setup-readiness-saga.ts` and
  // `src/lib/assistant-runtime/ports.ts` redact `sk-ant-…`, `AIza…` and `ya29.…`
  // with NO length floor, so a floor here would refuse less than the runtime
  // hides — a short credential accepted at rest and scrubbed in the log that
  // reports it.
  it("refuses a SHORT anthropic or google credential, as the redactors do", () => {
    expect(containsKeyShapedValue("sk-ant-abc123")).toBe(true);
    expect(containsKeyShapedValue("AIzaShort1")).toBe(true);
    expect(containsKeyShapedValue("ya29.short")).toBe(true);
    // …and still not on prose that merely contains the letters.
    expect(containsKeyShapedValue("a disk-ant colony")).toBe(false);
  });
});

describe("the real checkout", () => {
  it("is clean — no key-shaped value under docker/, tracked or generated", () => {
    // The positive case, run against THIS repository. It is what makes the gate
    // a statement about the product and not only about its fixtures, and it is
    // what would have been red before the generator stopped writing the key.
    const { hits } = findHits(REPO_ROOT);
    expect(hits.map((h) => `${h.path}:${h.line} ${h.label}`)).toEqual([]);
  });
});
