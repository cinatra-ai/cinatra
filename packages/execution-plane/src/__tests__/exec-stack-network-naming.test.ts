/**
 * THE SANDBOX NETWORK IS NAMED PER JOB (cinatra#3320).
 *
 * The battery harness used to hand compose one fixed network name, so every
 * battery on a machine shared a single docker network. One machine per job hid
 * that on the hosted road; on a shared runner pool the second job found the
 * first job's network with a container attached and refused to run before
 * executing a single assertion.
 *
 * These are SHAPE assertions, deliberately: the functional proof that two jobs
 * no longer collide can only come from two real battery jobs on one machine,
 * which needs a docker daemon this tier does not have. What is provable here —
 * and what a future edit could silently undo — is the RULE: the name is derived
 * from the job's own identity, never a bare fixed literal, and the compose file
 * reads the same variable for both the network's real name and the
 * `EXEC_SANDBOX_NETWORK` the broker asserts. The compose DEFAULT is asserted
 * too, because an unset variable must leave a real deployment byte-for-byte the
 * topology it was before.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { INTERNAL_NETWORK, sandboxNetworkNameFor } from "./e2e/support/exec-stack";

/** The name the network had when it was fixed, and the compose default today. */
const FIXED_NAME = "cinatra-exec-internal";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const HARNESS_PATH = path.join(
  REPO_ROOT,
  "packages/execution-plane/src/__tests__/e2e/support/exec-stack.ts",
);
const COMPOSE_PATH = path.join(REPO_ROOT, "docker-compose.exec.yml");

const harnessSource = (): string => readFileSync(HARNESS_PATH, "utf8");
const composeSource = (): string => readFileSync(COMPOSE_PATH, "utf8");

/** What docker accepts as a network name. */
const LEGAL_NETWORK_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

describe("the sandbox network name is derived per job", () => {
  it("carries the job's identity and is never the bare fixed name", () => {
    const name = sandboxNetworkNameFor({
      GITHUB_RUN_ID: "17512345678",
      GITHUB_JOB: "batteries",
      GITHUB_RUN_ATTEMPT: "3",
    });
    expect(name).not.toBe(FIXED_NAME);
    expect(name).toContain("17512345678");
    expect(name).toContain("batteries");
    expect(name).toMatch(LEGAL_NETWORK_NAME);
  });

  it("gives two legs of ONE run two different networks", () => {
    // Every leg of a matrix shares GITHUB_RUN_ID, GITHUB_JOB and the attempt —
    // there is no per-leg identifier in the environment at all — so the run's
    // identity alone would put two concurrent legs back on one network.
    const shared = { GITHUB_RUN_ID: "17512345678", GITHUB_JOB: "batteries", GITHUB_RUN_ATTEMPT: "1" };
    expect(sandboxNetworkNameFor({ ...shared })).not.toBe(sandboxNetworkNameFor({ ...shared }));
  });

  it("falls back to a unique name off CI, where there is no job identity at all", () => {
    const first = sandboxNetworkNameFor({});
    const second = sandboxNetworkNameFor({});
    expect(first).not.toBe(second);
    expect(first).not.toBe(FIXED_NAME);
    expect(first).toMatch(LEGAL_NETWORK_NAME);
  });

  it("honours an explicit pin, so an operator can still name the network", () => {
    expect(sandboxNetworkNameFor({ CINATRA_EXEC_SANDBOX_NETWORK: "pinned-net" })).toBe("pinned-net");
  });

  it("resolves the harness constant to a name of this run's own", () => {
    expect(INTERNAL_NETWORK).toMatch(LEGAL_NETWORK_NAME);
    // An explicit pin is the one way the constant may still be the shared name,
    // because that is the operator asking for it.
    if (!process.env.CINATRA_EXEC_SANDBOX_NETWORK) {
      expect(INTERNAL_NETWORK).not.toBe(FIXED_NAME);
    }
  });
});

describe("the rule the harness must keep", () => {
  it("declares no fixed network name for the stack to share", () => {
    expect(harnessSource()).not.toMatch(/export const INTERNAL_NETWORK\s*=\s*["'`]/);
  });

  it("reads the job identity out of the environment", () => {
    const source = harnessSource();
    expect(source).toContain("GITHUB_RUN_ID");
    expect(source).toContain("GITHUB_JOB");
    expect(source).toContain("GITHUB_RUN_ATTEMPT");
    expect(source).toMatch(/randomBytes\(/);
  });

  it("hands the derived name to every compose invocation", () => {
    expect(harnessSource()).toMatch(/CINATRA_EXEC_SANDBOX_NETWORK:\s*INTERNAL_NETWORK/);
  });
});

describe("the compose file reads the same variable, and defaults to today's name", () => {
  it("names the network from the variable", () => {
    const compose = composeSource();
    expect(compose).toContain("name: ${CINATRA_EXEC_SANDBOX_NETWORK:-cinatra-exec-internal}");
    expect(compose).not.toMatch(/^\s+name:\s*cinatra-exec-internal\s*$/m);
  });

  it("tells the broker the same network the stack brought up", () => {
    const compose = composeSource();
    expect(compose).toContain(
      "EXEC_SANDBOX_NETWORK: ${CINATRA_EXEC_SANDBOX_NETWORK:-cinatra-exec-internal}",
    );
    expect(compose).not.toMatch(/EXEC_SANDBOX_NETWORK:\s*["']cinatra-exec-internal["']/);
  });
});
