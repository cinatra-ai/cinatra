// -----------------------------------------------------------------------------
// ONE DEVELOPMENT COMMAND FOR THE FOUR SETUP WRITES.
//
// Proving a change on a development instance should not begin with a browser
// session through four wizard steps whose underlying writes take seconds. This
// composes the four — namespace, provider connection, connector-service secret,
// public origin — into one in-process call, reusing the SAME writers each
// screen reaches. It invents no row shape, no codec and no second validator.
//
// SECRET TRAVEL — the rule this whole path is built around:
//
//     Every secret value (the provider key, the connector-service secret)
//     reaches this process over STDIN, or an equivalent in-process channel.
//     NEVER as a command-line argument. NEVER through an environment file
//     written to disk. NEVER logged. Each value is sealed by the exact
//     encryption call the corresponding screen already uses, and nothing here
//     ever writes a credential to a file or bakes one into a database template.
//
// RUNTIME. This command, and every wrapper it calls, independently refuses to
// run outside a development runtime — see `./runtime-gate`. That is in addition
// to (never instead of) the admin-session authorization the wizard's own
// actions require; nothing here is reachable from a browser.
//
// IDEMPOTENT. Each leg reports whether it wrote. A second run over unchanged
// input writes nothing and makes no further external call.
// -----------------------------------------------------------------------------

import type { LlmProvider } from "@cinatra-ai/agents/llm-provider-policy";

import { assertDevelopmentRuntime } from "@/lib/dev-instance-provisioning/runtime-gate";
import {
  provisionInstanceNamespace,
  type ProvisionNamespaceOutcome,
} from "@/lib/dev-instance-provisioning/provision-namespace";
import {
  provisionConnectorServiceSecret,
  type ProvisionConnectorServiceSecretOutcome,
} from "@/lib/dev-instance-provisioning/provision-connector-service-secret";
import {
  PUBLIC_ORIGIN_RESTART_STEP,
  provisionPublicOrigin,
  type ProvisionPublicOriginOutcome,
} from "@/lib/dev-instance-provisioning/provision-public-origin";
import type {
  ProvisionProviderConnectionDeps,
  ProvisionProviderConnectionOutcome,
} from "@/lib/dev-instance-provisioning/provision-provider-connection";
import type { DeferredInstanceIdentityDeps } from "@/lib/instance-identity-deferred-write";

export type DevInstanceProvisioningRequest = {
  namespace?: {
    instanceNamespace: string;
    instanceDisplayName: string;
    registryUrl?: string;
  };
  connectorService?: {
    /** In-memory only, from stdin. */
    secretKey?: string;
    serverUrl?: string;
  };
  provider?: {
    provider: LlmProvider;
    /** In-memory only, from stdin. */
    apiKey: string;
    projectId?: string;
    organizationId?: string;
  };
  publicOrigin?: string | null;
};

export type DevInstanceProvisioningDeps = ProvisionProviderConnectionDeps &
  DeferredInstanceIdentityDeps;

export type DevInstanceProvisioningReport = {
  namespace: ProvisionNamespaceOutcome | null;
  connectorService: ProvisionConnectorServiceSecretOutcome | null;
  provider: ProvisionProviderConnectionOutcome | null;
  publicOrigin: ProvisionPublicOriginOutcome | null;
  /** True when at least one leg wrote. */
  wrote: boolean;
  /** The operator-facing lines the command prints, in order. */
  notices: string[];
};

/**
 * ORDER MATTERS, and it is the wizard's own. The connector-service secret comes
 * before the provider connection because the Anthropic credential is stored
 * THROUGH the connection service — the wizard's Secrets step precedes its Model
 * step for the same reason, and its Model step's fix-forward copy says so.
 */
export async function provisionDevInstance(
  request: DevInstanceProvisioningRequest,
  deps?: DevInstanceProvisioningDeps,
): Promise<DevInstanceProvisioningReport> {
  assertDevelopmentRuntime("provisionDevInstance");

  const notices: string[] = [];

  const namespace = request.namespace
    ? await provisionInstanceNamespace(request.namespace, {
        attachMarketplaceConsumer: deps?.attachMarketplaceConsumer,
      })
    : null;
  if (namespace) {
    notices.push(
      namespace.written
        ? `Namespace: @${namespace.instanceNamespace} written.`
        : `Namespace: @${namespace.instanceNamespace} was already on file — nothing written.`,
    );
  }

  const connectorService = request.connectorService
    ? provisionConnectorServiceSecret(request.connectorService)
    : null;
  if (connectorService) {
    notices.push(
      connectorService.written
        ? "Connector-service secret: written (sealed at rest by the screen's own codec)."
        : "Connector-service secret: already on file — nothing written.",
    );
  }

  // Loaded only when a provider leg is actually requested: the provider road
  // reaches the connector-dispatch graph, and the three other legs must stay
  // runnable in a plain Node process that never evaluates it.
  const provider = request.provider
    ? await (
        await import("@/lib/dev-instance-provisioning/provision-provider-connection")
      ).provisionProviderConnection(request.provider, deps)
    : null;
  if (provider) {
    notices.push(
      provider.written
        ? `Provider connection: ${provider.provider} committed.`
        : `Provider connection: nothing written — ${provider.note}.`,
    );
  }

  const publicOrigin =
    request.publicOrigin !== undefined ? provisionPublicOrigin(request.publicOrigin) : null;
  if (publicOrigin) {
    notices.push(
      publicOrigin.written
        ? `Public origin: ${publicOrigin.publicOrigin ?? "cleared"}.`
        : "Public origin: already set to this value — nothing written.",
    );
    // The restart step is printed whenever an origin stands, written now or
    // not: an operator re-running the command on an instance that has not been
    // restarted since still owes the restart.
    notices.push(PUBLIC_ORIGIN_RESTART_STEP);
  }

  return {
    namespace,
    connectorService,
    provider,
    publicOrigin,
    wrote: Boolean(
      namespace?.written ||
        connectorService?.written ||
        provider?.written ||
        publicOrigin?.written,
    ),
    notices,
  };
}
