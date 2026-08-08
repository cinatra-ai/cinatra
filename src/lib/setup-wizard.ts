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
//
// S3 (cinatra#2388, epic #2385): the AI step's readiness now derives from the
// provider-commit state machine — commitment (the LOCK) + a fresh keyed
// credential fingerprint + the provider-specific readiness evidence — and the
// derivation is FRESH on every request (the positive completion cache is gone;
// cinatra#2503 added a per-request memo, which is a dedupe within one render,
// not a cache across them — see the note below).
//
// cinatra#2503: the derivation below is memoized PER SERVER REQUEST with React
// `cache()`. Two gates read completeness — the root layout's shell gate and
// `/setup`'s own routing read — and they used to re-derive it separately even
// when they rendered together, so a flapping backend could hand them opposite
// answers in ONE render.
//
// Scope, stated honestly: React's cache is per server request. It removes
// same-render disagreement and collapses the duplicate credential reads a setup
// render made; it does NOT make the two gates agree ACROSS navigations (`/` and
// `/setup` are separate requests, each with a fresh cache). The cross-request
// half of the loop is closed by `evaluateSetupGate` below, which stops an error
// from being read as "incomplete" in the first place.
import { cache } from "react";

import { deriveSetupAiStepState } from "@/lib/setup-provider-commit";
import { getNangoStatus } from "@/lib/nango-system";
// Instance identity presence determines whether the name step is ready.
// The setup wizard uses /setup/key, /setup/name, and /setup/model route segments.
import { readInstanceIdentity } from "@/lib/instance-identity-store";
// cinatra#2386 — whether the sign-up step exists at all (it is present only
// until the first Better Auth user is created).
import { hasAnyBetterAuthUsers } from "@/lib/auth";

export type SetupWizardStep = {
  id: string;
  title: string;
  href: string;
  ready: boolean;
};

async function computeSetupWizardSteps(): Promise<SetupWizardStep[]> {
  const hasUsers = await hasAnyBetterAuthUsers();
  const identity = readInstanceIdentity();
  const nangoStatus = getNangoStatus();
  // S3 (cinatra#2388): the AI step is ready iff the COMMIT machine says so —
  // a committed provider (the lock), a LIVE keyed credential fingerprint that
  // still matches the commitment (credential loss/rotation reopens the key
  // flow without unlocking the choice), and the provider-specific readiness
  // evidence (the receipt re-derivation). This read also drives the lazy
  // receipt→commitment migration for instances that completed setup under the
  // receipt model.
  const aiReady = (await deriveSetupAiStepState()).ready;

  const steps: SetupWizardStep[] = [];

  // cinatra#2477 (owner acceptance review, was cinatra#2386) — the sign-up
  // step is ALWAYS step 1 of the rail, on every setup page. It completes
  // like any other step: `ready` flips true (a checked pill) once the first
  // Better Auth user exists. (Pre-#2477 the step retired — disappeared —
  // instead; the owner review pinned the universal indicator.)
  steps.push({
    id: "sign-up",
    title: "Account",
    href: "/setup/account",
    ready: hasUsers,
  });

  // The key step follows sign-up. The
  // env var must be set with at least 32 chars before any other setup can
  // proceed. Absence blocks the wizard.
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

  // S4 (cinatra#2389), relabeled "Model" + route /setup/model in the #2477
  // owner review: the step is the choice of the LLM that drives the Cinatra
  // chat assistant. The id stays "ai" — a stable internal identifier the
  // wizard logic keys on (like "sign-up" above), decoupled from label/route.
  steps.push({
    id: "ai",
    title: "Model",
    href: "/setup/model",
    ready: aiReady,
  });

  return steps;
}

/**
 * The wizard's step list, derived ONCE PER SERVER REQUEST (cinatra#2503).
 *
 * Every consumer — the root layout's shell gate, `/setup`'s router, the setup
 * layout's rail, and each step page's own "am I still the next step?" check —
 * goes through this one memo, so everything rendered by a single request sees
 * the SAME answer. A later request re-derives from scratch (that is what keeps
 * a completed step from going stale after a mutation). Outside a server-request
 * scope (unit tests, scripts) React's `cache` is a pass-through, so behavior
 * there is unchanged.
 */
export const getSetupWizardSteps = cache(computeSetupWizardSteps);

export function getFirstIncompleteStep(steps: SetupWizardStep[]): SetupWizardStep | null {
  return steps.find((step) => !step.ready) ?? null;
}

// Setup is complete when:
// 0. The first account exists (the sign-up step reads ready — cinatra#2477)
// 1. CINATRA_ENCRYPTION_KEY is set, which gates all setup
// 2. Instance name (namespace) is configured, which gates registry access
// 3. Nango is connected, which gates OAuth connections
// 4. The AI step's commit machine reads ready: a committed provider (the
//    lock) + a fresh matching credential fingerprint + the live
//    provider-specific readiness inputs (S4, cinatra#2389 — no receipt)
function isStepsComplete(steps: SetupWizardStep[]): boolean {
  // The sign-up step is always present (cinatra#2477); it blocks completion
  // until the first account exists (`ready: hasUsers`). In practice an
  // authenticated caller implies a user exists, so this never blocks a real
  // session — but the gate stays honest without relying on that invariant.
  const signUpStep = steps.find((s) => s.id === "sign-up");
  if (signUpStep && !signUpStep.ready) return false;
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

// S3 (cinatra#2388): the positive-only completion cache
// (`__cinatraSetupCompleteCacheV6`, its key constant, and
// `invalidateSetupWizardCache`) is RETIRED. It assumed completion is monotonic
// — "once setup is complete it stays complete" — which the commit machine
// makes false by design: a credential deletion/rotation flips the AI step back
// to incomplete via the fingerprint mismatch, and a 60 s stale `true` window
// would keep serving app routes on an instance whose provider can no longer
// authenticate. Completion is re-derived freshly on every REQUEST; the
// derivation is cheap (metadata reads + one connector credential read), and
// there is no stale-true window after invalidation because there is nothing to
// invalidate. (cinatra#2503 narrowed "every read" to "every request": the
// `cache()` above dedupes repeat reads WITHIN one render. That is not a
// staleness window in the old cache's sense — the memo does not survive into a
// later request, so nothing it holds is ever served to one.)
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
  const steps = await getSetupWizardSteps();
  return isStepsComplete(steps);
}

/**
 * The SHELL gate's view of setup completeness — three states, not two
 * (cinatra#2503).
 *
 * `isSetupWizardComplete()` above answers a boolean and PROPAGATES a read
 * failure, which is right for its API callers. The root layout needs something
 * else: it must never turn "I could not find out" into "not set up". That
 * conflation is the redirect loop. A transient Postgres refusal during
 * container warm-up made `isSetupWizardComplete()` throw, the layout's
 * `Promise.all` rejected, `setupComplete` fell back to its `false` default, and
 * the shell redirected a fully-configured instance to `/setup` — where the
 * independent gate, reading a moment later when the DB answered, said
 * "complete" and redirected back to `/`. Round and round until the read
 * stabilized.
 *
 * So an error is its own answer: `indeterminate`. The caller decides what to do
 * with it, and the layout deliberately does NOT force the wizard on it — an
 * instance that was working a second ago is far more likely to be mid-blip than
 * genuinely unconfigured, and the wrong guess in that direction is an infinite
 * bounce, while the wrong guess in the other direction is a degraded render.
 * That fail-open guess does not expire by itself (a root layout survives client
 * navigation), so the shell re-derives it once — see `setupGateIndeterminate`
 * in src/app/layout.tsx and its retry in src/components/app-shell.tsx.
 *
 * `incomplete` still means a real, successfully-read "steps remain" — that is
 * the ONLY state that redirects.
 */
export type SetupGateState = "complete" | "incomplete" | "indeterminate";

export async function evaluateSetupGate(): Promise<SetupGateState> {
  if (process.env.CINATRA_E2E_SETUP_BYPASS === "true") {
    return "complete";
  }
  try {
    const steps = await getSetupWizardSteps();
    return isStepsComplete(steps) ? "complete" : "incomplete";
  } catch (err) {
    // Logged, never swallowed silently: an indeterminate gate is a symptom of a
    // backend problem the operator needs to see, even though the shell degrades
    // gracefully around it.
    console.error(
      "[setup-wizard] setup-completeness read failed — gate is INDETERMINATE (not 'incomplete'):",
      err,
    );
    return "indeterminate";
  }
}
