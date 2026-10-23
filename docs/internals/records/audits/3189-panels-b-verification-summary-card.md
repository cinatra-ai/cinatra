# Panels B clause checklist — VerificationSummaryCard (cinatra-ai/cinatra#3189)

Recorded 2026-10-17 17:34Z, read-only.

| Item | Value |
|---|---|
| docs main sha (read) | `cc9f9ca971f3d854615b928f20c540f4da5a14df` (re-read 17:33Z, unchanged). Drawing `references/design/application-design-lifecycle-cards.html` (1401 lines) |
| pin and drift | `tests/e2e/design/conformance-pins.json` @ `7659bc29` has **no `app-lifecycle-cards` entry**. The committed manifest `manifests/app-lifecycle-cards.json` (contentHash `sha256:218bf86a…`, 69 surfaces) differs from docs main (`sha256:c6671465…`, 77 surfaces). **Drift: yes.** The 8 surfaces that exist only in docs are agent-hitl-screen-card, email-continued-reading-in-thread, email-continued-reading-outside-thread, hitl-screen-fields, post-continued-reading, regenerated-post-continued-reading, review-gate-card and schedule-cancel-confirm. This card's surfaces `verification-verified`, `verification-drift`, `verification-findings-not-met` and `verification-in-thread` are **identical** in both. The §VII prose was not compared against the pinned revision, because the manifest records no source docs sha |
| cinatra main sha (read) | `7659bc290ac71f9c3b4b0c152deeb803783353c4` (re-read 17:33Z) |
| Governing sections, and why | **Lifecycle cards §VII "The verification card"** `<h2>` L1109 (clauses L1109, L1110, examples L1111–1193, callout L1194), plus **§IX "Where each card appears"** L1274 (L1274, L1288, L1300, L1303). Artifact-review §III–X does not apply: that drawing has no verification or audit card (0 mentions in §III–X). Lifecycle L1194 says so itself: "The verification card has no drawing on any Application Design page … this page is where it is now fixed". The component's own header cites app-lifecycle-cards §VII/§IX. The run page reaches the card from a rail entry (artifact-review §I L330–332). That entry is drawn by `run-step-rail-extra-entry.tsx`, not by this card, so it is not counted here |
| Token resolution | Light `.cinatra` (`globals.css:186`): `--foreground` #15213a (L190), `--surface-strong` #ffffff (L192), `--surface-muted` #e8e8e3 (L193), `--muted-foreground: var(--muted)` #5a6477 (L199, L223), `--line` rgba(21,33,58,0.14) (L205), `--warning` #c79545 (L229, equal to `--brand-mustard` L237), `--mustard-ink` #7a5a1f (L246). Drawing (lifecycle `:root`): `--ink` #15213a, `--muted` #5a6477, `--mustard-ink` #7a5a1f |
| Code | `packages/agents/src/verification-summary-card.tsx` (410 lines): provenance note L67–68, HOST_FRAME L120–127, OUTCOME_COPY L142–171, absence returns L204–212, root `data-conformance-id="verification-card"` L215–221, heading row L223–236 (text "Audit" L231, `data-verification-chrome="Core analysis"` L229), scope sentence L239–241, revision pins L244–251, FieldDiffTable L286–342 (chip L325, struck Before L330), AdvisoryComments L364–409. Mounted on the run page by `src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/verification-view.tsx` (host `page_gate_region`, inside `data-conformance-id="run-surface" data-surface="verification"`) |

## Checklist (counted clauses)

| id | Clause (verbatim) and source @ docs `cc9f9ca9` | Assertion form | main standing @ `7659bc29` | Prior coverage | Pin-drift dep. |
|---|---|---|---|---|---|
| V1 | "the turn may carry a verification card: the Core analysis heading with its outcome pill" (L1109; every example draws "Core analysis", L1111–1193) | dom-aria. Inside `[data-conformance-id="verification-card"]`, the first row's heading text is exactly "Core analysis", followed by the outcome pill | **departs.** The heading text is "Audit" (`verification-summary-card.tsx:227–232`). Only the data attribute reads `data-verification-chrome="Core analysis"`. The code comment (L140) attributes the "audit" noun to plan §8 | `verification-summary-card.test.tsx:142` asserts the attribute only, never the text. No open PR covers it | no (surfaces identical) |
| V2 | "the scope sentence" (L1109) | dom-aria. A `p` directly after the heading row, before `[data-verification-revisions]` | **meets.** `:239–241`, one sentence per outcome from OUTCOME_COPY (`:142–171`). The wording differs from the drawn examples: EP1 | test `:507`, `:514` | no |
| V3 | "the two revision pins" (L1109) | dom-aria + computed-style. `[data-verification-revisions]` holds exactly two `span[title]` (reviewed, then repaired); its `font-family` is the mono stack | **meets.** `:244–251` (`font-mono`, reviewed → repaired) | test `:290` | no |
| V4 | "and the field-by-field before / after of exactly what was inspected" (L1109) | dom-aria. `[data-verification-field-diff]` table with Field / Before / After headers and one `[data-diff-field]` row per inspected field; an empty diff is drawn as a sentence, not an empty table | **meets.** `:286–342`; empty case `:306–309` | test `:352`, `:385` | no |
| V5 | "It carries no floor at all — it asks nothing, so it draws nothing to press." (L1109) | dom-aria. `[data-conformance-id="verification-card"]` contains 0 `button`, 0 `form` and 0 `input, textarea, select` | **meets.** The component renders no control | test `:493–502` | no |
| V6 | "It closes with Advisory comments: a label over one panel per comment, each carrying its author kind in mono above the comment itself." (L1109) | dom-aria + computed-style. The last region is the label "Advisory comments", then one panel per comment. In each panel the first child is the author kind with a monospace `font-family`, and the body comes after it | **meets.** `:364–409` (label `:371–373`; panel `rounded-panel border border-line bg-surface-muted` `:387`; author kind `font-mono` `:391`). Unavailable and empty lines are added (`:375–376`, `:411` test) | test `:395`, `:411`, `:421` | no |
| V7 | "The reading's provenance is the body of a service comment there, not a line of its own." (L1109) | dom-aria. No element outside the advisory panels carries the provenance; the `[provenance]` text appears only inside a comment body | **meets.** No provenance row exists (`:67–68`); a comment body is rendered as text (test `:443`) | test `:304`, `:443` | no |
| V8 | "Three outcomes. Verified, Out-of-scope drift … and Findings not met." (L1110) | dom-aria. The pill text is exactly "Verified" / "Out-of-scope drift" / "Findings not met" for `data-verification-outcome` verified / drifted / unmet | **meets.** OUTCOME_COPY labels (`:147`, `:157`, `:165`) | test `:271` | no |
| V9 | "Out-of-scope drift — a field changed that the review never covered, marked in place in the table" (L1110) | dom-aria. The drifted row (`data-diff-in-scope="false"`) carries the "out of scope" mark inside its Field cell; in-scope rows do not | **meets.** Chip `:325`, taken from `row.inScope` | test `:326–349`, `:352–366`, `:372` | no |
| V10 | "The outcome pill is the only place the card carries state colour." (L1110) | computed-style (light). Across the three outcomes, only the StatusPill's `background-color`/`color` change with the outcome; every other region keeps the same computed colours | **meets as the drawing reads it.** Only the pill varies by outcome. The heading tile (`bg-mustard-ink/15 text-mustard-ink`, `:224`) is constant. The row chip is mustard (`text-warning` #c79545 on `warning/15`, `:325`), and the drawing itself colours that chip mustard (EP2). See Note 2 and Doubt 2 | test `:271` (labels only; no colour assertion) | no |
| V11 | "Disclosed and out of scope are separate marks: a field may be disclosed to the analysis and still lie outside what the review covered, and the table says so on the row while the provenance says so in the list." (L1110) | dom-aria. A row carries only the in-scope/out-of-scope mark (no "disclosed" mark), and that mark equals the server's `inScope`. The disclosed list lives in the service comment body | **meets.** `:262–282` doc and `:319–325` | test `:326` | no |
| V12 | "The bordered panel is the card treatment for a conversation … on the run's own review page the same regions sit unframed in the page column" (L1194) | computed-style (light). With host `chat_thread` and `site_widget`: root `border-top-width: 1px`, `border-top-color: rgba(21, 33, 58, 0.14)`, `background-color: rgb(255, 255, 255)`. With host `page_gate_region`: root `border-top-width: 0px`, `background-color: rgba(0, 0, 0, 0)` | **meets.** HOST_FRAME `:120–127` | test `:227` | no |
| V13 | "Every card appears on every host, and it is the same card wherever it appears: the same regions, the same states, the same data on screen … Only the frame changes" (§IX L1274); "it never drops a region, a state or an affordance the card's own section draws, and never adds one" (L1303) | dom-aria. The inner markup of `[data-lifecycle-card="verification_summary"]` is identical across the four hosts; only the root class differs | **meets.** One body, HOST_FRAME only (`:214–255`) | test `:190`, `:227`, `:259` | no |
| V14 | "A card that asks nothing — the verification card of §VII — has nothing to disable: it is drawn whole, or it is absent." (L1300) | dom-aria. An `absent` resolve, no host, a missing body, an unknown verdict or a non-advisory state all give no `[data-lifecycle-card="verification_summary"]` node; otherwise the whole card is drawn | **meets.** `:204–212` | test `:154`, `:167`, `:175`, `:532–563` | no |

Counted: 14 clauses. By standing: meets 13 (V2–V14), departs 1 (V1), cannot-tell 0.

Form tally (main form per row): dom-aria 11 (V1, V2, V4–V9, V11, V13, V14), computed-style 3 (V3, V10, V12; V3 also reads the DOM, and V6 also reads a computed font-family), interaction 0, n/a-documented 0.

Not counted, with the reason:
- The rail entry that opens the card on the run page. Its label is "Audit" (`run-step-rail.ts:455–459`; `run-step-rail-extra-entry.tsx:654` links to `?view=verification`). That is rail anatomy (artifact-review §I) and belongs to `run-step-rail-panel` / `orchestrator-stepper-panel` (see that checklist, O-notes). No drawing names this entry.
- The §IX presence matrix row "Verification · Yes · Yes · …" (L1280). It is a table of presence per host, already graded through V13 and V14.
- The pinned visual pair adjunct in `verification-view.tsx`. It belongs to the view, not to this card.

## Drawn-example values: listed, not counted as clauses

| EP | Drawn value (lifecycle examples L1111–1193) | Code | Note |
|---|---|---|---|
| EP1 | Scope sentences, e.g. "Post-change verification of the repaired revision against the reviewed one. The before / after shows exactly the fields that were inspected — nothing more." | OUTCOME_COPY `:149–168` (longer, names "the review authorized", "This audit …") | Example copy, not a stated string |
| EP2 | Out-of-scope chip: mustard-ink text #7a5a1f on rgba(199,149,69,0.16), border rgba(199,149,69,0.42) | `border-warning/40 bg-warning/15 text-warning` (#c79545 text) `:325` | The tint and border match (warning = brand mustard #c79545). The text colour differs (#c79545 vs #7a5a1f). Not a clause |
| EP3 | Revision pins drawn as "rev-base → rev-repaired" text arrow | `ArrowRight` icon between two spans `:249` | Glyph choice only |
| EP4 | The heading plate is drawn as "the mustard plate" (L1194) | `size-[26px] rounded-lg bg-mustard-ink/15 text-mustard-ink` with `ScanSearch` `:224–226` | Plate exists; exact values not stated |
| EP5 | Author kind drawn as "Service"; provenance body "Core analysis of 3 disclosed field(s). … [provenance] lane=core-analysis-lane …" | Rendered from data | Fixture values |

## Notes

1. Rule 4 (drawing self-contradiction): §VII's text says the pill is the only state colour (L1110), yet the drawing colours the out-of-scope chip in mustard. The code follows the drawing. V10 is graded against the drawing's own reading.
2. The run-card host (`run_card`) is drawn unframed, the same as `page_gate_region` (HOST_FRAME `:120–127`). L1194 names only the conversation (bordered) and the run's review page (unframed). The run card host is not addressed by the text, so this is a note, not a clause.
3. Dark palette not graded (rule 3). No wrong import path appears in the drawing's markup for this card.
4. The code's own header calls the heading "Core analysis chrome" and keeps the user noun "audit" from plan §8. The drawing is the conformance source for this checklist, so V1 stands as a departure.

## Remains

- V1: the heading text "Audit" against the drawn "Core analysis". The fix (or a drawing change) is a decision between plan §8's noun and the drawing; see Doubt 1. No open PR touches `verification-summary-card.tsx` (open-PR read at 17:28Z, 47 PRs).
- No computed-style assertion exists yet for V10 or V12. The unit test reads classes, not resolved colours.

## Doubts

1. Whether plan §8's user-facing noun "audit" was meant to override the drawing's "Core analysis" heading. The drawing has no "Audit" text anywhere in §VII. I graded against the drawing.
2. V10 depends on reading the chip as part of the drawing's "marks", not as state colour. If a later reading reads L1110 literally, the chip becomes a departure, and so does the drawing.
3. The §VII prose has not been compared against the pinned revision, because the committed lifecycle manifest records no source docs sha. The four verification surfaces are identical, so I recorded no drift dependency.
