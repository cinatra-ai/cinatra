/**
 * L0 hardened container run profile (exec-plane S1, cinatra#1706).
 *
 * Builds the exact `docker run` argv for ONE sandbox command over the L0 base
 * image. This module is the hardened-container CONTRACT ported from the
 * openai-connector runner, upgraded per the epic:
 *
 *  - non-root: fixed runtime UID/GID (10001:10001), passed explicitly — the
 *    profile does not trust the image's USER directive;
 *  - read-only rootfs (`--read-only`), writable ONLY at the L2 workspace
 *    volume and a bounded tmpfs /tmp;
 *  - `--cap-drop ALL`, `--security-opt no-new-privileges:true` — no runtime
 *    root path exists (D2);
 *  - cpu / memory / pids quotas; wall-clock timeout is enforced host-side by
 *    the worker (a cgroup cannot express wall time);
 *  - EMPTY workspace: the ONLY mount is the named L2 volume at /workspace.
 *    There are NO host bind mounts — the historical `readRoots=[cwd]` default
 *    is deliberately gone;
 *  - env scrub-by-omission: `docker run` passes no host environment; the
 *    profile sets an explicit, enumerated environment (HOME + user-space
 *    install prefixes + proxy variables when egress rides the gateway) and
 *    nothing else. The sandbox holds no secrets and no host data (D5).
 *
 * Egress mapping (network-LAYER enforcement, D3):
 *  - `none`            → `--network none` (kernel-level deny; nothing to bypass);
 *  - gateway modes     → the container attaches ONLY to the internal sandbox
 *    network (no NAT route out); the attributing gateway container is the sole
 *    dual-homed path, and the proxy env vars point at it with the per-job
 *    attribution token. A process ignoring the proxy vars has no route — the
 *    enforcement is the network topology, not the env hint.
 */

import type { ResolvedEgress, SandboxCommandSpec } from "./types";

/** Fixed, contractual runtime identity inside every sandbox container. */
export const SANDBOX_RUNTIME_UID = 10001;
export const SANDBOX_RUNTIME_GID = 10001;

/** Workspace mount point — the cwd of every sandbox command. */
export const SANDBOX_WORKSPACE_DIR = "/workspace";

/** Local-dev image tag; production overrides with a digest-pinned reference. */
export const DEFAULT_L0_IMAGE_LOCAL_DEV = "cinatra-sandbox-l0:dev";

/**
 * Reject an image reference that could be parsed by docker as an OPTION rather
 * than a positional argument (a leading `-`), or that carries whitespace /
 * control characters. The ref is deployment-controlled (env) or the dev
 * default — never model-controlled — but validating it (plus the `--` argv
 * separator in `buildHardenedRunArgs`) is cheap defense-in-depth against a
 * misconfiguration smuggling e.g. `--privileged` into the run.
 */
export function assertSafeImageRef(ref: string): string {
  if (!/^[A-Za-z0-9]/.test(ref)) {
    throw new Error(
      `Refusing an L0 image reference that does not start with an alphanumeric ` +
        `character (possible docker option injection): "${ref}".`,
    );
  }
  // Allowlist the normal image-reference charset (registry/name:tag@sha256:...);
  // anything else — whitespace, control chars, shell metacharacters — is refused.
  if (!/^[A-Za-z0-9._:/@-]+$/.test(ref)) {
    throw new Error(
      `Refusing an L0 image reference with characters outside the image-ref ` +
        `charset: "${ref}".`,
    );
  }
  return ref;
}

/**
 * Resolve the L0 image reference. Production sets CINATRA_SANDBOX_L0_IMAGE to
 * a digest-pinned reference (deployment owns the pin); local-dev falls back to
 * the locally-built dev tag. The worker additionally records the RESOLVED
 * digest of whatever ran in every audit record, so the effective image is
 * always attributable even under the mutable dev tag. The resolved ref is
 * validated against option-injection.
 */
export function resolveL0ImageRef(override?: string): string {
  const raw = override ?? process.env.CINATRA_SANDBOX_L0_IMAGE;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return assertSafeImageRef(raw.trim());
  }
  return DEFAULT_L0_IMAGE_LOCAL_DEV;
}

/** Deterministic container name for one command dispatch (kill target). */
export function containerNameFor(jobId: string, seq: number): string {
  const safe = jobId.replace(/[^a-zA-Z0-9_.-]/g, "-");
  return `cinatra-exec-${safe}-${seq}`;
}

/**
 * The explicit sandbox environment. Enumerated allowlist — nothing from the
 * worker's own environment ever crosses (scrub-by-omission is structural:
 * `docker run` starts from the image env, and we add only these).
 * User-space install prefixes live IN the workspace so `pip install --user`
 * and `npm install -g` persist across commands within the run (L2 semantics).
 */
export function sandboxEnvironment(egress: ResolvedEgress): Record<string, string> {
  const env: Record<string, string> = {
    HOME: `${SANDBOX_WORKSPACE_DIR}/home`,
    PYTHONUSERBASE: `${SANDBOX_WORKSPACE_DIR}/.local`,
    PIP_CACHE_DIR: `${SANDBOX_WORKSPACE_DIR}/.cache/pip`,
    npm_config_prefix: `${SANDBOX_WORKSPACE_DIR}/.npm-global`,
    npm_config_cache: `${SANDBOX_WORKSPACE_DIR}/.cache/npm`,
    PATH: [
      `${SANDBOX_WORKSPACE_DIR}/.local/bin`,
      `${SANDBOX_WORKSPACE_DIR}/.npm-global/bin`,
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ].join(":"),
  };
  if (egress.kind === "gateway") {
    // Attribution token rides as the proxy USERNAME (identity, not a secret —
    // the gateway requires it so every egress flow is job-attributed). The
    // password is a fixed non-secret filler: pip's vendored urllib3 omits
    // Proxy-Authorization on CONNECT when the password part is empty (proven
    // in the E2E battery), while curl/npm tolerate either form. The gateway
    // authenticates on the username only.
    const proxyUrl = `http://${egress.jobToken}:x@${egress.gateway.host}:${egress.gateway.port}`;
    env.HTTP_PROXY = proxyUrl;
    env.HTTPS_PROXY = proxyUrl;
    env.http_proxy = proxyUrl;
    env.https_proxy = proxyUrl;
    env.NO_PROXY = "localhost,127.0.0.1";
    env.no_proxy = "localhost,127.0.0.1";
  }
  return env;
}

/**
 * Wrap the model's command for execution inside the sandbox:
 *  - seed the workspace's user-space directories (idempotent),
 *  - apply the per-file `ulimit -f` write cap (KiB units in bash) — one half
 *    of the enforced disk quota; the other half is the worker's post-command
 *    workspace measurement that terminates the job on total-quota breach.
 */
export function wrapSandboxCommand(command: string, workspaceQuotaKb: number): string {
  const seed =
    `mkdir -p "$HOME" "$PYTHONUSERBASE" "$PIP_CACHE_DIR" ` +
    `"$npm_config_prefix" "${SANDBOX_WORKSPACE_DIR}/.cache/npm"`;
  return `ulimit -f ${workspaceQuotaKb} && ${seed} && { ${command}\n}`;
}

/**
 * Build the full hardened `docker run` argv (without the leading binary) for
 * one command. Pure — safe to unit-test the contract exhaustively.
 */
export function buildHardenedRunArgs(
  spec: SandboxCommandSpec,
  opts: { imageRef: string; containerName: string },
): string[] {
  const { limits, egress } = spec;
  const args: string[] = [
    "run",
    "--rm",
    "--init",
    "--name",
    opts.containerName,
    "--user",
    `${SANDBOX_RUNTIME_UID}:${SANDBOX_RUNTIME_GID}`,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--pids-limit",
    String(limits.pidsLimit),
    "--memory",
    `${limits.memoryMb}m`,
    "--memory-swap",
    `${limits.memoryMb}m`,
    "--cpus",
    String(limits.cpus),
    "--tmpfs",
    "/tmp:rw,size=128m",
    "--volume",
    `${spec.workspaceVolume}:${SANDBOX_WORKSPACE_DIR}`,
    // Exec-plane S2 (cinatra#1707): staged skill snapshots mount READ-ONLY at
    // /skills — immutable inputs; the sandbox cannot modify a snapshot.
    ...(spec.skillsVolume
      ? ["--volume", `${spec.skillsVolume}:/skills:ro`]
      : []),
    "--workdir",
    SANDBOX_WORKSPACE_DIR,
    "--network",
    egress.kind === "none" ? "none" : egress.network,
  ];
  const env = sandboxEnvironment(egress);
  for (const [key, value] of Object.entries(env)) {
    args.push("--env", `${key}=${value}`);
  }
  // `--` ends option parsing: everything after it is positional (image + argv),
  // so an image ref can never be re-interpreted as a docker run option even if
  // validation were bypassed. Belt-and-suspenders with assertSafeImageRef.
  args.push(
    "--",
    assertSafeImageRef(opts.imageRef),
    "bash",
    "-c",
    wrapSandboxCommand(spec.command, limits.workspaceQuotaKb),
  );
  return args;
}

/**
 * Contract assertion: the argv contains NO host bind mounts. Every `--volume`
 * must reference a named volume (no path separator in the source), and there
 * must be no `--mount type=bind`. The worker asserts this on every dispatch —
 * a violated invariant is a bug, not a policy choice.
 */
export function assertNoBindMounts(args: string[]): void {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--volume" || args[i] === "-v") {
      const source = (args[i + 1] ?? "").split(":")[0];
      if (source.includes("/") || source.includes("\\") || source.startsWith(".")) {
        throw new Error(
          `execution-plane invariant violated: host bind mount "${args[i + 1]}" in sandbox argv`,
        );
      }
    }
    if (args[i] === "--mount" && (args[i + 1] ?? "").includes("type=bind")) {
      throw new Error(
        "execution-plane invariant violated: bind --mount in sandbox argv",
      );
    }
  }
}
