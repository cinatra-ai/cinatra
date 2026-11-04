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
// PATH (__fixtures__/prod-boot-e2e-docker-stub/docker.mjs). The stand-in records the
// argv of every `docker run` and models /api/health from each container's EFFECTIVE
// env (the last `-e NAME=value` wins), and the script's own `probe` code runs on the
// modelled body. So a value that the script reassigns later, sets only in a function
// that never runs, overrides through a caller's `"$@"`, or passes only in a block that
// never runs, is read as the container would see it.
//
// THE INVARIANTS: the script runs to its PASSED line under the stand-in, and every
// `docker run -d` of the image except the item-3 boot (`-app-missing-env`) carries a
// non-blank effective value for every SOFT_REQUIRED_ENV name.
//
// Runner: hosted by the vitest include glob `scripts/ci/__tests__/**/*.test.{ts,mjs}`.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SOFT_REQUIRED_ENV } from "../../../src/lib/boot/required-env-preflight";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "..", "prod-boot-e2e.sh");
const STUB = path.join(here, "__fixtures__", "prod-boot-e2e-docker-stub", "docker.mjs");
const IMAGE = "cinatra-prod-boot-e2e:stub";
const SOFT = SOFT_REQUIRED_ENV.map((v) => v.name);

let dir;
let run;
let calls;

/** The value a container sees for `name` from its `run` argv: the last -e wins. */
function effective(argv, name) {
  let val;
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] !== "-e") continue;
    const e = argv[i + 1];
    const eq = e.indexOf("=");
    if (eq < 0 ? e === name : e.slice(0, eq) === name) val = eq < 0 ? process.env[name] : e.slice(eq + 1);
  }
  return val;
}

const nameOf = (argv) => argv[argv.indexOf("--name") + 1];

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "prod-boot-e2e-stub-"));
  const wrapper = path.join(dir, "docker");
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${STUB}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  const log = path.join(dir, "calls.jsonl");
  writeFileSync(log, "");
  run = spawnSync("bash", [SCRIPT], {
    env: {
      ...process.env,
      PATH: `${dir}${path.delimiter}${process.env.PATH}`,
      IMAGE,
      STUB_STATE: path.join(dir, "state.json"),
      STUB_LOG: log,
      STUB_IMAGE: IMAGE,
      STUB_SOFT_ENV: SOFT.join(","),
    },
    encoding: "utf8",
    timeout: 120_000,
  });
  calls = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
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

  it("the main boot, the durable-degraded boot and the no-mount boot ran, and the item-3 boot", () => {
    const names = calls.filter((a) => a[0] === "run" && a.includes("-d")).map(nameOf);
    for (const suffix of ["-app", "-app-degraded", "-app-no-mount", "-app-missing-env"]) {
      expect(names.some((n) => n.endsWith(suffix)), `no docker run -d of a container ending ${suffix}`).toBe(true);
    }
  });

  for (const name of SOFT) {
    it(`every settled-health app boot gets a non-blank effective ${name}`, () => {
      const boots = calls.filter(
        (a) => a[0] === "run" && a.includes("-d") && a.includes(IMAGE) && !nameOf(a).endsWith("-app-missing-env"),
      );
      expect(boots.length).toBeGreaterThanOrEqual(3);
      for (const a of boots) {
        expect((effective(a, name) ?? "").trim(), `${nameOf(a)} has no non-blank ${name}`).not.toBe("");
      }
    });
  }
});
