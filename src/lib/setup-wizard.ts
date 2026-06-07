import { isOpenAIConnectionReady, getConfiguredOpenAIConnection } from "@cinatra-ai/openai-connector";
import { getNangoStatus } from "@cinatra-ai/nango-connector";
import { readOpenAIConnection } from "@/lib/openai-connection-store";
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
  const openAIConnection = readOpenAIConnection();
  const configuredConnection = await getConfiguredOpenAIConnection(openAIConnection ?? undefined);
  const openAIReady = isOpenAIConnectionReady(configuredConnection ?? openAIConnection ?? undefined);

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
    ready: openAIReady,
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
// 4. OpenAI is ready as the required LLM provider
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
// The V5 cache key suffix intentionally invalidates older setup-completion cache
// entries whose step definitions no longer match the current wizard.
declare global {
  // eslint-disable-next-line no-var
  var __cinatraSetupCompleteCacheV5: { result: boolean; expiresAt: number } | null | undefined;
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
  const cached = globalThis.__cinatraSetupCompleteCacheV5;
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
  globalThis.__cinatraSetupCompleteCacheV5 = { result, expiresAt: now + 60_000 };
  return result;
}

/** Call this after saving API connection administration so the next navigation reflects the new state. */
export function invalidateSetupWizardCache(): void {
  globalThis.__cinatraSetupCompleteCacheV5 = null;
}
