// -----------------------------------------------------------------------------
// LEG 3 — the PROVIDER CONNECTION, without a browser.
//
// TWO PROVIDERS, TWO ROADS, and the second is NOT a smaller version of the
// first.
//
//   openai    — a non-browser road already exists and is reused AS-IS: the boot
//               phase `provider-connection-bootstrap` seals the connection
//               through the wizard's own `updateOpenAIConnection` and then
//               completes the step through the same
//               `beginSetupProviderClaim` / `commitSetupProviderClaim` pair the
//               wizard's Continue drives. This module hands that phase the key
//               IN MEMORY, through the environment variable the phase already
//               reads, and restores the previous value afterwards. Nothing is
//               written to disk and nothing new is invented.
//
//   anthropic — the bootstrap does not cover it, and the wizard's Anthropic arm
//               is a longer sequence: the skills-upload CONSENT transaction, the
//               native-MCP-mode switch, and the READINESS SAGA — all three, or
//               `deriveSetupAiStepState` never reads ready no matter how good
//               the key is. So this module drives that same sequence, in the
//               wizard's order, through the wizard's own functions.
//
// SECRETS. The key arrives as an in-memory argument from the caller. It is
// never an argv value, never written to a file, and never logged — the only
// thing this module says about it is whether one was supplied.
// -----------------------------------------------------------------------------

import type { LlmProvider } from "@cinatra-ai/agents/llm-provider-policy";

import { updateDefaultLlmProviderAtBoot } from "@/lib/admin/default-llm-provider-mutation";
import { grantSetupConsentWithWorkspaceOptInInDatabase } from "@/lib/anthropic-setup-consent-store";
import { assertDevelopmentRuntime } from "@/lib/dev-instance-provisioning/runtime-gate";
import {
  readLiveCredentialFingerprint,
  type LiveCredentialFingerprint,
} from "@/lib/llm-credential-fingerprint";
import { providerConnectionBootstrapPhases } from "@/lib/boot/phases/provider-connection-bootstrap";
import {
  beginSetupProviderClaim,
  commitSetupProviderClaim,
  compensateOwnedSetupCommitment,
  deriveSetupAiStepState,
  readSetupProviderCommitState,
  releaseSetupProviderClaim,
} from "@/lib/setup-provider-commit";
import {
  clearSetupReadinessReceipt,
  readAnthropicMcpMode,
  runSetupReadinessSaga,
  writeAnthropicMcpMode,
  type SetupReadinessPorts,
} from "@/lib/setup-readiness-saga";
import type { SetupConnectionSaveResult } from "@/lib/setup-provider-connection-writer";

export type ProvisionProviderConnectionInput = {
  provider: LlmProvider;
  /** In-memory only. */
  apiKey: string;
  projectId?: string;
  organizationId?: string;
};

export type ProvisionProviderConnectionDeps = {
  /** The connector's own non-redirecting save, dispatched through the host
   *  writer. Injectable so a test can seed the connection without a live key. */
  saveConnection?: (
    provider: "openai" | "anthropic",
    values: Record<string, string>,
  ) => Promise<SetupConnectionSaveResult>;
  /** The live keyed credential fingerprint. Injectable for the same reason. */
  readCredentialFingerprint?: (provider: string) => Promise<LiveCredentialFingerprint>;
  /** Overrides folded onto the REAL readiness ports — the external readiness
   *  calls, and nothing else. The commit sink stays the machine's. */
  readinessPortOverrides?: Partial<SetupReadinessPorts>;
};

export type ProvisionProviderConnectionOutcome = {
  provider: LlmProvider;
  written: boolean;
  /** Why nothing was written, when nothing was. */
  note: string | null;
};

const OPENAI_KEY_ENV = "OPENAI_API_KEY";
const OPENAI_PROJECT_ENV = "OPENAI_API_PROJECT";
const OPENAI_ORG_ENV = "OPENAI_API_ORG";

export async function provisionProviderConnection(
  input: ProvisionProviderConnectionInput,
  deps?: ProvisionProviderConnectionDeps,
): Promise<ProvisionProviderConnectionOutcome> {
  assertDevelopmentRuntime("provisionProviderConnection");

  if (input.apiKey.trim().length === 0) {
    throw new Error(
      `No ${input.provider} API key reached the command. The key travels over stdin; ` +
        "it is never a command-line argument.",
    );
  }

  const readFingerprint = deps?.readCredentialFingerprint ?? readLiveCredentialFingerprint;

  // Already provisioned? The wizard's own derivation is the authority, so a
  // second run asks it rather than guessing from the rows.
  const before = await deriveSetupAiStepState({ readCredentialFingerprint: readFingerprint });
  if (
    before.ready &&
    before.commitState.kind === "committed" &&
    before.commitState.commitment.provider === input.provider
  ) {
    return {
      provider: input.provider,
      written: false,
      note: `the ${input.provider} connection is already committed and reads ready`,
    };
  }

  if (input.provider === "anthropic") {
    await provisionAnthropicConnection(input, deps, readFingerprint);
  } else {
    await provisionThroughEnvironmentBootstrap(input);
  }

  return { provider: input.provider, written: true, note: null };
}

/**
 * The OPENAI road, reused as-is. The key is placed in the process environment
 * the bootstrap phase reads — in memory, for the duration of the phase — and
 * the previous value is restored afterwards so the command leaves the process
 * exactly as it found it.
 */
async function provisionThroughEnvironmentBootstrap(
  input: ProvisionProviderConnectionInput,
): Promise<void> {
  // SERIALIZED. `process.env` is process-global, so two overlapping calls could
  // otherwise read each other's key or restore a stale value. The CLI gets a
  // private process, but this is an exported in-process API and has to be safe
  // for the caller that reuses it.
  return runExclusively(async () => {
    const restore = snapshotEnvValues([OPENAI_KEY_ENV, OPENAI_PROJECT_ENV, OPENAI_ORG_ENV]);
    process.env[OPENAI_KEY_ENV] = input.apiKey;
    if (input.projectId) process.env[OPENAI_PROJECT_ENV] = input.projectId;
    if (input.organizationId) process.env[OPENAI_ORG_ENV] = input.organizationId;
    try {
      const [phase] = providerConnectionBootstrapPhases();
      await phase.run();
    } finally {
      restore();
    }
  });
}

/** A process-local queue: one environment-borrowing bootstrap run at a time. */
let environmentBootstrapQueue: Promise<unknown> = Promise.resolve();
function runExclusively<T>(run: () => Promise<T>): Promise<T> {
  const next = environmentBootstrapQueue.then(run, run);
  environmentBootstrapQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function snapshotEnvValues(keys: readonly string[]): () => void {
  const previous = keys.map((key) => [key, process.env[key]] as const);
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/**
 * The ANTHROPIC road: the wizard's full sequence, in the wizard's order.
 *
 *   fence       → the pre-flight read, then `beginSetupProviderClaim` — taken
 *                 BEFORE the credential is written, because the fence guards
 *                 the credential and not only the commit.
 *   credential  → the connector's own non-redirecting save, through the host
 *                 writer the step uses, INSIDE the fence.
 *   consent     → the one transaction that lands the workspace upload opt-in
 *                 AND the bulk ledger grant, or neither.
 *   native mode → the readiness input `areProviderReadinessInputsSatisfied`
 *                 re-reads live; without it the step never reads ready.
 *   saga        → `runSetupReadinessSaga`, committing through the atomic setup
 *                 sink and the audited default write, under the wizard's
 *                 ownership-scoped compensation port.
 */
async function provisionAnthropicConnection(
  input: ProvisionProviderConnectionInput,
  deps: ProvisionProviderConnectionDeps | undefined,
  readFingerprint: (provider: string) => Promise<LiveCredentialFingerprint>,
): Promise<void> {
  // IMPORTED WHEN IT IS USED, not at module load. The connector-dispatch
  // writer's graph reaches the installed-extension wiring, which a plain Node
  // process running this command cannot evaluate — and a run that provisions no
  // provider (or one whose caller supplies its own writer) has no business
  // loading it. Same lazy shape the boot phase uses for the same reason.
  const saveConnection =
    deps?.saveConnection ??
    (await import("@/lib/setup-provider-connection-writer")).saveSetupProviderConnection;

  // ---- THE FENCE FIRST, exactly as the wizard takes it --------------------
  // The wizard reads the fence and ACQUIRES the claim BEFORE the credential is
  // written, on purpose: under a pending claim another run is verifying a
  // specific credential, and writing a new one underneath it invalidates the
  // fingerprint that run started with. Saving first and refusing afterwards
  // would leave exactly the damage the refusal is meant to prevent.
  const fence = readSetupProviderCommitState();
  if (fence.kind === "claim-pending") {
    throw new Error(
      "A setup provider claim is already pending on this instance — let it expire, then run again.",
    );
  }
  if (fence.kind === "committed" && fence.commitment.provider !== "anthropic") {
    throw new Error(
      `This instance is already committed to "${fence.commitment.provider}". Changing the ` +
        "provider is Administration's transactional path, not this command's.",
    );
  }

  // Sampled BEFORE the save, so it is the fingerprint this run STARTED from —
  // the value the machine compares against, not the one this run is about to
  // write.
  let claim: { nonce: string; priorDefault: string } | null = null;
  if (fence.kind === "absent") {
    const starting = await readFingerprint("anthropic");
    const begun = beginSetupProviderClaim({
      provider: "anthropic",
      actorId: null,
      startingCredentialFingerprint:
        starting.status === "readable" ? starting.fingerprint : null,
    });
    if (!begun.ok) {
      throw new Error(`Could not claim the setup provider record (${begun.refusal}).`);
    }
    claim = { nonce: begun.claim.nonce, priorDefault: begun.claim.priorDefault };
  }

  let claimConsumed = false;
  try {
    // ---- The credential, UNDER the fence ---------------------------------
    const saved = await saveConnection("anthropic", { apiKey: input.apiKey });
    if (!saved.ok) {
      throw new Error(`The Anthropic connection was not saved: ${saved.sanitizedMessage}`);
    }

    // No human took this action, so no human is named on the grant.
    grantSetupConsentWithWorkspaceOptInInDatabase(null);

    // BEFORE the fingerprint is sampled, exactly as the wizard does it: the
    // mode is a readiness-fingerprint input, so the receipt is cleared first.
    if (readAnthropicMcpMode() !== "native") {
      clearSetupReadinessReceipt();
      writeAnthropicMcpMode("native");
    }

    const live = await readFingerprint("anthropic");
    const credentialFingerprint = live.status === "readable" ? live.fingerprint : null;

    // The commitment THIS run creates, carried so the compensation below can
    // prove it owns the bytes it tombstones.
    let committed: { raw: string; provider: string } | null = null;

    const { createSetupReadinessPorts } = await import("@/lib/setup-readiness-ports");
    const ports = createSetupReadinessPorts({
      setDefaultProvider: async (provider) => {
        if (claim === null) return; // re-verify over an existing commitment
        const committedResult = await commitSetupProviderClaim({
          nonce: claim.nonce,
          credentialFingerprint,
          // Honest in the record: no operator worked the wizard.
          provenance: "environment-bootstrap",
          writeAuditedDefault: (p) => updateDefaultLlmProviderAtBoot({ provider: p }),
        });
        if (!committedResult.ok) throw new Error(committedResult.message);
        committed = { raw: committedResult.raw, provider };
        claimConsumed = true;
      },
    });

    // The wizard's OWNERSHIP-SCOPED compensation, not the default port. After a
    // landed commit a receipt-write failure forces a restore; the default port
    // writes the prior default unconditionally and leaves the commitment
    // standing — a committed provider with no receipt, which reads as "chosen
    // but never verified" forever. `compensateOwnedSetupCommitment` CAS-
    // tombstones the exact committed bytes first and only then restores.
    ports.restoreDefaultProvider = async () => {
      const landed = committed;
      if (landed && claim !== null) {
        compensateOwnedSetupCommitment({
          committedRaw: landed.raw,
          committedProvider: landed.provider,
          priorDefault: claim.priorDefault,
        });
        committed = null;
      }
    };

    Object.assign(ports, deps?.readinessPortOverrides ?? {});

    const result = await runSetupReadinessSaga({
      provider: "anthropic",
      actorUserId: null,
      onFailure: "leave-incomplete",
      ports,
    });
    if (!result.ok) {
      throw new Error(
        `The Anthropic readiness run stopped at "${result.failure.step}": ${result.failure.message}`,
      );
    }
  } finally {
    if (claim !== null && !claimConsumed) {
      try {
        releaseSetupProviderClaim({ nonce: claim.nonce });
      } catch {
        // The claim expires on its own; a failed release must not mask the
        // failure that brought us here.
      }
    }
  }
}
