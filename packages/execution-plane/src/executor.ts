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

export function createBrokerSandboxExecutor(
  broker: ExecutionBroker,
): SandboxExecutor {
  // One open job per carrier, memoized as a promise so a concurrent first
  // batch cannot double-open. A FAILED open is not cached — a later command
  // retries (e.g. transient docker failure), while a carrier-level refusal
  // (expired/bad signature) simply fails again, still structured.
  const jobs = new Map<string, Promise<{ ok: true; jobId: string } | { ok: false; message: string }>>();

  return async (input) => {
    let open = jobs.get(input.sessionCarrier);
    if (!open) {
      open = (async () => {
        const stagedSkills = await resolveStagedInputs(input.stagedSkills);
        const result = await broker.openJob(input.sessionCarrier, {
          stagedSkills,
        });
        return result.ok
          ? ({ ok: true, jobId: result.jobId } as const)
          : ({ ok: false, message: `${result.reason}: ${result.message}` } as const);
      })();
      jobs.set(input.sessionCarrier, open);
      const settled = await open;
      if (!settled.ok) jobs.delete(input.sessionCarrier);
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
