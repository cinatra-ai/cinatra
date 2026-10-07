// org-write-table-sweep — the floor compared with the base (cinatra#3832).
//
// The sweep's committed baseline (file -> raw org-axis DML count) is compared
// with the copy on the base branch, so a pull request cannot add its own write
// to the baseline. Every comparison runs against a real git fixture.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FLOOR_BASE_VAR, FLOOR_FILE, checkFloorAgainstBase } from "../org-write-table-sweep.mjs";
import {
  NO_PULL_REQUEST_RUN,
  PULL_REQUEST_RUN,
  UNREADABLE_BASE_RUN,
  envWithoutBase,
  makeFloorRepo,
  makeOneCommitCheckout,
} from "./floor-base-fixture.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const GATE = join(REPO_ROOT, "scripts", "audit", "org-write-table-sweep.mjs");

describe("org-write-table-sweep — floor compared with the base", () => {
  const fixtures = [];
  afterEach(() => {
    while (fixtures.length) fixtures.pop().cleanup();
  });
  function repo(baseFloor, headFloor, make = makeFloorRepo) {
    const f = make({ base: { [FLOOR_FILE]: baseFloor }, head: { [FLOOR_FILE]: headFloor } });
    fixtures.push(f);
    return f.root;
  }

  it("names its floor file and its own base variable", () => {
    expect(FLOOR_FILE).toBe("scripts/audit/org-write-table-sweep.baseline.json");
    expect(FLOOR_BASE_VAR).toBe("ORG_WRITE_TABLE_SWEEP_BASE");
  });

  it("a raised floor FAILS: a new file in the baseline and a raised count are growth", () => {
    const root = repo({ "src/lib/database.ts": 3 }, { "src/lib/database.ts": 4, "src/lib/new-writer.ts": 1 });
    const r = checkFloorAgainstBase({ repoRoot: root, env: PULL_REQUEST_RUN });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("grew");
    expect(r.growth).toEqual(["src/lib/database.ts (3 -> 4)", "src/lib/new-writer.ts (0 -> 1)"]);
  });

  it("a lowered floor PASSES: a lowered count and a removed stale file are not growth", () => {
    const root = repo({ "src/lib/database.ts": 3, "src/lib/gone.ts": 2 }, { "src/lib/database.ts": 1 });
    expect(checkFloorAgainstBase({ repoRoot: root, env: PULL_REQUEST_RUN })).toMatchObject({ ok: true, status: "held" });
  });

  it("a base that cannot be read on a pull request's run FAILS with its reason", () => {
    const root = repo({}, {});
    const r = checkFloorAgainstBase({ repoRoot: root, env: UNREADABLE_BASE_RUN });
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toMatch(/cannot be compared with the base: the base "origin\/no-such-base-3832" did not resolve/);
  });

  it("a base copy that is not a floor FAILS with its reason", () => {
    const root = repo(["src/lib/database.ts"], {});
    const r = checkFloorAgainstBase({ repoRoot: root, env: PULL_REQUEST_RUN });
    expect(r.status).toBe("unreadable");
    expect(r.lines[0]).toMatch(/is not a readable floor/);
  });

  it("no pull request PASSES with its line", () => {
    const root = repo({}, { "src/lib/database.ts": 3 });
    const r = checkFloorAgainstBase({ repoRoot: root, env: NO_PULL_REQUEST_RUN });
    expect(r).toMatchObject({ ok: true, status: "no-base" });
    expect(r.lines[0]).toContain(FLOOR_BASE_VAR);
  });

  it("in a checkout of one commit the base is fetched: a raised floor FAILS, a lowered one PASSES", () => {
    let root = repo({ "src/lib/database.ts": 3 }, { "src/lib/database.ts": 4 }, makeOneCommitCheckout);
    let r = checkFloorAgainstBase({ repoRoot: root, env: PULL_REQUEST_RUN });
    expect(r.status).toBe("grew");
    expect(r.fetched).toEqual({ remote: "origin", branch: "main" });
    root = repo({ "src/lib/database.ts": 3 }, { "src/lib/database.ts": 2 }, makeOneCommitCheckout);
    r = checkFloorAgainstBase({ repoRoot: root, env: PULL_REQUEST_RUN });
    expect(r).toMatchObject({ ok: true, status: "held" });
  });

  it("the gate itself runs the guard first: an unreadable base fails it with the reason", () => {
    const res = spawnSync(process.execPath, [GATE], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...envWithoutBase(process.env), ...UNREADABLE_BASE_RUN },
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/\[org-write-table-sweep\] FAIL — the floor scripts\/audit\/org-write-table-sweep\.baseline\.json cannot be compared with the base/);
  });

  it("the gate on a run that is no pull request prints the guard's line and runs its sweep", () => {
    const res = spawnSync(process.execPath, [GATE], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...envWithoutBase(process.env), ...NO_PULL_REQUEST_RUN },
    });
    expect(res.stdout).toMatch(/\[org-write-table-sweep\] floor base guard: no pull request and no base named/);
    expect(res.stdout).toMatch(/org-write-table-sweep: OK/);
    expect(res.status).toBe(0);
  });
});
