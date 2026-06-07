// Server-action authorization guard for extensions.
//
// Extension server actions ("use server" functions a setup/settings page binds
// to a <form>) run OUTSIDE the render-time host-context: they cannot close over
// the `ctx` the dispatch route builds, and they must not import host modules
// (`@/lib/auth-session`, `@/lib/connector-policy`) directly — that re-anchors
// the package to the host `src/` tree and breaks standalone extraction.
//
// Instead the host injects ONE guard implementation at boot via
// `setExtensionActionGuard`, and extension actions call
// `requireExtensionAction(packageId, mode)`. The host impl resolves the actor
// from the request (cookie session) and enforces the per-install connector /
// extension access policy, failing closed (redirect/throw) on denial. The SDK
// stays a leaf contract — it owns the shape, the host owns the enforcement.

export type ExtensionActionMode = "read" | "manage";

/**
 * The host-supplied enforcement. Resolves the current actor from the request
 * and enforces the extension's access policy for `mode`. MUST fail closed:
 * throw or redirect (never resolve) when access is denied or no actor is
 * present. Returns void on success.
 */
export type ExtensionActionGuard = (
  packageId: string,
  mode: ExtensionActionMode,
) => Promise<void>;

// Anchor the guard on `globalThis` via a namespaced+versioned Symbol so the host
// `setExtensionActionGuard` boot call and an extension's `requireExtensionAction`
// call resolve the SAME slot even when Next.js compiles `@cinatra-ai/sdk-extensions`
// into more than one module instance (server / RSC / route segments). A plain
// module-level binding would leave the extension's instance unwired → the guard
// would fail closed and break every gated action. (Same cross-compilation reason
// as the email-connector registry + host extension-mcp-registry.)
const ACTION_GUARD_KEY = Symbol.for("@cinatra-ai/sdk-extensions:action-guard/v1");
type GuardHolder = { [k: symbol]: ExtensionActionGuard | null | undefined };
const _holder = globalThis as unknown as GuardHolder;

/**
 * Wire the host enforcement. Called exactly once at boot (host instrumentation).
 * Re-calling replaces the previous impl — tests can swap a stub between blocks.
 */
export function setExtensionActionGuard(impl: ExtensionActionGuard): void {
  _holder[ACTION_GUARD_KEY] = impl;
}

/** @internal test-only — clear the guard so a fresh wiring is required. */
export function _resetExtensionActionGuardForTests(): void {
  _holder[ACTION_GUARD_KEY] = null;
}

/**
 * Enforce access for an extension server action. Default mode is `"manage"`
 * (the strict default — a mutation gate), so a forgotten argument fails safe
 * toward MORE restriction, not less. Fails CLOSED if the host never wired a
 * guard: an unguarded action is a boot-wiring bug, never an open door.
 */
export async function requireExtensionAction(
  packageId: string,
  mode: ExtensionActionMode = "manage",
): Promise<void> {
  const guard = _holder[ACTION_GUARD_KEY];
  if (!guard) {
    throw new Error(
      `[sdk-extensions] requireExtensionAction("${packageId}", "${mode}") was called before the host ` +
        `wired the action guard. The host must call setExtensionActionGuard(...) at boot.`,
    );
  }
  await guard(packageId, mode);
}
