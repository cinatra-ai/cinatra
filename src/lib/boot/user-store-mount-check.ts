// User-store durable-mount check (cinatra#789 item 5) — pure classifier.
//
// The required-extension reconcile already REFUSES to write into the durable user
// store (`/data/extensions/packages`). The residual gap: nothing VALIDATES at boot
// that the durable user-store mount actually EXISTS and is writable, so a
// misconfigured deploy (the volume never mounted) would silently treat it as
// ephemeral — and every user-installed extension would vanish on the next restart.
//
// This is a WARN, not a hard failure: a fresh instance legitimately has no user
// store dir until the first install, and we must not block a deploy that has not
// mounted it yet. So the boot phase using this classifier is `retryable`
// (self-healing / informational) — it surfaces the deficit clearly in logs + the
// boot phase log (health `degradedPhases`) WITHOUT making the health gate reject the
// boot. See the health-contract split (cinatra#789 item 1): only durable `degraded`-
// policy failures are deploy-blocking; this is intentionally NOT one of them.

export type UserStoreMountVerdict =
  | { kind: "ok" }
  | { kind: "missing"; message: string }
  | { kind: "not-writable"; message: string };

export type UserStoreMountProbe = {
  /** True when the store root path exists. */
  exists: boolean;
  /** True when the store root is writable (only meaningful when it exists). */
  writable: boolean;
};

/**
 * PURE verdict from a probe of the store root. Exported for unit testing.
 */
export function evaluateUserStoreMount(
  storeRoot: string,
  probe: UserStoreMountProbe,
): UserStoreMountVerdict {
  if (!probe.exists) {
    return {
      kind: "missing",
      message:
        `[user-store-mount-check] the durable user-install store ${storeRoot} does not exist. ` +
        `If a durable volume is expected there, it is NOT mounted — user-installed extensions would be ` +
        `treated as ephemeral and LOST on restart. A fresh instance with no user installs yet may not ` +
        `have created it; provision + mount the durable volume before installing extensions.`,
    };
  }
  if (!probe.writable) {
    return {
      kind: "not-writable",
      message:
        `[user-store-mount-check] the durable user-install store ${storeRoot} exists but is NOT writable — ` +
        `user extension installs will fail. Check the mount's ownership/permissions.`,
    };
  }
  return { kind: "ok" };
}
