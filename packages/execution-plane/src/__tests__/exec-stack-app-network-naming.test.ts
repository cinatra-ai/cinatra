/**
 * THE APP-FACING NETWORK IS NAMED PER JOB, AND NO FIXED NAME IS LEFT
 * (cinatra#3327).
 *
 * Two sibling files pin the same rule for the other names this harness hands
 * docker: `exec-stack-network-naming.test.ts` for the sandbox network
 * (cinatra#3320), `exec-stack-compose-project-naming.test.ts` for the compose
 * project and the gateway's egress leg (cinatra#3327). A THIRD fixed name
 * survived both of those, and it is the one that then failed EVERY battery on a
 * shared runner pool: the broker's app-facing bridge still carried a bare
 * `name: cinatra-exec-app`, so the first job's project owned that network and
 * every later project was turned away at `up` before a single assertion ran:
 *
 *   a network with name cinatra-exec-app exists but was not created for project
 *   "cinatra-exec-l5e2e-...". Set external: true to use an existing network
 *
 * This name is worse than the other two rather than milder. A shared network
 * can at least be adopted; a name already owned by another compose project is
 * REFUSED outright, so one job on the box was enough to stop all the others.
 *
 * These are SHAPE assertions, deliberately: the functional proof that two jobs
 * no longer collide can only come from two real battery jobs on one machine,
 * which needs a docker daemon this tier does not have. What is provable here —
 * and what a future edit could silently undo — is the RULE: every name that
 * reaches docker is derived from the job's own identity, never a bare fixed
 * literal, and the compose file reads the same variable the harness hands it.
 * The compose DEFAULT is asserted too, because an unset variable must leave a
 * real deployment byte-for-byte the topology it was before.
 *
 * The last describe is the one that generalizes: it walks the compose file's
 * whole `networks:` block rather than naming the three known networks, so a
 * FOURTH network added later with a fixed name fails here instead of on the
 * pool. That generalization is the actual lesson of this issue — the first two
 * fixes each closed one name they had been told about.
 *
 * The claim these assertions make is bounded, deliberately: every GLOBAL name
 * the compose file hands docker is derived, and so is the one host-wide object
 * beside them — the broker's published port, which collides across two stacks
 * on one box exactly as a fixed network name does. Objects the WORKER creates
 * through the host socket at run time are not in that set: they carry an
 * ownership LABEL rather than a name from this file, and teardown still sweeps
 * that label daemon-wide. Scoping the sweep needs a per-job ownership label the
 * worker itself stamps, which is product code and its own change.
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

/** The name the app-facing leg had when it was fixed, and the default today. */
const FIXED_APP_NETWORK = "cinatra-exec-app";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const HARNESS_PATH = path.join(
  REPO_ROOT,
  "packages/execution-plane/src/__tests__/e2e/support/exec-stack.ts",
);
const COMPOSE_PATH = path.join(REPO_ROOT, "docker-compose.exec.yml");
const BATTERY_PATH = path.join(
  REPO_ROOT,
  "packages/execution-plane/src/__tests__/e2e/service-boundary.e2e.test.ts",
);

const harnessSource = (): string => readFileSync(HARNESS_PATH, "utf8");
const composeSource = (): string => readFileSync(COMPOSE_PATH, "utf8");
const batterySource = (): string => readFileSync(BATTERY_PATH, "utf8");

/**
 * Every explicit network `name:` inside a compose file's top-level `networks:`
 * block, in file order — block form and inline flow mappings both, comments
 * ignored. A network with NO explicit name is not listed and does not need to
 * be: compose scopes that one to the project, which is already per job.
 */
const declaredNetworkNames = (source: string): readonly string[] => {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line === "networks:");
  expect(start).toBeGreaterThanOrEqual(0);
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    // A column-0 key ends the block.
    if (/^[A-Za-z]/.test(line)) break;
    const code = line.replace(/(^|\s)#.*$/, "$1");
    // A ${VAR:-default} value carries its own closing brace, so it is read as
    // one token before the flow mapping's terminator is honoured.
    for (const match of code.matchAll(/\bname:\s*(\$\{[^}]*\}|[^\s,}]+)/g)) names.push(match[1]);
  }
  return names;
};

/** What docker accepts as a network name. */
const LEGAL_NETWORK_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
/** The random tail `jobScopedName` ends every derived name with. */
const RUN_DISCRIMINATOR = /-[0-9a-f]{8}$/;

describe("the app-facing network name is derived per job", () => {
  it("carries the job's identity and is never the bare fixed name", () => {
    const name = execStack.appNetworkNameFor({
      GITHUB_RUN_ID: "17512345678",
      GITHUB_JOB: "batteries",
      GITHUB_RUN_ATTEMPT: "3",
    });
    expect(name).not.toBe(FIXED_APP_NETWORK);
    expect(name).toContain("17512345678");
    expect(name).toContain("batteries");
    expect(name).toMatch(LEGAL_NETWORK_NAME);
  });

  it("gives two legs of ONE run two different networks", () => {
    // Every leg of a matrix shares GITHUB_RUN_ID, GITHUB_JOB and the attempt —
    // there is no per-leg identifier in the environment at all — so the run's
    // identity alone would put two concurrent legs back onto one network.
    const shared = { GITHUB_RUN_ID: "17512345678", GITHUB_JOB: "batteries", GITHUB_RUN_ATTEMPT: "1" };
    expect(execStack.appNetworkNameFor({ ...shared })).not.toBe(
      execStack.appNetworkNameFor({ ...shared }),
    );
  });

  it("falls back to a unique name off CI, where there is no job identity at all", () => {
    const first = execStack.appNetworkNameFor({});
    const second = execStack.appNetworkNameFor({});
    expect(first).not.toBe(second);
    expect(first).not.toBe(FIXED_APP_NETWORK);
    expect(first).toMatch(LEGAL_NETWORK_NAME);
  });

  it("honours an explicit pin, so an operator can still name the network", () => {
    expect(execStack.appNetworkNameFor({ CINATRA_EXEC_APP_NETWORK: "pinned-net" })).toBe(
      "pinned-net",
    );
  });

  it("resolves the harness constant to a network of this run's own", () => {
    expect(execStack.APP_NETWORK).toMatch(LEGAL_NETWORK_NAME);
    // An explicit pin is the one way the constant may still be the shared name,
    // because that is the operator asking for it.
    if (!process.env.CINATRA_EXEC_APP_NETWORK) {
      expect(execStack.APP_NETWORK).not.toBe(FIXED_APP_NETWORK);
      // Not merely DIFFERENT from the old literal — a second fixed name such as
      // `cinatra-exec-app-shared` would satisfy that and be refused by compose
      // exactly as before. The constant must carry this process's own
      // discriminator.
      expect(execStack.APP_NETWORK).toMatch(RUN_DISCRIMINATOR);
      expect(execStack.APP_NETWORK.startsWith(`${FIXED_APP_NETWORK}-`)).toBe(true);
    }
  });

  it("names a different network from the other two legs of the same run", () => {
    // One variable per leg. Two of these resolving to one name would merge the
    // broker's app-facing bridge into the internal sandbox network, which is
    // the containment boundary gone.
    expect(execStack.APP_NETWORK).not.toBe(execStack.INTERNAL_NETWORK);
    expect(execStack.APP_NETWORK).not.toBe(execStack.EGRESS_NETWORK);
  });
});

describe("the rule the harness must keep for the app-facing network", () => {
  it("declares no fixed app network name for the stack to share", () => {
    expect(harnessSource()).not.toMatch(/export const APP_NETWORK\s*=\s*["'`]/);
  });

  it("derives it from the job identity, like the other two", () => {
    expect(harnessSource()).toMatch(/appNetworkNameFor\s*\(/);
  });

  it("hands the derived name to compose", () => {
    expect(harnessSource()).toMatch(/CINATRA_EXEC_APP_NETWORK:\s*APP_NETWORK/);
  });

  it("reclaims it only when this job itself named it", () => {
    // The pinned-name rule the sandbox and egress legs already carry: an
    // operator's own name may be an existing network somebody else
    // provisioned, and naming a network is not consent to have it destroyed.
    expect(harnessSource()).toMatch(
      /reclaimJobNetwork\(\s*APP_NETWORK,\s*"app",\s*APP_NETWORK_PINNED/,
    );
  });

  it("wires the remembered pin flag to the predicate, not to a constant", () => {
    // Asserting only the reclaim call's argument SPELLING leaves
    // `const APP_NETWORK_PINNED = false` green, and reclaim would then inspect
    // and remove a network an operator had named.
    expect(harnessSource()).toMatch(
      /const APP_NETWORK_PINNED\s*=\s*nameIsPinned\(\s*"CINATRA_EXEC_APP_NETWORK"\s*\)/,
    );
  });

  it("reads the pin state from the same variable the name comes from", () => {
    expect(execStack.nameIsPinned("CINATRA_EXEC_APP_NETWORK", {})).toBe(false);
    expect(execStack.nameIsPinned("CINATRA_EXEC_APP_NETWORK", { CINATRA_EXEC_APP_NETWORK: "  " })).toBe(
      false,
    );
    expect(
      execStack.nameIsPinned("CINATRA_EXEC_APP_NETWORK", {
        CINATRA_EXEC_APP_NETWORK: "operator-existing-net",
      }),
    ).toBe(true);
    // The name the harness would use is exactly the pin, so the two agree on
    // what "pinned" means and reclaim can never disagree with the resolver.
    expect(
      execStack.appNetworkNameFor({ CINATRA_EXEC_APP_NETWORK: "operator-existing-net" }),
    ).toBe("operator-existing-net");
  });

  it("inspects the job's own app network in the battery, not the old literal", () => {
    // The battery asserts the bridge's hardening options and that only the
    // broker is attached. Left on the literal it would inspect a network this
    // job did not create — another job's, or none at all.
    const source = batterySource();
    expect(source).not.toContain(`"${FIXED_APP_NETWORK}"`);
    expect(source).toMatch(/APP_NETWORK,\s*\]\);/);
  });
});

describe("the walker this file's last rule depends on actually sees a fixed name", () => {
  // The rule below is only worth as much as the walk that feeds it. It reads
  // BOTH declaration forms compose accepts, because a `name:` written inline
  // (`fourth: {name: shared}`) is the same global object as one written on its
  // own line, and a walk that saw only the block form would report the rule
  // kept while a fourth fixed network sat in the file.
  it("reads a name written on its own line", () => {
    expect(declaredNetworkNames(["networks:", "  one:", "    name: fixed-one", "x: y"].join("\n"))).toEqual([
      "fixed-one",
    ]);
  });

  it("reads a name written inline, in a flow mapping", () => {
    expect(
      declaredNetworkNames(["networks:", "  one: {name: fixed-one, driver: bridge}", "x: y"].join("\n")),
    ).toEqual(["fixed-one"]);
  });

  it("does not read a name out of a comment", () => {
    expect(
      declaredNetworkNames(["networks:", "  # the name: it used to have", "  one: {}", "x: y"].join("\n")),
    ).toEqual([]);
  });

  it("stops at the end of the block", () => {
    expect(
      declaredNetworkNames(["networks:", "  one:", "    name: fixed-one", "services:", "  s:", "    name: not-a-network"].join("\n")),
    ).toEqual(["fixed-one"]);
  });
});

describe("the broker's published port is per job too", () => {
  // A published port is a host-wide object, not a project-scoped one: two
  // stacks on one runner box cannot both bind 127.0.0.1:4100, so a fixed
  // publish refuses the second job at `up` the way the fixed network name did.
  it("is not the fixed port, and is a legal TCP port", () => {
    const port = execStack.brokerHostPortFor({});
    expect(port).not.toBe(4100);
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(1023);
    expect(port).toBeLessThan(65_536);
  });

  it("gives two legs of ONE run two different ports", () => {
    const shared = { GITHUB_RUN_ID: "17512345678", GITHUB_JOB: "batteries", GITHUB_RUN_ATTEMPT: "1" };
    const ports = new Set(
      Array.from({ length: 12 }, () => execStack.brokerHostPortFor({ ...shared })),
    );
    // The identity is shared by every leg; the randomness is what separates
    // them, so twelve draws must not all land on one port.
    expect(ports.size).toBeGreaterThan(1);
  });

  it("honours an explicit pin and refuses one that is not a port", () => {
    expect(execStack.brokerHostPortFor({ CINATRA_EXEC_BROKER_HOST_PORT: "4100" })).toBe(4100);
    expect(() => execStack.brokerHostPortFor({ CINATRA_EXEC_BROKER_HOST_PORT: "not-a-port" })).toThrow();
    expect(() => execStack.brokerHostPortFor({ CINATRA_EXEC_BROKER_HOST_PORT: "70000" })).toThrow();
  });

  it("resolves the harness constant once and hands it to compose", () => {
    expect(Number.isInteger(execStack.BROKER_HOST_PORT)).toBe(true);
    if (!process.env.CINATRA_EXEC_BROKER_HOST_PORT) {
      expect(execStack.BROKER_HOST_PORT).not.toBe(4100);
    }
    expect(harnessSource()).toMatch(
      /CINATRA_EXEC_BROKER_HOST_PORT:\s*String\(BROKER_HOST_PORT\)/,
    );
    expect(harnessSource()).toMatch(/export const BROKER_HOST_PORT\s*=\s*brokerHostPortFor\(\)/);
  });

  it("leaves an ordinary deployment on the port it always published", () => {
    // The container port never moves; only the host side is a variable, and
    // unset it is the historical literal.
    expect(composeSource()).toContain('"127.0.0.1:${CINATRA_EXEC_BROKER_HOST_PORT:-4100}:4100"');
    expect(composeSource()).not.toMatch(/^\s+-\s*"127\.0\.0\.1:4100:4100"\s*$/m);
  });
});

describe("the compose file reads the same variable, and defaults to today's name", () => {
  it("names the app-facing network from the variable", () => {
    const compose = composeSource();
    expect(compose).toContain("name: ${CINATRA_EXEC_APP_NETWORK:-cinatra-exec-app}");
    expect(compose).not.toMatch(/^\s+name:\s*cinatra-exec-app\s*$/m);
  });

  it("leaves the two earlier variables exactly as cinatra#3320 and the first leg left them", () => {
    // This file must not be able to pass by having quietly changed those rules.
    const compose = composeSource();
    expect(compose).toContain("name: ${CINATRA_EXEC_SANDBOX_NETWORK:-cinatra-exec-internal}");
    expect(compose).toContain("name: ${CINATRA_EXEC_EGRESS_NETWORK:-cinatra-exec-egress}");
  });
});

describe("no fixed name reaches docker from the compose file at all", () => {
  it("gives EVERY declared network a variable with the historical default", () => {
    const names = declaredNetworkNames(composeSource());
    // The three the harness knows about today. A fourth added later lands here
    // too, which is the point of walking the block instead of naming them.
    expect(names.length).toBe(3);
    for (const name of names) {
      expect(name).toMatch(/^\$\{CINATRA_EXEC_[A-Z_]+:-[a-z0-9][a-z0-9-]*\}$/);
    }
  });

  it("pins no container name, so two jobs never collide on one container", () => {
    expect(composeSource()).not.toMatch(/^\s*container_name:/m);
  });

  it("declares no top-level volume, so this rule has nothing more to cover", () => {
    // A plain named volume is NOT automatically shared — compose scopes it to
    // the project as `<project>_<key>`, and the project is per job. It would
    // only become a global name by carrying its own explicit `name:`, the way
    // the networks did. There is no top-level `volumes:` block at all, so the
    // question does not arise; this assertion is what makes a future one land
    // here, where the explicit-name rule can be applied to it.
    expect(composeSource()).not.toMatch(/^volumes:/m);
  });

  it("keeps the compose project default at column 0, where `-p` supersedes it", () => {
    // The file's own `name: cinatra-exec` is the PROJECT default for a
    // deployment that runs compose without `-p`. The harness passes `-p` on
    // every invocation (asserted in the sibling file), so it never reaches
    // docker from a battery — it is not a residual fixed name.
    expect(composeSource()).toMatch(/^name: cinatra-exec$/m);
    const invocations = harnessSource().match(/\["compose",/g) ?? [];
    const scoped = harnessSource().match(/\["compose",\s*"-p",\s*COMPOSE_PROJECT,/g) ?? [];
    expect(invocations.length).toBeGreaterThan(0);
    expect(scoped.length).toBe(invocations.length);
  });
});
