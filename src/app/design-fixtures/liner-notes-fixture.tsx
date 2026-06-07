import { PrimitiveRow } from "./primitive-row";

/**
 * `.liner-notes` utility fixture row.
 *
 * Renders the spec §IX 5 liner-notes prose pattern: 2-column flow with a
 * burgundy italic-800 drop-cap and JetBrains Mono first-line small-caps.
 * The placeholder prose is long enough to exercise the column break + the
 * column rule. Use this as the visual reference when adopting `.liner-notes`
 * on a real call site (e.g. run summary, campaign retrospective).
 */
export function LinerNotesFixture() {
  return (
    <PrimitiveRow
      name="Liner notes"
      spec=".liner-notes"
      conformance="Spec §IX 5: 2-column flow, burgundy italic-800 drop-cap, JetBrains Mono first-line small-caps. Falls back to 1-column under 480px."
    >
      <div className="liner-notes max-w-[640px]">
        <p>
          On the morning of the run, the orchestrator picked up four high-confidence
          leads from the overnight enrichment pass and queued them against the
          campaign template that the operator approved earlier that week. The
          confidence scores were tight: 0.91, 0.88, 0.84, 0.82 — all above the
          0.80 floor the safety policy demanded for autonomous send.
        </p>
        <p>
          By 11:24 the first two drafts were in review, with the auditor agent
          flagging a small clarity concern on the second lead's opening line.
          The operator approved the auditor's suggested rewrite verbatim and
          released both drafts to the outbound queue. The third and fourth drafts
          followed by lunch, after a quick spell-check on the proper noun the
          enrichment had pulled from a slightly stale company page.
        </p>
        <p>
          Total elapsed: 2 hours 18 minutes, end to end. Two of the four leads
          replied within the next 48 hours; one of those converted into a
          discovery call. The orchestrator logged the conversion against the
          campaign cost ledger and the operator marked the run as a success.
        </p>
      </div>
    </PrimitiveRow>
  );
}
