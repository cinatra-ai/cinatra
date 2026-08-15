// cinatra#2654 — the non-CLI entry points start the WayFlow agent runtime too.
//
// THE DEFECT
// `wayflow` is profile-gated (`profiles: [wayflow, drupal, wordpress]`) and no
// default bring-up activated the profile. A fresh install therefore had nothing
// on :3010 and EVERY agent run died with ECONNREFUSED. The owner ruling makes
// the runtime part of every install-owned local stack, and requires the
// non-CLI setup/service entry points to follow the same default.
//
// WHY A SOURCE-LEVEL TEST
// These three entry points are a shell script, an npm script, and a Make
// target. Running them needs a live Docker daemon and several minutes of image
// build, so CI cannot execute them. What CI CAN do is pin the four properties
// that carry the whole behaviour, each of which silently restores the bug on
// its own:
//   1. the compose profile still exists (it IS the opt-out mechanism),
//   2. every default bring-up activates it,
//   3. the bridge-token env is generated BEFORE the bring-up, not after, and
//   4. a broken image build fails loudly instead of half-starting the stack.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(path.join(repoRoot, rel), "utf8");

const setup = read("scripts/setup.sh");
const makefile = read("Makefile");
const pkg = JSON.parse(read("package.json"));
const compose = read("docker-compose.yml");

describe("docker-compose.yml keeps the profile as the opt-out mechanism", () => {
  it("the wayflow service is still profile-gated", () => {
    // The fix is orchestration-side ON PURPOSE. Un-gating the service in
    // compose would remove the only way to bring the stack up without the
    // runtime, and would start it for every unrelated `docker compose up`.
    const service = compose.slice(compose.indexOf("\n  wayflow:"));
    const profiles = service.slice(service.indexOf("profiles:"), service.indexOf("healthcheck:"));
    expect(profiles).toContain("- wayflow");
    expect(profiles).toContain("- drupal");
    expect(profiles).toContain("- wordpress");
  });
});

describe("scripts/setup.sh starts the runtime by default", () => {
  it("activates the wayflow profile on the infrastructure bring-up", () => {
    expect(setup).toContain('COMPOSE_PROFILE_ARGS="--profile wayflow"');
    expect(setup).toContain(
      "docker compose -f docker-compose.yml -f docker-compose.dev.yml $COMPOSE_PROFILE_ARGS up -d",
    );
  });

  it("offers NO_WAYFLOW=1 as the opt-out, and only that", () => {
    expect(setup).toContain('if [ "${NO_WAYFLOW:-}" = "1" ]; then');
    expect(setup).toContain("WAYFLOW=0");
    // The default is on: the variable is initialised to 1 before the opt-out.
    expect(setup.indexOf("WAYFLOW=1")).toBeLessThan(setup.indexOf('if [ "${NO_WAYFLOW:-}" = "1" ]; then'));
  });

  it("generates the bridge-token env BEFORE the bring-up, not after", () => {
    // Ordering is the whole point. Generating it afterwards (the old order)
    // meant the very first start read no token and the loader crash-looped
    // with "FATAL: CINATRA_BRIDGE_TOKEN is unset or empty".
    const genAt = setup.indexOf("node scripts/gen-wayflow-env.mjs --require-bridge-token");
    const upAt = setup.indexOf("$COMPOSE_PROFILE_ARGS up -d");
    expect(genAt).toBeGreaterThan(-1);
    expect(upAt).toBeGreaterThan(-1);
    expect(genAt).toBeLessThan(upAt);
  });

  it("builds the runtime image as its own step and fails loudly", () => {
    expect(setup).toContain("--profile wayflow build wayflow");
    const buildBlock = setup.slice(setup.indexOf("--profile wayflow build wayflow"));
    expect(buildBlock.slice(0, 600)).toContain("error ");
    expect(buildBlock.slice(0, 600)).toContain("NO_WAYFLOW=1");
    // Loud, and safely rerunnable: the message names the re-run.
    expect(buildBlock.slice(0, 600)).toContain("scripts/setup.sh");
  });

  it("records the decision the doctor reads", () => {
    expect(setup).toContain("CINATRA_WAYFLOW_RUNTIME=$WAYFLOW_RUNTIME_MODE");
    expect(setup).toContain('WAYFLOW_RUNTIME_MODE="local"');
    expect(setup).toContain('WAYFLOW_RUNTIME_MODE="off"');
  });

  it("waits for the runtime, bounded and non-fatal", () => {
    const waitBlock = setup.slice(setup.indexOf("Waiting for the WayFlow agent runtime"));
    expect(waitBlock.slice(0, 700)).toContain("http://127.0.0.1:3010/.health");
    // A still-mounting loader warns; it never aborts an otherwise good setup.
    expect(waitBlock.slice(0, 700)).toContain("warn ");
    expect(waitBlock.slice(0, 700)).not.toContain("error ");
  });

  it("no longer tells the operator the runtime does not start by default", () => {
    expect(setup).not.toContain("does NOT start by default");
  });
});

describe("npm run services starts the runtime by default", () => {
  it("activates the wayflow profile, after generating the bridge-token env", () => {
    const script = pkg.scripts.services;
    expect(script).toContain("--profile wayflow");
    expect(script.indexOf("gen-wayflow-env.mjs --require-bridge-token")).toBeLessThan(
      script.indexOf("--profile wayflow"),
    );
  });
});

describe("the Make dev target starts the runtime by default", () => {
  it("activates the wayflow profile on its bring-up", () => {
    const target = makefile.slice(makefile.indexOf("\ndev:"), makefile.indexOf("\n# Stop infrastructure"));
    expect(target).toContain("--profile wayflow");
    expect(target).toContain("up -d");
  });
});
