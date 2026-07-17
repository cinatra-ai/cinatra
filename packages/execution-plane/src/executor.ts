/**
 * Broker-backed `SandboxExecutor` binding (exec-plane S2, cinatra#1707).
 *
 * The bridge between the `@cinatra-ai/llm` injection contract and the broker:
 * the injection layer builds the `sandbox_execution` tool around a
 * `SandboxExecutor`, and this factory produces that executor from an
 * `ExecutionBroker`. The app wiring slice (S1 remainder) passes it into the
 * orchestration entry points as `executionExecutor`; the E2E battery drives it
 * directly.
 *
 * Semantics:
 *  - ONE broker job per sealed carrier, opened lazily on the first command and
 *    reused across steps/turns of the request (memoized per carrier — the L2
 *    workspace persistence contract). Staged skill snapshots are resolved
 *    (content + digests) exactly once, at open time.
 *  - Failures are STRUCTURED, never thrown into the model loop: an open/exec
 *    refusal becomes a per-command output with a non-zero exit code and the
 *    broker's fail-closed message on stderr; a worker timeout maps to the
 *    `timeout` outcome.
 *  - Per-command resource limits are BROKER-owned (quotas/limits ride
 *    `ExecutionBrokerOptions`); the model-supplied `timeoutMs` /
 *    `maxOutputLength` hints are advisory and deliberately not forwarded —
 *    the enforced caps must not be model-controlled.
 */

import type {
  SandboxExecutor,
  SandboxExecuteOutput,
  SandboxStagedSkill,
} from "@cinatra-ai/llm";
import type { ExecutionBroker } from "./broker";
import type { StagedSkillInput } from "./types";

/** Exit code for broker-refused commands (structured, model-visible). */
const REFUSED_EXIT_CODE = 126;

async function resolveStagedInputs(
  stagedSkills: SandboxStagedSkill[] | undefined,
): Promise<StagedSkillInput[]> {
  if (!stagedSkills || stagedSkills.length === 0) return [];
  return Promise.all(
    stagedSkills.map(async (skill) => ({
      slug: skill.slug,
      files: (await skill.resolveFiles()).map((f) => ({
        path: f.path,
        content: f.content,
        digest: f.digest,
      })),
    })),
  );
}

/**
 * Bound on distinct carriers a single executor instance tracks. The wiring
 * layer builds one executor per broker (possibly long-lived), so the map must
 * not grow with traffic: past the cap the OLDEST tracked job is closed
 * (`closeJob` — eagerly frees its per-job skills volume; the run-keyed L2
 * workspace stays, retention GC owns it) and evicted. A carrier's TTL bounds
 * usefulness anyway (an expired carrier re-opens as a structured refusal).
 */
const MAX_TRACKED_CARRIERS = 256;

export function createBrokerSandboxExecutor(
  broker: ExecutionBroker,
): SandboxExecutor {
  // One open job per carrier, memoized as a promise so a concurrent first
  // batch cannot double-open. A FAILED open is not cached — a later command
  // retries (e.g. transient docker failure), while a carrier-level refusal
  // (expired/bad signature) simply fails again, still structured. The closure
  // NEVER rejects (codex round-1): a throwing resolveFiles()/openJob() becomes
  // a structured failure, so nothing escapes into the provider tool loop and
  // no permanently-rejected promise can poison the cache.
  const jobs = new Map<string, Promise<{ ok: true; jobId: string } | { ok: false; message: string }>>();

  async function evictPastCap(): Promise<void> {
    while (jobs.size > MAX_TRACKED_CARRIERS) {
      const oldest = jobs.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      const settled = await jobs.get(oldest)!;
      jobs.delete(oldest);
      if (settled.ok) await broker.closeJob(settled.jobId);
    }
  }

  return async (input) => {
    let open = jobs.get(input.sessionCarrier);
    if (!open) {
      open = (async () => {
        try {
          const stagedSkills = await resolveStagedInputs(input.stagedSkills);
          const result = await broker.openJob(input.sessionCarrier, {
            stagedSkills,
          });
          return result.ok
            ? ({ ok: true, jobId: result.jobId } as const)
            : ({ ok: false, message: `${result.reason}: ${result.message}` } as const);
        } catch (err) {
          return {
            ok: false,
            message: `staging_failed: ${(err as Error).message}`,
          } as const;
        }
      })();
      jobs.set(input.sessionCarrier, open);
      const settled = await open;
      if (!settled.ok) jobs.delete(input.sessionCarrier);
      else await evictPastCap();
    }
    const job = await open;
    if (!job.ok) {
      return input.commands.map(() => ({
        stdout: "",
        stderr: `The execution plane refused to open a job — ${job.message}`,
        outcome: { type: "exit" as const, exitCode: REFUSED_EXIT_CODE },
      }));
    }

    const outputs: SandboxExecuteOutput[] = [];
    for (const command of input.commands) {
      const result = await broker.exec(job.jobId, command);
      if (!result.ok) {
        outputs.push({
          stdout: "",
          stderr: `The execution plane refused the command — ${result.reason}: ${result.message}`,
          outcome: { type: "exit", exitCode: REFUSED_EXIT_CODE },
        });
        continue;
      }
      const r = result.result;
      outputs.push({
        stdout: r.stdout,
        stderr: r.stderr,
        outcome:
          r.termination === "timeout"
            ? { type: "timeout" }
            : { type: "exit", exitCode: r.exitCode ?? REFUSED_EXIT_CODE },
      });
    }
    return outputs;
  };
}
