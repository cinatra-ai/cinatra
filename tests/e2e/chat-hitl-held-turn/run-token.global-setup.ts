// ONE TOKEN PER RUN, MINTED BEFORE ANY WORKER STARTS (chat-hitl S9k, cinatra#2824).
//
// Playwright runs `globalSetup` once, in the runner process, before it forks the
// worker that executes the setup project and the worker that executes the restore
// teardown. Both inherit this process's environment, and so does every fixture
// SUBPROCESS the setup shells out to (`fixtures.mts` is spawned with
// `{...process.env}`). That makes an environment variable set here the one thing
// the whole run shares and a CONCURRENT run cannot see.
//
// WHY THAT IS LOAD-BEARING. The account and instance snapshots are stamped with
// this token at write, and each teardown consumes only a snapshot carrying its own
// stamp. Without it, a second run refused by the exclusive snapshot create still
// ran its teardown, which restored and then DELETED the FIRST run's snapshot while
// that run was still live — and the first run's own teardown then printed a
// verified verdict over a restore it never performed. See
// `state-rules.ts` (`snapshotClaim`) for the rule the teardowns apply.
//
// IT ALWAYS MINTS, AND NEVER INHERITS. An earlier draft honored a token already
// in the environment so a wrapping harness could supply its own; that reopens the
// hole from the other side. Two invocations launched from the same exported
// variable would each read the other's snapshot as their own, which is exactly the
// state the token exists to make impossible. A token is minted per invocation,
// full stop, and an inherited value is overwritten and named in the log.
import { RUN_TOKEN_ENV, mintRunToken } from "./state-rules";

export default function mintRunTokenForThisRun(): void {
  const inherited = process.env[RUN_TOKEN_ENV]?.trim();
  process.env[RUN_TOKEN_ENV] = mintRunToken();
  if (inherited) {
    console.log(
      `[S9k] ignoring an inherited ${RUN_TOKEN_ENV} (${inherited}): a run token identifies ONE ` +
        "invocation, and sharing one would let two runs consume each other's snapshots",
    );
  }
  console.log(`[S9k] run token ${process.env[RUN_TOKEN_ENV]}`);
}
