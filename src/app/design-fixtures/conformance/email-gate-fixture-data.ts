// ---------------------------------------------------------------------------
// Fixed fixture data for the EMAIL GATE FIELD RENDERERS (cinatra#4319).
//
// cinatra-ai/design, specs/app-artifact-review.html, "The email gate fields":
// the sender field, the drafts review and the recipients review. On a real
// screen they need a connected send-as account or a CRM list, so the sample page
// hands each one the snapshot the run's gate would hand it. Every value below is
// invented: no credential, no mail account, no CRM connection.
//
// A reading names the props the gate passes and nothing else. What the field
// draws (labels, the waiting line, the count, the buttons) is the extension's.
// ---------------------------------------------------------------------------

import type { GmailSendAsAliasOption } from "@cinatra-ai/sdk-ui/field-renderer-props";

/** The field-renderer binding ids the app's build map keys these renderers by. */
export const EMAIL_GATE_BINDING_IDS = {
  sender: "@cinatra-ai/email-outreach-agent:gmail-sender",
  drafts: "@cinatra-ai/email-drafting-agent:email-drafts-review",
  recipients: "@cinatra-ai/email-recipient-selection-agent:campaign-recipients-review",
} as const;

export type EmailGateSurface =
  | "email-gate-sender-field"
  | "email-gate-drafts-review-field"
  | "email-gate-recipients-review-field";

/** Per surface: the binding, plus the drawing's `data-state` and `data-field`. */
export const EMAIL_GATE_SURFACES: ReadonlyArray<{
  surface: EmailGateSurface;
  binding: string;
  fieldName: string;
  label?: string;
  dataState: string;
  dataField: string;
}> = [
  {
    surface: "email-gate-sender-field",
    binding: EMAIL_GATE_BINDING_IDS.sender,
    fieldName: "sender",
    label: "Sender email",
    dataState: "empty error kind:artifact",
    dataField: "sender=context.gmailAliases",
  },
  {
    surface: "email-gate-drafts-review-field",
    binding: EMAIL_GATE_BINDING_IDS.drafts,
    fieldName: "drafts",
    dataState: "empty kind:artifact",
    dataField: "drafts=gate.draftBundle.draftedEmails",
  },
  {
    surface: "email-gate-recipients-review-field",
    binding: EMAIL_GATE_BINDING_IDS.recipients,
    fieldName: "recipients",
    dataState: "empty kind:artifact",
    dataField: "recipients=gate.confirmedRecipients",
  },
];

export const SENDER_ALIASES: GmailSendAsAliasOption[] = [
  { sendAsEmail: "anna.keller@acme.example", displayName: "Anna Keller", isPrimary: true },
  { sendAsEmail: "sales@acme.example" },
];

export type EmailGateReading = {
  surface: EmailGateSurface;
  /** Carried as `data-variant`. */
  variant: string;
  value: unknown;
  disabled?: boolean;
  required?: boolean;
  error?: string | null;
  description?: string;
  mode?: "edit" | "view";
};

const INITIAL_DRAFTS = [
  {
    id: "d1",
    recipientEmail: "anna.keller@acme.example",
    subject: "Re-connecting on Q3 priorities",
    body: "Hi there, following up on the pilot we scoped last quarter. Two of the three teams you named have since moved onto the new plan.\n\nAre you open to a short call next week?",
  },
  {
    id: "d2",
    recipientEmail: "jonas.weber@northwind.example",
    subject: "Rollout timeline",
    body: "Hi there, your team asked about the rollout timeline in the spring. The migration notes are ready, and I can walk you through them.",
  },
];

const RECIPIENTS = [
  { contactId: "c1", name: "Anna Keller", title: "Head of Operations", email: "anna.keller@acme.example", accountName: "Acme" },
  { contactId: "c2", name: "Jonas Weber", email: "jonas.weber@northwind.example", accountName: "Northwind" },
  { contactId: "c3", name: "Mara Lind", title: "VP Engineering", email: "mara.lind@globex.example", accountName: "Globex" },
];

export const EMAIL_GATE_READINGS: EmailGateReading[] = [
  { surface: "email-gate-sender-field", variant: "empty", value: "", required: true },
  {
    surface: "email-gate-sender-field",
    variant: "error",
    value: "",
    required: true,
    description: "The address the campaign's emails go out from.",
    error: "This field is required.",
  },
  { surface: "email-gate-sender-field", variant: "disabled", value: "anna.keller@acme.example", required: true, disabled: true },
  { surface: "email-gate-drafts-review-field", variant: "waiting", value: {} },
  { surface: "email-gate-drafts-review-field", variant: "initial", value: { draftBundle: { draftedEmails: INITIAL_DRAFTS } } },
  {
    surface: "email-gate-drafts-review-field",
    variant: "follow-up",
    value: {
      followupBundle: {
        draftedEmails: [
          { id: "f1", recipientEmail: "jonas.weber@northwind.example", followUpDay: 4, subject: "Following up", body: "Hi there, picking up where my last note left off: the notes are attached to this thread." },
          { id: "f2", recipientEmail: "jonas.weber@northwind.example", followUpDay: 11, subject: "Still on your list?", body: "Hi there, is the Q3 rollout still on your list? A short reply is enough." },
        ],
      },
    },
  },
  {
    surface: "email-gate-drafts-review-field",
    variant: "no-recipient",
    value: { draftBundle: { draftedEmails: [{ id: "n1", subject: "Re-connecting on Q3 priorities", body: INITIAL_DRAFTS[0].body }] } },
  },
  { surface: "email-gate-recipients-review-field", variant: "waiting", value: {} },
  {
    surface: "email-gate-recipients-review-field",
    variant: "editable",
    value: { confirmedRecipients: RECIPIENTS, sourceListName: "Q3 pilot accounts" },
  },
  {
    surface: "email-gate-recipients-review-field",
    variant: "read-only",
    value: { confirmedRecipients: RECIPIENTS, sourceListName: "Q3 pilot accounts" },
    mode: "view",
    disabled: true,
  },
];
