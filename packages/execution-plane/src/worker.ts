/**
 * Local-dev sandbox worker (exec-plane S1, cinatra#1706).
 *
 * The local-dev PLACEMENT of the `SandboxWorker` contract: a fresh hardened
 * container per command (`docker run --rm` over the digest-pinned L0 image),
 * the per-run L2 workspace volume as the only mount, and network config from
 * the resolved egress policy. A container exists only while a command executes
 * (epic capacity model). Other placements (remote worker pools) implement the
 * same contract in the deployment layer — the broker cannot tell the
 * difference.
 *
 * Enforcement owned here:
 *  - wall-clock timeout: host-side timer → `docker rm -f <name>`;
 *  - stdout/stderr caps: bounded capture; overflow terminates the command
 *    (`output_cap_exceeded`) — output is truncated, never unbounded;
 *  - disk quota: post-command `du` measurement (the per-file ulimit rides
 *    inside the command; see l0-profile). Over-quota is reported to the broker
 *    which terminates the job;
 *  - image attribution: the RESOLVED digest of the image that ran is captured
 *    per command for the audit record;
 *  - no-bind-mount invariant asserted on every dispatch.
 */

import {
  assertNoBindMounts,
  buildHardenedRunArgs,
  containerNameFor,
  resolveL0ImageRef,
  SANDBOX_WORKSPACE_DIR,
} from "./l0-profile";
import { runDocker, type DockerCli } from "./docker-cli";
import { measureWorkspaceKb } from "./workspace";
import type {
  SandboxCommandResult,
  SandboxCommandSpec,
  SandboxEgressUse,
  SandboxTermination,
  SandboxWorker,
} from "./types";

export type LocalDevWorkerOptions = {
  /** Override the L0 image reference (default: env / local-dev tag). */
  imageRef?: string;
  /** Injection seam for tests. */
  docker?: DockerCli;
  /** Injection seam for gateway stats retrieval (host-side admin fetch). */
  fetchImpl?: typeof fetch;
};

export class LocalDevSandboxWorker implements SandboxWorker {
  private readonly imageRef: string;
  private readonly docker: DockerCli;
  private readonly fetchImpl: typeof fetch;
  private digestCache: string | null = null;
  private seq = 0;

  constructor(opts: LocalDevWorkerOptions = {}) {
    this.imageRef = resolveL0ImageRef(opts.imageRef);
    this.docker = opts.docker ?? runDocker;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Resolve (and cache) the immutable identity of the configured L0 image. */
  private async resolveImageDigest(): Promise<string> {
    if (this.digestCache) return this.digestCache;
    const byDigest = await this.docker([
      "image",
      "inspect",
      "--format",
      "{{if .RepoDigests}}{{index .RepoDigests 0}}{{else}}{{.Id}}{{end}}",
      this.imageRef,
    ]);
    if (byDigest.exitCode !== 0) {
      throw new Error(
        `L0 image "${this.imageRef}" is not available: ${byDigest.stderr.trim()} ` +
          `(local-dev: build it with \`docker build -t ${this.imageRef} docker/sandbox\`).`,
      );
    }
    this.digestCache = byDigest.stdout.trim();
    return this.digestCache;
  }

  async runCommand(spec: SandboxCommandSpec): Promise<SandboxCommandResult> {
    const imageDigest = await this.resolveImageDigest();
    const containerName = containerNameFor(spec.jobId, this.seq++);
    const args = buildHardenedRunArgs(spec, {
      imageRef: this.imageRef,
      containerName,
    });
    assertNoBindMounts(args);

    const startedAt = Date.now();
    const outcome = await this.docker(args, {
      timeoutMs: spec.limits.timeoutMs,
      maxBuffer: spec.limits.maxStdioBytes,
    });
    const wallMs = Date.now() - startedAt;

    let termination: SandboxTermination = "exited";
    if (outcome.timedOut) termination = "timeout";
    else if (outcome.stdioOverflow) termination = "output_cap_exceeded";
    if (termination !== "exited") {
      // The child was SIGKILLed host-side; the container may still be running —
      // force-remove it (fresh-container-per-command means nothing to preserve).
      await this.docker(["rm", "-f", containerName]);
    }

    let workspaceKb = 0;
    try {
      workspaceKb = await measureWorkspaceKb(
        spec.workspaceVolume,
        this.imageRef,
        this.docker,
      );
    } catch {
      // Measurement failure must not mask the command result; the broker
      // treats an unmeasurable workspace as within quota for THIS command and
      // the next command re-measures.
      workspaceKb = 0;
    }
    if (
      termination === "exited" &&
      workspaceKb > spec.limits.workspaceQuotaKb
    ) {
      termination = "disk_quota_exceeded";
    }

    const egress = await this.collectEgressUse(spec);

    return {
      exitCode: outcome.exitCode,
      stdout: truncateTo(outcome.stdout, spec.limits.maxStdioBytes).text,
      stderr: truncateTo(outcome.stderr, spec.limits.maxStdioBytes).text,
      stdoutTruncated: truncateTo(outcome.stdout, spec.limits.maxStdioBytes).truncated,
      stderrTruncated: truncateTo(outcome.stderr, spec.limits.maxStdioBytes).truncated,
      termination,
      wallMs,
      imageDigest,
      workspaceKb,
      ...(egress ? { egress } : {}),
    };
  }

  private async collectEgressUse(
    spec: SandboxCommandSpec,
  ): Promise<SandboxEgressUse | undefined> {
    if (spec.egress.kind !== "gateway") return undefined;
    const adminUrl = spec.egress.gateway.adminUrl;
    const controlSecret = spec.egress.gateway.controlSecret;
    if (!adminUrl || !controlSecret) return undefined;
    try {
      const response = await this.fetchImpl(
        `${adminUrl.replace(/\/$/, "")}/__stats?job=${encodeURIComponent(spec.egress.jobToken)}`,
        { headers: { "x-egress-control": controlSecret } },
      );
      if (!response.ok) return undefined;
      const body = (await response.json()) as {
        totalBytes: number;
        destinations: Array<{
          host: string;
          port: number;
          allowed: number;
          denied: number;
          bytesIn: number;
          bytesOut: number;
        }>;
      };
      return {
        totalBytes: body.totalBytes,
        destinations: body.destinations.map((d) => ({
          host: d.host,
          port: d.port,
          allowed: d.allowed > 0,
          bytesIn: d.bytesIn,
          bytesOut: d.bytesOut,
        })),
      };
    } catch {
      return undefined;
    }
  }
}

export const SANDBOX_COMMAND_CWD = SANDBOX_WORKSPACE_DIR;

function truncateTo(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  return {
    text: buf.subarray(0, maxBytes).toString("utf8"),
    truncated: true,
  };
}
