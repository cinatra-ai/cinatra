// cinatra#4484: the SHAPE of the clone-extensions composite action, read from
// the real file. The sync itself is unit-tested in packages/cli; this guards
// what a unit test cannot reach: the pinned run restores extensions/ from a
// cache keyed on BOTH committed lock files before the sync, fetches at depth 1
// with a low-speed limit, saves the cache right after a sync that missed it
// (before any install can add to the tree), and needs no token.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const ACTION_PATH = path.join(REPO_ROOT, ".github", "actions", "clone-extensions", "action.yml");
const action = fs.readFileSync(ACTION_PATH, "utf8");

// The steps of the composite action, each as its own text block, in order.
const stepsText = action.split(/\n {2}steps:\n/)[1] ?? "";
const steps = stepsText.split(/\n(?= {4}- )/).filter((s) => s.trim().startsWith("- "));
const indexOf = (re) => steps.findIndex((s) => re.test(s));

const restoreAt = indexOf(/uses: actions\/cache\/restore@/);
const syncAt = indexOf(/sync-dev-extensions\.mjs --pinned/);
const saveAt = indexOf(/uses: actions\/cache\/save@/);

describe("clone-extensions action — the pinned companion cache (cinatra#4484)", () => {
  it("restores extensions/ before the sync and saves it after, in that order", () => {
    expect(restoreAt).toBeGreaterThanOrEqual(0);
    expect(syncAt).toBeGreaterThan(restoreAt);
    expect(saveAt).toBeGreaterThan(syncAt);
  });

  it("uses the repository's sha-pinned actions/cache for both steps", () => {
    expect(steps[restoreAt]).toMatch(/uses: actions\/cache\/restore@[0-9a-f]{40} # v\d+\.\d+\.\d+/);
    expect(steps[saveAt]).toMatch(/uses: actions\/cache\/save@[0-9a-f]{40} # v\d+\.\d+\.\d+/);
  });

  it("keys the cache on the hashes of both committed lock files, with no partial-match restore", () => {
    const restore = steps[restoreAt];
    expect(restore).toMatch(/path: extensions\n/);
    const key = restore.match(/key: (.+)/)?.[1] ?? "";
    expect(key).toMatch(/hashFiles\([^)]*'cinatra-required-extensions\.lock\.json'[^)]*\)/);
    expect(key).toMatch(/hashFiles\([^)]*'cinatra-dev-extensions\.lock\.json'[^)]*\)/);
    expect(restore).not.toMatch(/restore-keys/);
  });

  it("caches only the pinned mode, and restores only into an absent tree", () => {
    expect(steps[restoreAt]).toMatch(/if: .*inputs\.mode == 'pinned'/);
    expect(steps[restoreAt]).toMatch(/hashFiles\('extensions\/\*\/\*\/package\.json'\) == ''/);
    expect(steps[saveAt]).toMatch(/if: .*inputs\.mode == 'pinned'/);
  });

  it("saves under the restore step's own key, only after a miss", () => {
    const id = steps[restoreAt].match(/id: ([\w-]+)/)?.[1];
    expect(id).toBeTruthy();
    expect(steps[saveAt]).toMatch(new RegExp(`steps\\.${id}\\.outputs\\.cache-hit != 'true'`));
    expect(steps[saveAt]).toMatch(new RegExp(`steps\\.${id}\\.outputs\\.cache-primary-key != ''`));
    expect(steps[saveAt]).toMatch(new RegExp(`key: \\$\\{\\{ steps\\.${id}\\.outputs\\.cache-primary-key \\}\\}`));
  });

  it("runs the pinned sync shallow, with a low-speed limit, and the head canary unchanged", () => {
    const sync = steps[syncAt];
    expect(sync).toMatch(/pinned\) node scripts\/ci\/sync-dev-extensions\.mjs --pinned --shallow ;;/);
    expect(sync).toMatch(/head\) {3}node scripts\/ci\/sync-dev-extensions\.mjs ;;/);
    expect(sync).toMatch(/GIT_HTTP_LOW_SPEED_LIMIT: "\d+"/);
    expect(sync).toMatch(/GIT_HTTP_LOW_SPEED_TIME: "\d+"/);
  });

  it("needs no token", () => {
    expect(action).not.toMatch(/github\.token|secrets\.|GITHUB_TOKEN|token:/i);
  });
});
