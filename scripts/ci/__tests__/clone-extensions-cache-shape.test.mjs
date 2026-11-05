// cinatra#4484: the SHAPE of the clone-extensions composite action, read from
// the real file. The sync itself is unit-tested in packages/cli; this guards
// what a unit test cannot reach: the pinned run restores extensions/ from a
// cache keyed exactly on the runner OS and BOTH committed lock files, only
// when extensions/ does not exist (the absence step's own script is run
// here), fetches at depth 1 with a low-speed limit (on the shared sync step,
// so the head canary has it too), saves the cache with the same actions/cache
// release right after a sync that missed it (before any install can add to
// the tree), and needs no token. The `if:` expressions are compared whole, so
// an `&&` turned into `||` fails; GitHub's evaluation of them is not run here.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const ACTION_PATH = path.join(REPO_ROOT, ".github", "actions", "clone-extensions", "action.yml");
const action = fs.readFileSync(ACTION_PATH, "utf8");

// The steps of the composite action, each as its own text block, in order.
const stepsText = action.split(/\n {2}steps:\n/)[1] ?? "";
const steps = stepsText.split(/\n(?= {4}- )/).filter((s) => s.trim().startsWith("- "));
const indexOf = (re) => steps.findIndex((s) => re.test(s));

const treeAt = indexOf(/id: companion-tree\n/);
const restoreAt = indexOf(/uses: actions\/cache\/restore@/);
const syncAt = indexOf(/sync-dev-extensions\.mjs --pinned/);
const saveAt = indexOf(/uses: actions\/cache\/save@/);

const ifOf = (step) => step?.match(/\n {6}if: (.+)/)?.[1] ?? null;
const usesOf = (step) => step?.match(/uses: (actions\/cache\/(?:restore|save))@([0-9a-f]{40}) # (v\d+\.\d+\.\d+)/) ?? null;

// The `run: |` block of a step, dedented.
function runScriptOf(step) {
  const lines = (step ?? "").split("\n");
  const at = lines.findIndex((l) => /^ {6}run: \|$/.test(l));
  if (at < 0) return null;
  const body = [];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() !== "" && !l.startsWith("        ")) break;
    body.push(l.slice(8));
  }
  return body.join("\n");
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "clone-extensions-shape-"));
afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

// Runs the absence step's own script in a new directory that `prepare` fills.
function absentOutput(name, prepare) {
  const dir = path.join(work, name);
  fs.mkdirSync(dir);
  prepare(dir);
  const out = path.join(work, `${name}.out`);
  fs.writeFileSync(out, "");
  execFileSync("bash", ["-c", runScriptOf(steps[treeAt]) ?? "exit 3"], {
    cwd: dir,
    env: { ...process.env, GITHUB_OUTPUT: out },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return fs.readFileSync(out, "utf8");
}

describe("clone-extensions action — the pinned companion cache (cinatra#4484)", () => {
  it("reads the tree, restores extensions/ before the sync and saves it after, in that order", () => {
    expect(treeAt).toBeGreaterThanOrEqual(0);
    expect(restoreAt).toBeGreaterThan(treeAt);
    expect(syncAt).toBeGreaterThan(restoreAt);
    expect(saveAt).toBeGreaterThan(syncAt);
  });

  it("uses the same sha-pinned actions/cache release for restore and save", () => {
    const restore = usesOf(steps[restoreAt]);
    const save = usesOf(steps[saveAt]);
    expect(restore?.[1]).toBe("actions/cache/restore");
    expect(save?.[1]).toBe("actions/cache/save");
    expect(save?.[2]).toBe(restore?.[2]);
    expect(save?.[3]).toBe(restore?.[3]);
  });

  it("keys the cache exactly on the runner OS and the hashes of both committed lock files, with no partial-match restore", () => {
    const restore = steps[restoreAt];
    expect(restore).toMatch(/\n {8}path: extensions\n/);
    expect(restore.match(/\n {8}key: (.+)/)?.[1]).toBe(
      "clone-extensions-pinned-v1-${{ runner.os }}-${{ hashFiles('cinatra-required-extensions.lock.json', 'cinatra-dev-extensions.lock.json') }}",
    );
    expect(restore).not.toMatch(/restore-keys/);
  });

  it("caches only the pinned mode, and restores only when extensions/ does not exist", () => {
    expect(ifOf(steps[treeAt])).toBe("inputs.mode == 'pinned'");
    expect(ifOf(steps[restoreAt])).toBe("inputs.mode == 'pinned' && steps.companion-tree.outputs.absent == 'true'");
  });

  it("the absence step reads absent=true only for a path that does not exist at all", () => {
    expect(absentOutput("absent", () => {})).toBe("absent=true\n");
    expect(absentOutput("empty-dir", (d) => fs.mkdirSync(path.join(d, "extensions")))).toBe("absent=false\n");
    expect(
      absentOutput("other-depth", (d) => {
        fs.mkdirSync(path.join(d, "extensions", "a", "b", "c"), { recursive: true });
        fs.writeFileSync(path.join(d, "extensions", "a", "b", "c", "package.json"), "{}\n");
        fs.writeFileSync(path.join(d, "extensions", "README.md"), "x\n");
      }),
    ).toBe("absent=false\n");
    expect(absentOutput("a-file", (d) => fs.writeFileSync(path.join(d, "extensions"), "x\n"))).toBe("absent=false\n");
    expect(absentOutput("dangling-link", (d) => fs.symlinkSync(path.join(d, "nowhere"), path.join(d, "extensions")))).toBe(
      "absent=false\n",
    );
  });

  it("saves under the restore step's own key, only after a miss", () => {
    expect(ifOf(steps[saveAt])).toBe(
      "inputs.mode == 'pinned' && steps.companion-cache.outputs.cache-primary-key != '' && steps.companion-cache.outputs.cache-hit != 'true'",
    );
    expect(steps[saveAt]).toMatch(/\n {8}path: extensions\n/);
    expect(steps[saveAt].match(/\n {8}key: (.+)/)?.[1]).toBe("${{ steps.companion-cache.outputs.cache-primary-key }}");
  });

  it("runs the pinned sync shallow; the low-speed limit of the shared sync step applies to the head canary too", () => {
    const sync = steps[syncAt];
    expect(sync).toMatch(/pinned\) node scripts\/ci\/sync-dev-extensions\.mjs --pinned --shallow ;;/);
    expect(sync).toMatch(/head\) {3}node scripts\/ci\/sync-dev-extensions\.mjs ;;/);
    expect(ifOf(sync)).toBeNull();
    expect(sync).toMatch(/\n {8}GIT_HTTP_LOW_SPEED_LIMIT: "1000"\n/);
    expect(sync).toMatch(/\n {8}GIT_HTTP_LOW_SPEED_TIME: "60"\n/);
  });

  it("needs no token", () => {
    expect(action).not.toMatch(/github\.token|secrets\.|GITHUB_TOKEN|token:/i);
  });
});
