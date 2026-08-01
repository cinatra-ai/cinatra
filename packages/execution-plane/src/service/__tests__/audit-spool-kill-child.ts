/**
 * The KILLED broker, for `audit-spool.test.ts`'s G1/AC4 arm (cinatra#2266).
 *
 * A separate real process, because the property under test is that nothing but
 * the fsynced file survives a `SIGKILL`: no exit handler runs, no buffered
 * write is flushed, no in-memory state is saved. Faking that inside the test
 * process would be testing the fake.
 *
 * It reproduces the broker's own sequence:
 *   1. one command that RUNS TO COMPLETION — reserve, dispatch, commit;
 *   2. one command that is RESERVED and DISPATCHED and never completes;
 *   3. SIGKILL itself, exactly where the broker would have died — after the
 *      reservation is durable and before the terminal record exists.
 *
 * Run by the test as `node <this file> <spool dir>`; Node ≥22.18 strips the
 * types, so it drives the SAME module the broker does rather than a copy.
 */
import { openAuditSpool } from "../audit-spool.ts";
import { DEFAULT_SANDBOX_LIMITS, type ExecutionAuditRecord } from "../../types.ts";

const dir = process.argv[2];
if (!dir) {
  process.stderr.write("usage: audit-spool-kill-child.ts <spool-dir>\n");
  process.exit(2);
}

const record = (
  jobId: string,
  decision: ExecutionAuditRecord["decision"],
): ExecutionAuditRecord => ({
  jobId,
  orgId: "org-1",
  userId: "user-1",
  surface: "agent_run",
  command: "sleep 60",
  cwd: "/workspace",
  seq: 0,
  decision,
  effectivePolicy: { egressMode: "none", limits: DEFAULT_SANDBOX_LIMITS },
  atMs: 1_700_000_000_000,
});

const spool = openAuditSpool({ dir });

// 1. A command that completes: reserved, dispatched, committed.
const done = await spool.reserve(record("job-done", "outcome_unknown"));
await done.commit(record("job-done", "executed"));

// 2. A command that is dispatched and never resolves. Its reservation is
//    DURABLE at this point — that is the guarantee being tested.
await spool.reserve(record("job-inflight", "outcome_unknown"));

// 3. Die where the broker would have died. SIGKILL, so nothing else runs.
process.kill(process.pid, "SIGKILL");
