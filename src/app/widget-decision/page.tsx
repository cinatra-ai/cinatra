import type { Metadata } from "next";

import { Main } from "@/components/layout/main";
import { BrandMark } from "@/components/brand-mark";
import { WidgetDecisionConfirm } from "@/components/widget-decision/widget-decision-confirm";
import {
  WidgetDecisionRationale,
  WidgetDecisionSubject,
} from "@/components/widget-decision/widget-decision-text";
import { getAuthSession } from "@/lib/auth-session";
import { reviewReferenceCode } from "@/lib/lifecycle/widget-action-capability";
import { readActionCapabilityRequest } from "@/lib/lifecycle/widget-action-capability-store";
import { WIDGET_DECISION_REQUEST_QUERY_PARAM } from "@/lib/widget-lifecycle-scope";

export const metadata: Metadata = { title: "Confirm decision" };
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// The HOSTED CONFIRMATION WINDOW (cinatra#2575, epic #2564 S8b).
//
// WHAT IT IS FOR, in one sentence: deciding a review from a website widget must
// be impossible for the website itself, so the decision passes through a small
// Cinatra window that the site cannot open on the person's behalf, cannot read,
// and cannot press the button inside.
//
// WHY THAT IS TRUE HERE and not merely asserted:
//   • it is a TOP-LEVEL Cinatra page under the person's own Cinatra cookie
//     session — the widget's `cwu_` bearer, which the CMS backend possesses by
//     design, is not what authorizes anything on this page;
//   • it is NOT in the public-path allowlist, so a visitor without a session is
//     sent to the ordinary sign-in and returned here — the same authentication
//     the app itself uses, with no widget-specific back door;
//   • what it shows comes ENTIRELY from a server-written row: the act, WHAT is
//     under review (named from the artifacts the requester had already cleared
//     read access to), a stable reference code for the gate, and the WHOLE
//     rationale. Nothing on this screen comes from the URL beyond the request
//     id, and the id names a row that grants nothing.
//
// WHAT IT SHOWS IS LOAD-BEARING, and the reason is the residual this design
// carries. The site holds the widget bearer, so it can ask for a capability on
// any gate the person may READ and then open this window itself — no design
// short of forbidding the site to open windows can prevent that. What the window
// can do is make the substitution VISIBLE, which is why it names the subject
// (codex round 0, finding 1), states the item count, prints a gate-derived
// reference code that a decoy with the same title cannot match (round 1,
// finding 2), shows the entire rationale rather than an opening (round 1,
// finding 1) with nothing that could push an ending out of view in EITHER axis
// — no inner scroll region (round 2) and no unwrapped run that the global
// `overflow-x: hidden` would clip sideways (the round-2 residual, fixed in
// `WidgetDecisionRationale`) — and tells the person to close it if they did not
// just start it.
//
// STATED HONESTLY: the reference code is only half a comparison until the same
// code appears beside the decision on the widget card, which is S8d's. Until
// then it distinguishes two confirmations from each other but has nothing on
// the card to be checked against. That is a gap in this slice, not a claim it
// makes.
//
// ONE REFUSAL FOR EVERYTHING A STRANGER COULD LEARN. Absent, expired, and
// somebody else's are the same card with the same words. Only once the signed-in
// person is confirmed to BE the person the request was minted for does the copy
// get more specific ("already used"), because at that point they are being told
// about their own request.
//
// THE PAGE MUTATES NOTHING. Rendering it is a GET and stays one: the single-use
// confirmation is a Server Action fired by a deliberate click. That is not only
// hygiene — a destructive render would let anyone who could cause a navigation
// spend somebody's confirmation, and a reload would eat it.
// ---------------------------------------------------------------------------

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/** The act, in the words a person uses about it. */
const ACT_HEADING: Record<string, string> = {
  approve: "Approve this review",
  reject: "Reject this review",
  comment: "Send this comment",
};

/** What pressing the button does, in the imperative. */
const ACT_BUTTON: Record<string, string> = {
  approve: "Confirm approval",
  reject: "Confirm rejection",
  comment: "Confirm comment",
};

/** The site the assistant runs on, in the person's words. */
const CLIENT_LABEL: Record<string, string> = {
  wordpress: "WordPress",
  drupal: "Drupal",
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <Main className="flex min-h-screen items-start justify-center pt-10">
      <div className="flex w-full max-w-md flex-col items-center">
        <div className="mb-8 flex items-center">
          <BrandMark size={30} />
        </div>
        {children}
      </div>
    </Main>
  );
}

function UnavailableCard() {
  return (
    <Shell>
      <div className="grid gap-3 text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          Nothing to confirm
        </h1>
        <p className="text-sm leading-6 text-muted-foreground">
          This confirmation is not available. Go back to the assistant and decide
          again.
        </p>
      </div>
    </Shell>
  );
}

export default async function WidgetDecisionPage({ searchParams }: Props) {
  const sp = await searchParams;
  const capabilityId = first(sp[WIDGET_DECISION_REQUEST_QUERY_PARAM]);
  if (!capabilityId) return <UnavailableCard />;

  // The middleware guard sends a session-less visitor to sign-in and back, so
  // this branch is defensive rather than routine — and it answers with the same
  // card as every other refusal, because a person with no session must not be
  // able to learn whether an id names a real pending decision.
  const session = await getAuthSession();
  const userId = session?.user?.id ? String(session.user.id) : "";
  if (!userId) return <UnavailableCard />;

  const row = await readActionCapabilityRequest(capabilityId);
  // ONE card for absent, expired and not-yours. The comparison is deliberately
  // before any detail is rendered: the request names an org's work, and a person
  // who is not its subject may not learn that it exists.
  if (!row || row.userId !== userId) return <UnavailableCard />;

  if (row.confirmed || row.consumed) {
    return (
      <Shell>
        <div className="grid gap-3 text-center">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            Already confirmed
          </h1>
          <p className="text-sm leading-6 text-muted-foreground">
            You confirmed this decision. Each confirmation is used once. Go back
            to the assistant to see the outcome.
          </p>
        </div>
      </Shell>
    );
  }

  const heading = ACT_HEADING[row.disposition] ?? "Confirm this decision";
  const buttonLabel = ACT_BUTTON[row.disposition] ?? "Confirm";
  const clientLabel = CLIENT_LABEL[row.client] ?? "connected";

  return (
    <Shell>
      <div className="grid w-full gap-5">
        <div className="grid gap-2 text-center">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            {heading}
          </h1>
          <p className="text-sm leading-6 text-muted-foreground">
            You asked the assistant on your {clientLabel} site to do this. Confirm
            it here, in Cinatra, because the site cannot make this decision for
            you.
          </p>
        </div>

        {/* WHAT is under review. Without this line the window says "Approve
            this review" about a review it cannot name, and whoever opened it
            could substitute a different one behind the same sentence. The value
            was derived server-side, at request time, from artifacts the
            requester had already cleared read access to. */}
        <div className="grid gap-1">
          <p className="text-xs font-medium text-foreground">What you are deciding</p>
          {/* The SUBJECT is assembled from artifact TITLES the requester chose,
              so it is adversarial text and must be shown WHOLE: it is this
              window's primary answer to substitution, and a clipped suffix
              defeats exactly the affordance it exists to provide. It wraps
              under the same contract as the rationale — see
              `widget-decision-text.tsx`. */}
          <WidgetDecisionSubject text={row.subjectLabel} />
          {/* The REFERENCE CODE. Titles are neither unique nor immutable, so a
              decoy can be made to read the same; a code derived from the gate
              itself cannot (codex round 1, finding 2). It is a comparison aid,
              not a secret — see `reviewReferenceCode`. */}
          <p className="text-xs leading-5 text-muted-foreground">
            Review reference{" "}
            <span className="font-mono text-foreground">
              {reviewReferenceCode(row.runId, row.reviewTaskId)}
            </span>
          </p>
        </div>

        {row.commentText ? (
          <div className="grid gap-1">
            <p className="text-xs font-medium text-foreground">Your message</p>
            {/* The WHOLE message, laid out IN FULL — no internal scroll region
                (codex round 2). A scrolled box left the exploit intact one level
                down: a benign opening plus enough filler pushes the
                consequential ending out of view while Confirm stays reachable,
                so the click still authorizes text nobody read. Without the box,
                the message occupies the page and the button sits AFTER it in
                document order, so reaching Confirm means scrolling past the
                whole thing. The 2,000-character cap on this path is what keeps
                that a page rather than a scroll of parchment.

                The HORIZONTAL half of the same property lives in
                `WidgetDecisionRationale`: an unbroken run has no soft-wrap
                opportunity, so without `wrap-anywhere` it would extend sideways
                and the global `html { overflow-x: hidden }` would clip its
                ending — round 2's exploit rotated ninety degrees. That module
                owns the layout contract and the assertion that pins it. */}
            <WidgetDecisionRationale text={row.commentText} />
          </div>
        ) : null}

        <WidgetDecisionConfirm capabilityId={row.capabilityId} confirmLabel={buttonLabel} />

        <p className="text-center text-xs leading-5 text-muted-foreground">
          This confirmation works once, and only for this review. If you did not
          just start this from the assistant on your site, close this window.
        </p>
      </div>
    </Shell>
  );
}
