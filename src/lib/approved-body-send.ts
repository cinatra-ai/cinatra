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
 * raw text is dropped (it is kept nowhere). A refusal of the body (under the revision's lock, at the check or at the
 * send time) passes on only the code `bodyRefusalCode` reads from it.
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

/**
 * THE FIXED CODE OF A BODY READ THAT REFUSED (cinatra#3089). The decided-revision readers return a refusal as text,
 * and a read that failed in the store embeds the store's own error in it (a connection, a query or a stored value):
 * that text never reaches the answer or the log. The send passes on only the code read here from the readers' own
 * fixed phrases; any other text, a failed read included, answers `body_read_failed`.
 */
export function bodyRefusalCode(text: string): string {
  // A failed read ("... could not be read: <store text>") is matched first, so no store text can pick another code.
  if (/ could not be read/.test(text)) return "body_read_failed";
  const known: Array<[RegExp, string]> = [
    [/ is not its current revision\b/, "body_superseded"],
    [/ was decided against /, "body_decided_against"],
    [/ still waits on an open decision$/, "body_decision_open"],
    [/ has a repair filed against it$/, "body_repaired"],
    [/ was not approved by a person$| was approved, but not by a person of organisation /, "body_not_approved"],
    [/ was not filed in run /, "body_not_filed_in_run"],
    [/ is not an artifact this organisation can see$/, "body_not_visible"],
    [/ is of type "/, "body_wrong_type"],
  ];
  return known.find(([re]) => re.test(text))?.[1] ?? "body_read_failed";
}

/**
 * THE WORK CAP OF THE PROVENANCE CHECK of one reference-only send (cinatra#3089). Each run looked up costs a filings
 * query, and each artifact it filed a type read on the synchronous objects store. One send looks up at most `runs`
 * runs (the call's run and every recorded writer of the two bundles) and reads at most `filings` filed artifacts in
 * all: the call's run, asked first, with `perRun` (the reader's own cap) as its cap, and each writer run with an
 * equal share of the rest (never more than `perRun`); a run that filed more than its cap counts as filed. A send with more runs is refused
 * (`provenance_over_cap`), never read as "no bodies filed for review", which would mail the bundle. A real campaign
 * has the call's run and one or two writer runs, which keep the reader's full cap of 200 each.
 */
export const PROVENANCE_CHECK_CAP = { runs: 20, filings: 600, perRun: 200 } as const;
