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
 * Bound on distinct carriers a single executor instance TRACKS. The wiring
 * layer builds one executor per broker (possibly long-lived), so this map must
 * not grow with traffic. Eviction forgets the carrier→job MAPPING ONLY — it
 * never closes the job (codex round-2: closing on eviction could terminate a
 * job another in-flight call is actively using). Job/volume lifecycle stays
 * where it already lives: the broker's per-org open-job ceiling bounds open
 * jobs, the carrier TTL bounds re-opens, teardown/closeJob free volumes
 * eagerly, and the two-tier retention GC reaps the rest. An evicted-but-live
 * carrier that is presented again simply opens a fresh job (run-keyed L2
 * workspaces persist across that re-open).
 */
const MAX_TRACKED_CARRIERS = 256;

/** `throw null` / non-Error throwables must still become a structured string. */
function describeThrown(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "unknown error";
  }
}

export function createBrokerSandboxExecutor(
  broker: ExecutionBroker,
): SandboxExecutor {
  // One open job per carrier, memoized as a promise so a concurrent first
  // batch cannot double-open. A FAILED open is not cached — a later command
  // retries (e.g. transient docker failure), while a carrier-level refusal
  // (expired/bad signature) simply fails again, still structured. The closure
  // NEVER rejects (codex rounds 1-2): any throwable — including non-Error
  // values — from resolveFiles()/openJob() becomes a structured failure, so
  // nothing escapes into the provider tool loop and no permanently-rejected
  // promise can poison the cache.
  const jobs = new Map<string, Promise<{ ok: true; jobId: string } | { ok: false; message: string }>>();

  function evictPastCap(): void {
    while (jobs.size > MAX_TRACKED_CARRIERS) {
      const oldest = jobs.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      jobs.delete(oldest); // mapping only — never closeJob (see above)
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
            message: `staging_failed: ${describeThrown(err)}`,
          } as const;
        }
      })();
      jobs.set(input.sessionCarrier, open);
      const settled = await open;
      if (!settled.ok) jobs.delete(input.sessionCarrier);
      else evictPastCap();
    } else {
      // LRU touch: re-insert so hot carriers are never the eviction victim.
      jobs.delete(input.sessionCarrier);
      jobs.set(input.sessionCarrier, open);
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
