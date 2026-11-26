/**
 * The send of an approved body, apart from the use-cases adapter (cinatra#3089):
 * the shipped provider sender, the fixed failure codes of the answer, and the
 * manual-check text of a message in doubt. Moved verbatim out of
 * `trigger-email-send-use-cases.ts`.
 */
import type { ReleasedListRefusal } from "@cinatra-ai/agents/publish-decision-store";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import type { RevisionEffectClaimKey } from "./artifacts/materialization-ledger";
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
    } catch {
      // The routing's or the mailbox status's own text (it can name the mailbox) is kept nowhere: a fixed code.
      const { EffectNotStartedError } = await import("./artifacts/materialization-ledger");
      throw new EffectNotStartedError(SEND_FAILURE_CODE.not_started);
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
  "provider may have accepted it. Check the sent mail of the connected mailbox for each message named (by its draft in " +
  "the bundle of this campaign) to learn whether it went out. Nothing in the app clears an in-doubt mark. This is a " +
  "manual check, and a message that did not go out must be sent by hand";

/**
 * THE FIXED CODE OF A BODY READ THAT REFUSED (cinatra#3089). The decided-revision readers return a refusal as text,
 * and a read that failed in the store embeds the store's own error in it (a connection, a query or a stored value):
 * that text never reaches the answer or the log. The send passes on only the code read here from the readers' own
 * fixed phrases; any other text, a failed read included, answers `body_read_failed`.
 */
export function bodyRefusalCode(text: string): (typeof BODY_REFUSAL_CODES)[number] {
  // A failed read ("... could not be read: <store text>") is matched first, so no store text can pick another code.
  if (/ could not be read/.test(text)) return "body_read_failed";
  const known: Array<[RegExp, (typeof BODY_REFUSAL_CODES)[number]]> = [
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

/** The codes `bodyRefusalCode` answers, and `body_changed` (another text at the send time) (cinatra#3089). */
export const BODY_REFUSAL_CODES = [
  "body_read_failed",
  "body_superseded",
  "body_decided_against",
  "body_decision_open",
  "body_repaired",
  "body_not_approved",
  "body_not_filed_in_run",
  "body_not_visible",
  "body_wrong_type",
  "body_changed",
] as const;

/**
 * THE ANSWERS OF THE RELEASED-LIST ROAD (cinatra#3089): every text that road can put in a send's answer, by its code.
 * A `#` stands for a number (a position in the bundle or the list, or a count): the only value a text carries. No id,
 * address, contact, campaign, reader text or error message is ever filled in.
 */
export const RELEASED_ROAD_TEXT = {
  // Refused before any mail (`releasedRoadRefusal`).
  calling_run_unreadable: "the run of this call could not be read",
  claim_without_step: "the call claimed a publish decision, but no verified step made it",
  decision_unreadable: "the publish decision of the calling step could not be read",
  decision_missing: "the call claimed a publish decision, but the calling step governs none",
  decision_signed_other: "the call was signed for another publish decision than the one that governs the calling step",
  decision_claim_other_run: "the call claimed a publish decision of another run",
  decision_claim_conflict: "the call was signed for another publish decision than the one it claimed",
  decision_claim_unreadable: "the publish decision this call claimed could not be read",
  decision_claim_not_current: "the publish decision this call claimed is not a decision of the current attempt of the run",
  decision_claim_superseded: "the publish decision this call claimed was superseded by a newer decision of the step",
  released_list_refused: "the released list of the publish decision was refused",
  campaign_missing: "the released publish decision carries no campaign",
  campaign_spaced: "the released publish decision carries its campaign with white space around it",
  campaign_other: "the call names another campaign than the released publish decision carries",
  sender_refused: "the sender of the released publish card could not be read",
  sender_spaced: "the sender the released publish card showed carries white space around it",
  sender_other: "the call names another sender than the released publish card showed",
  sender_not_shown: "the call names a sender the released publish card did not show",
  entry_no_revision: "approved body # names no artifact revision",
  entry_spaced: "approved body # carries an id, a contact or an address with white space around it",
  entry_artifact_twice: "approved body # names an artifact a second time",
  entry_no_contact: "approved body # names no contact",
  entry_contact_twice: "approved bodies # and # are for one contact",
  entry_no_address: "approved body # names no recipient address",
  entry_no_draft: "approved body # is for a contact that no draft of the bundle names",
  entry_many_drafts: "approved body # is for a contact that # drafts of the bundle name",
  draft_no_body: "draft # of the bundle has an address but no approved body",
  draft_no_address: "approved body # is for draft # of the bundle, which has no address",
  address_changed: "draft # of the bundle: the recipient's address changed after the card was shown",
  body_refused: "approved body # was refused",
  body_other_contact: "approved body # is the body of another contact than its draft's",
  body_other_campaign: "approved body # is not filed for the released campaign",
  body_not_draft: "approved body # is not the body of draft # of the bundle",
  subject_changed: "draft # of the bundle: the subject changed after the card was shown",
  bind_failed: "the messages could not be bound to their approved bodies",
  body_type_unregistered: "the email body type is not registered, so no message was bound to its approved body",
  draft_not_bound: "draft # of the bundle was not bound to its approved body",
  // A message with a send record (sent or in doubt) is terminal: it is neither bound nor mailed again.
  revision_not_mailed: "draft # already has a send record (sent or in doubt), so its newly approved revision was not mailed",
  // Thrown by the fan-out's binding (`materializeEmailFanout`, `loadDefaultEmitEmailFanout`).
  fanout_no_binder: "the email body of draft # cannot be bound: the fan-out has no binder for approved bodies",
  fanout_bind_failed: "the email body of draft # could not be bound",
  fanout_bind_refused: "the email body of draft # was refused",
  types_unreadable: "the registered object types could not be read, so no message can be bound to its approved body",
  // The mail of each message.
  not_bound_stop: "draft # of the bundle has no bound approved body, so it was not sent",
  refused_at_claim: "draft # was not sent, its body was refused when its mail was claimed",
  refused_at_send: "draft # was not sent, its body was refused at its send time",
  contact_other_body: "draft # was not sent, its contact was already claimed for another body of this run",
  mark: "draft # was mailed, but its sent record could not be written",
  claim: "the mail of draft # could not be claimed, so it was not sent",
  not_started: "draft # was not sent, no mail provider was reached",
  release: "draft # was not sent, and its claim could not be given back",
  act: "the mail provider failed on draft #, which may or may not have gone out",
  in_doubt_count: "# message(s) are in doubt",
  in_doubt: "draft # is in doubt",
  // Any text that is none of these.
  send_failed: "the send failed for a reason that is not shown",
} as const;
export type ReleasedRoadText = keyof typeof RELEASED_ROAD_TEXT;

const RELEASED_LIST_CODES = [
  "released_list_fields_invalid",
  "decision_not_released",
  "released_list_malformed",
  "released_list_ambiguous",
  "released_list_not_shown",
  "released_list_bodies_not_drawn",
] as const satisfies readonly ReleasedListRefusal[];

/** THE CLOSED SET OF CODES a released-list answer may carry in parentheses (cinatra#3089). */
export const RELEASED_ROAD_CODES: ReadonlySet<string> = new Set<string>([
  ...Object.keys(RELEASED_ROAD_TEXT),
  ...RELEASED_LIST_CODES,
  ...BODY_REFUSAL_CODES,
  ...Object.values(SEND_FAILURE_CODE),
  "already_bound",
  "bind_refused",
]);
export type ReleasedRoadCode = ReleasedRoadText | ReleasedListRefusal | (typeof BODY_REFUSAL_CODES)[number]
  | (typeof SEND_FAILURE_CODE)[keyof typeof SEND_FAILURE_CODE] | "already_bound" | "bind_refused";

const REFUSED_BEFORE_ANY_MAIL = "The send was refused before any email went out: ";

/** One text of the released-list road: its fixed words, each `#` filled by the next number, and its code. */
export function releasedRoadText(key: ReleasedRoadText, numbers: readonly number[] = [], code: ReleasedRoadCode = key): string {
  let i = 0;
  const filled = RELEASED_ROAD_TEXT[key].replace(/#/g, () => String(Math.trunc(Math.abs(numbers[i++] ?? 0))));
  return `${filled} (${code})`;
}

/** A refusal of the released-list road before any mail (thrown; the send answers it through `releasedRoadAnswer`). */
export function releasedRoadRefusal(key: ReleasedRoadText, numbers: readonly number[] = [], code: ReleasedRoadCode = key): Error {
  return new Error(`${REFUSED_BEFORE_ANY_MAIL}${releasedRoadText(key, numbers, code)}`);
}

/** The early answers every send shares (kept as they are, so the old road answers them unchanged). */
const SHARED_EARLY_ANSWERS = [
  "approvedDraftBundleRef and confirmedRecipientsRef are required",
  "Could not fetch approvedDraftBundle or confirmedRecipients.",
  "Approved draft bundle has no drafts.",
];
const ANSWER_FORMS: ReadonlySet<string> = new Set<string>([
  ...Object.values(RELEASED_ROAD_TEXT),
  ...SHARED_EARLY_ANSWERS,
  IN_DOUBT_MANUAL_CHECK,
]);

/**
 * THE ONE GUARD OF A RELEASED-LIST ANSWER (cinatra#3089): the send builds the `errorMessage` of every call that entered
 * the released-list road through this function, whatever produced the text. Each part (the parts are joined by "; ")
 * passes only when it is one of RELEASED_ROAD_TEXT, the shared early answers, IN_DOUBT_MANUAL_CHECK or one of the
 * caller's own fixed `ownForms` (texts with no number, for a constant this module does not hold), with numbers
 * only where the text has a `#`, optionally after the refused-before-any-mail prefix and followed only by codes of
 * RELEASED_ROAD_CODES in parentheses. Any other part (an error's message, a reader's or a store's text, an id, an
 * address) is replaced by the fixed `send_failed` text, so no raw text can reach the answer or the persisted status.
 */
export function releasedRoadAnswer(text: string, ownForms: readonly string[] = []): string {
  const passes = (part: string): boolean => {
    let rest = part.startsWith(REFUSED_BEFORE_ANY_MAIL) ? part.slice(REFUSED_BEFORE_ANY_MAIL.length) : part;
    for (let m = / \(([a-z_]+)\)$/.exec(rest); m; m = / \(([a-z_]+)\)$/.exec(rest)) {
      if (!RELEASED_ROAD_CODES.has(m[1]!)) return false;
      rest = rest.slice(0, m.index);
    }
    const form = rest.replace(/\d+/g, "#");
    return ANSWER_FORMS.has(form) || (form === rest && ownForms.includes(form));
  };
  const parts = text.split("; ").map((part) => (passes(part) ? part : releasedRoadText("send_failed")));
  return [...new Set(parts)].join("; ");
}

/**
 * THE SEND RECORDS OF THE RELEASED-LIST ROAD, READ BEFORE ANY BINDING (cinatra#3089). `read` answers the send record of
 * one message under the key its claim takes (`messageSendKey`), whatever revision it was claimed with; `takeContactSeat`
 * gives the contact of a message to the message's body artifact for the whole run (the first artifact that takes it
 * holds it) and answers the artifact that holds it. Both are optional on an injected ledger: one without them reads no
 * record and holds no seat.
 */
export type MessageSendRecords = {
  read(key: RevisionEffectClaimKey, actor: PrimitiveActorContext): Promise<MessageSendRecord | null>;
  takeContactSeat(
    seat: { runId: string; contactId: string; artifactId: string; representationRevisionId: string },
    actor: PrimitiveActorContext,
  ): Promise<string>;
};
/** A message's send record: marked sent (`done`) or claimed and never marked (`in_doubt`), and the revision claimed. */
export type MessageSendRecord = { state: "done" | "in_doubt"; representationRevisionId?: string | null };

/** The send-record key of one message: the key its claim takes (`performRevisionEffectOnce`). */
export function messageSendKey(
  runId: string,
  bindingOutputId: string,
  body: { artifactId: string; representationRevisionId: string },
): RevisionEffectClaimKey {
  return {
    runId,
    path: "email_fanout",
    bindingOutputId,
    effect: "message-send",
    artifactId: body.artifactId,
    representationRevisionId: body.representationRevisionId,
  };
}

function sendOrgOf(actor: PrimitiveActorContext): string {
  if (!actor.orgId) throw new Error("the acting actor carries no organization, so no send record can be read");
  return actor.orgId;
}

/** The materialization ledger's send records and contact seats (the default when no ledger is injected). */
export const defaultMessageSendRecords: MessageSendRecords = {
  async read(key, actor) {
    const { readRevisionEffect } = await import("./artifacts/materialization-ledger");
    return readRevisionEffect({
      orgId: sendOrgOf(actor),
      runId: key.runId,
      path: key.path,
      bindingOutputId: key.bindingOutputId,
      effect: key.effect,
    });
  },
  async takeContactSeat(seat, actor) {
    const { holdRunSeat } = await import("./artifacts/materialization-ledger");
    return holdRunSeat({
      orgId: sendOrgOf(actor),
      runId: seat.runId,
      path: "email_fanout",
      seatOutputId: `email-contact:${seat.runId}:${seat.contactId}`,
      seat: "contact-seat",
      artifactId: seat.artifactId,
      representationRevisionId: seat.representationRevisionId,
    });
  },
};

/**
 * The messages of `bodies` (by draft position) that have a send record (cinatra#3089): TERMINAL, so they are not bound
 * and not mailed. With no `read`, none. A read that fails refuses the send before any mail with a fixed code
 * (`bind_failed`): its text is never passed on.
 */
export async function readSendRecords(
  bodies: ReadonlyMap<number, { artifactId: string; representationRevisionId: string }>,
  keyOf: (body: { artifactId: string; representationRevisionId: string }) => RevisionEffectClaimKey,
  read: ((key: RevisionEffectClaimKey) => Promise<MessageSendRecord | null>) | undefined,
): Promise<Map<number, MessageSendRecord>> {
  const found = new Map<number, MessageSendRecord>();
  if (!read) return found;
  for (const [index, body] of bodies) {
    let record: MessageSendRecord | null;
    try {
      record = await read(keyOf(body));
    } catch {
      throw releasedRoadRefusal("bind_failed");
    }
    if (record) found.set(index, record);
  }
  return found;
}
