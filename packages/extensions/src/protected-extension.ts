// ---------------------------------------------------------------------------
// DECLARATION-DRIVEN protected-extension enforcement (cinatra#1927).
//
// An extension package may DECLARE itself protected in its `cinatra/config.json`
// (`{ "formatVersion": 1, "protected": true }` — the generic, kind-agnostic
// domain owned by `@cinatra-ai/sdk-extensions/extension-protection`). The host
// then REFUSES every uninstall / delete of that extension, server-side, on every
// removal path:
//
//   - the GENERIC dispatcher pipeline — `assertNoLockedCanonicalRow` is the
//     kind-agnostic backstop every destructive dispatcher entry point runs
//     (archive / uninstall / force_delete / purge / registry_remove), and the
//     install-batch saga's compensation inverse consults the same resolver
//     before its row-scoped teardown (which bypasses the dispatcher);
//   - the DIRECT agent-registry installer — `assertAgentTemplateRemovable`
//     (packages/agents/src/removal-gate.ts), the path the agent-catalog
//     `uninstallRegistryPackage` action and the agents MCP delete handler take.
//
// SERVER-SIDE, NOT A HIDDEN BUTTON. The protection verdict is resolved from the
// INSTALLED PACKAGE'S OWN declaration on the server; nothing in the request
// participates. A forged uninstall (a hand-crafted server-action POST, a direct
// MCP `delete` call, a CLI invocation) hits the same refusal as the UI, because
// the UI affordance is not the gate.
//
// TRUE IoC — NO HARDCODED PACKAGE NAME. Core never carries a list of protected
// extensions; the PACKAGE declares and the HOST enforces. (A literal package
// name here would be a new hardcoded extension-INSTANCE coupling — see
// scripts/audit/core-extension-instance-coupling-ban.mjs, whose baseline is
// pinned EMPTY.) That is also why this is not modelled as an entry in the
// host-declared system-extension inventory or as a `required-in-prod` lock:
// those are HOST-side enrollments naming a package; this is a DECLARATION.
//
// RELATIONSHIP TO THE EXISTING REFUSALS. `assertCanRemoveExtension` (#1036,
// host-declared system extensions) and the `locked` row status (required-in-prod)
// are unchanged and run FIRST; this is an additive third refusal with the same
// "update is permitted, removal is not" semantics. `classifyRemovalFailure`
// maps it onto the existing user-facing `system` reason so every removal surface
// renders a coherent "this extension cannot be removed" message with no new UI.
//
// TRUST ROOT + RESIDUAL. The verdict is read from the materialized package's
// declaration — the SAME bytes, from the same store, that the install pipeline
// validated the declaration from (`readAssistantInstallSignalsFromStore`). An
// operator with write access to the extension store could therefore clear the
// flag; that is the identical trust root the declaration already has at install
// time, and it is NOT the forged-request threat this gate exists for. The
// hardening step — stamping the resolved flag onto the canonical row at the
// install finalize seam, so removal reads a DB column instead of the store (the
// `widget_auth_token_keys` arm-(c) precedent) — needs a canonical-row/DDL
// surface and is deliberately out of this slice's fences.
// ---------------------------------------------------------------------------

/** The removal intents this gate refuses — the kind-agnostic destructive set. */
export type ProtectedExtensionRemovalOp =
  | "archive"
  | "uninstall"
  | "force_delete"
  | "purge"
  | "registry_remove"
  | "compensation";

/**
 * The user-facing refusal. Deliberately mirrors the system-extension copy
 * ("update is permitted; removal is not") so the two protections read as one
 * concept to an operator.
 */
export function protectedExtensionRemovalMessage(
  packageName: string,
  op: ProtectedExtensionRemovalOp,
): string {
  return (
    `Cannot ${op} ${packageName} — the extension DECLARES itself protected ` +
    `(cinatra/config.json \`protected: true\`). Update is permitted; uninstall/delete is not.`
  );
}

/**
 * Refusal raised when a protected extension's removal is attempted. Carries a
 * STABLE `.code` / `.name` so `classifyRemovalFailure` duck-types it across the
 * dynamic-import / package boundary (the same contract the other removal errors
 * use — never `instanceof`).
 */
export class ProtectedExtensionRemovalError extends Error {
  readonly code = "DECLARED_PROTECTED_EXTENSION";
  readonly packageName: string;
  readonly op: ProtectedExtensionRemovalOp;
  constructor(packageName: string, op: ProtectedExtensionRemovalOp) {
    super(protectedExtensionRemovalMessage(packageName, op));
    this.name = "ProtectedExtensionRemovalError";
    this.packageName = packageName;
    this.op = op;
  }
}

/**
 * PURE refusal kernel: throw when the resolved declaration says protected.
 * Exported separately so a caller that already resolved the flag (or a test)
 * exercises the EXACT predicate both enforcement paths refuse on — the two
 * paths can never drift because they share this function.
 */
export function assertNotDeclaredProtected(
  packageName: string,
  op: ProtectedExtensionRemovalOp,
  isProtected: boolean,
): void {
  if (isProtected) throw new ProtectedExtensionRemovalError(packageName, op);
}

/** Injectable seam — the default resolves the real host reader lazily, so this
 *  module keeps no eager edge onto the host store/IO graph and every unit test
 *  can drive the gate without a filesystem. */
export type ProtectedExtensionDeps = {
  /**
   * Resolve whether `packageName`'s INSTALLED declaration marks it protected.
   * Contract (mirrors the install-time reader):
   *   - no materialized package / no `cinatra/config.json` / no `protected` key
   *     ⇒ `false` (absence is a PROVABLE non-protection — today's behavior for
   *     every extension, so an unprotected uninstall is untouched);
   *   - a present but unreadable / malformed declaration ⇒ THROW (fail-closed:
   *     we cannot prove the extension is unprotected, so we do not remove it).
   */
  readDeclaredProtection?: (packageName: string) => Promise<boolean>;
};

async function defaultReadDeclaredProtection(packageName: string): Promise<boolean> {
  const { resolveDeclaredProtectionForPackage } = await import(
    "@/lib/extension-protection-host"
  );
  return resolveDeclaredProtectionForPackage(packageName);
}

/**
 * Resolve the declared protection of an installed package. Never throws for the
 * ordinary "declares nothing" case; propagates the reader's fail-closed throw
 * for a present-but-unreadable declaration.
 */
export async function resolveDeclaredProtection(
  packageName: string,
  deps: ProtectedExtensionDeps = {},
): Promise<boolean> {
  const read = deps.readDeclaredProtection ?? defaultReadDeclaredProtection;
  return read(packageName);
}

/**
 * THE removal gate. Refuse `op` on `packageName` when its installed declaration
 * marks it protected. PURE-until-throw: performs no mutation. Call it BEFORE the
 * first durable mutation of any removal path.
 */
export async function assertExtensionNotProtected(
  packageName: string,
  op: ProtectedExtensionRemovalOp,
  deps: ProtectedExtensionDeps = {},
): Promise<void> {
  assertNotDeclaredProtected(packageName, op, await resolveDeclaredProtection(packageName, deps));
}
