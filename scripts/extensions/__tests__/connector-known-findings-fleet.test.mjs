// cinatra#3867 — the floor of the known older findings of connectors over the
// MATERIALIZED tree.
//
// On the application's pull requests the root unit tier runs with the
// companion repositories cloned into extensions/cinatra-ai, one folder each. This is the
// FLEET run of CONNECTOR_KNOWN_FINDINGS_FLOOR: it runs the gate over every
// materialized package that has a line on the floor and asserts
//   - no stale line (a line whose finding is gone fails here, where the change
//     that drops it can land; a connector's own single-package run only prints
//     a note, so its cure can merge first);
//   - every floored package is materialized (a line never read is never proven);
// and it FAILS CLOSED when it finds no package at all.

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkKnownFindingsFloorOverTree } from "../conformance-gate.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const EXT_ROOT = join(REPO_ROOT, "extensions", "cinatra-ai");

function packageDirs() {
  if (!existsSync(EXT_ROOT)) return [];
  return readdirSync(EXT_ROOT)
    .sort()
    .map((slug) => join(EXT_ROOT, slug))
    .filter((dir) => existsSync(join(dir, "package.json")));
}

describe("known older findings of connectors over the materialized tree", () => {
  it("F: every floored package is materialized and every floor line still matches its finding", () => {
    const dirs = packageDirs();
    // FAIL CLOSED: a tree with no package proves nothing.
    expect(dirs.length).toBeGreaterThan(0);

    const report = checkKnownFindingsFloorOverTree(dirs, { sdkRoot: REPO_ROOT });
    expect(report.infra).toEqual([]);
    expect(report.unmaterialized).toEqual([]);
    expect(report.stale.map((f) => f.detail)).toEqual([]);
    expect(report.checked.length).toBeGreaterThan(0);
  });
});
