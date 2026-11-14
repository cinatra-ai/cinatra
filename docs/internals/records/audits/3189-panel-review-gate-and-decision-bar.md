# Panels: the review gate card and the decision bar clauses (cinatra#3189)

This record is the per-clause checklist of two run-page panels of cinatra#3189: `review-gate-card` and
`review-decision-bar`. The issue grades them against the review and decision floor of the artifact review drawing,
sections III to X ("The in-run review gate" through "One window, five readings"). Each row quotes one clause of
those sections with its section and line, and reads its standing on main with file and line. This pull request
changes no product code. A departure goes to the owner named in the last table.

| Item | Value |
|---|---|
| Drawing read | design main `635da007`: `specs/app-artifact-review.html`, sections III (line 1279) to X (line 1751). Line numbers below are lines of that file |
| Pins | `tests/e2e/design/conformance-pins.json` pins no manifest for `app-artifact-review`, so no pin can drift for these panels. Each clause is graded against the current drawing content, as the issue asks |
| Code read | cinatra main `faee0830`: `packages/agents/src/review-gate-card.tsx` (card) and `packages/agents/src/review-decision-bar.tsx` (bar). Where a clause is drawn by a component these two files mount, the row names that file too |
| Open work on this floor | cinatra#4571 (Closes cinatra#3080) is open and unmerged. It changes the floor to Comment, Regenerate and Continue. This record reads main only; it does not grade #4571, and the rows D1 to D4 can change when #4571 merges |
| Method | A row quotes the clause verbatim (a long paragraph by its operative sentence), names "meets" or "departs" with the code that shows it, and is read from code, not from a capture. Pixel values (radius, colour tokens) are left to the independent UI grade |
| Not governed here | Section V's markdown display, saving indicator and download card (lines 1398-1401, 1540, 1545-1546, 1583) govern the type displays inside the island, not these two panels. Section IX's window panel is `hitl-conversation-panel.tsx` (its own status row, cinatra#3188); only the parts these two files draw are read |

## Fixed by this pull request

| id | Clause (drawing) | Standing on main | Fix and test |
|---|---|---|---|
| - | - | - | none: this pull request records the checklist only |

## Settled, no change

| id | Clause (drawing, line) | Reading on main |
|---|---|---|
| G1 | III, 1283: "The review is a gate inside the run, not a page of its own." "the gate itself — header, the one review target, decision bar and the run's prompt window — fills the run detail on the right." | meets for the gate's own content: one card draws header, target, bar and window in that order (card 1595-1682). The route and the rail beside it are the page's and the rail panel's composition, not these files |
| G2 | III, 1284: "The gate is type-agnostic: it keys on no concrete artifact type, binding, or renderer identity" | meets. `renderState` branches on the gate state only (card 1421-1694). The target is mounted through the display-only island, which resolves the type renderer server side (card 2210-2470) |
| G3 | III, 1285: "the gate opens with a gate header (what is under review, and — when the producing agent supplied one — a one-line summary of what it made and why), then the review target, then the decision bar and the conversational prompt window (§VI)." | meets for header, target, bar and window order (card 1595, 1616, 1649, 1682). The summary's place departs: see D5 |
| G4 | III, 1285: "A gate carries one target: one artifact, one pinned reference." | meets for every gate minted under one review per artifact: one `ReviewTargetFrame` (card 1616). A gate opened before that rule that still pins several draws one panel per target in pinned order, with one floor (card 1626, `PairedReviewTargets` 2940) |
| G5 | III, 1286: "a wide representation scrolls inside its own container rather than widening the page" | meets: the island scrolls inside its own frame, with no height control (card 2178-2185, `ReviewTargetIsland` 2210) |
| G6 | III, 1289: "Each target is pinned to one exact representation revision, frozen when the gate was raised." | meets: the header names the pinned revision (card 2745-2748) and the pending pin is held by the island's own address (card 2210) |
| G7 | IV, 1298: "the artifact's display title over a mono meta line carrying its type, the pinned representation revision (shown as a mono revision id with a pinned marker), and the read-only row facts the host authorized" | meets: title and type label (card 2733-2740), the mono line with `revision <id>` and ` · pinned` (card 2742-2748), the facts joined as given (card 2749) |
| G8 | IV, 1298: "The header is inert: it exposes no edit control and no revision picker" | meets: `ReviewTargetHeader` draws text only (card 2716-2753) |
| G9 | IV, 1299: "the review surface adds no per-type controls of its own around it." | meets: the frame adds no control around the island (card 2179-2181, 2831) |
| G10 | IV, 1331: "where a fact names a scope the line names it as the scope vocabulary labels every scope — its type, then its actual name" | not read here: the facts arrive composed (`header.facts`) and the card joins them as given (card 2749). The wording is the host resolver's, outside these files |
| G11 | V, 1354: "It is not put on screen: a display shows the work and nothing about itself — no renderer name, no package identity, no provenance line" | meets for these files: neither file draws a renderer name or a provenance line |
| G12 | V, 1355: "The floor is never a blank." | meets for the card's part: while the island loads it draws the skeleton (card 2617), and past its bound a retry panel (card 2647). It never draws an empty frame. The floor diagnostic itself is the island's |
| G13 | V, 1392: "It is distinct from the gate-level blocks in §VII, which stop the whole surface before any target renders." | meets: the island's timeout panel is not `ReviewGateBlocked`, because no gate reason is true (card 2193-2203) |
| G14 | VI, 1594: "Typing a change request into it is how a reviewer requests changes; there is no dedicated “request changes” button." | meets: the window is drawn beneath the bar (card 1682, `ReviewGatePromptWindow` 3039); the bar has no request-changes control (bar 204-240) |
| G15 | VI, 1594: "The review draws no card that names who requested changes" | meets: the settled header reads "Changes requested" and names nobody (`reviewGateHeaderTitle`, `src/lib/artifacts/review-surface-model.ts` 186-188) |
| G16 | VI, 1595: "The decision bar carries one free-text Note field — the same field whatever the decision" | meets: one `Textarea` for every disposition (bar 183-193) |
| G17 | VI, 1595: "where the producer holds the words that made the reviewed revision — a picture's prompt — the field opens carrying them" | meets: the field opens on `recordedPrompt` (bar 101) |
| G18 | VI, 1595: "a Continue or a Comment over an untouched pre-filled field records no note at all" | meets: an untouched or blank note is sent as `null` (bar 118) |
| G19 | VI, 1596: "a decided gate retains and displays the target it froze." | meets: the settled reading keeps the target frame, read-only, with no decision controls (card 1486-1567) |
| G20 | VI, 1597: "instead of committing, the surface shows a blocked state (§VII) naming the reason, with a refresh back to the live gate." | meets: a `blocked` outcome draws `ReviewGateBlocked` (bar 148-150); a settled gate this build cannot read draws the no-longer-pending block with Refresh (card 1571) |
| G21 | VI, 1597: "submitting the same decision twice is safe — it resolves the gate once, never twice." | meets on screen: an idempotent answer is shown as already recorded (bar 306, 333). The engine side is outside these files |
| G22 | VII, 1636: "A reviewer who may see the gate but not act on it gets the affordances disabled, with a one-line reason, rather than a live control that fails on click." | meets: the controls are disabled on `canDecide` / `canComment` (bar 210, 221, 233) and the one-line reason is drawn (bar 244-251). The reason's words name Approve and Reject: see D1 |
| G23 | VII, 1636: "A viewer with no access to the run at all never reaches the surface: it opens to the standard not-authorized panel" | not applicable to these files: the card draws no DOM for a reader who may not read the target (card 1402), and the not-authorized panel is the page's |
| G24 | VII, 1637: "While the host prepares the target the surface shows a loading skeleton in the target slot — never a flash of empty chrome." | meets: the loading state draws the header and `ReviewGateLoading` (card 1478-1483); the island draws its skeleton in the target slot (card 2617) |
| G25 | VII, 1637: "A blocked gate offers a refresh back to the live gate; it never lets a stale decision through." | meets: see G20 |
| G26 | VIII, 1686: "No affordance on this surface hard-deletes an artifact." | meets: neither file draws a delete control |
| G27 | IX, 1699: "the reader's own turns are right-aligned on the indigo ground in white; the assistant's are left-aligned on the muted surface in ink. A bubble takes at most four-fifths of the panel's width, keeps the line breaks it was written with, and carries no author label, no avatar and no timestamp" | meets in the settled exchange the card draws itself: `justify-end` with `bg-primary text-primary-foreground`, `justify-start` with `bg-surface-muted text-foreground`, `max-w-[80%]`, `whitespace-pre-wrap` on the person's turn, no label (card 3182-3201) |
| G28 | IX, 1700: "The panel scrolls at its own cap and holds itself at the bottom, so the newest turn is the one in view." | meets in the settled exchange: `max-h-52 overflow-y-auto` (card 3180), held at the end on mount and on a new turn (card 3166-3174) |
| G29 | IX, 1702: "it is kept per run: it is stored with the run, it is there after a reload" | meets: the window and the settled exchange read the run's own store by `runId` (card 3077-3083, 3151-3157) |
| G30 | IX, 1703: "a person without respond access never sees the box, rather than a field that would be refused." | meets: the window returns nothing without `canComment` (card 3090) |
| G31 | IX, 1746: "where a chat thread already carries the run, this window is a second view of it and hands off to that thread rather than opening a second conversation" | meets: inside a conversation the card draws no window and the thread's composer is the road (card 1332-1374) |
| G32 | X, 1755: "These are five readings of one window, never five windows." | meets for this mount: the card mounts the one window and names its reading `surface="review"` (card 3118). The sentence it reads is the window panel's |
| G33 | X, 1757: "an explicit request for changes is placed by the card's own comment machinery, word for word" "a question is answered and files nothing." | meets: a turn that acted re-reads the card; a turn that only answered moves nothing (card 3092-3100) |

## Findings left with a named owner

| id | Clause (drawing, line) | Standing on main | Owner |
|---|---|---|---|
| D1 | VI, 1593: "It offers exactly three affordances: Continue (primary), Regenerate, and Comment." The drawing draws Comment (ghost), Regenerate (outline, refresh glyph) and Continue (primary, trailing arrow) (1607-1611) | departs: the bar offers Comment, Reject (destructive, cross glyph) and Approve (primary, leading check) (bar 205-239). The disabled reason names "Approve / Reject" (`review-surface-model.ts` 409), and the bar's own landed notice reads "Approved." / "Rejected." (bar 303-305) | cinatra#3080 (open pull request #4571). Nothing new to file |
| D2 | VI, 1593: "There is nothing to press for “no”"; VIII, 1682: "There is no control for “no”." | departs: Reject is that control (bar 216-227) | cinatra#3080 (#4571) |
| D3 | VI, 1595 and the drawn field (1603-1604): the label "Note (optional on Continue · the words a Regenerate works from)" and the sentence "Add a note, or say what to change before Regenerate…" | departs: the label reads "Decision rationale (optional on approve, expected on reject)" and the placeholder "Add a note for the run and the audit trail…" (bar 180-189) | cinatra#3080 (#4571) |
| D4 | VI, 1627: "The Regenerate affordance is visually and structurally distinct from Continue"; VIII, 1683: "Regenerate appends a revision — it never overwrites or deletes the one under review." | departs: main has no Regenerate (bar 204-240), so neither clause can be met | cinatra#3080 (#4571) |
| D5 | III, 1285: the gate header, then "a one-line summary of what it made and why", then the review target. The drawn example puts the summary line between the gate header (1307) and the bordered target (1312), at 1310 | departs in place: the summary is drawn inside the island (`src/app/lifecycle/review-island/page.tsx` 365-374), which sits beneath the target header inside the one bordered target panel (card 1616, `ReviewTargetFrame` 2831) | to file in project 12 |
