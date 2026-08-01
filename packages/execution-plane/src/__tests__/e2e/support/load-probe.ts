/**
 * The MEASUREMENT half of the exec-plane LOAD BATTERY (epic cinatra#1705, AC7).
 *
 * AC7 asks for recorded numbers, not for a green assertion: peak concurrent
 * sandbox containers, a return to zero between commands, and a bounded
 * worker-host envelope across a burst. Those are observations of a running
 * host, so they live here rather than in the battery — and every one of them
 * is read from `docker` itself. Nothing in this module simulates a container,
 * a count or a resource reading.
 *
 * SIBLING-SAFE BY CONSTRUCTION. The ownership label the worker stamps
 * (`ai.cinatra.execution-plane=sandbox`) is shared by every execution plane on
 * the host, so a bare count would silently fold a concurrently-running lane's
 * containers into this battery's peak — inflating it past a ceiling that was
 * never breached, or (worse) hiding a real breach behind an unrelated dip. The
 * sampler therefore reads the per-container JOB label and counts only jobs this
 * battery opened.
 */
import { docker } from "./exec-stack";
import { SANDBOX_CONTAINER_LABEL, SANDBOX_CONTAINER_JOB_LABEL } from "../../../l0-profile";

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Live sandbox containers belonging to `jobIds`.
 *
 * `docker ps` is the source of truth on purpose: the broker's own
 * `executingCount` lives in the broker process and would be the implementation
 * reporting on itself, while a container either exists on the host or does not.
 *
 * FAIL-CLOSED, and this is the whole point of the function. The `docker`
 * wrapper RESOLVES on a non-zero exit rather than throwing, so a probe that
 * could not answer returns empty stdout — and an empty listing is
 * indistinguishable from the answer "no containers are running". Every clause
 * this module supports would then be satisfiable by a BROKEN probe: "drained
 * to zero" would pass, and a peak would be understated. So a failed `docker
 * ps` throws. The sampler's loops catch and skip the sample (their sample
 * COUNTS are asserted, so systematic failure still surfaces); the wait helpers
 * and the direct assertions propagate it, which is the correct outcome — "I
 * cannot see the host" is not evidence that the host is idle.
 */
export async function liveSandboxes(
  jobIds: ReadonlySet<string>,
): Promise<Array<{ id: string; jobId: string }>> {
  const listed = await docker([
    "ps",
    "--filter",
    `label=${SANDBOX_CONTAINER_LABEL}=sandbox`,
    "--format",
    `{{.ID}}\t{{.Label "${SANDBOX_CONTAINER_JOB_LABEL}"}}`,
  ]);
  if (listed.exitCode !== 0) {
    throw new Error(
      `docker ps failed (exit ${listed.exitCode}); refusing to read that as "no ` +
        `containers are running": ${listed.stderr.trim().slice(0, 300)}`,
    );
  }
  return listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [id, jobId] = line.split("\t");
      return { id: (id ?? "").trim(), jobId: (jobId ?? "").trim() };
    })
    .filter((row) => row.id.length > 0 && jobIds.has(row.jobId));
}

export async function liveSandboxJobs(jobIds: ReadonlySet<string>): Promise<string[]> {
  return (await liveSandboxes(jobIds)).map((row) => row.jobId);
}

/** Bytes from one `docker stats` size field ("12.34MiB", "1.5GiB", "900B"). */
export function parseStatsBytes(text: string): number {
  const match = /^([0-9.]+)\s*([A-Za-z]*)$/.exec(text.trim());
  if (!match) return Number.NaN;
  const scale: Record<string, number> = {
    "": 1,
    b: 1,
    kb: 1_000,
    kib: 1_024,
    mb: 1_000_000,
    mib: 1_024 * 1_024,
    gb: 1_000_000_000,
    gib: 1_024 * 1_024 * 1_024,
  };
  const unit = scale[match[2].toLowerCase()];
  return unit === undefined ? Number.NaN : Number(match[1]) * unit;
}

export type Reading = { memBytes: number; cpuPercent: number; pids: number };

/**
 * Do two docker container ids denote the same container?
 *
 * `docker compose ps -q` hands back the FULL 64-char id while `docker ps` and
 * `docker stats` print the 12-char short form, so the two snapshots this module
 * correlates never match with `===`. The length floor keeps a truncated or
 * empty field from matching everything.
 */
export function sameContainer(a: string, b: string): boolean {
  if (a.length < 12 || b.length < 12) return false;
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * ONE `docker stats --no-stream` reading of EVERY running container, keyed by
 * id.
 *
 * WHY THE WHOLE HOST rather than an explicit id list, which is what this
 * module did first and what cost a real (and instructive) flake: `docker stats`
 * fails the WHOLE invocation with `No such container` the moment ONE listed id
 * has exited, printing nothing at all. Sandbox containers are ephemeral by
 * design — a `docker ps` snapshot is stale within milliseconds — so an
 * id-list reading of the sandbox fleet loses the containers that are still
 * alive along with the one that is not. That surfaced as `sandboxStatSamples`
 * of zero on a burst whose containers were all genuinely measured moments
 * earlier: a probe that fails ENTIRELY, and a battery that reds for a reason
 * that has nothing to do with the plane.
 *
 * A whole-host reading cannot fail that way (there is no id to be missing),
 * and on a loaded host it is not even slower — one call for the worker AND the
 * fleet instead of two. The caller filters by id, so a sibling lane's
 * containers are read and discarded, never counted.
 */
export async function readHostStats(): Promise<Map<string, Reading>> {
  const out = await docker(
    ["stats", "--no-stream", "--format", "{{.ID}}|{{.MemUsage}}|{{.CPUPerc}}|{{.PIDs}}"],
    { timeoutMs: 60_000 },
  );
  if (out.exitCode !== 0) {
    throw new Error(
      `docker stats failed (exit ${out.exitCode}): ${out.stderr.trim().slice(0, 300)}`,
    );
  }
  const rows = new Map<string, Reading>();
  for (const line of out.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const [id, mem, cpu, pids] = line.split("|");
    const containerId = (id ?? "").trim();
    if (containerId.length === 0) continue;
    const memBytes = parseStatsBytes((mem ?? "").split("/")[0] ?? "");
    const cpuPercent = Number((cpu ?? "").replace("%", "").trim());
    const pidCount = Number((pids ?? "").trim());
    // ALL THREE OR NOTHING. An unparseable CPU field used to be coerced to 0
    // and folded into the sum, which made "CPU stayed under the ceiling" a
    // clause a broken parse could satisfy: an upper bound is trivially met by
    // a fabricated zero. A row is now either fully read or dropped, so an
    // unreadable fleet shows up where it is already asserted — in the sample
    // count — rather than as a comfortable-looking number.
    if (
      !Number.isFinite(memBytes) ||
      !Number.isFinite(pidCount) ||
      !Number.isFinite(cpuPercent)
    ) {
      continue;
    }
    rows.set(containerId, { memBytes, pids: pidCount, cpuPercent });
  }
  return rows;
}

/** Sum the readings of the containers in `ids` that this snapshot actually saw. */
export function sumReadings(
  stats: ReadonlyMap<string, Reading>,
  ids: readonly string[],
): { total: Reading; read: number } | null {
  const total: Reading = { memBytes: 0, cpuPercent: 0, pids: 0 };
  let read = 0;
  for (const wanted of ids) {
    for (const [id, reading] of stats) {
      if (!sameContainer(id, wanted)) continue;
      total.memBytes += reading.memBytes;
      total.pids += reading.pids;
      total.cpuPercent += reading.cpuPercent;
      read += 1;
      break;
    }
  }
  return read === 0 ? null : { total, read };
}

export type LoadEnvelope = {
  /** Container-count samples taken. */
  containerSamples: number;
  /** Highest number of THIS battery's sandbox containers alive at one instant. */
  peakSandboxes: number;
  /** Samples that observed zero — a container exists only while a command runs. */
  zeroSamples: number;
  /** `docker stats` readings taken against the worker container. */
  workerSamples: number;
  peakWorkerMemBytes: number;
  peakWorkerCpuPercent: number;
  peakWorkerPids: number;
  /**
   * `docker stats` readings taken against THIS battery's live sandbox
   * containers, summed per reading. This is the host exposure the sandboxes
   * themselves account for — the worker dispatches them, it does not contain
   * them, so a worker-only reading would miss the entire fleet.
   */
  sandboxStatSamples: number;
  peakSandboxMemBytes: number;
  peakSandboxCpuPercent: number;
  peakSandboxPids: number;
  /** Most sandbox containers a single `docker stats` reading covered. */
  peakSandboxesMeasured: number;
};

export type LoadSampler = {
  envelope: LoadEnvelope;
  stop: () => Promise<LoadEnvelope>;
};

/**
 * Sample the host while a burst runs.
 *
 * TWO INDEPENDENT LOOPS, because they have incompatible cadences: `docker ps`
 * answers in tens of milliseconds and must be fast enough to catch a peak that
 * exists for the length of one `sleep`, while `docker stats --no-stream` takes
 * on the order of a second. Interleaving them in one loop would let the slow
 * probe blind the fast one for exactly as long as the peak lasts.
 *
 * The resource loop reads the WHOLE host once per iteration and filters (see
 * `readHostStats`), so the worker and the sandbox fleet come out of a single
 * consistent reading and an exiting sandbox can no longer take the whole
 * measurement down with it.
 */
export function startLoadSampler(opts: {
  jobIds: ReadonlySet<string>;
  workerContainerId: string;
  containerIntervalMs?: number;
  workerIntervalMs?: number;
}): LoadSampler {
  const envelope: LoadEnvelope = {
    containerSamples: 0,
    peakSandboxes: 0,
    zeroSamples: 0,
    workerSamples: 0,
    peakWorkerMemBytes: 0,
    peakWorkerCpuPercent: 0,
    peakWorkerPids: 0,
    sandboxStatSamples: 0,
    peakSandboxMemBytes: 0,
    peakSandboxCpuPercent: 0,
    peakSandboxPids: 0,
    peakSandboxesMeasured: 0,
  };
  let running = true;

  const containerLoop = (async () => {
    while (running) {
      try {
        const live = await liveSandboxes(opts.jobIds);
        envelope.containerSamples += 1;
        if (live.length > envelope.peakSandboxes) envelope.peakSandboxes = live.length;
        if (live.length === 0) envelope.zeroSamples += 1;
      } catch {
        // A transient docker CLI failure must not end the measurement; the
        // sample count is asserted on, so systematic failure still shows.
      }
      await sleep(opts.containerIntervalMs ?? 150);
    }
  })();

  const statsLoop = (async () => {
    while (running) {
      try {
        // Bracket the (slow) stats reading with two (fast) `docker ps`
        // snapshots and take their UNION as the candidate fleet. A sandbox that
        // STARTS during the reading is in the second snapshot; one that EXITS
        // during it is in the first. Either way the id is offered to the
        // filter, and the filter keeps only what the stats reading actually
        // saw — so the fleet figure is never inflated by a container that was
        // not measured, and never silently undercounts one that was.
        const before = await liveSandboxes(opts.jobIds);
        const stats = await readHostStats();
        const after = await liveSandboxes(opts.jobIds);
        const fleet = [...new Set([...before, ...after].map((row) => row.id))];

        const worker = sumReadings(stats, [opts.workerContainerId]);
        if (worker) {
          envelope.workerSamples += 1;
          envelope.peakWorkerMemBytes = Math.max(
            envelope.peakWorkerMemBytes,
            worker.total.memBytes,
          );
          envelope.peakWorkerCpuPercent = Math.max(
            envelope.peakWorkerCpuPercent,
            worker.total.cpuPercent,
          );
          envelope.peakWorkerPids = Math.max(envelope.peakWorkerPids, worker.total.pids);
        }

        const sandboxes = sumReadings(stats, fleet);
        if (sandboxes) {
          envelope.sandboxStatSamples += 1;
          envelope.peakSandboxMemBytes = Math.max(
            envelope.peakSandboxMemBytes,
            sandboxes.total.memBytes,
          );
          envelope.peakSandboxCpuPercent = Math.max(
            envelope.peakSandboxCpuPercent,
            sandboxes.total.cpuPercent,
          );
          envelope.peakSandboxPids = Math.max(envelope.peakSandboxPids, sandboxes.total.pids);
          envelope.peakSandboxesMeasured = Math.max(
            envelope.peakSandboxesMeasured,
            sandboxes.read,
          );
        }
      } catch {
        // Same rationale as above.
      }
      await sleep(opts.workerIntervalMs ?? 250);
    }
  })();

  return {
    envelope,
    stop: async () => {
      running = false;
      await Promise.all([containerLoop, statsLoop]);
      return envelope;
    },
  };
}

/**
 * Wait until this battery's sandbox containers are all gone.
 *
 * Returns the milliseconds it took, or null if the deadline passed — the
 * caller asserts, so "it never drained" is a value here, not a throw.
 */
export async function waitForZeroSandboxes(
  jobIds: ReadonlySet<string>,
  timeoutMs: number,
): Promise<number | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const live = await liveSandboxJobs(jobIds);
    if (live.length === 0) return Date.now() - startedAt;
    await sleep(150);
  }
  return null;
}

/** Wait until at least `count` of this battery's sandbox containers are live. */
export async function waitForLiveSandboxes(
  jobIds: ReadonlySet<string>,
  count: number,
  timeoutMs: number,
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const live = await liveSandboxJobs(jobIds);
    if (live.length >= count) return true;
    await sleep(100);
  }
  return false;
}
