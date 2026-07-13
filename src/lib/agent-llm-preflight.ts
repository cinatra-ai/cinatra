import "server-only";

// Run-enqueue LLM-provider availability preflight (cinatra#1062, wave 7 of
// #1055). The ratified LLM-provider dependency vocabulary is the OAS
// `metadata.cinatra.llm` block (docs/internals/contracts/llm-provider-dependency-vocabulary.md); this
// module surfaces an agent's declared provider requirement at run-enqueue,
// before the run reaches its `/api/llm-bridge` step.
//
// It REUSES the same pure resolver as the runtime bridge
// (`resolveCinatraLlmDispatch`) with the real `resolveProviderAdapter`
// availability probe, so the enqueue gate and the runtime dispatch CANNOT drift
// (they share one capability matrix + one branch algebra). We deliberately do
// NOT reimplement "is a compatible provider available" here.
//
// Why not a `kind:"connector"` dependency edge on the provider connector: the
// LLM provider connectors are admin-only surfaces, so routing the requirement
// through the #1056 connector-access preflight would deny non-admin runs. See
// the decision doc. Provider USABILITY is adapter availability — exactly what
// the resolver below checks.

import { resolveProviderAdapter } from "@cinatra-ai/llm";
import type { OasCinatraLlm, LlmProvider } from "@cinatra-ai/agents";
import {
  resolveCinatraLlmDispatch,
  type AdapterAvailabilityProbe,
} from "@/app/api/llm-bridge/_llm-dispatch";

export class LlmProviderNotConfiguredError extends Error {
  override readonly name = "LlmProviderNotConfiguredError";
  readonly code = "LLM_PROVIDER_NOT_CONFIGURED" as const;
  /** Deep-link to the LLM provider configuration surface. */
  readonly settingsHref = "/configuration/llm";
  /** The resolver's 503 body (capability, requestedProvider, message, …). */
  readonly detail: Record<string, unknown>;

  constructor(detail: Record<string, unknown>) {
    super(
      typeof detail.message === "string"
        ? detail.message
        : "Agent run blocked: no installed and configured LLM provider satisfies this agent's requirement.",
    );
    this.detail = detail;
  }
}

// Real adapter-availability probe — parity with `/api/llm-bridge`'s
// `isAdapterAvailable` (a provider is available iff its adapter resolves, which
// means a credential is configured). Injectable so tests drive the resolver
// without touching the LLM registry.
const defaultAdapterAvailabilityProbe: AdapterAvailabilityProbe = async (
  provider: LlmProvider,
): Promise<boolean> => (await resolveProviderAdapter(provider).catch(() => null)) !== null;

/**
 * Throw `LlmProviderNotConfiguredError` when an agent's declared LLM-provider
 * requirement cannot be satisfied by any installed-and-configured provider.
 *
 * Blocks ONLY on the resolver's 503 (`capability_unsatisfiable`) outcome — no
 * available provider satisfies a `capabilityRequired` (or a `preferredProvider`
 * that is itself capability-incompatible). Everything the resolver would let
 * proceed passes here too, matching runtime:
 *   - a resolved dispatch (a compatible provider is available), and
 *   - a soft fallback (a bare `preferredProvider` is down but no capability gate
 *     forces a hard error — the bridge falls back to the configured default).
 * A 400 `model_provider_mismatch` is a publish-time validation concern
 * (`validate-agent-json`), not a provider-availability failure, so it is not a
 * run-enqueue block here.
 *
 * `undefined` requirement (no OAS llm block, or none could be read) => no gate.
 */
export async function assertLlmProviderAvailableForRun(
  requirement: OasCinatraLlm | undefined,
  probe: AdapterAvailabilityProbe = defaultAdapterAvailabilityProbe,
): Promise<void> {
  if (!requirement) return; // no preflight signal
  const outcome = await resolveCinatraLlmDispatch(requirement, probe);
  if (outcome.kind === "error" && outcome.status === 503) {
    throw new LlmProviderNotConfiguredError(outcome.body);
  }
}
