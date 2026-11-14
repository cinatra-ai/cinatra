# Panel: the schedule prompt window clauses (cinatra#3189)

This record covers one run-page panel of the shared-primitives wave: `packages/agents/src/schedule-prompt-window.tsx`, the
prompt window under the scheduler on the run's Schedule step and on the run's schedule tab. Each row quotes one clause of
the drawing, with its section and line, and reads its standing on main. This pull request changes no product code: the
"Fixed" table is empty, and every departure is left with a named owner.

| Item | Value |
|---|---|
| Drawings read | design main `635da007`: `specs/app-artifact-review.html` (I, I.5, IX, X), `specs/app-lifecycle-cards.html` (X), `specs/app-components.html` (Standard scheduling step). Line numbers are lines of those files at `635da007` |
| Governing sections | The #3189 body names no section for this file by name. It names its neighbours' sections: "the review and decision floor is the same drawing's §III–X", "the conversation host has its parity section in `application-design-lifecycle-cards.html`" and "the two scheduling panels are graded against the components drawing's own 'Standard scheduling step' section". This record reads those sections, and the drawing's own example anchored `schedule-prompt-window` (`app-artifact-review.html` I.5, line 1214) |
| Pins | `tests/e2e/design/conformance-pins.json`: `app-components` manifest `d1d40b0c…`, equal to `conformance/app-components.json` at design main `635da007`. `app-artifact-review` and `app-lifecycle-cards` have no pin, so they are read at design main content, as the #3189 body asks. The panel's code comment cites design `458fb7ffce6c`, an older drawing |
| Code read | cinatra main `b4830483` (the panel file is the same blob, `ca0aa5fb`, at `faee0830`) |
| Method | A row quotes its clause in the drawing's rendered words, with section and line, and reads the standing on main as "meets" or "departs" at file:line. A clause drawn by the shared `HitlConversationPanel` (the live field, the exchange, the send control) is not graded here: the #3189 body lists that panel as covered by #3188 |

## Fixed by this pull request

| id | Clause (drawing) | Standing on main | Fix and test |
|---|---|---|---|

None. This pull request is the record only.

## Settled, no change

| id | Clause (drawing) | Reading |
|---|---|---|
| SW1 | "its one line, a status, reads “This schedule can no longer be changed — the form above shows it as it stands, and nothing typed here would change it. Start a new run to schedule it again.” — those words, and no send control." (`app-artifact-review.html` I.5, line 1143) | meets. The words are `SCHEDULE_WINDOW_OVER_NOTICE` (`schedule-prompt-window.tsx:68-71`), drawn in a `role="status"` paragraph (`:211-217`). The spent branch (`:198-223`) draws no send control |
| SW2 | "its field takes nothing typed: it is drawn disabled" (I.5, line 1143); the example marks the field `aria-disabled="true"` (line 1234) | meets. The field carries `aria-disabled="true"` and holds only the status line, no input (`schedule-prompt-window.tsx:206-218`) |
| SW3 | "The page’s window still stands beneath it, in the same place" (I.5, line 1143); "The window keeps its place under the form." (line 1242) | meets. The spent branch keeps the live window's outer wrapper, `px-5 pb-4 pt-6` and `mx-auto max-w-3xl` (`schedule-prompt-window.tsx:204-205`), the same classes as the live panel (`hitl-conversation-panel.tsx:324`, `:326`). Note: the spent wrapper is marked `data-run-window-placement="floating"` (`:204`), while the live reading for this surface is `"in-flow"` (`hitl-conversation-panel.tsx:75`). That is a code mark, not a drawn value |
| SW4 | "a person without respond access never sees the box, rather than a field that would be refused." (IX, line 1703) | meets for the live window: `visible={canRespondInWindow !== false && !!templateId && !!mount}` (`schedule-prompt-window.tsx:240`). For the spent window, see SW-D4 |
| SW5 | "it is kept per run: it is stored with the run, it is there after a reload" (IX, line 1702); "the exchange is one per run — a person who reaches the same run from two of these surfaces is in the same conversation, never in a second one about the same step." (X, line 1791) | meets. The exchange is the run's store, `useRunWindowConversation({ runId, surface: "armed-trigger" })` (`schedule-prompt-window.tsx:144`). Both hosts pass the run's id (`schedule-rail-step.tsx:350-357`, `run-schedule-tab.tsx:106-113`) |
| SW6 | "Fills the scheduler form's own rows — when the run starts, its time, its timezone — whether the schedule is being set for the first time or changed once it stands. The person presses the form's own button, unless the same message plainly asks for it to be submitted." (X, line 1775); "Filling is not submitting. … Asked in the same message to send it, Cinatra presses that same control — never a second path." (`app-lifecycle-cards.html` X, line 1865) | meets. A turn that pressed calls `onActed` and the card re-resolves; a fill hands its values to the card's own rows through `onFill` (`schedule-prompt-window.tsx:170-174`). The window keeps no draft of its own |
| SW7 | "When the run carries a natural-language prompt, the always-visible assistant panel pre-fills these controls (the loading state)" (`app-components.html`, Standard scheduling step, line 1469); "opening it shows this same form … and nothing else." (line 1547) | not applicable here. The first clause is the in-flow step's window, mounted by `trigger-screen-client.tsx:1060-1065` with surface `schedule`, not by this panel. The second speaks to the form: the window beneath it is the page's, not the form's (`app-artifact-review.html` I, line 496) |

## Findings left with a named owner

| id | Clause (drawing) | Standing on main | Owner |
|---|---|---|---|
| SW-D1 | "It is the run page’s own window, drawn by the page beneath the form and never by the form (§I.5)." (I, line 496); "The step’s screen draws its own form and its own buttons and stops there; it never draws a window inside itself" (I.5, line 1141); "drawn by the page beneath the step’s screen — never inside the card, and never inside the card’s host" (`app-lifecycle-cards.html` X, line 1877) | departs. This panel renders the window itself, into a div of its own (`schedule-prompt-window.tsx:225-246`). The Schedule step's own screen mounts it (`schedule-rail-step.tsx:350`), and so does the schedule tab (`run-schedule-tab.tsx:106`), not the page chrome | in flight: the open cinatra#4439 (Refs cinatra#3487) moves the live window and the spent notice into the page chrome. To file in project 12 only if that pull request closes without it |
| SW-D2 | The schedule screen, "the scheduler form, in both of its states", reads "Ask Cinatra to set the schedule above, or ask about it…" (X, lines 1773-1774). The run's Schedule step example draws the same sentence (I, lines 579 and 712) | departs. The panel names the surface `"armed-trigger"` (`schedule-prompt-window.tsx:144`, `:236`) on the Schedule step too, so the field there reads "Ask Cinatra to suggest edits to the fields above…" (`hitl-conversation-panel.tsx:42`) | to file in project 12 |
| SW-D3 | The armed-trigger tab, "the run's schedule as it stands", reads "Ask Cinatra to change this schedule, or ask about it…" (X, lines 1778-1779) | departs. The armed-trigger sentence is "Ask Cinatra to suggest edits to the fields above…" (`hitl-conversation-panel.tsx:42`), taken from a plan line, not from the drawing. It is the sentence of this window on the tab (`run-schedule-tab.tsx:106`) | to file in project 12 |
| SW-D4 | "The window is drawn only for a person who may answer the run." (IX, line 1703) | departs, on the clause's plain words. The spent branch (`schedule-prompt-window.tsx:198-223`) does not read `canRespondInWindow`, so a reader the live branch hides the window from (`:240`) still gets the disabled window and its status line | to file in project 12 |
| SW-D5 | The spent window's field: `border:1px solid var(--line-strong)` (I.5 example, line 1234) | departs. `border-line` (`schedule-prompt-window.tsx:209`), the 14% hairline (`src/app/globals.css:31`), not the ink line `--line-strong` (`:32`) | to file in project 12 (with SW-D6 to SW-D10, one issue) |
| SW-D6 | The same field: `border-radius:8px` (line 1234) | departs. `rounded-panel` (`schedule-prompt-window.tsx:209`) is `--r-panel`, 0.875rem, 14px (`src/app/globals.css:52`, `:658`) | as SW-D5 |
| SW-D7 | The same field: `background:var(--surface-muted)` (line 1234) | departs. `bg-surface` (`schedule-prompt-window.tsx:209`) is `--surface` `#f7f7f3`, not `--surface-muted` `#e8e8e3` (`src/app/globals.css:14`, `:16`) | as SW-D5 |
| SW-D8 | The same field: `padding:9px 11px` (line 1234) | departs. `px-3 py-2.5` (`schedule-prompt-window.tsx:209`) is 12px by 10px | as SW-D5 |
| SW-D9 | The same field draws no shadow (line 1234) | departs. `shadow-lg` (`schedule-prompt-window.tsx:209`) | as SW-D5 |
| SW-D10 | The status line: `font-size:12.5px;line-height:1.5;color:var(--muted)` (line 1235) | departs on size: `text-sm` (`schedule-prompt-window.tsx:214`) is 14px. The colour, `text-muted-foreground`, meets | as SW-D5 |

The open cinatra#4439 moves the spent notice into `run-page-chrome.tsx` with the same classes as main
(`rounded-panel border border-line bg-surface px-3 py-2.5 shadow-lg`, `text-sm`), and it keeps the surface `"armed-trigger"`.
So SW-D2 to SW-D10 stand on that pull request's head as well.
