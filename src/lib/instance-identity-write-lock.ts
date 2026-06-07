/**
 * Per-process serialisation for `instance_identity` writes that mutate the
 * registry token (setup bootstrap, marketplace register, token rotate, status
 * reconcile). The mutex lives in this module so every cross-file caller takes
 * the SAME lock — otherwise per-file mutexes would race against each other.
 *
 * The lock is acquired across both the remote MCP call AND the local write
 * so two concurrent rotators are fully serialised in-process. Multi-process
 * serialisation (a DB-level advisory lock or SQL CAS) is the follow-up.
 *
 * Callers MUST re-read `instance_identity` IMMEDIATELY BEFORE the final
 * write inside the lock and merge their changes onto that fresh row — the
 * lock only blocks other in-file writes from this set, not legitimate writes
 * from elsewhere in the codebase (e.g. `markFirstPublishedIfCurrentScope`)
 * that may have happened during the HTTP wait.
 */

const mutex: { tail: Promise<void> } = { tail: Promise.resolve() };

export async function withInstanceIdentityWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = mutex.tail.then(fn, fn);
  mutex.tail = next.then(
    () => {},
    () => {},
  );
  return next;
}
