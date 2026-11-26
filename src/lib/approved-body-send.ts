/**
 * The send of an approved body, apart from the use-cases adapter (cinatra#3089):
 * the shipped provider sender, the fixed failure codes of the answer, and the
 * manual-check text of a message in doubt. Moved verbatim out of
 * `trigger-email-send-use-cases.ts`.
 */
import type { TriggerEmailSendDeps } from "./trigger-email-send-use-cases";

/**
 * The shipped mail sender, in two parts split at the hand-over to the provider's
 * transport (cinatra#3089).
 *
 * BEFORE the hand-over, every step that can refuse runs here, and any failure
 * throws `EffectNotStartedError` (nothing reached a provider, so a retry may
 * mail the message): the provider-neutral facade must be installed (it resolves
 * through the `email-system` capability the email connector registers); the
 * host routing resolves the connector (the sender identity's, else the first
 * installed one, as the facade does) and that connector must be installed and
 * report its mailbox connected; the development redirect is checked once, so a
 * redirect switched on with no address refuses here.
 *
 * THE HAND-OVER is the facade's send, pinned to the connector resolved above.
 * Any failure from there on may follow the provider's acceptance (a timeout, a
 * reset connection, an error answer: the connectors throw a plain error for
 * every provider answer, a rejected recipient included, so nothing shows the
 * provider took nothing), and it is thrown as it is: the caller keeps the
 * message in doubt. The facade repeats its routing and the redirect inside
 * that call; a failure there is read as in doubt too, which never mails twice.
 */
export function createDefaultSendEmail(): TriggerEmailSendDeps["sendEmail"] {
  return async (message, options) => {
    let send: TriggerEmailSendDeps["sendEmail"];
    let connectorId: string;
    try {
      const [{ requireEmailSystemFacade }, { resolveEmailSendProviders, resolveHostEmailRouting }] =
        await Promise.all([import("@/lib/email-transport-provider"), import("@/lib/email-send-providers")]);
      const facade = requireEmailSystemFacade();
      const routing = resolveHostEmailRouting();
      if (!routing) throw new Error("The host email routing is not registered.");
      const providers = resolveEmailSendProviders();
      const routed = await routing.resolveConnectorId({ userId: options?.userId, orgId: options?.orgId });
      const provider = routed ? providers.find((p) => p.definition.connectorId === routed) : providers[0];
      if (!provider) {
        throw new Error(
          routed ? `The email connector ${routed} is not installed.` : "No connected email connector is available.",
        );
      }
      const status = await provider.getStatus({ userId: options?.userId });
      if (status.status !== "connected") {
        throw new Error(
          `The mailbox of ${provider.definition.name} is not connected${status.detail ? `: ${status.detail}` : "."}`,
        );
      }
      routing.applyDevModeOverride(message);
      connectorId = provider.definition.connectorId;
      send = facade.sendEmail.bind(facade) as unknown as TriggerEmailSendDeps["sendEmail"];
    } catch (err) {
      const { EffectNotStartedError } = await import("./artifacts/materialization-ledger");
      throw new EffectNotStartedError(err instanceof Error ? err.message : String(err));
    }
    return send(message, { ...options, connectorId });
  };
}

/**
 * THE FIXED REASONS OF THE APPROVED SEND (cinatra#3089). No text from the mail connector, the provider or the send
 * record's store reaches the answer or the log: a provider's error can quote the recipient's address (a rejected
 * recipient) and a mailbox status can name the mailbox, so each failure stage answers one of these codes, and the
 * raw text is dropped (it is kept nowhere). The one reason passed on is a refusal under the revision's lock
 * (`refused`), whose text is the host's own decision-state reading of the body.
 */
export const SEND_FAILURE_CODE = {
  claim: "send_record_claim_failed",
  refused: "body_refused",
  not_started: "provider_not_reached",
  act: "provider_error",
  release: "send_record_release_failed",
  mark: "send_record_write_failed",
} as const;

/** What the answer of an approved send tells a person about a message in doubt (cinatra#3089). No tool or route clears
 *  an in-doubt mark: it is a manual check. */
export const IN_DOUBT_MANUAL_CHECK =
  "A message in doubt is never mailed again by this or any later send, also not under a new approval: the mail " +
  "provider may have accepted it. Check the sent mail of the connected mailbox for each message named (by its contact, " +
  "in this campaign) to learn whether it went out. Nothing in the app clears an in-doubt mark; this is a manual check, " +
  "and a message that did not go out must be sent by hand";
