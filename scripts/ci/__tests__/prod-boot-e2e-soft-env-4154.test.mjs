// The prod-boot e2e gives each app boot that expects a settled health body every
// soft-required env var (cinatra#4154). The item-3 boot, which expects a hard
// failure, is the one app boot left without the attest key.
//
// THE FAILURE. A soft-required var that a boot does not set makes the boot phase
// `required-env-soft-check` fail as retryable, and the health body then lists it in
// `degradedPhases`. The e2e reads /api/health through `probe`, which keeps only the
// first 300 characters of the body (scripts/ci/prod-boot-e2e.sh `probe`). In the
// durable-degraded case (step 7a) the extra phase name pushed
// `"blockingPhases":["boot-degrade-probe"]` past that cut, and the step failed with
// "durable-degraded boot did not list boot-degrade-probe in blockingPhases".
//
// HOW THIS FILE PROVES IT. It runs the real script with a stand-in `docker` first on
// PATH (__fixtures__/prod-boot-e2e-docker-stub/docker.mjs). The stand-in accepts only
// the call shapes the script uses, records each valid `docker run -d` with its
// EFFECTIVE env (the last `-e NAME=value` wins; a bare `-e NAME` reads the env of that
// docker invocation), and models the app from that env: the item-3 preflight failure
// from the hard-required names it lacks, and /api/health from the rest. The script's
// own `probe` code runs on the modelled body. This file reads only those recorded
// runs, so the value it checks is the value the container gets.
//
// THE INVARIANTS: the script runs to its PASSED line under the stand-in; the main, the
// durable-degraded, the no-mount and the item-3 boots were recorded; the item-3 boot
// lacks exactly the two hard-required names its case removes; and every other
// recorded app boot has a non-blank effective value for every SOFT_REQUIRED_ENV and
// HARD_REQUIRED_ENV name.
//
// Runner: hosted by the vitest include glob `scripts/ci/__tests__/**/*.test.{ts,mjs}`.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HARD_REQUIRED_ENV, SOFT_REQUIRED_ENV } from "../../../src/lib/boot/required-env-preflight";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "..", "prod-boot-e2e.sh");
const STUB = path.join(here, "__fixtures__", "prod-boot-e2e-docker-stub", "docker.mjs");
const IMAGE = "cinatra-prod-boot-e2e:stub";
const SOFT = SOFT_REQUIRED_ENV.map((v) => v.name);
const HARD = HARD_REQUIRED_ENV.map((v) => v.name);
const ITEM3 = "-app-missing-env";

let dir;
let run;
let appRuns;

const blank = (v) => (v ?? "").trim() === "";

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "prod-boot-e2e-stub-"));
  const wrapper = path.join(dir, "docker");
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${STUB}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  const stateFile = path.join(dir, "state.json");
  run = spawnSync("bash", [SCRIPT], {
    env: {
      ...process.env,
      PATH: `${dir}${path.delimiter}${process.env.PATH}`,
      IMAGE,
      STUB_STATE: stateFile,
      STUB_IMAGE: IMAGE,
      STUB_SOFT_ENV: SOFT.join(","),
      STUB_HARD_ENV: HARD.join(","),
    },
    encoding: "utf8",
    timeout: 120_000,
  });
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { runs: [] };
  appRuns = state.runs.filter((r) => r.app);
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("cinatra#4154 — prod-boot e2e boots carry every soft-required env var", () => {
  it("SOFT_REQUIRED_ENV names the attest key", () => {
    expect(SOFT).toContain("CINATRA_CONTEXT_ATTEST_KEY");
  });

  it("the script runs to its PASSED line under the docker stand-in", () => {
    const tail = `${run.stdout ?? ""}\n${run.stderr ?? ""}`.split("\n").slice(-30).join("\n");
    expect(run.status, tail).toBe(0);
    expect(run.stdout).toContain("==> prod-boot e2e PASSED");
  });

  it("the main, durable-degraded, no-mount and item-3 boots were recorded", () => {
    for (const suffix of ["-app", "-app-degraded", "-app-no-mount", ITEM3]) {
      expect(appRuns.some((r) => r.name.endsWith(suffix)), `no recorded boot ending ${suffix}`).toBe(true);
    }
  });

  it("the item-3 boot lacks exactly the two hard-required names its case removes", () => {
    const item3 = appRuns.filter((r) => r.name.endsWith(ITEM3));
    expect(item3.length).toBe(1);
    expect(HARD.filter((n) => blank(item3[0].env[n]))).toEqual(["BETTER_AUTH_SECRET", "CINATRA_ENCRYPTION_KEY"]);
  });

  for (const name of [...SOFT, ...HARD]) {
    it(`every other recorded app boot has a non-blank effective ${name}`, () => {
      const boots = appRuns.filter((r) => !r.name.endsWith(ITEM3));
      expect(boots.length).toBeGreaterThanOrEqual(3);
      for (const r of boots) expect(blank(r.env[name]), `${r.name} has no non-blank ${name}`).toBe(false);
    });
  }
});
