# End-to-end steps

The maintained steps the end-to-end suites and the picture rounds drive the
product through. A picture round, the run that proves a pull request on a booted
app and takes its pictures, calls these steps instead of following written rules
in its instructions. A defect in how a run drives the product then becomes a
defect of a step, with a test, fixed once for every run.

| Step | What it guarantees |
| --- | --- |
| `signInThroughPage` | One sign-in, through the product's own sign-in page, after the form has hydrated, and back only once the page has landed past it. |
| `waitForIsland` | A frame of the review island, taken when it has loaded or when the bound runs out. |
| `watchRun` | A run's watch kept to its bound, with a frame taken when the run settles or at the bound. |
| `readCount` | A count on one line, taken once it has held still. |
| `navigateTo` | A page reached through the product's own navigation, never by typing its address. |
| `readRows` | Rows of one table by named columns, every name checked against the database's catalog first. |
| `press` | One control pressed by its role and accessible name, never a guess, and the page's next settled state. |
| `selectFrom` | One entry selected in a picker found by its name, and the selection reflected on the page. |
| `dispatchRun` | A run started from its card or sent through the composer, and the run or its notification shown. |
| `uploadFile` | A file uploaded through the page's own upload control, with its row in the list before it returns. |
| `fillForm` | Fields filled by their labels; a required field left empty on submit is refused with the page's own error. |
| `switchTheme` | The theme switched through the app's own control, and read back from the page and its review island. |
| `decideGate` | A decision taken through the named gate's own control, and the run seen to leave the gate. |
<!-- The four rows above: uploadFile, fillForm, switchTheme and decideGate. -->

`index.mjs` exports every step, the once-only budget (`createSignInBudget`), the
refusal (`StepRefusal`) and every bound. It is plain ESM with JSDoc types that
imports only Node's builtins and its own files, so both of these work:

- a Playwright suite imports it: `import { navigateTo } from "../steps/index.mjs";`
- a plain Node process imports it from the checkout under test, next to that
  checkout's own `@playwright/test`, with no TypeScript and no import aliases.

## What every step shares

- **A record.** Every step takes a `record` callback and writes one line per event
  through it. A line names a page by its path, never by its address or its query
  string, and never carries a credential. A step without a `record` does nothing.
- **Refusals by name.** A step that cannot keep its guarantee throws a
  `StepRefusal` whose message names the step, the kind of refusal and the reason,
  for example `navigateTo refused (no-link): no visible link on /agents leads to
  /chat — no address was typed`. The same line is written through the record first.
  An error from Playwright is reduced to its class (`TimeoutError`), because its
  message can repeat a value it was given to type.
- **Named bounds.** Every bound is an exported constant; a caller may shorten or
  lengthen one through the step's options, and an unknown or non-positive bound is
  refused before anything happens.
- **Frames through a shutter.** The two watching steps take their frame through a
  `shutter` the caller passes: `({ step, state, settled, elapsedMs }) => path`.
  The shutter takes the picture (usually `page.screenshot`) and answers its path.

## `signInThroughPage(page, { credentials, budget, record, url?, bounds? })`

Signs a run in once. The sign-in form comes from the product's auth form library,
which renders `noValidate` only once hydration has committed, so the form's
`novalidate` attribute is the hydration mark.

1. Refuses, before anything is sent, a call without the run's budget, without
   credentials, or with an unknown bound.
2. Loads the sign-in page with a full load and checks it landed there.
3. Arms two guards before anything is pressed. The page guard cancels a submission
   the app's own handler did not cancel: the native submission a press before
   hydration makes. The network guard aborts a navigation to the sign-in page that
   would carry the form's fields, including one a script starts with `form.submit()`.
4. Waits for the hydration mark, never a fixed sleep. A page still without it after
   the bound is reloaded once; a second stall is refused with a reading of the page.
5. Fills the two fields and presses once.
6. Reads the app's own sign-in request (the email route, or the username route the
   same form takes) and its answer.
7. Waits for the landing: the page leaves the sign-in page, and the page it lands
   on draws its ready signal, the app shell (`SIGN_IN_READY_SELECTORS`: its link
   to the chat, its navigation or its sidebar; `ready` names others). A step
   taken next never runs on the sign-in page.

**The once-only budget.** A run creates one budget with `createSignInBudget()` and
hands the same object to every sign-in it makes. A press that sent no sign-in
request is a driver failure and never spends it; a request that left the page
spends it, whatever the answer. A second sign-in on a spent budget is refused
without loading anything.

| Bound | Default | Covers |
| --- | --- | --- |
| `SIGN_IN_NAVIGATION_BOUND_MS` | 300_000 | the page load, and the one reload |
| `SIGN_IN_HYDRATION_BOUND_MS` | 60_000 | from the load to the hydration mark |
| `SIGN_IN_HYDRATION_POLL_MS` | 100 | how often the mark, and then the landing, is read |
| `SIGN_IN_ACTION_BOUND_MS` | 30_000 | one fill, or the press |
| `SIGN_IN_REQUEST_BOUND_MS` | 10_000 | from the press to the app's own request |
| `SIGN_IN_ANSWER_BOUND_MS` | 120_000 | from that request to the app's answer |
| `SIGN_IN_LANDING_BOUND_MS` | 120_000 | from the app's answer to the landing and its ready signal |

Refusal kinds: `input` and `spent` (nothing was sent), `blocker` (the page never
became pressable), `driver-failure` (the press sent no sign-in request),
`rejected`, `no-answer` and `no-landing` (the request left the page, and the budget
is spent).

## `waitForIsland(page, { record, shutter, frameSrcPath?, bound?, pollMs? })`

Waits for a review card's island: the framed document that shows the work under
review. It reads the island's own load state (`data-island-load-state` on
`[data-conformance-id="review-target-island"]`) on a fixed cadence and takes the
frame when the state is `loaded`, or when the bound runs out. The card's own
`timed-out` does not end the wait: the frame stays mounted and a late load heals
it. Either way it writes exactly one line (settled or ran out, the elapsed time and
the state) and answers `{ state, settled, elapsedMs, path }`.

The island is the first on the page whose frame shows `frameSrcPath`
(`/lifecycle/review-island` by default). Other readings: `absent`, `unmarked`,
`unreadable`. A frame the browser loads lazily does not start loading off screen,
so bring the card into view before waiting.

| Bound | Default | Covers |
| --- | --- | --- |
| `ISLAND_WAIT_BOUND_MS` | 120_000 | the whole wait |
| `ISLAND_POLL_MS` | 250 | how often the state is read |

## `watchRun(page, { record, shutter, bound?, pollMs? })`

Watches a run on the run page until it settles or the bound runs out, and takes the
frame either way. A reading it could not take, for example while the page reloads,
is a reading and never the end of the watch. The state it reads:

- `completion:<evidence>`: the completion card, with the reading its output rests
  on. Settled, unless that reading is `pending`.
- `status:<status>`: the run's own status pill, the one drawn with the dot in the
  run surface. Settled at `approved`, `failed` and `needs-review` (the run waits
  for a person); still moving at `running` and `queued`.
- `absent`, `unmarked` (a run surface that draws no status, as when the run's first
  step is an input step on the rail) and `unreadable`: never settled.

It writes one line and answers `{ state, settled, elapsedMs, path }`.

| Bound | Default | Covers |
| --- | --- | --- |
| `RUN_WATCH_BOUND_MS` | 300_000 | the whole watch |
| `RUN_WATCH_POLL_MS` | 1_000 | how often the state is read |

## `readCount(page, { selector, record, settleMs?, pollMs?, bound? })`

A reading with a value, for a state whose precondition is absent on the boot: no
notifications, no failed run. It counts what the selector matches (attached
elements, visible or not) and records the count on one line only once it has held
still for `settleMs`, so a list that mounts a moment after the page loads is never
read as empty. A count that never holds still within the bound is refused.

| Bound | Default | Covers |
| --- | --- | --- |
| `COUNT_SETTLE_MS` | 1_000 | how long the count must hold still |
| `COUNT_POLL_MS` | 100 | how often it is read |
| `COUNT_BOUND_MS` | 15_000 | how long it has to hold still at all |

## `navigateTo(page, { path, record, bounds? })`

Presses the first visible link on the current page that leads to `path` (its
`href` is the path, or the path with a query string or a fragment, and it opens in
this tab), waits for the landing, and writes where it landed from. Already on
`path`, it presses nothing. With no such link it refuses: it never types an
address. A press that lands elsewhere, for example through a redirect, is refused
with the page it landed on. A press that starts no navigation within
`NAVIGATE_START_BOUND_MS` (no navigation request, no request for `path` such as a
client-side router sends, and no other path in the address), for example because
the link's own handler opens a dialog in place, is refused at once
(`no-navigation`), naming the link it pressed and the dialog or panel the page
shows instead.

With `furtherPage: true` it opens the page in a further page instead, and first
reads the requests that stand open on the origin (`readStandingRequests`): a
browser keeps at most six connections per origin over plain HTTP, so at or above
`STANDING_REQUEST_BOUND` (four, which keeps two free for a load and a press;
`standingBound` changes it), or while a page's count is unknown, it opens nothing
and refuses with the count, the bound and the pages that hold them, so the caller
closes a page it no longer needs. An origin served over HTTP/2 is not counted, and
the reading sees only what the pages sent after it was first taken on the context,
so a run calls `readStandingRequests(context, { record })` once, before the
context's first page loads.

With `furtherPage: true` it opens the page in a further page instead, and first
reads the requests that stand open on the origin (`readStandingRequests`): a
browser keeps at most six connections per origin over plain HTTP, so at or above
`STANDING_REQUEST_BOUND` (four, which keeps two free for a load and a press;
`standingBound` changes it), or while a page's count is unknown, it opens nothing
and refuses with the count, the bound and the pages that hold them, so the caller
closes a page it no longer needs. An origin served over HTTP/2 is not counted, and
the reading sees only what the pages sent after it was first taken on the context,
so a run calls `readStandingRequests(context, { record })` once, before the
context's first page loads.

| Bound | Default | Covers |
| --- | --- | --- |
| `NAVIGATE_ACTION_BOUND_MS` | 30_000 | the press |
| `NAVIGATE_START_BOUND_MS` | 5_000 | from the press to the start of its navigation |
| `NAVIGATE_LANDING_BOUND_MS` | 120_000 | from the press to the landing |

<!-- readRows, the landing of signInThroughPage, dispatchRun, press and selectFrom -->

## `readRows(database, { table, columns, record, where?, schema?, limit?, bounds? })`

Reads rows of one table by named columns. The caller hands the step the database
client it already holds: a connected `pg` client or pool, or anything with a
`query(text, values)` call that answers `{ rows }`. The step imports no driver of
its own.

1. Reads the columns of every table of that name from the database's own catalog
   (`information_schema.columns`), before anything else.
2. Refuses at once a table no schema holds and a column the table does not have,
   and names the closest there is: `user_id` finds `userId`, and `org_id` finds
   `organizationId`. The columns of `where` are checked the same way.
3. Builds the one query from names the catalog listed, each quoted as an
   identifier, and hands every value of `where` to the database as a bound
   parameter (`null` matches an empty column). It never takes a query string.
4. Answers `{ schema, table, columns, rows }` and writes one line that names the
   table, the columns and the matched columns, never a value.

The product keeps its sign-in tables (camel-case columns such as `userId`) in
`public`, and its own tables in its configured schema. Without `schema` the step
reads the one schema that holds the table, and refuses a table that two schemas
hold until the schema is named.

| Bound | Default | Covers |
| --- | --- | --- |
| `READ_ROWS_BOUND_MS` | 10_000 | one reading of the database: the catalog, or the rows |
| `READ_ROWS_LIMIT` | 100 | the rows one reading answers; more matching rows are refused, never cut |

Refusal kinds: `input`, `unknown-table`, `ambiguous` and `unknown-column`
(nothing was read), `too-many-rows`, `unreadable` (the database refused the
reading; only the error's class and code are kept) and `no-answer`. Its unit
tests read a database double. With `E2E_STEPS_UNIT_DATABASE_URL` naming a
PostgreSQL database the tests may create schemas in, the same cases also read
that database, in schemas they create and drop.

## The control steps: `press`, `selectFrom` and `dispatchRun`

These steps find a control as a person with a screen reader finds it: by its
role and its accessible name. The name is the text the elements of
`aria-labelledby` hold, `aria-label`, the control's own labels or a fieldset's
legend, or, for a button, a link, a tab, a menu item, an option or a radio, its
text without hidden parts. Only a shown control counts: drawn, and not hidden
from assistive technology (`aria-hidden`). Names are compared whole, after each
run of white space becomes one space.

When a name matches several controls, the step acts on none of them: it refuses
(`ambiguous`) and names where each one sits. The one control a step acts on
carries the mark `data-step-control` for that act only. A refusal lists at most
`CONTROL_NAMES_LISTED` (ten) names and counts the others.

| Bound | Default | Covers |
| --- | --- | --- |
| `CONTROL_ACTION_BOUND_MS` | 10_000 | one press or one selection |
| `CONTROL_POLL_MS` | 100 | how often the page is read while a step waits |

## `press(page, { name, record, role?, within?, bounds? })`

Presses the one shown control of `role` named `name`: a button by default, or a
link, a menu item or a tab (`role: "link"`, `"menuitem"` or `"tab"`). Then it
waits for the page's next settled state, read with the start signal of
`navigateTo` (a navigation request, the page's own request for a link's path, or
another path in the address):

- no start signal within `PRESS_START_BOUND_MS`: no navigation started, and the
  page stayed where it was;
- a start signal: the navigation must land within `PRESS_SETTLE_BOUND_MS`, on a
  new document that has loaded, or in place on another path.

A press whose navigation starts only after the start bound (a handler that waits
for a slow answer first) reads as one that stayed; give such a control a longer
`startMs`. The step answers `{ name, role, from, path, navigated, elapsedMs }`.

A checkbox, a radio or a switch (`role: "checkbox"`, `"radio"` or `"switch"`) is
pressed the same way, and its checked state is read before the press and once the
page has settled (a state the page changes only after a slow answer needs a
longer `startMs`); a press that did not change it is refused (`unchanged`). With
`within`, the name is looked for only inside the one shown part of the page of
that name, a landmark or a section named by its label or its heading, as a
refusal names the part a control sits in; a scope that no part carries is
refused (`no-scope`), and one that several parts carry (`ambiguous`).

| Bound | Default | Covers |
| --- | --- | --- |
| `PRESS_START_BOUND_MS` | 2_000 | from the press to the start of a navigation |
| `PRESS_SETTLE_BOUND_MS` | 60_000 | from the press to the landing of that navigation |

Refusal kinds: `input`, `unreadable` (the page could not be read), `no-scope`
(naming the named parts the page shows), `no-control` (naming the controls of
the role that the page, or its scope, shows), `ambiguous` and `disabled`
(nothing was pressed), `driver-failure`, `unsettled` and `unchanged` (the
checked state did not change, or could not be read after the press).

## `selectFrom(page, { picker, entry, record, bounds? })`

Selects `entry`, by its visible text, in the one shown picker named `picker`:

- a select: the option is selected as a person selects it;
- a radio group (`role="radiogroup"`, or a fieldset or group that holds radios):
  the radio with that label is checked;
- a listbox: the option is pressed;
- a combobox that is not a text field: it is pressed first, to open the list it
  controls (`aria-controls`), and the option is pressed in that list.

When no picker carries the name, a combobox with no accessible name, as the
shared select draws one, is found by the text a person reads for it, tried in
this order: the placeholder it shows (marked `data-placeholder`), the value it
shows, or the text of a label element before it in its form group (the nearest
element that holds one, a label that names no other control, with no other
field between the two); when more than one combobox matches on the first of
these that finds one, it refuses (`ambiguous`).

Then it waits until the page reflects the selection: the entry reads as selected
(the selected option of a select, a checked radio, `aria-selected` or
`aria-checked`, a combobox that shows the entry), or a live region (a status, an
alert, a toast) names the entry that did not name it before. The step answers
`{ picker, entry, kind, via, path, elapsedMs }`, where `via` is `state` or
`confirmation`.

| Bound | Default | Covers |
| --- | --- | --- |
| `SELECT_REFLECT_BOUND_MS` | 5_000 | from the selection to the page reflecting it, and from opening a combobox to its list |

Refusal kinds: `input`, `unreadable`, `no-picker` (naming the pickers the page
shows), `ambiguous`, `no-entry` (naming the picker's entries) and `disabled`
(nothing was selected), `driver-failure` and `not-reflected`.

## `dispatchRun(page, { record, card?, control?, prompt?, composer?, bounds? })`

Starts a run from its card, or sends it through the conversation's composer, or
both, the card first.

- **The card.** A card is an `article`, or an element the design system marks as
  a card (`data-slot="card"`, or a `data-slot` that ends in `-card`). Its name is
  its `aria-label`, the text of `aria-labelledby`, or its title: the element
  marked as the card's name or title, or its first heading. The step presses the
  card's one shown button or link named `control` (`Run` by default).
- **The composer.** With `prompt`, the step waits for the one shown text box
  named `composer` (`Send message` by default), types the prompt into it, and
  presses the send control, the button of the same name. The product gives its
  composer that name in an empty conversation and in one with messages alike;
  only the placeholder differs ("Ask anything..." or "Type a message..."), and a
  placeholder is never read as a name. No line carries the prompt.

Then the step waits for what the press that sent the run brings that the page
did not show before:

- the run: the run page's surface, or the run panel the conversation draws, with
  the newest run's state read as `watchRun` reads it; or
- a notification: a toast that is neither an error nor still loading, or a row
  of the notifications list.

The step answers `{ card, via, state, path, elapsedMs }`, where `via` is `run`
or `notification`. To watch the run itself, hand the page to `watchRun` next.

| Bound | Default | Covers |
| --- | --- | --- |
| `DISPATCH_RUN_COMPOSER_BOUND_MS` | 30_000 | from the call, or the card's press, to the composer |
| `DISPATCH_RUN_BOUND_MS` | 120_000 | from the press that sent the run to the run or its notification |

Refusal kinds: `input`, `unreadable`, `no-card` (naming the cards the page
shows), `ambiguous`, `no-control` (naming the card's controls) and `disabled`
(nothing was pressed), `no-composer` (naming the text boxes the page shows; no
prompt was sent), `driver-failure` and `no-run` (the refusal names the page, and
an error the page shows).

<!-- uploadFile, fillForm, switchTheme and decideGate: the steps that drive a page's own controls. -->

## `uploadFile(page, { control, path, record, bounds? })`

Uploads the file at `path` through the page's own upload control. It presses the
first shown button named `control` (the library's Upload button, which opens a
hidden file input, or a shown file input with a label of its own), answers the
file chooser the press opens with the file, and waits until a row that names the
file appears in the library's list (`UPLOAD_ROW_SELECTOR`), beyond the rows that
named it before the press. A line names the file by its name alone, never by the
place it was read from. A press the page's handler has not taken over yet (before
the page has hydrated) opens no chooser, and is refused as such at once. It
answers `{ control, file, path, elapsedMs }`.

| Bound | Default | Covers |
| --- | --- | --- |
| `UPLOAD_CONTROL_BOUND_MS` | 15_000 | the control shown with its name |
| `UPLOAD_ACTION_BOUND_MS` | 30_000 | the press, and handing the file to the chooser |
| `UPLOAD_CHOOSER_BOUND_MS` | 5_000 | from the press to the file chooser |
| `UPLOAD_ROW_BOUND_MS` | 120_000 | from the file handed over to its row |
| `UPLOAD_POLL_MS` | 250 | how often the control and the list are read |

Refusal kinds: `input` (nothing was pressed), `no-control` (naming the page's file
inputs), `driver-failure`, `no-chooser` (the press opened no file chooser) and
`no-row` (naming the rows the list shows).

## `fillForm(page, { fields, record, form?, submit?, bounds? })`

Fills `fields` (`{ label: value }`) by the labels a person reads: a field's label
is the text its `aria-labelledby` names, else its `aria-label`, else the text of
its `<label>`. `form` selects what holds the fields, the whole page by default. A
label the form does not show within the bound is refused before anything is
filled, naming the labels it has. With `submit`, it then presses the form's
control of that name. A field still empty after the press is a required field
left empty when the page marks it (`aria-invalid="true"`) or shows an error for
it, or when it declares itself required; the refusal quotes the page's own error
text: what its `aria-errormessage` names, else an error its `aria-describedby`
names, else an error in the field's own box (`FIELD_ERROR_SELECTOR`). No value is
ever written to a line. It answers `{ filled, submitted, path }`.

| Bound | Default | Covers |
| --- | --- | --- |
| `FORM_FIELDS_BOUND_MS` | 15_000 | every named field shown |
| `FORM_ACTION_BOUND_MS` | 30_000 | one fill, or the press |
| `FORM_ERROR_BOUND_MS` | 5_000 | from the press to the page's error for a field left empty |
| `FORM_POLL_MS` | 100 | how often the form is read |

Refusal kinds: `input` and `unknown-label` (nothing was filled), `driver-failure`,
`no-submit` (naming the form's controls) and `required-empty`.

## `switchTheme(page, { to, record, island?, frameSrcPath?, bounds? })`

Switches the page to `to` (`light` or `dark`) through the app's own theme
control, the button named "Toggle theme": it presses it at most once, and not at
all when the page shows `to` already. It then reads, on a fixed cadence, the
page's palette (the class the app writes on the document root: `cinatra` or
`dark`) and the theme each review island applied (`data-island-color-scheme` on
the wrapper of the island's document, in every frame on `frameSrcPath`, which is
`/lifecycle/review-island` by default), until both report `to`. With
`island: false` only the page's palette is read, for a page that frames no
island. It answers `{ to, pressed, islands, elapsedMs }`.

| Bound | Default | Covers |
| --- | --- | --- |
| `THEME_CONTROL_BOUND_MS` | 15_000 | the control shown with its name, which it has only once the app has mounted it |
| `THEME_ACTION_BOUND_MS` | 30_000 | the press |
| `THEME_APPLIED_BOUND_MS` | 10_000 | from the press to the page and its islands reporting the theme |
| `THEME_POLL_MS` | 100 | how often they are read |

Refusal kinds: `input` (nothing was pressed), `no-control`, `driver-failure`,
`not-applied` (the page's palette did not become `to`) and `island-unreported`
(the page shows `to`, but an island reported something else last: the other
theme, `unmarked`, `absent` or `unreadable`).

## `decideGate(page, { gate, decision, record, bounds? })`

Takes a decision at a gate a run stops at. A gate is a lifecycle card
(`GATE_SELECTOR`), named by its accessible name, else its heading, else its
title: the first text it shows, as the review gate's "Review requested". The
decision is that gate's own shown button of the name, never another gate's. After
the press it waits until the run has left the gate: on a run page the run's
status pill reads another status than `needs-review`; on a page without it the
gate reads `settled` or `decided`, or is no longer drawn. It answers
`{ gate, decision, state, elapsedMs, path }`.

| Bound | Default | Covers |
| --- | --- | --- |
| `GATE_FIND_BOUND_MS` | 30_000 | the gate and its control drawn |
| `GATE_ACTION_BOUND_MS` | 30_000 | the press |
| `GATE_LEAVE_BOUND_MS` | 60_000 | from the press to the run leaving the gate |
| `GATE_POLL_MS` | 250 | how often the page is read |

Refusal kinds: `input` (nothing was pressed), `no-gate` (naming the gates the
page shows), `no-control` (naming the gate's controls), `driver-failure` and
`still-at-gate` (with the last reading).

## Shared bounds

| Bound | Default | Covers |
| --- | --- | --- |
| `FRAME_BOUND_MS` | 60_000 | the shutter answering with a frame |
| `READING_BOUND_MS` | 5_000 | one reading of the page; a watch can overrun its bound by at most this |

## Tests

- **Unit tests**, in the root unit tier (`pnpm test:root`, or
  `pnpm exec vitest run --config vitest.config.ts tests/e2e/steps`). Each step's
  branches run against a page double over a local fixture app: no browser, no
  server. With `E2E_STEPS_UNIT_BROWSER=1` the same cases also drive a real browser
  over the same fixture pages, which keeps the double honest.
- **The live smoke**, one per step, against a running development server:
  `pnpm exec playwright test -c tests/e2e/config/steps.config.ts`. Without a
  browser or a server every test is skipped, and its reason names what is missing.
  `E2E_STEPS_ISLAND_PATH` and `E2E_STEPS_RUN_PATH` name a page with a review island
  and a run page for the two watching smokes.
