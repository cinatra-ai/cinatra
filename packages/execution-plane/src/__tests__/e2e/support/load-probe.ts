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
 */
export async function liveSandboxJobs(jobIds: ReadonlySet<string>): Promise<string[]> {
  const listed = await docker([
    "ps",
    "--filter",
    `label=${SANDBOX_CONTAINER_LABEL}=sandbox`,
    "--format",
    `{{.Label "${SANDBOX_CONTAINER_JOB_LABEL}"}}`,
  ]);
  return listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((jobId) => jobId.length > 0 && jobIds.has(jobId));
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

export type WorkerReading = { memBytes: number; cpuPercent: number; pids: number };

/** One `docker stats --no-stream` reading for the worker container. */
export async function readWorkerStats(containerId: string): Promise<WorkerReading | null> {
  const out = await docker(
    ["stats", "--no-stream", "--format", "{{.MemUsage}}|{{.CPUPerc}}|{{.PIDs}}", containerId],
    { timeoutMs: 60_000 },
  );
  const line = out.stdout.trim().split("\n")[0]?.trim();
  if (!line) return null;
  const [mem, cpu, pids] = line.split("|");
  const memBytes = parseStatsBytes((mem ?? "").split("/")[0] ?? "");
  const cpuPercent = Number((cpu ?? "").replace("%", "").trim());
  const pidCount = Number((pids ?? "").trim());
  if (!Number.isFinite(memBytes) || !Number.isFinite(pidCount)) return null;
  return {
    memBytes,
    cpuPercent: Number.isFinite(cpuPercent) ? cpuPercent : 0,
    pids: pidCount,
  };
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
  };
  let running = true;

  const containerLoop = (async () => {
    while (running) {
      try {
        const live = await liveSandboxJobs(opts.jobIds);
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

  const workerLoop = (async () => {
    while (running) {
      try {
        const reading = await readWorkerStats(opts.workerContainerId);
        if (reading) {
          envelope.workerSamples += 1;
          envelope.peakWorkerMemBytes = Math.max(envelope.peakWorkerMemBytes, reading.memBytes);
          envelope.peakWorkerCpuPercent = Math.max(
            envelope.peakWorkerCpuPercent,
            reading.cpuPercent,
          );
          envelope.peakWorkerPids = Math.max(envelope.peakWorkerPids, reading.pids);
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
      await Promise.all([containerLoop, workerLoop]);
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
