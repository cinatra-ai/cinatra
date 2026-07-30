/**
 * REAL-CONTAINER drain (exec-plane L3). Part of the Docker E2E battery.
 *
 * The unit suite proves the broker DECIDES to drain and issues the right argv.
 * That is not the same as a container actually being gone: `docker rm --force`
 * on a live container is the step where a name-matching mistake, an unanchored
 * filter or a wrong flag would show up, and no fake `DockerCli` can fail that
 * way. So this case starts a real, long-running container under the real
 * `containerNameFor` name and asserts the real drain removes it.
 *
 * Run with: pnpm test:e2e   (package: @cinatra-ai/execution-plane)
 * FAILS — never skips — when docker is unavailable: a green run always means
 * the real thing ran.
 *
 * Uses a minimal base image rather than the battery's L0 build on purpose: the
 * drain matches on container NAME and is image-agnostic by construction, so
 * paying for the L0 build here would buy nothing but minutes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { runDocker } from "../../docker-cli";
import {
  SANDBOX_CONTAINER_JOB_LABEL,
  SANDBOX_CONTAINER_LABEL,
  containerNameFor,
  containerNamePrefixFor,
} from "../../l0-profile";
import { createLocalDockerContainerOps } from "../../volume-ops";

const BASE_IMAGE = "busybox:stable";

const jobId = `e2e-drain-${randomUUID()}`;
const containers = [containerNameFor(jobId, 0), containerNameFor(jobId, 1)];
/** Another job's container: same namespace, different label. */
const otherJobId = `e2e-drain-${randomUUID()}`;
const otherJobContainer = containerNameFor(otherJobId, 0);
/**
 * A container carrying THIS job's name shape but NOT its label — the case a
 * name-only drain would have taken and an ownership-labelled one must not.
 */
const unlabelledLookalike = containerNameFor(jobId, 99);
/**
 * A container of the DIFFERENT job `<jobId>-nested`, whose names all begin with
 * this job's prefix. The anchored name check is what keeps it out.
 */
const nestedJobContainer = containerNameFor(`${jobId}-nested`, 0);

async function isRunning(name: string): Promise<boolean> {
  const inspected = await runDocker(["inspect", "--format", "{{.State.Running}}", name]);
  return inspected.exitCode === 0 && inspected.stdout.trim() === "true";
}

async function startSleeper(name: string, labelJobId?: string): Promise<void> {
  const started = await runDocker([
    "run",
    "-d",
    "--name",
    name,
    ...(labelJobId
      ? [
          "--label",
          `${SANDBOX_CONTAINER_LABEL}=sandbox`,
          "--label",
          `${SANDBOX_CONTAINER_JOB_LABEL}=${labelJobId}`,
        ]
      : []),
    "--network",
    "none",
    BASE_IMAGE,
    "sleep",
    "300",
  ]);
  if (started.exitCode !== 0) {
    throw new Error(`could not start ${name}: ${started.stderr.trim()}`);
  }
}

beforeAll(async () => {
  const daemon = await runDocker(["version", "--format", "{{.Server.Version}}"]);
  if (daemon.exitCode !== 0) {
    throw new Error(
      `the drain E2E requires a running docker daemon: ${daemon.stderr.trim()}`,
    );
  }
  const pulled = await runDocker(["pull", BASE_IMAGE], { timeoutMs: 180_000 });
  if (pulled.exitCode !== 0) {
    throw new Error(`could not pull ${BASE_IMAGE}: ${pulled.stderr.trim()}`);
  }
}, 300_000);

afterAll(async () => {
  for (const name of [
    ...containers,
    otherJobContainer,
    unlabelledLookalike,
    nestedJobContainer,
  ]) {
    await runDocker(["rm", "--force", name]);
  }
});

describe("host-exclusivity drain — real containers", () => {
  it("force-removes every container of the job and nothing else", async () => {
    for (const name of containers) await startSleeper(name, jobId);
    await startSleeper(otherJobContainer, otherJobId);
    await startSleeper(nestedJobContainer, `${jobId}-nested`);
    // Labelled for NOTHING, but named exactly like one of this job's.
    await startSleeper(unlabelledLookalike);
    const bystanders = [otherJobContainer, nestedJobContainer, unlabelledLookalike];
    for (const name of [...containers, ...bystanders]) {
      expect(await isRunning(name)).toBe(true);
    }

    const cancelled = await createLocalDockerContainerOps().cancelJobContainers(jobId);

    expect(cancelled.sort()).toEqual([...containers].sort());
    for (const name of containers) {
      expect(await isRunning(name)).toBe(false);
    }
    // Each bystander defeats a DIFFERENT wrong implementation:
    //  - otherJobContainer: a filter on the shared `cinatra-exec-` namespace;
    //  - nestedJobContainer: an unanchored prefix test (job `<jobId>-nested`
    //    shares this job's whole prefix);
    //  - unlabelledLookalike: a name-only drain with no ownership proof.
    for (const name of bystanders) {
      expect(await isRunning(name)).toBe(true);
    }
    expect(containerNamePrefixFor(jobId).endsWith("-")).toBe(true);
  }, 180_000);

  it("is idempotent — a second drain finds nothing and does not throw", async () => {
    await expect(
      createLocalDockerContainerOps().cancelJobContainers(jobId),
    ).resolves.toEqual([]);
  }, 60_000);
});
