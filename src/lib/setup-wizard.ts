// S6 (cinatra#2093, epic #2086): the AI step's readiness is the validity of the
// setup READINESS RECEIPT, not a cached connection boolean.
//
// The pre-S6 read asked the OpenAI surface "does this connection look ready?".
// That hardcoded OpenAI as the only possible provider AND — on the Anthropic
// path — would have answered "yes" for a connection whose `function-tools` MCP
// mode rejects every `container.skills` request, so setup would complete while
// skills silently never reached the model. Readiness is now the RECEIPT the
// saga earns (key validated, skills uploaded and injectable, probe accepted),
// which expires when the credential, the MCP mode, or the catalog changes.
//
// ROUTE-GRAPH NOTE: this module is statically reachable from the LOCKED routes
// through the app-shell setup redirect, so the readiness module (+ the purpose
// policy behind it) adds a measured +2 first-party modules to each. That raise
// is ABSORBED with a record in route-graph-ratchet.baseline.json rather than
// hidden — the route-graph analyzer follows `import()` too, so a lazy import
// would move the runtime cost without changing the measured graph, and
// pretending otherwise would be the dishonest fix.
import { readSetupReadinessState } from "@/lib/setup-readiness-saga";
import { getNangoStatus } from "@/lib/nango-system";
// Instance identity presence determines whether the name step is ready.
// The setup wizard uses /setup/key, /setup/name, and /setup/ai route segments.
import { readInstanceIdentity } from "@/lib/instance-identity-store";

export type SetupWizardStep = {
  id: string;
  title: string;
  href: string;
  ready: boolean;
};

export async function getSetupWizardSteps(): Promise<SetupWizardStep[]> {
  const identity = readInstanceIdentity();
  const nangoStatus = getNangoStatus();
  // Provider-AGNOSTIC readiness: valid receipt ⇒ the chosen provider (whichever
  // it is) was actually proven to work, including the Anthropic upload+probe
  // arms. No receipt, a receipt for a provider that is no longer the stored
  // default, or a receipt whose configuration fingerprint drifted ⇒ not ready.
  const aiReady = readSetupReadinessState().ready;

  const steps: SetupWizardStep[] = [];

  // The key step is first. The env var must be set with at least 32 chars
  // before any other setup can proceed. Absence blocks the wizard.
  const encryptionKeyOk = (process.env.CINATRA_ENCRYPTION_KEY?.trim().length ?? 0) >= 32;
  steps.push({
    id: "key",
    title: "Key",
    href: "/setup/key",
    ready: encryptionKeyOk,
  });

  // The name step follows the key step. The identity row's presence is the
  // `ready` signal.
  steps.push({
    id: "name",
    title: "Name",
    href: "/setup/name",
    ready: identity !== null,
  });

  if (nangoStatus.status !== "connected") {
    steps.push({
      id: "connections",
      title: "Connections",
      href: "/setup/connections",
      ready: false,
    });
  }

  steps.push({
    id: "ai",
    title: "AI",
    href: "/setup/ai",
    ready: aiReady,
  });

  return steps;
}

export function getFirstIncompleteStep(steps: SetupWizardStep[]): SetupWizardStep | null {
  return steps.find((step) => !step.ready) ?? null;
}

// Setup is complete when:
// 1. CINATRA_ENCRYPTION_KEY is set, which gates all setup
// 2. Instance name (namespace) is configured, which gates registry access
// 3. Nango is connected, which gates OAuth connections
// 4. The AI step holds a VALID readiness receipt for the chosen LLM provider
function isStepsComplete(steps: SetupWizardStep[]): boolean {
  // The key must be ready as a hard precondition.
  const keyStep = steps.find((s) => s.id === "key");
  if (keyStep && !keyStep.ready) return false;
  const nameStep = steps.find((s) => s.id === "name");
  if (nameStep && !nameStep.ready) return false;
  const nangoStep = steps.find((s) => s.id === "connections");
  if (nangoStep && !nangoStep.ready) return false;
  const aiStep = steps.find((s) => s.id === "ai");
  if (aiStep && !aiStep.ready) return false;
  return true;
}

// Stored on globalThis so Turbopack HMR module re-evaluation (triggered on every
// new route compilation in dev mode) does not reset the cache. A module-level
// `let` would reset to null on every HMR cycle, causing a Nango HTTP call and
// a readCampaignStore() Worker thread on each proxy request after compilation.
// Setup state only changes when the user connects an API key, so 60 s staleness
// is acceptable and globalThis keeps the value warm across HMR reloads.
//
// The cache key suffix intentionally invalidates older setup-completion cache
// entries whose step definitions no longer match the current wizard.
declare global {
  // eslint-disable-next-line no-var
  var __cinatraSetupCompleteCacheV6: { result: boolean; expiresAt: number } | null | undefined;
}

export async function isSetupWizardComplete(): Promise<boolean> {
  // Browser-e2e affordance: a freshly-provisioned instance has no
  // instance-identity / Nango / OpenAI rows, so the app shell redirects every
  // authenticated route to /setup. Browser tests exercise app surfaces
  // (projects, customers, permissions), not the wizard. This is an explicit,
  // opt-in env flag that is never set in a real deployment. Gated on the var
  // alone so it also works when the e2e runs against a production build
  // (`next start`, NODE_ENV=production).
  if (process.env.CINATRA_E2E_SETUP_BYPASS === "true") {
    return true;
  }
  const now = Date.now();
  const cached = globalThis.__cinatraSetupCompleteCacheV6;
  if (cached && cached.expiresAt > now) {
    return cached.result;
  }
  // Cache miss - re-evaluate. Log this so we can detect unexpected re-evaluations
  // caused by Turbopack HMR resetting the module-level _setupCompleteCache variable.
  console.log("[setup-wizard] isSetupWizardComplete: cache miss, re-evaluating steps");
  const steps = await getSetupWizardSteps();
  const result = isStepsComplete(steps);
  console.log(
    "[setup-wizard] isSetupWizardComplete: result =",
    result,
    "| steps =",
    steps.map((s) => `${s.id}:${s.ready}`).join(", "),
  );
  // Only cache a COMPLETE (true) result. An INCOMPLETE (false) result must be
  // re-evaluated on every call: otherwise the app-shell redirect gate
  // (layout.tsx -> app-shell `requiresSetupRedirect`) can serve a 60s-stale
  // `false` right after the user finishes the last step (e.g. the AI/OpenAI
  // step, whose save path does not invalidate this cache) while `/setup`
  // re-evaluates the steps FRESH, finds them complete, and redirects back to
  // `/` -> `/chat` -> (stale false) `/setup` -> ... an infinite redirect loop
  // until the TTL expires. A stale `true` is safe (once setup is complete it
  // stays complete), and re-evaluating an incomplete setup is cheap (identity +
  // secret-key presence + OpenAI state reads, no live network call). This is
  // also robust to multi-worker dev where globalThis invalidation is unreliable.
  if (result) {
    globalThis.__cinatraSetupCompleteCacheV6 = { result, expiresAt: now + 60_000 };
  }
  return result;
}

/** Call this after saving API connection administration so the next navigation reflects the new state. */
export function invalidateSetupWizardCache(): void {
  globalThis.__cinatraSetupCompleteCacheV6 = null;
}
