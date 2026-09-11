// -----------------------------------------------------------------------------
// LEG 1 — the NAMESPACE, without a browser.
//
// The Name screen's action (`saveInstanceIdentityAction`) validates, resolves a
// registry mode, writes, and then REDIRECTS. A redirect is exactly what a
// command cannot use, and re-implementing the write beside it is exactly what
// this must not become. So this wrapper is thin: the same namespace validator
// the screen and the rename modal share, then the screen's own deferred
// persistence path (`persistDeferredInstanceIdentity`), which is the mode a
// local development instance takes anyway — no registry user is provisioned and
// no marketplace token is spent.
//
// IDEMPOTENT. The screen refuses to re-provision over an existing identity row
// (`identity-exists`); this wrapper keeps that invariant and reports the second
// run as "already provisioned" instead of failing it, because a command that is
// safe to re-run is the whole point. A row under a DIFFERENT namespace is not
// this command's to overwrite — renaming an instance is Administration's
// transactional path, and saying so is more useful than silently clobbering it.
// -----------------------------------------------------------------------------

import { getApprovedInstanceNamespaces } from "@/lib/instance-namespace/approved-list";
import { parseInstanceDisplayName } from "@/lib/instance-identity-display-name";
import { validateInstanceNamespace } from "@/lib/instance-namespace";
import { readInstanceIdentity } from "@/lib/instance-identity-store";
import {
  persistDeferredInstanceIdentity,
  type DeferredInstanceIdentityDeps,
} from "@/lib/instance-identity-deferred-write";
import { assertDevelopmentRuntime } from "@/lib/dev-instance-provisioning/runtime-gate";
import { resolveRegistryUrl } from "@/app/setup/name/registry-url";

export type ProvisionNamespaceInput = {
  instanceNamespace: string;
  instanceDisplayName: string;
  /** Defaults to the wizard's own resolver, which prefers the local registry
   *  in a development runtime. */
  registryUrl?: string;
};

export type ProvisionNamespaceOutcome = {
  written: boolean;
  instanceNamespace: string;
  instanceDisplayName: string;
};

export async function provisionInstanceNamespace(
  input: ProvisionNamespaceInput,
  deps?: DeferredInstanceIdentityDeps,
): Promise<ProvisionNamespaceOutcome> {
  assertDevelopmentRuntime("provisionInstanceNamespace");

  // The screen's OWN display-name policy, not a second one: the same schema
  // `saveInstanceIdentityAction` parses with. Re-deriving "trim, 1..120" beside
  // it would be precisely the drift this change exists to avoid.
  const displayName = parseInstanceDisplayName(input.instanceDisplayName);
  if (!displayName.ok) throw new Error(displayName.message);
  const instanceDisplayName = displayName.instanceDisplayName;

  const namespaceResult = validateInstanceNamespace(input.instanceNamespace, {
    approvedExactNames: getApprovedInstanceNamespaces(),
  });
  if (!namespaceResult.ok) {
    throw new Error(
      `"${input.instanceNamespace}" is not a usable instance namespace — it fails the ` +
        "same policy the setup screen applies.",
    );
  }
  const instanceNamespace = namespaceResult.canonical;

  const existing = readInstanceIdentity();
  if (existing) {
    if (existing.instanceNamespace === instanceNamespace) {
      return { written: false, instanceNamespace, instanceDisplayName };
    }
    throw new Error(
      "This instance already carries the namespace " +
        `"${existing.instanceNamespace}". Renaming an instance is Administration's ` +
        "transactional path, not this command's.",
    );
  }

  await persistDeferredInstanceIdentity(
    {
      instanceNamespace,
      instanceDisplayName,
      registryUrl: input.registryUrl?.trim() || resolveRegistryUrl(),
    },
    deps,
  );

  return { written: true, instanceNamespace, instanceDisplayName };
}
