// The provider connection BOOTSTRAPS FROM THE ENVIRONMENT at boot.
//
// A deployment already materializes the provider credential into the instance
// ENVIRONMENT as `OPENAI_API_KEY`. The assistant, however, reads its key only
// from the SEALED `openai_connection` metadata row that the /setup/model wizard
// writes — so on every fresh deployment a human had to re-type a key the host
// was already holding. This phase closes that gap, once, at boot.
//
// WHAT IT DOES — and, as deliberately, what it does not:
//
//  - IT USES THE WIZARD'S OWN WRITER. The seal goes through
//    `updateOpenAIConnection`, which is the exact function the connector's
//    `saveConnection` is wired to (see register-host-connector-services) and
//    therefore the exact at-rest codec, row shape and merge-and-swap the wizard
//    produces. There is no second sealing path to keep in step with the first.
//  - IT COMPLETES THE STEP THROUGH THE SAME MACHINE. `beginSetupProviderClaim`
//    + `commitSetupProviderClaim` are what the wizard's Continue drives, and a
//    bootstrap that only sealed the row would still read INCOMPLETE: the step's
//    derivation asks for a COMMITMENT, not for a key. So the record is written
//    by the machine, under its fence, exactly as an operator's run would.
//  - THE SEALED ROW WINS. When a row already carries a key, the environment is
//    ignored. A key an operator rotated in the interface, or one this host's
//    environment never had, must not be silently replaced by whatever value a
//    deployment still carries. `CINATRA_PROVIDER_BOOTSTRAP_ROTATE=true` is the
//    explicit, logged opt-out, and it re-seals ONCE per process.
//    PRESENCE IS READ FROM THE RAW ROW, not from the decrypted value. A sealed
//    blob that cannot be decrypted (a rotated `CINATRA_ENCRYPTION_KEY`, tamper)
//    is dropped fail-closed by the unseal reader, so a decrypted read reports
//    NO KEY for a row that plainly has one — and this phase would then overwrite
//    an operator's credential without the rotate flag. An unreadable sealed row
//    is still a sealed row and still wins; the flag remains the only way past it.
//  - A ROTATION KEEPS THE STEP COMPLETE. Re-sealing changes the credential, and
//    the step's derivation compares the live credential's fingerprint against
//    the one the commitment stored — so a re-seal that left the commitment alone
//    would report the model step INCOMPLETE on an instance that was complete a
//    moment earlier. The rotate path therefore refreshes the stored fingerprint
//    through the machine's own byte-equal CAS.
//  - AN INTERRUPTED BOOTSTRAP RESUMES. The seal and the commitment are two
//    writes; a crash or a refusal between them leaves a sealed row and no
//    commitment, and the sealed-row-wins rule would then skip forever. So when
//    the sealed row holds THIS environment's value and no commitment exists, the
//    next boot finishes the half-done job. A row holding any OTHER value is an
//    operator's, and their unfinished wizard stays theirs.
//  - `OPENAI_API_KEY` STAYS IN THE ENVIRONMENT (decision, recorded here because
//    this is the phase that now also reads it): the knowledge-graph indexer
//    resolves that same variable directly for its legacy path, and that read is
//    unrelated to the sealed connection row. Consuming a variable is not owning
//    it — clearing it here would break the indexer and buy nothing, since the
//    value is in the process environment either way.
//
// POLICY `retryable`: a bootstrap that cannot run is never a reason to fail a
// deploy. Every refusal path leaves the instance exactly as the wizard would
// find it and simply retries on the next boot.
//
// SECRETS: this module never logs, returns or records the key VALUE. It narrates
// only THAT a bootstrap happened, and a failure carries the error CLASS only.
//
// Deliberately NOT importing "server-only": unit tests import the phase list.

import type { BootPhase } from "@/lib/boot/boot-phase";

/** The explicit opt-out that lets the environment overwrite a sealed row. */
export const PROVIDER_BOOTSTRAP_ROTATE_ENV = "CINATRA_PROVIDER_BOOTSTRAP_ROTATE";

/** The environment variables this phase reads. The key is REQUIRED; both ids are optional. */
export const PROVIDER_BOOTSTRAP_KEY_ENV = "OPENAI_API_KEY";
export const PROVIDER_BOOTSTRAP_PROJECT_ENV = "OPENAI_API_PROJECT";
export const PROVIDER_BOOTSTRAP_ORG_ENV = "OPENAI_API_ORG";

/** The provider whose connection `OPENAI_API_KEY` configures. */
const BOOTSTRAP_PROVIDER = "openai";

const LOG = "[provider-connection-bootstrap]";

/**
 * ONE re-seal per process. The rotate flag is a deployment-level instruction,
 * not a standing mode: a `retryable` phase that ran again in the same process
 * (or a future caller re-running the sequence) must not keep overwriting the
 * row, and must not re-narrate a rotation that already happened.
 */
let rotatedInThisProcess = false;

/** A present, non-blank environment value, or undefined. */
function envValue(name: string): string | undefined {
  const trimmed = process.env[name]?.trim();
  return trimmed ? trimmed : undefined;
}

/** The error's CLASS, for logs — never its message (a writer's message could quote input). */
function errorClass(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/**
 * Does the STORED row hold a key — read from the RAW row, never the decrypted one.
 *
 * The unseal reader drops a sealed blob it cannot decrypt (a rotated encryption
 * key, tamper) fail-closed, so a decrypted read reports NO KEY for a row that
 * plainly has one. Deciding the sealed-row-wins rule on that read would let this
 * phase overwrite an operator's credential without the rotate flag. Presence is
 * therefore syntactic: a sealed field, or a legacy plaintext one.
 */
async function sealedRowHoldsAKey(): Promise<boolean> {
  const { readRawOpenAIConnectionRow } = await import("@/lib/database-metadata");
  const { isSealed, OPENAI_CONNECTION_SECRET_FIELD } = await import(
    "@/lib/connector-config-secret-fields"
  );
  const raw = readRawOpenAIConnectionRow() as Record<string, unknown> | null;
  const field = raw?.[OPENAI_CONNECTION_SECRET_FIELD];
  if (isSealed(field)) return true;
  return typeof field === "string" && field.trim().length > 0;
}

/**
 * The digest of the credential the row NOW holds. Always sampled AFTER a seal,
 * so the commitment stores the value that is actually stored and the step reads
 * FRESH on the very first render. Never the value itself.
 */
async function liveCredentialFingerprint(): Promise<string | null> {
  const { readLiveCredentialFingerprint } = await import(
    "@/lib/llm-credential-fingerprint"
  );
  const live = await readLiveCredentialFingerprint(BOOTSTRAP_PROVIDER);
  return live.status === "readable" ? live.fingerprint : null;
}

/**
 * Complete the model setup step the way a wizard run leaves it: a COMMITMENT
 * recorded by the claim/commit machine, carrying the digest of the credential
 * that was just sealed.
 *
 * Never fatal. A record that already exists (a real wizard run, or a claim in
 * flight) is left to its owner — the machine refuses a claim over either by
 * design, and a bootstrap has no business fencing an operator out of their own
 * setup.
 */
async function completeModelSetupStep(options: {
  /**
   * A re-seal happened, so an EXISTING commitment now stores the fingerprint of
   * a credential that is gone. Refresh it, or the step this rotation was meant
   * to keep working reads incomplete on the next render.
   */
  refreshExistingCommitment: boolean;
}): Promise<void> {
  const {
    beginSetupProviderClaim,
    commitSetupProviderClaim,
    readSetupProviderCommitSnapshot,
    refreshCommittedCredentialFingerprint,
    releaseSetupProviderClaim,
  } = await import("@/lib/setup-provider-commit");

  const snapshot = readSetupProviderCommitSnapshot();
  const state = snapshot.state;
  if (state.kind !== "absent") {
    if (
      options.refreshExistingCommitment &&
      state.kind === "committed" &&
      state.commitment.provider === BOOTSTRAP_PROVIDER &&
      snapshot.raw !== null
    ) {
      const refreshed = refreshCommittedCredentialFingerprint({
        expectedRaw: snapshot.raw,
        commitment: state.commitment,
        credentialFingerprint: await liveCredentialFingerprint(),
      });
      console.log(
        `${LOG} the existing provider commitment's credential fingerprint was ` +
          `${refreshed ? "REFRESHED" : "left alone (a concurrent transition won)"} ` +
          `after the re-seal, so the model step stays complete.`,
      );
      return;
    }
    console.log(
      `${LOG} a setup provider record already exists (${state.kind}) — the model ` +
        `step's state stays its owner's.`,
    );
    return;
  }

  const credentialFingerprint = await liveCredentialFingerprint();

  const begun = beginSetupProviderClaim({
    provider: BOOTSTRAP_PROVIDER,
    // No human took this action, so no human is named on the record.
    actorId: null,
    startingCredentialFingerprint: credentialFingerprint,
  });
  if (!begun.ok) {
    console.warn(
      `${LOG} the setup provider record moved while bootstrapping (${begun.refusal}) — ` +
        `the model step is left to whoever holds it.`,
    );
    return;
  }

  const { updateDefaultLlmProviderAtBoot } = await import(
    "@/lib/admin/default-llm-provider-mutation"
  );
  const committed = await commitSetupProviderClaim({
    nonce: begun.claim.nonce,
    credentialFingerprint,
    // Honest in the record: this commitment was earned by a boot-time bootstrap,
    // not by an operator working through the wizard.
    provenance: "environment-bootstrap",
    writeAuditedDefault: (provider) => updateDefaultLlmProviderAtBoot({ provider }),
  });
  if (!committed.ok) {
    // Give the fence back on every refusal that could still be holding it; the
    // release is a conditional delete over this run's OWN bytes, so a refusal
    // that already moved or tombstoned the record makes it a no-op.
    try {
      releaseSetupProviderClaim({ nonce: begun.claim.nonce });
    } catch (err) {
      console.error(`${LOG} could not release the setup claim (${errorClass(err)})`);
    }
    console.warn(
      `${LOG} completing the model setup step failed (${committed.refusal}) — the ` +
        `connection is sealed and the wizard still owns the step; retried next boot.`,
    );
    return;
  }

  console.log(
    `${LOG} the model setup step is COMPLETE: the provider commitment was recorded ` +
      `from the environment bootstrap, so no operator has to re-enter the key.`,
  );
}

export function providerConnectionBootstrapPhases(): BootPhase[] {
  return [
    {
      name: "provider-connection-bootstrap",
      policy: "retryable",
      run: async () => {
        const apiKey = envValue(PROVIDER_BOOTSTRAP_KEY_ENV);
        if (!apiKey) {
          return {
            skipped: `${PROVIDER_BOOTSTRAP_KEY_ENV} is not set in the environment`,
          };
        }

        const { readOpenAIConnection, updateOpenAIConnection } = await import(
          "@/lib/openai-connection-store"
        );
        const rowHasKey = await sealedRowHoldsAKey();
        const rotate = process.env[PROVIDER_BOOTSTRAP_ROTATE_ENV] === "true";

        if (rowHasKey) {
          if (!rotate) {
            // An interrupted bootstrap left a sealed row and no commitment. When
            // the row holds THIS environment's value the unfinished half is
            // ours to finish; any other value belongs to an operator, and so
            // does their setup state. The comparison is in memory only.
            if (readOpenAIConnection()?.apiKey === apiKey) {
              const { readSetupProviderCommitState } = await import(
                "@/lib/setup-provider-commit"
              );
              if (readSetupProviderCommitState().kind === "absent") {
                console.log(
                  `${LOG} the connection was already sealed from this environment but ` +
                    `the model setup step was never completed — finishing that now.`,
                );
                await completeModelSetupStep({ refreshExistingCommitment: false });
                return;
              }
            }
            return {
              skipped:
                "a sealed provider connection already exists — the sealed row wins " +
                `over the environment (set ${PROVIDER_BOOTSTRAP_ROTATE_ENV}=true to re-seal)`,
            };
          }
          if (rotatedInThisProcess) {
            return {
              skipped: `${PROVIDER_BOOTSTRAP_ROTATE_ENV} already re-sealed the connection this boot`,
            };
          }
          console.warn(
            `${LOG} ${PROVIDER_BOOTSTRAP_ROTATE_ENV}=true — RE-SEALING the stored ` +
              `provider connection from the environment, once. The key that stood in ` +
              `the row is replaced; unset the flag to make the sealed row ` +
              `authoritative again.`,
          );
        }

        try {
          await updateOpenAIConnection(
            {
              apiKey,
              // Both ids are OPTIONAL: an instance configured with a plain key
              // bootstraps exactly as well as one scoped to a project.
              projectId: envValue(PROVIDER_BOOTSTRAP_PROJECT_ENV),
              organizationId: envValue(PROVIDER_BOOTSTRAP_ORG_ENV),
            },
            // No request exists at boot, so there is no rendered route cache to
            // drop — and `revalidatePath` throws rather than no-opping without
            // one, which would report this LANDED seal as a failed phase.
            { revalidateRoutes: false },
          );
        } catch (err) {
          // The writer's own messages carry the row key only, but this phase is
          // the one holding a plaintext credential — it re-throws by CLASS so no
          // future writer's message can ever reach the boot log through here.
          throw new Error(
            `${LOG} sealing the provider connection from the environment failed ` +
              `(${errorClass(err)}). The phase is retryable and runs again next boot.`,
          );
        }

        if (rowHasKey) rotatedInThisProcess = true;
        console.log(
          `${LOG} sealed the provider connection from the environment ` +
            `(${PROVIDER_BOOTSTRAP_KEY_ENV}); the sealed row is the source of truth ` +
            `from here on.`,
        );

        // A first seal writes the commitment; a re-seal refreshes the fingerprint
        // on the commitment that already stands, so a rotation never reopens a
        // step the instance had already completed.
        await completeModelSetupStep({ refreshExistingCommitment: rowHasKey });
      },
    },
  ];
}
