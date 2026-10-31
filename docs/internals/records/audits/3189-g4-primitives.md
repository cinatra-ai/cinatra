# G4 primitives: the status pill, toast, tabs and tooltip clauses (cinatra#3189)

This record covers the G4 group of the shared-primitives wave: skeleton, sonner, spinner, status-pill, table, tabs,
textarea, toolbar and tooltip. Each clause was graded against the approved drawings. Every clause that departs, or that
the drawings settle, is either fixed by the pull request that adds this record or has a named owner below.

| Item | Value |
|---|---|
| Drawings read | design main `5a23f118`: `specs/app-components.html` (Badge / Pill, Tabs, Toolbar, Tooltip / Popover, Toast / Sonner, Table) and `specs/app.html` (V, the status-pills roster) |
| Pins | `tests/e2e/design/conformance-pins.json`: `app` manifest `32e9d03e…`, `app-components` manifest `9de4ae11…`. Both are equal to design main, so there is no drift |
| Code read | cinatra main `a9ca3056` |
| Method | One row per clause: the clause, word for word, with its drawing section; how it is asserted; the standing on main with file and line; the test that now covers it |

## Fixed by this pull request

| id | Clause (drawing) | Standing on main | Fix and test |
|---|---|---|---|
| SP4 | "Anything that stands for a run, approval or lifecycle state takes the status pill and its fixed roster (V)" (components, Badge / Pill). The roster draws Scheduled as `pill approved` on a 6% ground and Queued as `pill running` on an 8% ground | departs: Scheduled was indigo (`border-primary/30 bg-primary/8 text-primary`) and Queued grey (`border-muted/30 bg-muted/10 text-muted-foreground`), in both StatusPill copies | Scheduled `border-success/30 bg-success/6 text-success`, Queued `border-primary/30 bg-primary/8 text-primary`, in `src/components/ui/status-pill.tsx` and `packages/sdk-ui/src/status-pill.tsx`. `status-pill-roster-tones-3189.test.tsx`; `status-pill-drawing-conformance.test.tsx` now grades Queued as a tinted state |
| SP5 | The same roster's glyphs: Scheduled is a calendar of three strokes; Declined is a trash can, apart from Failed's cross | departs: the calendar drew a fourth stroke (`M3 10h18`) in both copies. The SDK copy drew Declined with Failed's cross | The fourth stroke is removed in both copies. The SDK copy draws the trash can (the application copy still draws the cross; the open cinatra#4364 draws it apart). `status-pill-roster-tones-3189.test.tsx` |
| SN3 | "each on the popover surface with a status-coloured border and matching text" (Toast / Sonner), for the default toast. The drawn default has `border: 1px solid var(--line-strong)`, the ink of its text | departs: `--normal-border` was `var(--border)`, the 14% hairline | `--normal-border: var(--line-strong)` in `src/components/ui/sonner.tsx`. `sonner-drawing-conformance.test.tsx` |
| SN5 | "icon led"; "an icon on the left identifies the type". The examples draw a muted circled alert (default), a check (success), a triangle (warning) and a cross (error), 14px, stroked | departs: the toast library draws no icon for an untyped toast (a bare call or `.message`), and it draws filled discs for the typed ones | The wrapper (`packages/sdk-ui/src/toast.ts`) gives the untyped toast the drawn circled alert. A falsy `icon` (null, false, 0, an empty string) no longer removes the glyph. The Toaster hands the library the three drawn typed glyphs. Info has no drawn glyph, so it keeps the library's own; the UI grade reads it as undrawn. `toast-icon-led-and-stack-3189.test.tsx` (rendered Toaster) |
| TB2 | "Tab labels are 13px sans" (Tabs). The drawing's sans face is `--font-sans`, Archivo, commented "UI chrome", and every drawn tab uses it | departs: both Tabs copies set the label in Inter | `font-display` (the application's Archivo token) on the trigger in `src/components/ui/tabs.tsx` and `packages/sdk-ui/src/ui/tabs.tsx`. `tabs-drawing-conformance.test.tsx` |
| TT5, TT6 | "a shadow per palette": light `0 4px 8px -2px rgba(21,33,58,0.3)`, dark `0 4px 8px rgba(0,0,0,0.5)`. The example draws a 6px corner and 6px 10px padding (Tooltip / Popover) | the host copy meets. The SDK copy (`packages/sdk-ui/src/ui/tooltip.tsx`, rendered in the application by the SDK's AccessCombobox) departs: no shadow, a palette-dependent corner and 12px side padding | The SDK copy takes the host copy's recipe: both shadows, `rounded-[6px]`, `px-2.5 py-1.5`. `sdk-tooltip-drawn-recipe-3189.test.tsx` |

## Settled, no change

| id | Clause (drawing) | Reading |
|---|---|---|
| SN6 | "close + copy by default (copy when non-empty copy text is available)"; "By default every toast carries a Close (X) on the right, and a Copy action when non-empty copy text is available" | meets. The wrapper adds Copy for a non-empty text and turns Close on. A caller's own action, `action: null` and `closeButton: false` are the "by default" exceptions. Covered by `toast-caller-action-and-opt-out-4285.test.tsx` and `toast-ghost-icon-controls-3566.test.tsx`. `toast.loading` and `toast.promise` pass through to the library without the wrapper's options; no product code calls either at `a9ca3056` |
| SN7 | "Stack vertically, newest on top." | meets. The library prepends a new toast, so the newest is index 0 and the front of a top-anchored stack. The Toaster changes none of this. Read in a rendered Toaster by `toast-icon-led-and-stack-3189.test.tsx` |

## Named owners of the G4 findings not fixed here

| Finding | Owner |
|---|---|
| Toolbar control height: the chip says 40px, the example draws 34px | cinatra#4284 |
| Table zebra: the drawn stripe uses both stripe tokens and has a dark value; the code paints one flat band | cinatra#4286 |
| Toolbar composition: the artifacts toolbar's second white control | cinatra#4287 |
| Toolbar composition: the segmented filter groups' outer border | cinatra#4288 |
| Toolbar composition: the bordered search fields in the skills, connectors and assistants toolbars | the second pull request of cinatra#4291 |
| The chrome face of status pills, buttons and toolbar buttons | cinatra#4289 |
| The Archived glyph (the roster draws an archive box) | cinatra#4296 (the application copy) and cinatra#4290 (the lifecycle badge). The SDK copy still draws the cross: cinatra#4444 |
| The independent UI grade of these surfaces | cinatra#4291 |
