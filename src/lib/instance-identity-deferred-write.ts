// -----------------------------------------------------------------------------
// The DEFERRED instance-identity PERSISTENCE PATH.
//
// This is not a new writer. It is the write half of `saveInstanceIdentityAction`
// (src/app/setup/name/actions.ts), lifted out of that "use server" module so a
// NON-BROWSER caller can reach the SAME writer the Name screen reaches instead
// of growing a second one beside it. The action keeps everything that is the
// wizard's: the admin session, the codes-only flash redirects, the registry
// provisioning modes, and the redirect on success. What moved is only the
// sequence of durable calls the deferred mode performs — the mode a local
// development instance takes, where no registry user is provisioned:
//
//     writeInstanceIdentity(...)  →  invalidateInstanceIdentityCache()
//                                 →  best-effort marketplace consumer attach
//
// A "use server" module may only export async functions, so a shared helper
// cannot live in the action file and stay importable from a plain module — the
// same reason `./registry-url` was extracted from it earlier.
// -----------------------------------------------------------------------------

import {
  buildFreshInstanceIdentityDurableFields,
  writeInstanceIdentity,
  type RemoteRegistryConnection,
} from "@/lib/instance-identity-store";
import { invalidateInstanceIdentityCache } from "@/lib/instance-identity-cache";
import { redactSensitive } from "@/lib/redact-sensitive";

export function buildDeferredRemoteRegistry(
  instanceNamespace: string,
  registryUrl: string,
): RemoteRegistryConnection | undefined {
  if (!registryUrl || !/^https?:\/\//i.test(registryUrl)) return undefined;
  return {
    url: registryUrl,
    namespace: instanceNamespace,
    status: "not_connected",
  };
}

/** The best-effort marketplace consumer attach the wizard performs after the
 *  deferred write. Never fatal — boot retries it. */
export async function attachMarketplaceConsumerBestEffort(): Promise<void> {
  try {
    const { ensureMarketplaceAttachment } = await import("@/lib/marketplace-attach");
    await ensureMarketplaceAttachment();
  } catch (e) {
    console.error(
      "[saveInstanceIdentityAction] marketplace consumer attach failed; will retry on boot:",
      redactSensitive(e),
    );
  }
}

export type DeferredInstanceIdentityInput = {
  instanceNamespace: string;
  instanceDisplayName: string;
  registryUrl: string;
};

export type DeferredInstanceIdentityDeps = {
  /** Injectable so a caller with no marketplace account (a local development
   *  provisioning run) can skip the network attempt outright. Defaults to the
   *  wizard's own best-effort attach. */
  attachMarketplaceConsumer?: () => Promise<void>;
};

export async function persistDeferredInstanceIdentity(
  input: DeferredInstanceIdentityInput,
  deps?: DeferredInstanceIdentityDeps,
): Promise<void> {
  const remote = buildDeferredRemoteRegistry(input.instanceNamespace, input.registryUrl);
  writeInstanceIdentity({
    instanceNamespace: input.instanceNamespace,
    instanceDisplayName: input.instanceDisplayName,
    ...buildFreshInstanceIdentityDurableFields(),
    registryUrl: input.registryUrl,
    firstPublishedAt: null,
    createdAt: new Date().toISOString(),
    ...(remote ? { registries: { remote } } : {}),
  });
  invalidateInstanceIdentityCache();
  await (deps?.attachMarketplaceConsumer ?? attachMarketplaceConsumerBestEffort)();
}
