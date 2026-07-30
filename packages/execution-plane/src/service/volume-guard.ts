/**
 * Worker-side NAME POLICY for the typed volume/container ops (exec-plane L3,
 * epic cinatra#1705).
 *
 * The worker is the only host in the managed topology that holds a docker
 * socket, and the broker is the only party allowed to reach it. That makes the
 * broker→worker hop the exact place where "a compromised broker" stops being a
 * theoretical actor: every name it hands over is a name the worker is about to
 * act on with root-equivalent authority. So the worker does NOT trust the
 * broker's names — it re-derives what a legitimate name can look like and
 * refuses everything else, fail-closed:
 *
 *  - a volume name must carry the execution-plane prefix for its TIER
 *    (`WORKSPACE_VOLUME_PREFIX` for L2 workspaces, `SKILLS_VOLUME_PREFIX` for
 *    staged skills) and nothing else may follow but the sanitizer's own
 *    character class. `-v /:/host`, `../../`, an option-looking `--foo`, a
 *    docker-managed volume belonging to another service — all refused before a
 *    single argv is built;
 *  - a REMOVAL additionally re-reads the volume's labels and refuses unless it
 *    carries `WORKSPACE_LABEL=<tier>`. The prefix is a naming convention; the
 *    label is what the execution plane actually stamps on the volumes it
 *    created, so an operator volume that merely happens to be named like one of
 *    ours is not destroyed on request. An ABSENT volume is not a refusal —
 *    removal is best-effort and idempotent by contract;
 *  - a container drain is expressed as a jobId, never a container name, and the
 *    derived prefix is validated the same way.
 *
 * Every refusal throws `ExecVolumeNameRefusedError`, which the worker service
 * maps onto a structured `malformed_request` answer: a broker that asks for
 * something outside the vocabulary learns only that it was refused.
 */

import type { DockerCli } from "../docker-cli";
import { containerNamePrefixFor } from "../l0-profile";
import { SKILLS_VOLUME_PREFIX } from "../staging";
import { WORKSPACE_LABEL, WORKSPACE_VOLUME_PREFIX } from "../workspace";

/** Retention tier — the value the execution plane stamps in `WORKSPACE_LABEL`. */
export type ExecVolumeTier = "l2" | "skills";

export class ExecVolumeNameRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecVolumeNameRefusedError";
  }
}

/**
 * Docker's own volume-name grammar is `[a-zA-Z0-9][a-zA-Z0-9_.-]`; the
 * execution plane's sanitizers (`workspaceVolumeName` / `skillsVolumeName`)
 * emit a strict subset of it. 255 is docker's ceiling.
 */
const VOLUME_SUFFIX_RE = /^[a-zA-Z0-9_.-]+$/;
const MAX_VOLUME_NAME_LENGTH = 255;

/**
 * Keys/jobIds are sanitized into a name, so their own charset is unconstrained
 * — but an unbounded one would produce a name docker refuses (or, worse, a name
 * that collides after truncation somewhere downstream). Bound them here.
 */
const MAX_KEY_LENGTH = 200;

const PREFIX_FOR_TIER: Record<ExecVolumeTier, string> = {
  l2: WORKSPACE_VOLUME_PREFIX,
  skills: SKILLS_VOLUME_PREFIX,
};

function refuse(message: string): never {
  throw new ExecVolumeNameRefusedError(message);
}

/**
 * Assert a volume NAME the broker handed over is one this worker is willing to
 * act on for `tier`. Returns the name so call sites read as a pipeline.
 */
export function assertExecVolumeName(name: unknown, tier: ExecVolumeTier): string {
  if (typeof name !== "string" || name.length === 0) {
    refuse("A volume name is required.");
  }
  if (name.length > MAX_VOLUME_NAME_LENGTH) {
    refuse(
      `Refusing a volume name longer than ${MAX_VOLUME_NAME_LENGTH} characters.`,
    );
  }
  const prefix = PREFIX_FOR_TIER[tier];
  if (!name.startsWith(prefix)) {
    // The prefix is quoted back (it is a public constant); the rejected name is
    // NOT echoed — a refusal must not become an oracle that reflects attacker
    // input into an operator's log line verbatim.
    refuse(
      `Refusing a volume name outside the execution plane's "${prefix}" namespace (fail-closed).`,
    );
  }
  const suffix = name.slice(prefix.length);
  if (suffix.length === 0 || !VOLUME_SUFFIX_RE.test(suffix)) {
    refuse(
      `Refusing a volume name whose suffix is empty or outside [a-zA-Z0-9_.-] (fail-closed).`,
    );
  }
  return name;
}

/**
 * Assert a workspace KEY (the input to `ensureWorkspace`) is bounded and that
 * the name it sanitizes to is one this worker would accept.
 */
export function assertWorkspaceKey(
  key: unknown,
  toVolumeName: (key: string) => string,
): string {
  if (typeof key !== "string" || key.length === 0) {
    refuse("A workspace key is required.");
  }
  if (key.length > MAX_KEY_LENGTH) {
    refuse(`Refusing a workspace key longer than ${MAX_KEY_LENGTH} characters.`);
  }
  assertExecVolumeName(toVolumeName(key), "l2");
  return key;
}

/**
 * Assert a jobId (the input to `stageSkills`) is bounded and that the skills
 * volume name it sanitizes to is one this worker would accept.
 */
export function assertStagingJobId(
  jobId: unknown,
  toVolumeName: (jobId: string) => string,
): string {
  if (typeof jobId !== "string" || jobId.length === 0) {
    refuse("A job id is required.");
  }
  if (jobId.length > MAX_KEY_LENGTH) {
    refuse(`Refusing a job id longer than ${MAX_KEY_LENGTH} characters.`);
  }
  assertExecVolumeName(toVolumeName(jobId), "skills");
  return jobId;
}

/**
 * Assert a jobId whose containers are about to be force-removed. The derived
 * prefix must be exactly the execution plane's container namespace plus a
 * non-empty, sanitizer-shaped job segment — a jobId that sanitizes to nothing
 * would yield the prefix `cinatra-exec--`, which is not a job.
 */
export function assertDrainJobId(jobId: unknown): string {
  if (typeof jobId !== "string" || jobId.length === 0) {
    refuse("A job id is required.");
  }
  if (jobId.length > MAX_KEY_LENGTH) {
    refuse(`Refusing a job id longer than ${MAX_KEY_LENGTH} characters.`);
  }
  const prefix = containerNamePrefixFor(jobId);
  const segment = prefix.slice("cinatra-exec-".length, -1);
  if (segment.length === 0 || !VOLUME_SUFFIX_RE.test(segment)) {
    refuse("Refusing a job id that does not name an execution-plane container set.");
  }
  return jobId;
}

/**
 * Read a volume's labels and assert that, IF it exists, the execution plane
 * created it for `tier`.
 *
 * Called on all four volume ops, not just removal (Codex round 2, finding A1).
 * `docker volume create` on an existing name ADOPTS it rather than failing, so
 * without this check a volume that merely occupies a plane-shaped name would be
 * silently taken over — written into by staging, and force-removed by staging's
 * own fail-closed cleanup path. Asserting ownership BEFORE the operation is
 * what keeps "the plane only ever touches its own volumes" true rather than
 * merely intended.
 *
 * Returns `"absent"` when docker does not know the volume — for a create that
 * is the normal case, and for a removal it is a no-op (removal is idempotent by
 * contract, never a refusal). Anything else THROWS.
 *
 * `{{json .Labels}}` rather than `{{index .Labels "…"}}`: a Go template
 * indexing a nil map is a template ERROR, which docker reports as a non-zero
 * exit — indistinguishable from "no such volume" and therefore silently
 * downgraded to a no-op. JSON keeps "unlabelled" (`null`) distinguishable from
 * "unknown".
 */
export async function assertExecVolumeOwnership(
  volumeName: string,
  tier: ExecVolumeTier,
  docker: DockerCli,
): Promise<"labelled" | "absent"> {
  const inspected = await docker([
    "volume",
    "inspect",
    "--format",
    "{{json .Labels}}",
    volumeName,
  ]);
  if (inspected.exitCode !== 0) return "absent";
  let labels: unknown;
  try {
    labels = JSON.parse(inspected.stdout.trim() || "null");
  } catch {
    refuse("Refusing to act on a volume whose labels could not be read (fail-closed).");
  }
  const value =
    labels !== null && typeof labels === "object"
      ? (labels as Record<string, unknown>)[WORKSPACE_LABEL]
      : undefined;
  if (value !== tier) {
    refuse(
      `Refusing to act on a volume that does not carry "${WORKSPACE_LABEL}=${tier}" ` +
        `— it was not created by the execution plane (fail-closed).`,
    );
  }
  return "labelled";
}
