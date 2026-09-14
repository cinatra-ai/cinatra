/**
 * THE COMPOSE PROJECT AND THE EGRESS NETWORK ARE NAMED PER JOB (cinatra#3327).
 *
 * The sibling file `exec-stack-network-naming.test.ts` pins the same rule for
 * the SANDBOX network (cinatra#3320). Two names were left behind by that fix:
 * the harness still brought every stack up under one fixed compose project, and
 * the gateway's internet leg still carried one fixed network name. On a shared
 * runner pool that is the same defect twice over — the first job to finish
 * removed the network the second job's gateway was attached to, and the second
 * job's stack could not come up at all:
 *
 *   could not find a network matching network mode cinatra-exec-egress:
 *   network cinatra-exec-egress not found
 *
 * These are SHAPE assertions, deliberately: the functional proof that two jobs
 * no longer collide can only come from two real battery jobs on one machine,
 * which needs a docker daemon this tier does not have. What is provable here —
 * and what a future edit could silently undo — is the RULE: each name is
 * derived from the job's own identity, never a bare fixed literal, and the
 * compose file reads the same variable the harness hands it. The compose
 * DEFAULT is asserted too, because an unset variable must leave a real
 * deployment byte-for-byte the topology it was before.
 *
 * The harness is imported as a NAMESPACE rather than by name on purpose. A file
 * that names an export the previous head does not have fails to load there, and
 * a suite that cannot load reports one collection error instead of the several
 * failures that say WHICH part of the rule is missing. Through the namespace
 * this file runs on either head and each assertion answers for itself.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as execStack from "./e2e/support/exec-stack";

/** The names these two carried when they were fixed, and the defaults today. */
const FIXED_PROJECT = "cinatra-exec-l5e2e";
const FIXED_EGRESS_NETWORK = "cinatra-exec-egress";

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
/** What compose accepts as a project name — narrower: lower case, no dots. */
const LEGAL_PROJECT_NAME = /^[a-z0-9][a-z0-9_-]*$/;
/** The random tail `jobScopedName` ends every derived name with. */
const RUN_DISCRIMINATOR = /-[0-9a-f]{8}$/;

describe("the compose project name is derived per job", () => {
  it("carries the job's identity and is never the bare fixed name", () => {
    const name = execStack.composeProjectNameFor({
      GITHUB_RUN_ID: "17512345678",
      GITHUB_JOB: "batteries",
      GITHUB_RUN_ATTEMPT: "3",
    });
    expect(name).not.toBe(FIXED_PROJECT);
    expect(name).toContain("17512345678");
    expect(name).toContain("batteries");
    expect(name).toMatch(LEGAL_PROJECT_NAME);
  });

  it("gives two legs of ONE run two different projects", () => {
    // Every leg of a matrix shares GITHUB_RUN_ID, GITHUB_JOB and the attempt —
    // there is no per-leg identifier in the environment at all — so the run's
    // identity alone would put two concurrent legs back into one project.
    const shared = { GITHUB_RUN_ID: "17512345678", GITHUB_JOB: "batteries", GITHUB_RUN_ATTEMPT: "1" };
    expect(execStack.composeProjectNameFor({ ...shared })).not.toBe(
      execStack.composeProjectNameFor({ ...shared }),
    );
  });

  it("falls back to a unique name off CI, where there is no job identity at all", () => {
    const first = execStack.composeProjectNameFor({});
    const second = execStack.composeProjectNameFor({});
    expect(first).not.toBe(second);
    expect(first).not.toBe(FIXED_PROJECT);
    expect(first).toMatch(LEGAL_PROJECT_NAME);
  });

  it("stays a name compose accepts even when the job's own name is not", () => {
    // A workflow job id may carry upper case and dots; a compose project may
    // carry neither, and compose REJECTS rather than folds one that does.
    const name = execStack.composeProjectNameFor({
      GITHUB_RUN_ID: "17512345678",
      GITHUB_JOB: "Batteries.Leg/One",
      GITHUB_RUN_ATTEMPT: "2",
    });
    expect(name).toMatch(LEGAL_PROJECT_NAME);
  });

  it("honours an explicit pin, so an operator can still name the project", () => {
    expect(execStack.composeProjectNameFor({ CINATRA_EXEC_COMPOSE_PROJECT: "pinned-project" })).toBe(
      "pinned-project",
    );
  });

  it("resolves the harness constant to a project of this run's own", () => {
    expect(execStack.COMPOSE_PROJECT).toMatch(LEGAL_PROJECT_NAME);
    // An explicit pin is the one way the constant may still be the shared name,
    // because that is the operator asking for it.
    if (!process.env.CINATRA_EXEC_COMPOSE_PROJECT) {
      expect(execStack.COMPOSE_PROJECT).not.toBe(FIXED_PROJECT);
    }
    if (!process.env.CINATRA_EXEC_COMPOSE_PROJECT) {
      // A second fixed name would pass "not the old literal" and collide the
      // same way; the constant must carry this process's own discriminator.
      expect(execStack.COMPOSE_PROJECT).toMatch(RUN_DISCRIMINATOR);
    }
  });
});

describe("the egress network name is derived per job", () => {
  it("carries the job's identity and is never the bare fixed name", () => {
    const name = execStack.egressNetworkNameFor({
      GITHUB_RUN_ID: "17512345678",
      GITHUB_JOB: "batteries",
      GITHUB_RUN_ATTEMPT: "3",
    });
    expect(name).not.toBe(FIXED_EGRESS_NETWORK);
    expect(name).toContain("17512345678");
    expect(name).toContain("batteries");
    expect(name).toMatch(LEGAL_NETWORK_NAME);
  });

  it("gives two legs of ONE run two different networks", () => {
    const shared = { GITHUB_RUN_ID: "17512345678", GITHUB_JOB: "batteries", GITHUB_RUN_ATTEMPT: "1" };
    expect(execStack.egressNetworkNameFor({ ...shared })).not.toBe(
      execStack.egressNetworkNameFor({ ...shared }),
    );
  });

  it("falls back to a unique name off CI, where there is no job identity at all", () => {
    const first = execStack.egressNetworkNameFor({});
    const second = execStack.egressNetworkNameFor({});
    expect(first).not.toBe(second);
    expect(first).not.toBe(FIXED_EGRESS_NETWORK);
    expect(first).toMatch(LEGAL_NETWORK_NAME);
  });

  it("honours an explicit pin, so an operator can still name the network", () => {
    expect(execStack.egressNetworkNameFor({ CINATRA_EXEC_EGRESS_NETWORK: "pinned-net" })).toBe(
      "pinned-net",
    );
  });

  it("resolves the harness constant to a network of this run's own", () => {
    expect(execStack.EGRESS_NETWORK).toMatch(LEGAL_NETWORK_NAME);
    if (!process.env.CINATRA_EXEC_EGRESS_NETWORK) {
      expect(execStack.EGRESS_NETWORK).not.toBe(FIXED_EGRESS_NETWORK);
      // Not merely DIFFERENT from the old literal — a second fixed name such as
      // `cinatra-exec-egress-shared` would satisfy that and collide exactly as
      // before. The constant must carry this process's own discriminator.
      expect(execStack.EGRESS_NETWORK).toMatch(RUN_DISCRIMINATOR);
      expect(execStack.EGRESS_NETWORK.startsWith(`${FIXED_EGRESS_NETWORK}-`)).toBe(true);
    }
  });

  it("names a different network from the sandbox leg of the same run", () => {
    // One variable per leg. If the two ever resolved to one name the gateway's
    // internet leg and the internal sandbox network would be the same network,
    // which is the containment boundary gone.
    expect(execStack.EGRESS_NETWORK).not.toBe(execStack.INTERNAL_NETWORK);
  });
});

describe("the rule the harness must keep", () => {
  it("declares no fixed project name for the stack to share", () => {
    expect(harnessSource()).not.toMatch(/export const COMPOSE_PROJECT\s*=\s*["'`]/);
  });

  it("declares no fixed egress network name for the stack to share", () => {
    expect(harnessSource()).not.toMatch(/export const EGRESS_NETWORK\s*=\s*["'`]/);
  });

  it("reads the job identity out of the environment for both", () => {
    const source = harnessSource();
    expect(source).toMatch(/composeProjectNameFor\s*\(/);
    expect(source).toMatch(/egressNetworkNameFor\s*\(/);
    expect(source).toContain("GITHUB_RUN_ID");
    expect(source).toContain("GITHUB_JOB");
    expect(source).toContain("GITHUB_RUN_ATTEMPT");
    expect(source).toMatch(/randomBytes\(/);
  });

  it("hands the derived project to every compose invocation", () => {
    const source = harnessSource();
    expect(source).toMatch(/"-p",\s*COMPOSE_PROJECT/);
    // EVERY invocation, not merely one: a second call site that forgot `-p`
    // would run under compose's own default project and share it with the whole
    // machine again. Count them rather than proving one exists.
    const invocations = source.match(/\["compose",/g) ?? [];
    const scoped = source.match(/\["compose",\s*"-p",\s*COMPOSE_PROJECT,/g) ?? [];
    expect(invocations.length).toBeGreaterThan(0);
    expect(scoped.length).toBe(invocations.length);
  });

  it("hands the derived egress name to compose", () => {
    expect(harnessSource()).toMatch(/CINATRA_EXEC_EGRESS_NETWORK:\s*EGRESS_NETWORK/);
  });

  it("reclaims only networks this job itself named", () => {
    const source = harnessSource();
    expect(source).toMatch(/reclaimJobNetwork\(\s*INTERNAL_NETWORK/);
    expect(source).toMatch(/reclaimJobNetwork\(\s*EGRESS_NETWORK/);
    // No literal reaches `network rm`: the only names it may carry are derived.
    expect(source).not.toMatch(/"network",\s*"rm",\s*["'`]/);
    // And the removal stays CONDITIONAL. Deleting the refusal below would leave
    // every assertion above true while the step tore a live network out.
    expect(source).toMatch(/Refusing to remove it/);
    expect(source).toMatch(/if \(attached !== "0"\)/);
  });

  it("never reclaims a network an operator named", () => {
    const source = harnessSource();
    // A derived name is this process's own invention and nothing else can be
    // using it. A PINNED name may be an existing network somebody else
    // provisioned, and an idle network is not an abandoned one — so the step is
    // handed the pin state and returns before it inspects or removes anything.
    expect(source).toMatch(/reclaimJobNetwork\(\s*INTERNAL_NETWORK,\s*"sandbox",\s*INTERNAL_NETWORK_PINNED/);
    expect(source).toMatch(/reclaimJobNetwork\(\s*EGRESS_NETWORK,\s*"egress",\s*EGRESS_NETWORK_PINNED/);
    expect(source).toMatch(/if \(pinned\) return;/);
  });

  it("reads the pin state from the same variables the names come from", () => {
    expect(execStack.nameIsPinned("CINATRA_EXEC_EGRESS_NETWORK", {})).toBe(false);
    expect(execStack.nameIsPinned("CINATRA_EXEC_EGRESS_NETWORK", { CINATRA_EXEC_EGRESS_NETWORK: "  " })).toBe(false);
    expect(
      execStack.nameIsPinned("CINATRA_EXEC_EGRESS_NETWORK", {
        CINATRA_EXEC_EGRESS_NETWORK: "operator-existing-net",
      }),
    ).toBe(true);
    expect(execStack.nameIsPinned("CINATRA_EXEC_SANDBOX_NETWORK", {})).toBe(false);
    expect(
      execStack.nameIsPinned("CINATRA_EXEC_SANDBOX_NETWORK", {
        CINATRA_EXEC_SANDBOX_NETWORK: "operator-existing-net",
      }),
    ).toBe(true);
    // The name the harness would use is exactly the pin, so the two agree on
    // what "pinned" means and reclaim can never disagree with the resolver.
    expect(
      execStack.egressNetworkNameFor({ CINATRA_EXEC_EGRESS_NETWORK: "operator-existing-net" }),
    ).toBe("operator-existing-net");
  });
});

describe("the compose file reads the same variable, and defaults to today's name", () => {
  it("names the egress network from the variable", () => {
    const compose = composeSource();
    expect(compose).toContain("name: ${CINATRA_EXEC_EGRESS_NETWORK:-cinatra-exec-egress}");
    expect(compose).not.toMatch(/^\s+name:\s*cinatra-exec-egress\s*$/m);
  });

  it("leaves the sandbox network's own variable exactly as cinatra#3320 left it", () => {
    // This file must not be able to pass by having quietly changed that rule.
    expect(composeSource()).toContain("name: ${CINATRA_EXEC_SANDBOX_NETWORK:-cinatra-exec-internal}");
  });
});
