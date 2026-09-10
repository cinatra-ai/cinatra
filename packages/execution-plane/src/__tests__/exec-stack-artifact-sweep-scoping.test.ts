/**
 * THE HARNESS'S OWN DOCKER LOOKUPS ARE SCOPED TO THE JOB (cinatra#3327).
 *
 * Three sibling files pin the NAMES this harness hands docker — the sandbox
 * network (cinatra#3320), the compose project with the gateway's egress leg,
 * and the broker's app-facing leg with the published port. With those derived
 * per job the stack finally came up under four concurrent batteries on one
 * self-hosted daemon. Every battery then failed a class of test it had never
 * failed alone, and all of it was one defect wearing three costumes: the names
 * were per job, the LOOKUPS were not.
 *
 *   - the wall-clock-kill arm asserted "no container left" from `docker ps
 *     --filter name=cinatra-exec-`, a bare SUBSTRING match that also matches a
 *     concurrent job's compose containers (`<project>-cinatra-exec-broker-1`
 *     contains it), and reported another job's broker as its own leftover;
 *   - teardown's artifact sweep force-removed EVERY container and volume on the
 *     daemon carrying the plane's ownership label, so the first job to finish
 *     destroyed the live sandboxes of the three still running — which surfaced
 *     in the sibling as "a run with work in flight is never reaped", a reaper
 *     defect the reaper had no part in;
 *   - the three built images shared one tag, and `docker build -t` MOVES a tag,
 *     so a rebuild re-pointed the ref another job's stack was resolving.
 *
 * The rule this file pins, then: every docker lookup the harness or a battery
 * makes selects on something that names THIS job — the job id a container
 * carries on its ownership label, the volume name derived from this run's own
 * job ids and run keys, an image tag carrying the job's identity — and never on
 * a shared label, a shared tag or a bare name substring.
 *
 * These are SHAPE assertions plus the pure ownership predicate, deliberately.
 * The functional proof that four concurrent battery jobs no longer reach into
 * each other needs four real jobs on one machine with a docker daemon, which
 * this tier does not have. What is provable here — and what a future edit could
 * silently undo — is the rule itself.
 *
 * The harness is imported as a NAMESPACE on purpose, exactly as its sibling
 * files do it. A file that names an export the previous head does not have
 * fails to LOAD there, and a suite that cannot load reports one collection
 * error instead of the several failures that say WHICH part of the rule is
 * missing. Through the namespace this file runs on either head and every
 * assertion answers for itself.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SANDBOX_CONTAINER_JOB_LABEL, SANDBOX_CONTAINER_LABEL } from "../l0-profile";
import { skillsVolumeName } from "../staging";
import { workspaceVolumeName } from "../workspace";
import * as execStack from "./e2e/support/exec-stack";

/** The one tag all three built images carried while it was shared. */
const FIXED_IMAGE_TAG = "l5e2e";
/** The bare substring the wall-clock-kill arm used to hand `docker ps`. */
const FIXED_NAME_SUBSTRING = "name=cinatra-exec-";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const HARNESS_PATH = path.join(
  REPO_ROOT,
  "packages/execution-plane/src/__tests__/e2e/support/exec-stack.ts",
);
const DOCKER_BATTERY_PATH = path.join(
  REPO_ROOT,
  "packages/execution-plane/src/__tests__/e2e/docker-battery.e2e.test.ts",
);
const SERVICE_BOUNDARY_PATH = path.join(
  REPO_ROOT,
  "packages/execution-plane/src/__tests__/e2e/service-boundary.e2e.test.ts",
);
const LOAD_BATTERY_PATH = path.join(
  REPO_ROOT,
  "packages/execution-plane/src/__tests__/e2e/load-battery.e2e.test.ts",
);
const COMPOSE_PATH = path.join(REPO_ROOT, "docker-compose.exec.yml");

const harnessSource = (): string => readFileSync(HARNESS_PATH, "utf8");
const dockerBatterySource = (): string => readFileSync(DOCKER_BATTERY_PATH, "utf8");
const composeSource = (): string => readFileSync(COMPOSE_PATH, "utf8");
const serviceBoundarySource = (): string => readFileSync(SERVICE_BOUNDARY_PATH, "utf8");
const loadBatterySource = (): string => readFileSync(LOAD_BATTERY_PATH, "utf8");
/** The shared L0 tag two battery FILES built while it was one reference. */
const SHARED_L0_TAG = "cinatra-sandbox-l0:dev";

/** What docker accepts as the tag half of an image reference. */
const LEGAL_IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
/** The random tail every derived name in this harness ends with. */
const RUN_DISCRIMINATOR = /-[0-9a-f]{8}$/;

const CI_JOB = {
  GITHUB_RUN_ID: "17512345678",
  GITHUB_JOB: "batteries",
  GITHUB_RUN_ATTEMPT: "3",
} as const;

describe("the built image tags are derived per job", () => {
  it("carries the job's identity and is never the bare shared tag", () => {
    const ref = execStack.jobScopedImageFor("cinatra-sandbox-l0", { ...CI_JOB });
    expect(ref).not.toBe(`cinatra-sandbox-l0:${FIXED_IMAGE_TAG}`);
    const [repository, tag] = ref.split(":");
    expect(repository).toBe("cinatra-sandbox-l0");
    expect(tag).toContain("17512345678");
    expect(tag).toContain("batteries");
    expect(tag).toMatch(LEGAL_IMAGE_TAG);
  });

  it("gives two legs of ONE run two different tags", () => {
    // Every leg of a matrix shares the run id, the job and the attempt — there
    // is no per-leg identifier in the environment at all — so identity alone
    // would put two concurrent legs back onto one tag, which is where a
    // `docker build -t` of one leg takes the ref the other is resolving.
    expect(execStack.jobScopedImageFor("cinatra-exec-worker", { ...CI_JOB })).not.toBe(
      execStack.jobScopedImageFor("cinatra-exec-worker", { ...CI_JOB }),
    );
  });

  it("falls back to a unique tag off CI, where there is no job identity at all", () => {
    const first = execStack.jobScopedImageFor("cinatra-exec-worker", {});
    const second = execStack.jobScopedImageFor("cinatra-exec-worker", {});
    expect(first).not.toBe(second);
    expect(first.split(":")[1]).toMatch(LEGAL_IMAGE_TAG);
  });

  it("resolves the three harness constants to this run's own images", () => {
    for (const [ref, repository] of [
      [execStack.L0_IMAGE, "cinatra-sandbox-l0"],
      [execStack.WORKER_IMAGE, "cinatra-exec-worker"],
      [execStack.BROKER_IMAGE, "cinatra-exec-broker-carrier"],
    ] as const) {
      expect(ref).not.toBe(`${repository}:${FIXED_IMAGE_TAG}`);
      expect(ref.startsWith(`${repository}:${FIXED_IMAGE_TAG}-`)).toBe(true);
      // Not merely DIFFERENT from the old literal — a second fixed tag such as
      // `l5e2e-batteries` would satisfy that and be shared by every job on the
      // box exactly as before. The tag must carry this process's own
      // discriminator.
      expect(ref).toMatch(RUN_DISCRIMINATOR);
      expect(ref.split(":")[1]).toMatch(LEGAL_IMAGE_TAG);
    }
  });

  it("gives the three images three different refs", () => {
    const refs = new Set([execStack.L0_IMAGE, execStack.WORKER_IMAGE, execStack.BROKER_IMAGE]);
    expect(refs.size).toBe(3);
  });

  it("declares no fixed tag for the three of them to share", () => {
    const source = harnessSource();
    expect(source).not.toMatch(/export const L0_IMAGE\s*=\s*["'`]/);
    expect(source).not.toMatch(/export const WORKER_IMAGE\s*=\s*["'`]/);
    expect(source).not.toMatch(/export const BROKER_IMAGE\s*=\s*["'`]/);
  });

  it("hands the derived refs to compose, so the stack runs what it built", () => {
    const source = harnessSource();
    expect(source).toMatch(/CINATRA_SANDBOX_L0_IMAGE:\s*L0_IMAGE/);
    expect(source).toMatch(/CINATRA_EXEC_WORKER_IMAGE:\s*WORKER_IMAGE/);
    expect(source).toMatch(/CINATRA_APP_IMAGE:\s*BROKER_IMAGE/);
  });

  it("leaves a deployment to name its own images, exactly as before", () => {
    // The harness resolves these three refs and passes them in; the compose
    // file still REQUIRES each variable and invents nothing, so a deployment
    // that sets them itself is byte-for-byte the topology it was.
    const compose = composeSource();
    expect(compose).toContain("${CINATRA_EXEC_WORKER_IMAGE:?");
    expect(compose).toContain("${CINATRA_SANDBOX_L0_IMAGE:?");
    expect(compose).toContain("${CINATRA_APP_IMAGE:?");
    expect(compose).not.toContain(FIXED_IMAGE_TAG);
  });
});

describe("the teardown sweep owns what this run created, and nothing else", () => {
  const owned = {
    jobIds: new Set(["job-of-this-run"]),
    workspaceKeys: new Set(["run-of-this-run"]),
  };

  it("claims a sandbox container by the job id it carries on its label", () => {
    expect(execStack.artifactsOwnedBy(owned).ownsJob("job-of-this-run")).toBe(true);
  });

  it("leaves a CONCURRENT job's container alone", () => {
    // The whole defect: the ownership label is identical on every execution
    // plane on the machine, so a sweep that selected on the label alone
    // force-removed a sibling job's live sandboxes the instant this one
    // finished.
    expect(execStack.artifactsOwnedBy(owned).ownsJob("job-of-another-run")).toBe(false);
  });

  it("refuses a container that carries no job id at all", () => {
    // An empty label column is "I could not tell whose this is", which is not
    // a licence to remove it.
    expect(execStack.artifactsOwnedBy(owned).ownsJob("")).toBe(false);
  });

  it("claims this run's skills volume and this run's L2 workspace volume", () => {
    const scope = execStack.artifactsOwnedBy(owned);
    expect(scope.ownsVolume(skillsVolumeName("job-of-this-run"))).toBe(true);
    expect(scope.ownsVolume(workspaceVolumeName("run-of-this-run"))).toBe(true);
  });

  it("leaves a CONCURRENT job's volumes alone", () => {
    const scope = execStack.artifactsOwnedBy(owned);
    expect(scope.ownsVolume(skillsVolumeName("job-of-another-run"))).toBe(false);
    expect(scope.ownsVolume(workspaceVolumeName("run-of-another-run"))).toBe(false);
  });

  it("owns nothing at all when nothing was registered", () => {
    // The safe direction of the trade, stated as a test: a battery that
    // registers no job leaves its own leftovers on the host rather than
    // reaching into a sibling's.
    const none = execStack.artifactsOwnedBy({ jobIds: new Set(), workspaceKeys: new Set() });
    expect(none.ownsJob("job-of-another-run")).toBe(false);
    expect(none.ownsVolume(skillsVolumeName("job-of-another-run"))).toBe(false);
  });
});

describe("the rule the harness must keep for its own docker lookups", () => {
  it("takes the run's ownership as an argument rather than sweeping the daemon", () => {
    expect(harnessSource()).toMatch(
      /export async function sweepExecArtifacts\(\s*owned\?:\s*ExecArtifactOwnership\s*\)/,
    );
  });

  it("reads the job label off each listed container instead of trusting the tier label", () => {
    // Asserting only that the sweep takes an argument leaves a body that
    // ignores it green. The listing must actually carry the job id, which is
    // the only thing that distinguishes this run's containers from a sibling's.
    const source = harnessSource();
    expect(source).toMatch(/\{\{\.Label "\$\{SANDBOX_CONTAINER_JOB_LABEL\}"\}\}/);
    expect(source).toMatch(/scope\s*&&\s*!scope\.ownsJob\(/);
    expect(source).toMatch(/scope\s*&&\s*!scope\.ownsVolume\(/);
  });

  it("hands teardown the ownership this stack collected", () => {
    // A sweep that can be scoped but is called unscoped is the old sweep.
    expect(harnessSource()).toMatch(
      /sweepExecArtifacts\(\{\s*jobIds:\s*ownedJobIds,\s*workspaceKeys:\s*ownedWorkspaceKeys\s*\}\)/,
    );
  });

  it("gives the stack a way to be told which jobs are its own", () => {
    expect(harnessSource()).toMatch(/own\(runKey:\s*string,\s*jobId:\s*string\):\s*void;/);
  });

  it("keeps the lease, env, TLS and work directories under this run's own temp root", () => {
    // Already true, and load-bearing enough to hold: a shared path under a
    // fixed name is the same collision one layer off the daemon. The lease
    // directory is the one the broker takes its mkdir mutex in.
    const source = harnessSource();
    expect(source).toMatch(/mkdtempSync\(path\.join\(os\.tmpdir\(\), "cinatra-exec-l5-"\)\)/);
    expect(source).toMatch(/const tlsDir = path\.join\(workDir, "tls"\)/);
    expect(source).toMatch(/const envDir = path\.join\(workDir, "env"\)/);
    expect(source).toMatch(/const leaseDir = path\.join\(workDir, "lease"\)/);
  });

  it("drops only the image tags this run itself built", () => {
    const source = harnessSource();
    expect(source).toMatch(/async function removeJobScopedImages\(\)/);
    expect(source).toMatch(/\["image", "rm", tag\]/);
  });
});

describe("the docker battery's own container listing is scoped to its job", () => {
  it("no longer hands docker a bare name substring", () => {
    expect(dockerBatterySource()).not.toContain(FIXED_NAME_SUBSTRING);
  });

  it("asserts the wall-clock kill on THIS job's ownership label", () => {
    // Anchored to THAT arm. The file already filtered on the job label
    // elsewhere (the AC9 container ledger), so a bare search for the label
    // would report this rule kept while the arm that actually failed on the
    // pool went on passing docker a name substring.
    expect(dockerBatterySource()).toMatch(
      /Fresh-container-per-command[\s\S]{0,900}?runDocker\(\[\s*"ps",\s*"--filter",\s*`label=\$\{SANDBOX_CONTAINER_JOB_LABEL\}=\$\{jobId\}`/,
    );
  });

  it("removes only its own skills volumes in teardown", () => {
    // The same host-wide-sweep defect one file over: the stray-volume sweep
    // listed every volume on the daemon carrying the retention tier label.
    const source = dockerBatterySource();
    expect(source).toMatch(/const ours = new Set\(createdJobIds\.map\(/);
    expect(source).toMatch(/if \(!ours\.has\(name\)\) continue;/);
  });

  it("records every job it opens, including the ones it never names", () => {
    // Executor- and tool-opened jobs mint their own ids, which no call site
    // sees. Without them the teardown above could not name its own volumes and
    // would be back to removing every one on the daemon.
    expect(dockerBatterySource()).toMatch(/broker\.openJob\s*=\s*\(async/);
    expect(dockerBatterySource()).toMatch(/createdJobIds\.push\(opened\.jobId\)/);
  });
});

describe("the labels these lookups select on are the ones the plane stamps", () => {
  it("uses the plane's own label constants, not transcribed strings", () => {
    // A transcribed label drifts silently: the sweep would list nothing, remove
    // nothing, and report a clean teardown while the host filled up.
    expect(SANDBOX_CONTAINER_LABEL).toBe("ai.cinatra.execution-plane");
    expect(SANDBOX_CONTAINER_JOB_LABEL).toBe("ai.cinatra.execution-plane.job");
    const source = harnessSource();
    expect(source).toMatch(/label=\$\{SANDBOX_CONTAINER_LABEL\}/);
    expect(source).not.toMatch(/"label=ai\.cinatra\.execution-plane"/);
  });

  it("names this run's volumes with the plane's own name builders", () => {
    // The L2 volume is named after the session's RUN id and the skills volume
    // after the JOB id; two builders, so the sweep cannot guess one shape for
    // both and quietly own neither.
    const source = harnessSource();
    expect(source).toMatch(/skillsVolumeName\(jobId\)/);
    expect(source).toMatch(/workspaceVolumeName\(key\)/);
  });
});

describe("nothing a job creates outlives the ownership that can reclaim it", () => {
  it("claims the workspace volume of a job opened WITHOUT a run id", () => {
    // The broker's workspace key is `session.runId ?? jobId`, so an owned job
    // with no run key names its L2 volume after the job id. A predicate that
    // built only the run-key spelling would leave that volume on the host for
    // good — no later run can name it either, because no later run knows the
    // job id.
    const owns = execStack.artifactsOwnedBy({
      jobIds: new Set(["job-without-a-run"]),
      workspaceKeys: new Set<string>(),
    });
    expect(owns.ownsVolume(workspaceVolumeName("job-without-a-run"))).toBe(true);
    expect(owns.ownsVolume(skillsVolumeName("job-without-a-run"))).toBe(true);
    // Still nobody else's.
    expect(owns.ownsVolume(workspaceVolumeName("run-of-another-job"))).toBe(false);
  });

  it("drops this run's unique image tags when SETUP itself fails", () => {
    // Teardown is reached through `stack.down()`, and a battery whose bring-up
    // throws never receives a stack. With the tags unique to this run, a worker
    // build that fails after the L0 build succeeded leaves that tag on a
    // self-hosted box permanently: the next process derives a different name
    // and cannot name this one.
    const source = harnessSource();
    expect(source).toMatch(
      /export async function bringUpExecStack\([\s\S]{0,200}?try \{[\s\S]{0,120}?bringUpExecStackOrThrow\(options\)/,
    );
    expect(source).toMatch(/catch \(error\)[\s\S]{0,1400}?await removeJobScopedImages\(\);[\s\S]{0,80}?throw error;/);
  });

  it("claims the run key BEFORE the open that provisions its volume", () => {
    // The broker provisions the L2 workspace for the run key before it can
    // refuse for a later reason, and every arm that opens expecting a refusal
    // provisions nothing only because the refusal came first. Registering after
    // a returned job id therefore leaves a real class of volume owned by
    // nobody — and the sweep now removes only what is owned.
    expect(serviceBoundarySource()).toMatch(
      /function carrierFor\([\s\S]{0,900}?stack\.own\(runId, ""\);[\s\S]{0,80}?return sealExecutionSession/,
    );
    expect(loadBatterySource()).toMatch(
      /stack\.own\(runId, ""\);\s*\n\s*const opened = await app\.openJob\(carrier\);/,
    );
  });

  it("reads the broker-to-worker receipt as THIS run's own volume", () => {
    // A listing of every l2 volume on the daemon is satisfied by a concurrent
    // battery's workspace, so that arm passed on a sibling's artifact and would
    // have stayed green with the hop broken.
    const source = serviceBoundarySource();
    expect(source).toMatch(/expect\(names\)\.toContain\(workspaceVolumeName\(runId\)\)/);
    expect(source).not.toMatch(/expect\(volumes\.stdout\.trim\(\)\.length\)\.toBeGreaterThan\(0\)/);
  });

  it("gives the docker battery's own L0 build a tag no sibling file shares", () => {
    // `environment-promotion-rebuild.e2e.test.ts` builds the very same context
    // under the very same tag, and the two are separate concurrent battery
    // jobs: one shared, host-wide, MUTABLE reference that `docker build -t`
    // moves. The harness's three images were scoped; this fourth tag is in a
    // battery the harness does not reach.
    const source = dockerBatterySource();
    expect(source).not.toContain(`"${SHARED_L0_TAG}"`);
    expect(source).toMatch(/const IMAGE = jobScopedImageFor\("cinatra-sandbox-l0"\)/);
    expect(source).toMatch(/await runDocker\(\["image", "rm", IMAGE\]\)/);
  });

  it("tells the truth about what the load battery's stack guard can still catch", () => {
    // A derived project name ends in a discriminator minted in THIS process, so
    // it cannot name an earlier attempt's stack either. Claiming the guard
    // catches "this job's own leftovers" would be a comment that reads as a
    // safety net and is none.
    const source = loadBatterySource();
    expect(source).toContain("CINATRA_EXEC_COMPOSE_PROJECT");
    expect(source).not.toMatch(/a stack an earlier attempt of this same job\s*\n?\s*\*? ?left behind/);
  });
});
