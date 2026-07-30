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
 *    refusal becomes a per-command output with a non-zero exit code, the
 *    broker's fail-closed message on stderr, and `refusedByPlane` set so
 *    callers above can tell "the plane said no" from "the sandbox ran and the
 *    command exited non-zero" (cinatra#2175 — the surface provenance guard
 *    must not read a refusal as an execution); a worker timeout maps to the
 *    `timeout` outcome.
 *  - Per-command resource limits are BROKER-owned (quotas/limits ride
 *    `ExecutionBrokerOptions`); the model-supplied `timeoutMs` /
 *    `maxOutputLength` hints are advisory and deliberately not forwarded —
 *    the enforced caps must not be model-controlled.
 */

import { randomUUID } from "node:crypto";

import type {
  SandboxExecutor,
  SandboxExecuteOutput,
  SandboxStagedSkill,
} from "@cinatra-ai/llm";
import type { ExecutionBroker } from "./broker";
import type { StagedSkillInput } from "./types";
import type { ResolvedEnvironmentMount } from "./environment/mount";

/**
 * The per-command voucher SOURCE (epic #1705). Supplied by the app wiring,
 * which holds the signing key and the run store; this package only carries the
 * request. Returning a refusal (rather than throwing) keeps the mint's own
 * fail-closed denials — a hard-removed run, an OBO ceiling that no longer
 * contains the run's re-derived chain — structured all the way to the model.
 *
 * `nonce` is present only on a remint answering a broker revalidation challenge:
 * the reminted voucher must carry exactly that nonce.
 */
export type CommandVoucherMinter = (input: {
  /** The sealed carrier the job was opened with (the mint re-opens it itself). */
  sessionCarrier: string;
  jobId: string;
  command: string;
  commandId: string;
  nonce?: string;
}) => Promise<
  { ok: true; voucher: string } | { ok: false; reason: string; message: string }
>;

export type BrokerSandboxExecutorOptions = {
  /**
   * REQUIRED. An executor with no voucher source could submit no authorized
   * command at all, so making it optional would only produce a broker that
   * refuses everything at runtime instead of a compile error here.
   */
  mintVoucher: CommandVoucherMinter;
};

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
 * never closes the job (closing on eviction could terminate a
 * job another in-flight call is actively using). Job/volume lifecycle stays
 * where it already lives: the broker's per-org open-job ceiling bounds open
 * jobs, the carrier TTL bounds re-opens, teardown/closeJob free volumes
 * eagerly, and the two-tier retention GC reaps the rest. An evicted-but-live
 * carrier that is presented again simply opens a fresh job (run-keyed L2
 * workspaces persist across that re-open).
 */
const MAX_TRACKED_CARRIERS = 256;

/**
 * `throw null` / non-Error throwables must still become a structured string.
 * The ENTIRE inspection sits inside the try: a hostile
 * throwable can make `instanceof` itself throw (Proxy with a throwing
 * getPrototypeOf trap) or carry a throwing `message` getter — even then this
 * returns a string and the caller's never-rejects contract holds.
 */
function describeThrown(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    return String(err);
  } catch {
    return "unknown error";
  }
}

export function createBrokerSandboxExecutor(
  broker: ExecutionBroker,
  opts: BrokerSandboxExecutorOptions,
): SandboxExecutor {
  // One open job per carrier, memoized as a promise so a concurrent first
  // batch cannot double-open. A FAILED open is not cached — a later command
  // retries (e.g. transient docker failure), while a carrier-level refusal
  // (expired/bad signature) simply fails again, still structured. The closure
  // NEVER rejects — by contract: any throwable — including non-Error
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
          // The llm injection contract carries the resolved L1 mount as an
          // OPAQUE token (`provenance: unknown`) so packages/llm takes no
          // execution-plane dependency; re-narrow it to `ResolvedEnvironmentMount`
          // at this package seam. The broker re-verifies the signed provenance
          // fail-closed before every mount (cinatra#1708 AC4) — this passthrough
          // trusts nothing, it only routes. Absent ⇒ openJob over the L0 base
          // (byte-identical S2 dispatch).
          const environment = input.environment as
            | ResolvedEnvironmentMount
            | undefined;
          const result = await broker.openJob(input.sessionCarrier, {
            stagedSkills,
            ...(environment ? { environment } : {}),
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
        // Nothing ran: no sandbox, no audit row (cinatra#2175).
        refusedByPlane: true as const,
      }));
    }

    const jobId = job.jobId;
    /**
     * Mint an authorization for one command and submit it. A mint REFUSAL is
     * projected into the same `ExecResult` shape as a broker refusal so the
     * caller has one path to handle — and, like every other failure here, it
     * never throws into the provider tool loop.
     */
    const execWithVoucher = async (
      command: string,
      commandId: string,
      nonce?: string,
    ): Promise<Awaited<ReturnType<ExecutionBroker["exec"]>>> => {
      let minted: Awaited<ReturnType<CommandVoucherMinter>>;
      try {
        minted = await opts.mintVoucher({
          sessionCarrier: input.sessionCarrier,
          jobId,
          command,
          commandId,
          ...(nonce ? { nonce } : {}),
        });
      } catch (err) {
        return {
          ok: false,
          reason: "voucher_missing",
          message: `the plane could not authorize this command: ${describeThrown(err)}`,
        };
      }
      if (!minted.ok) {
        return {
          ok: false,
          reason: "voucher_missing",
          message: `the plane declined to authorize this command (${minted.reason}): ${minted.message}`,
        };
      }
      return broker.exec(jobId, command, minted.voucher);
    };

    const outputs: SandboxExecuteOutput[] = [];
    for (const command of input.commands) {
      // ONE commandId per command, stable across the single permitted remint —
      // that identity is what the broker's idempotency and its remint cap are
      // keyed on, so a retry must not invent a new one.
      const commandId = randomUUID();
      let result = await execWithVoucher(command, commandId);

      // The broker's one-shot revalidation: the authorization expired while the
      // command waited for admission. Remint against the broker's own challenge
      // nonce and resubmit EXACTLY once — the cap itself lives in the broker, so
      // this loop cannot widen it.
      if (!result.ok && result.reason === "revalidation_required" && result.revalidation) {
        result = await execWithVoucher(command, commandId, result.revalidation.nonce);
      }

      if (!result.ok) {
        outputs.push({
          stdout: "",
          stderr: `The execution plane refused the command — ${result.reason}: ${result.message}`,
          outcome: { type: "exit", exitCode: REFUSED_EXIT_CODE },
          // Nothing ran for this command (cinatra#2175).
          refusedByPlane: true,
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
