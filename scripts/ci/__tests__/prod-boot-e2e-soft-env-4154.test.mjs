// The prod-boot e2e gives every app boot each soft-required env var (cinatra#4154).
//
// THE FAILURE. A soft-required var that a boot does not set makes the boot phase
// `required-env-soft-check` fail as retryable, and the health body then lists it in
// `degradedPhases`. The e2e reads /api/health through `probe`, which keeps only the
// first 300 characters of the body (scripts/ci/prod-boot-e2e.sh `probe`). In the
// durable-degraded case (step 7a) the extra phase name pushed
// `"blockingPhases":["boot-degrade-probe"]` past that cut, and the step failed with
// "durable-degraded boot did not list boot-degrade-probe in blockingPhases", although
// the app reported the probe as blocking.
//
// THE INVARIANT this file guards: each `docker run` of an app boot that expects a
// settled health body (the main boot and `run_boot_case`) passes every name of
// SOFT_REQUIRED_ENV as `-e NAME="$VAR" \` from a variable the script assigns a
// non-blank value (a blank value counts as missing), as the script already did for
// CINATRA_BRIDGE_TOKEN. Then the only degraded phases are the ones a case drives on
// purpose.
//
// Runner: hosted by the vitest include glob `scripts/ci/__tests__/**/*.test.{ts,mjs}`.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SOFT_REQUIRED_ENV } from "../../../src/lib/boot/required-env-preflight";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = readFileSync(path.join(here, "..", "prod-boot-e2e.sh"), "utf8");

/**
 * The text from `startMarker` up to the first `"$IMAGE"` after it, without comment
 * lines, so a name in a comment never counts.
 */
function dockerRunBlock(startMarker) {
  const start = script.indexOf(startMarker);
  expect(start, `marker not found: ${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = script.indexOf('"$IMAGE"', start);
  expect(end, `no "$IMAGE" line after: ${startMarker}`).toBeGreaterThan(start);
  return script
    .slice(start, end)
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

/**
 * The script variable a block passes as `-e NAME="$VAR" \`, or null. The line must
 * end with the continuation backslash, so the argument stays part of `docker run`.
 */
function passedVariable(block, name) {
  const m = block.match(new RegExp(`^\\s*-e ${name}="\\$([A-Za-z_][A-Za-z0-9_]*)" \\\\$`, "m"));
  return m ? m[1] : null;
}

/** True when the script assigns VAR a non-blank quoted literal at the top level. */
function assignsNonBlank(variable) {
  const m = script.match(new RegExp(`^${variable}="([^"]*)"$`, "m"));
  return m !== null && m[1].trim() !== "";
}

const blocks = {
  "main boot (booting app container)": dockerRunBlock('echo "==> booting app container"'),
  "run_boot_case (degraded and no-mount cases)": dockerRunBlock("run_boot_case() {"),
};

describe("cinatra#4154 — prod-boot e2e boots set every soft-required env var", () => {
  it("SOFT_REQUIRED_ENV names the attest key", () => {
    expect(SOFT_REQUIRED_ENV.map((v) => v.name)).toContain("CINATRA_CONTEXT_ATTEST_KEY");
  });

  for (const [label, block] of Object.entries(blocks)) {
    for (const { name } of SOFT_REQUIRED_ENV) {
      it(`${label} passes -e ${name} from a non-blank variable`, () => {
        const variable = passedVariable(block, name);
        expect(variable, `no '-e ${name}="$VAR" \\' line`).not.toBeNull();
        expect(assignsNonBlank(variable), `${variable} is not assigned a non-blank value`).toBe(true);
      });
    }
  }
});
