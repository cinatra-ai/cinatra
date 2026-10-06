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
| `readOptions` | A picker's entries in their order and the entry it shows, read without choosing; a combobox's list opened and closed again with the Escape key. |
| `dispatchRun` | A run started from its card or sent through the composer, and the run or its notification shown. |
| `readControlNames` | Every shown control of a page, by its role and its accessible name, a control without a name included. |
| `armPageTape` | The document's time origin noted, and the main frame's navigations counted from then on. |
| `readPageTape` | The tape read back: new documents and changes of the address in place since it was armed, and whether the page is still the same document. |
| `uploadFile` | A file uploaded through the page's own upload control, with its row in the list before it returns. |
| `fillForm` | Fields filled by their labels; a required field left empty on submit is refused with the page's own error. |
| `switchTheme` | The theme switched through the app's own control, and read back from the page and its review island. |
| `decideGate` | A decision taken through the named gate's own control, and the run seen to leave the gate. |
| `typeInWindow` | Text typed into a window's text box through the keyboard, read back from the box, and sent through the window's own send control when asked. |
| `waitForTurn` | A turn of a window's conversation waited for without a reload: a new entry of the assistant, and the send control idle again. |
| `reloadPage` | The browser's own reload of the page, and the new document's time origin. |
| `sendInComposer` | One message sent through the conversation's composer, and the kind of the card that answers it; a message that starts a run is refused. |
| `openAddress` | A page no visible link leads to, such as the not-found page, loaded once by its address, with the status of the response. |
| `readAddress` | The page's path and the values of the query parameters the caller names, read once the address has held still; any other parameter counted, never written. |
| `pressByTestId` | One element without a role pressed by its test id and its whole text, never a guess, and the page's next settled state, read as `press` reads it; the record says the element has no role. |
| `readTitle` | The page's title, read by the browser's own reading of it once it has held still. |
| `openPageInOwnContext` | A further page opened from a visible link in a browser context of its own, with connections of its own, signed in by the session the first page carries and never through the sign-in page. |
<!-- The rows from uploadFile on: uploadFile, fillForm, switchTheme and decideGate; then typeInWindow, waitForTurn, reloadPage, sendInComposer and openAddress. -->

`index.mjs` exports every step, the once-only budget (`createSignInBudget`), the
refusal (`StepRefusal`) and every bound. It is plain ESM with JSDoc types that
imports only Node's builtins and its own files, so both of these work:

- a Playwright suite imports it: `import { navigateTo } from "../steps/index.mjs";`
- a plain Node process imports it from the checkout under test, next to that
  checkout's own `@playwright/test`, with no TypeScript and no import aliases.

## What every step shares

- **A record.** Every step takes a `record` callback and writes one line per event
  through it. A line names a page by its path, never by its address or its query
  string, and never carries a credential. A line may carry the value of a query
  parameter that the caller named to `openAddress` or `readAddress`, and no
  other. A step without a `record` does nothing.
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

The same start signals and short bound apply with `furtherPage: true`: no start is refused as `no-further-page`, naming what the current page shows instead, while a started open keeps its full landing wait.

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
run of white space becomes one space. When no control's name reads the same, a
name that reads the same once all white space is removed names the control, as
parts drawn with no space between them read ("3Select blog idea" for "3 Select
blog idea"): a name that reads the same exactly wins, and several that read the
same only so are refused as `ambiguous`, each named as the page reads it.

When a name matches several controls, the step acts on none of them: it refuses
(`ambiguous`) and names where each one sits. The one control a step acts on
carries the mark `data-step-control` for that act only. A refusal lists at most
`CONTROL_NAMES_LISTED` (ten) names and counts the others.
A step that marks a control first waits until the page has hydrated, by the
reading React leaves on the page's rendered elements; a page with nothing to
hydrate is read at once, and a page that does not hydrate within
`CONTROL_HYDRATION_BOUND_MS` is refused as `unreadable`.

| Bound | Default | Covers |
| --- | --- | --- |
| `CONTROL_ACTION_BOUND_MS` | 10_000 | one press or one selection |
| `CONTROL_HYDRATION_BOUND_MS` | 60_000 | from a step's first reading to the page's hydration |
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
  new document that has loaded, or in place on another path. A browser holds a
  reading of the page while a navigation is in flight; the step waits for one
  no longer than the bound leaves, so a navigation that lands late is refused
  at the bound, with the page still on the document it started from.

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
  controls (`aria-controls`), and the option is pressed in that list;
- a search field, a combobox that is a text input (as the entity search draws
  one): the entry's text is typed into it, and the option is pressed in the
  list that opens.

When no picker carries the name, a combobox with no accessible name, as the
shared select draws one, is found by the text a person reads for it, tried in
this order: the placeholder it shows (marked `data-placeholder`), the value it
shows, or the text of a label element before it in its form group (the nearest
element that holds one, a label that names no other control, with no other
field between the two); when more than one combobox matches on the first of
these that finds one, it refuses (`ambiguous`). A search field with no
accessible name is found the same way, by its placeholder while it is empty or
by the text it holds.

Once it has opened a combobox, it reads the combobox again by its mark, never by
its name: while the list is open, the shared select hides everything outside the
list from assistive technology, the combobox included.

A search field lists its entries once text is typed into it. The step types the
entry's text, reads the field again by its mark (the text hides its placeholder
and changes its value), and waits within the reflect bound for an option of the
entry's name. A search list draws each entry as a row, the entry's name first
and then what tells it apart (a detail line, a status), so an option is named
by its first text. The step presses the one option of the name, refuses several
(`ambiguous`), and refuses none once the bound has run out (`no-entry`), naming
the entries the list showed. It reads the choice back from the page, never from
the list, whose selected row is only the one a key press would choose: the
field shows the entry once its list has closed, or the page draws the entry (a
row, a chip) more often than before the press. The field or the page showing
another entry of the list instead is refused (`other-entry`).

Then it waits until the page reflects the selection: the entry reads as selected
(the selected option of a select, a checked radio, `aria-selected` or
`aria-checked`, a combobox that shows the entry), or a live region (a status, an
alert, a toast) names the entry that did not name it before. The step answers
`{ picker, entry, kind, via, path, elapsedMs }`, where `via` is `state` or
`confirmation`.

A combobox the step opened is also waited for until its list has closed, when
the list still hides the combobox from assistive technology once the choice
shows: the shared select shows the choice while its list is still closing, and
while the list is open it hides the rest of the page, so a second pick on the
page would find no picker. The wait reads the combobox as the open wait does,
within the same bound, measured from the choice, and the log line then ends
`; its list closed after <n> ms`. A list that is closed at once, or a list the
step found already open, takes no wait and adds nothing to the line.

| Bound | Default | Covers |
| --- | --- | --- |
| `SELECT_REFLECT_BOUND_MS` | 5_000 | from the selection to the page reflecting it, from opening a combobox to its list, from the selection to the close of a list that hides the page, and from typing into a search field to its entry in the list |

Refusal kinds: `input`, `unreadable`, `no-picker` (naming the pickers the page
shows), `ambiguous`, `no-entry` (naming the picker's entries) and `disabled`
(nothing was selected), `driver-failure`, `other-entry` (a search field's page
took another entry than the one pressed), `not-reflected` and `not-closed` (a list
that still hides the page once the bound has run out).

## `readOptions(page, { picker, record, bounds? })`

Reads the entries of the one shown picker named `picker`, found as `selectFrom`
finds it (a combobox with no accessible name included), in the page's order,
and the entry it shows as chosen, and chooses nothing. A select, a radio group,
a listbox, and a combobox whose list is shown already, are read as they are. A
combobox whose list is not shown is opened as `selectFrom` opens it and read
again by its mark; then the Escape key is pressed once, the list's own close,
and the step waits until the list has closed: the combobox reads closed and is
no longer hidden from assistive technology, within the reflect bound measured
from the key, whether or not the list hid the page. The step presses nothing
else. It answers `{ picker, kind, entries, more, shows, path }`: `entries` the
names of at most `CONTROL_NAMES_LISTED` entries, `more` the count of the rest,
and `shows` the entry the picker showed when the step found it (a select's
selected option, a radio group's checked radio, a listbox's option marked
selected or checked, a combobox's own text, empty while it shows its
placeholder), or the empty string. Its one line reads, for example,
`readOptions: the picker "Size" on /pick/start lists "Small", "Medium",
"Large", "Huge" in this order and shows "Small"`, and, for a combobox it opened,
ends `; its list closed after <n> ms`; a picker that shows no entry is said to
show no entry. It takes the bounds of `selectFrom` (`SELECT_BOUNDS`).

Refusal kinds: `input`, `unreadable`, `no-picker` (naming the pickers the page
shows), `ambiguous`, `disabled` and `no-list` (a search field, which lists
entries only for typed text), each before anything is read; `no-entry` (an
opened combobox shows no list), `driver-failure` (the press or the Escape key
was not taken) and `not-closed` (the list did not close within the bound of the
Escape key).

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

<!-- readControlNames: every shown control of a page, by its role and its name. -->

## `readControlNames(page, { record, within?, bounds? })`

Reads every shown control of the page by its role and its accessible name, with
the reader of the control steps: the same order of name sources and the same
rule for what counts as shown, so a name it reads is the name `press` looks for.
Beside the roles of controls (a button, a link, a menu item, a tab, a tree item,
a text box, a search field, a combobox, a listbox and its options, a checkbox, a
radio and a radio group, a switch, a slider and a spin button), it reads the
parts of a page a person moves between: a region, a group, a dialog or an alert
dialog, a form, a navigation and a search landmark. An element without a `role`
takes the one its tag gives it: a button is a button, a `nav` is a navigation,
and a section or a form is a region or a form only once it has a name. An
element with neither is not listed. With `within`, it reads only inside the one
shown part of the page of that name, found as `press` finds it.

It answers `{ controls, more }`. `controls` lists each control as
`{ role, name, from, description }`, in the page's order, at most
`READ_CONTROL_NAMES_LIMIT` of them, and `more` counts the controls beyond.
`from` says where the name comes from:
`aria-labelledby`, `aria-label`, `label` (the control's own labels, or a
fieldset's legend), `text` (its text, or a button input's value) or `title`.
`description` is the text `aria-describedby` names. A control without a name is
listed, with an empty name and an empty `from`: a reading that left it out could
not show that its name is missing. A section that its heading names for a
person with a screen reader points to that heading (`aria-labelledby`), and
reads as a region with the heading's text. A heading alone names its section
for no one, so such a section is no region; its controls are listed all the
same.

It writes one line per control: `readControlNames: ` and the JSON of its role,
its name and `from`, such as
`readControlNames: {"role":"button","name":"Save","from":"text"}`. A name is
written whole up to `READ_CONTROL_NAME_LENGTH` characters; a longer one is cut
there and ends with an ellipsis, and an address in a name is written as "an
address". When the limit cut controls off, one more line counts them, such as
`readControlNames: {"more":12}`. The answer keeps every name whole.

| Bound | Default | Covers |
| --- | --- | --- |
| `READING_BOUND_MS` | 5_000 | the one reading of the page (`readingMs` changes it) |
| `READ_CONTROL_NAMES_LIMIT` | 400 | the controls one reading lists; `more` counts the others |
| `READ_CONTROL_NAME_LENGTH` | 300 | the characters of a name one line carries |

Refusal kinds: `input` (nothing was read), `no-scope` (naming the named parts
the page shows), `ambiguous` (naming where each part of that name sits),
`no-control` (the page, or its part, shows no control) and `driver-failure`
(the reading failed, or gave no answer within its bound; only the error's class
is kept).

<!-- armPageTape and readPageTape: the document's time origin and the main frame's navigations. -->

## `armPageTape(page, { record, bounds? })` and `readPageTape(page, { record, bounds? })`

A check that a page changed in place, the same document between two moments,
with no reload and no navigation, arms a tape on the page first and reads it
back later. `armPageTape` reads the document's time origin
(`performance.timeOrigin`, which every new document has anew) and its path,
and from then on counts the navigations of the page's main frame on the
driver's side, from the page's own navigation events: new documents and
changes of the address in place apart. It writes one line, such as
`armPageTape: {"path":"/agents","timeOrigin":1790000000000.5}`, and answers
`{ path, timeOrigin, rearmed }`. Arming the page again starts the count again,
and its line says so with `"rearmed":true`.

`readPageTape` answers
`{ path, timeOrigin, armedTimeOrigin, documents, addressChanges, sameDocument }`
and writes one line, `readPageTape: ` and the JSON of those fields. `documents`
counts the new documents of the main frame, `addressChanges` its changes of the
address in place, and `sameDocument` is true only when the time origin is
still the armed one and no new document was counted.

The page announces every navigation of its main frame, a new document and a
change in place alike. A new document is one that a navigation request of the
main frame led to: a request for the same address (without its fragment) that
has not failed. A document of another origin, or of none (the browser's own
error page), is always a new one. A change in place (a state pushed into the
history, a new fragment, a step back within the document) sends no request. A
state written into the history at the same address, as a client-side router
writes one, is no change of the address, and a frame inside the page counts
for nothing.

The tape belongs to the page object: two pages hold two tapes, a tape lasts
through the page's new documents and changes of address, and it ends with the
page. The module keeps no state of its own.

| Bound | Default | Covers |
| --- | --- | --- |
| `READING_BOUND_MS` | 5_000 | one reading of the document (`readingMs` changes it) |

Refusal kinds: `input` (nothing was armed or read), `closed` (the page is
closed, and its tape ended with it), `no-tape` (no tape was armed on the page)
and `driver-failure` (the reading failed, or gave no answer within its bound;
only the error's class is kept).

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
filled, naming the labels it has. One reading of the form both lists its labels
and resolves the field a label names, and a label names a field when both read
the same without their white space ("Idea (optional)" and "Idea(optional)"
alike); a label that names two fields is refused as `ambiguous`, naming both,
before anything is filled. With `submit`, it then presses the form's control of
that name, which the same reading resolves by the same match, so a name a
refusal lists is one the step takes; a name that two controls carry is refused
as `ambiguous`, naming both, before anything is pressed, and a control hidden
from assistive technology is neither listed nor pressed. A field still empty
after the press is a required field left empty when the page marks it
(`aria-invalid="true"`) or shows an error for it, or when it declares itself
required; the refusal quotes the page's own error
text: what its `aria-errormessage` names, else an error its `aria-describedby`
names, else an error in the field's own box (`FIELD_ERROR_SELECTOR`). No value is
ever written to a line. It answers `{ filled, submitted, path }`.

| Bound | Default | Covers |
| --- | --- | --- |
| `FORM_FIELDS_BOUND_MS` | 15_000 | every named field shown |
| `FORM_ACTION_BOUND_MS` | 30_000 | one fill, or the press |
| `FORM_ERROR_BOUND_MS` | 5_000 | from the press to the page's error for a field left empty |
| `FORM_POLL_MS` | 100 | how often the form is read |

Refusal kinds: `input`, `unknown-label` and `ambiguous` (nothing was filled; for
a name two controls carry, nothing was pressed), `driver-failure`, `no-submit`
(naming the form's controls) and `required-empty`.

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

<!-- typeInWindow, waitForTurn, reloadPage, sendInComposer and openAddress: a window's text box, a turn of its conversation, a reload, a composer's message and an address no link leads to. -->

## `typeInWindow(page, { field, text, record, send?, replace?, within?, bounds? })`

Types `text` into the one shown text box of role textbox named `field`, as a
person types it. A run window's text box is no form field: the product draws it
as a box whose content is editable, named by its `aria-label` (the run window's
"Apply AI suggestion", `RUN_WINDOW_FIELD`), so `fillForm` finds no field in it.
The step finds the box with the reader of the control steps, never by a test
id; with `within`, only inside the one shown part of the page of that name, for
a page that shows more than one window. It presses into the box, puts the caret
at the end of its text (with `replace`, selects the text and deletes it with
Backspace first) and types the text key by key. A text with a line break or
another control character is refused, since a line break would press Enter,
which sends. The text is read back from the box, and a box that does not read
back what was typed is refused. A box the product has locked, as it locks a
window's box while an answer is pending, is refused before anything is typed.

With `send`, it presses the box's own send control, the shown button of the
box's name nearest to it (the product names a window's box and its send control
alike), once the text is in, and waits until the window has taken the message:
the product empties the box as it takes it. Right before the press it notes, in
the page's document, the entries the window shows, for `waitForTurn`. The step
answers `{ field, text, sent, path }`, where `text` is what the box read back.
No line carries the text.

| Bound | Default | Covers |
| --- | --- | --- |
| `WINDOW_FIELD_BOUND_MS` | 30_000 | from the call to the text box shown with its name (`fieldMs`) |
| `CONTROL_ACTION_BOUND_MS` | 10_000 | the press into the box, and the press on the send control (`actionMs`) |
| `WINDOW_SENT_BOUND_MS` | 5_000 | from the press on the send control to the window taking the message (`sentMs`) |
| `CONTROL_POLL_MS` | 100 | how often the page is read while the step waits (`pollMs`) |

Refusal kinds: `input`, `unreadable`, `no-scope`, `no-field` (naming the text
boxes the page shows), `ambiguous`, `disabled` and, with `send`, `no-control`
(naming the buttons nearest to the box; nothing was typed), `driver-failure`,
`not-typed` and `not-sent`.

## `waitForTurn(page, { record, field?, within?, bounds? })`

Waits, never reloading, until a new entry of the assistant stands in a window
and its send control is idle again. The product marks each entry of a window's
conversation with `data-run-window-entry` (`RUN_WINDOW_ENTRY_ATTRIBUTE`), as
`person` or `assistant`, and the step counts the shown ones in the page, or in
the one shown part of it named `within`. The window is named by its text box
(`field`, "Apply AI suggestion" unless named otherwise), found as
`typeInWindow` finds it. While an answer is pending, the product locks the box
and gives the send control its stop name; the send control is idle once the
box takes text again and a shown button of the box's name stands beside it
again.

A send made by `typeInWindow` notes, in the page's document, the entries its
window showed right before the press. The wait counts from that note when there
is one for the same `field` and `within`, so an answer that stood before the
wait began is still the new turn; without one it counts from its own first
reading. A wait that sees the turn takes the note away, and a new document has
none. The step answers `{ field, before, after, since, elapsedMs, path }`, where
`before` and `after` count the entries as `{ person, assistant }` and `since` is
`send` or `wait`. At its bound it refuses (`no-turn`) and names what was
missing: the new entry, the idle send control, or both.

| Bound | Default | Covers |
| --- | --- | --- |
| `TURN_BOUND_MS` | 120_000 | from the start of the wait to the turn (`turnMs`) |
| `TURN_CEILING_MS` | 600_000 | the most `turnMs` may be raised to |
| `TURN_POLL_MS` | 250 | how often the window is read (`pollMs`) |

Refusal kinds: `input` (nothing was waited for, a `turnMs` above the ceiling
included), `unreadable`, `no-scope`, `no-window` (naming the text boxes the
page shows) and `ambiguous`, all at once, and `no-turn` at the bound.

## `reloadPage(page, { record, bounds? })`

The browser's own reload of the page, until the new document's content has
loaded (`DOMContentLoaded`). The step then reads the new document's time
origin (`performance.timeOrigin`, which every new document has anew, as
`armPageTape` reads it) and answers `{ path, timeOrigin, elapsedMs }`. A reload
that lands on another path than the one the page was on, such as a redirect to
the sign-in page, is refused, naming where it landed.

| Bound | Default | Covers |
| --- | --- | --- |
| `RELOAD_BOUND_MS` | 120_000 | from the reload to the new document's content loaded (`reloadMs`) |
| `READING_BOUND_MS` | 5_000 | the reading of the new document (`readingMs`) |

Refusal kinds: `input` and `closed` (nothing was reloaded), `no-load`,
`landed-elsewhere` and `driver-failure` (the new document could not be read).

## `sendInComposer(page, { prompt, composer, record, bounds? })`

Sends one message through the conversation's composer, the one shown text box
named `composer` ("Send message" in the product), and waits for the card that
answers it. It types on `typeInWindow`'s road, in place of the text the
composer held (a stored draft), so that the message is the prompt alone, and
presses the composer's own send control. A card is what the conversation draws
for an answer that is not text: a lifecycle card (`data-lifecycle-card`) or a
renderable view (`data-view-type`), whose value is the card's kind. The step
reads the shown cards of each kind right before the press, and answers
`{ composer, kind, path, elapsedMs }` once a card stands that the conversation
did not show then. It reads the page as `dispatchRun` reads it for a run (the
run page's surface, the run panel the conversation draws, or a notification of
a run) and refuses a send after which one shows: starting a run is
`dispatchRun`'s act. No line carries the prompt.

| Bound | Default | Covers |
| --- | --- | --- |
| `DISPATCH_RUN_COMPOSER_BOUND_MS` | 30_000 | from the call to the composer shown with its name (`composerMs`) |
| `CONTROL_ACTION_BOUND_MS` | 10_000 | one press (`actionMs`) |
| `WINDOW_SENT_BOUND_MS` | 5_000 | from the press on the send control to the composer taking the message (`sentMs`) |
| `COMPOSER_CARD_BOUND_MS` | 120_000 | from the send to the answer's card (`cardMs`) |
| `CONTROL_POLL_MS` | 100 | how often the page is read (`pollMs`) |

Refusal kinds: `input` (nothing was sent), those of `typeInWindow` with
`no-composer` in place of `no-field`, `starts-run`, and `no-card` (naming an
error the page shows, the conversation's error card among them).

## `openAddress(page, { path, record, params?, bounds? })`

Loads `path`, once, on the current page's own origin and in the caller's page,
so the session the page is signed in with goes with it, and answers
`{ path, status, from, elapsedMs }`: where the load landed, the status of the
response, and the path the page was on. It is the one step that types an
address, because a page that exists only for a wrong address, such as the
not-found page, has no link that leads to it, so no press can reach it. It
refuses, before it loads anything, a path that a visible link on the current
page leads to, read as `navigateTo` reads its links (`has-link`: pressing that
link is `navigateTo`'s act), an address of another origin (`other-origin`), and
anything that is no page path. Its line says that an address was typed.

A page that keeps its views at their own addresses, such as `?tab=locked`, is
opened with its query when the caller names the parameters the path may carry
in `params`, such as `["tab"]`. The path may then carry a query of those names,
and the step answers `{ path, status, from, elapsedMs, query, others }`: `query`
holds each named parameter's value where the load landed (null when the address
does not carry it), and `others` counts the parameters of any other name, whose
values are never written. It refuses as `input`, before it loads anything,
`params` that is no list of distinct names (letters, digits, `_`, `.` and `-`),
a path with a fragment, and a query that names a parameter `params` does not
name, without writing that parameter. The `has-link` reading then reads the
path with its query. Its line writes each named parameter as `name="value"`, cut
as a name is, or `name absent`, and counts the others, such as
`openAddress: typed the address of /configuration/extensions with the query
tab="locked" into the page on /chat, where no visible link leads to it; it
landed on /configuration/extensions with the query tab="locked" with status 200
after 412 ms`.

| Bound | Default | Covers |
| --- | --- | --- |
| `OPEN_ADDRESS_BOUND_MS` | 120_000 | from the typed address to the landing (`loadMs`) |
| `READING_BOUND_MS` | 5_000 | the reading of the page's links (`readingMs`) |

Refusal kinds: `input`, `other-origin`, `unreadable` and `has-link` (no address
was typed), and `no-load`.

## `readAddress(page, { params, record, settleMs?, pollMs?, bound? })`

Reads the address of the page, on the driver's side as the page's address is,
so a view the page chooses in place (a state pushed into its history) is read
as a load is. It answers `{ path, query, others }` once two readings of the
path and of the values of the parameters `params` names lie `settleMs` apart
and are equal, and every reading between them agreed: `query` holds each named
parameter's value (null when the address does not carry it), and `others`
counts the parameters of any other name, whose values are never written. Its
one line is written as `openAddress` writes a query, such as
`readAddress: the page is on /configuration/extensions with the query
tab="archived"`, or `... with the query tab="all", and 1 other parameter not
written`. An address that never holds still within `bound` is refused
(`unsteady`), naming the last two readings, the path and the named values only.
An unknown option, `params` that is no list of distinct names, or a bound that
is not a positive number of milliseconds is refused before anything is read
(`input`).

| Bound | Default | Covers |
| --- | --- | --- |
| `ADDRESS_SETTLE_MS` | 1_000 | how long the address must hold still (`settleMs`) |
| `ADDRESS_POLL_MS` | 100 | how often it is read (`pollMs`) |
| `ADDRESS_BOUND_MS` | 15_000 | how long it has to hold still at all (`bound`) |

Refusal kinds: `input` and `unsteady`.

<!-- pressByTestId and readTitle: an element without a role pressed by its test id and its text, and the page's title. -->

## `pressByTestId(page, { testId, text, record, within?, bounds? })`

Presses the one shown element that carries the test id `testId` (in
`data-testid`, `TEST_ID_ATTRIBUTE`, the attribute the product's browser tests
read) and whose own text is `text`, for an element the product draws to be
pressed without a role, such as a row of the type picker in the upload dialog: a
list item with a click handler and a test id. `press` finds a control by its
role and its name, so it has nothing to name there.

- **Its own text.** The text the element draws: its text nodes, without a hidden
  part, a script or a style, each run of white space made one space and trimmed,
  and compared whole with `text`, folded the same way. A text that holds `text`
  as a part is no match. Only a shown element counts: drawn, and inside nothing
  hidden.
- **Never a guess.** It presses only when exactly one element matches. No match
  is refused (`no-control`), naming how many shown elements carry the test id
  and their texts, at most `CONTROL_NAMES_LISTED` of them, each cut as a name
  is; several are refused (`ambiguous`), naming the part of the page each sits
  in. With `within`, it looks only inside the one shown part of the page of that
  name, found as `press` finds it.
- **The accessible road first.** An element that carries a role `press` presses
  (its own, or one its tag gives it) and an accessible name is `press`'s: the
  step refuses it (`has-role`), naming the role and the name, and presses
  nothing.
- **The fault said.** Before the press it writes one line: the page's path, the
  test id, the text, and that the element carries no role and was found by its
  test id, such as `pressByTestId: on /artifacts, the element of the test id
  "artifacts-picker-type" with the text "Note pack:note Pack" carries no role;
  it was found by its test id`. A person who uses the keyboard or a screen
  reader finds such an element by no name, and every record of a run that needs
  the step says so.

It reads the page's next settled state with the reading `press` uses
(press-settle.mjs), within the same bounds (`PRESS_BY_TEST_ID_BOUNDS`, the
bounds of `press`), and answers the fields `press` answers, with the test id:
`{ name, role, testId, from, path, navigated, elapsedMs }`, where `name` is the
text and `role` is empty for an element without one.

| Bound | Default | Covers |
| --- | --- | --- |
| `CONTROL_ACTION_BOUND_MS` | 10_000 | the press (`actionMs`) |
| `PRESS_START_BOUND_MS` | 2_000 | from the press to the start of a navigation (`startMs`) |
| `PRESS_SETTLE_BOUND_MS` | 60_000 | from the press to the landing of that navigation (`settleMs`) |
| `CONTROL_POLL_MS` | 100 | how often the page is read while the step waits (`pollMs`) |

Refusal kinds: `input` (the page was not touched), `unreadable`, `no-scope`,
`no-control`, `ambiguous` and `has-role` (nothing was pressed),
`driver-failure` and `unsettled`.

## `readTitle(page, { record, settleMs?, pollMs?, bound? })`

Reads the document's title through the browser's own reading of it
(`document.title`), never by a selector: a count with a selector on the head's
title element reads 0, since the engine that reads text reads only what the page
draws. As `readCount` does for a count, it answers only once two readings that
lie `settleMs` apart are equal and every reading between them agreed, so a title
the page sets a moment after it loads is never read as the one before; a
reading that could not be taken agrees with nothing. It answers
`{ title, path }` and writes one line that names the page by its path and
carries the title, cut as a name is, such as
`readTitle: the title of the page on /agents reads "Agents"`. An empty title is
a title: it is answered as the empty string, and the line says the page has an
empty title. A title that never holds still within `bound` is refused
(`unsteady`), naming the last two titles it read. An unknown option, or a bound
that is not a positive number of milliseconds, is refused before anything is
read (`input`).

| Bound | Default | Covers |
| --- | --- | --- |
| `TITLE_SETTLE_MS` | 1_000 | how long the title must hold still (`settleMs`) |
| `TITLE_POLL_MS` | 100 | how often it is read (`pollMs`) |
| `TITLE_BOUND_MS` | 15_000 | how long it has to hold still at all (`bound`) |

## `openPageInOwnContext(page, { path, record, bounds? })`

Opens `path` in a page of a browser context of its own, for a state that needs
two people at once, such as one person on a run's pending gate while another
settles it. A run page holds several requests open on its origin, and over
plain HTTP a browser opens at most six connections to one origin in one
context, so a further page in the same context (`navigateTo` with
`furtherPage`) can starve the first page's own send. A second context has
connections of its own.

1. Refuses, before the page is touched, a path that is no page path or carries
   a query string or a fragment, the sign-in page (`SIGN_IN_PAGE_PATH`, which
   is `signInThroughPage`'s), and an unknown or non-positive bound.
2. Reads the visible links on the current page that lead to `path`, as
   `navigateTo` reads them. With none, it opens nothing and refuses, naming how
   many visible links the page shows: it opens only what a person could open
   from there, and never invents an address.
3. Opens a new context on the page's browser from the storage state of the
   page's context (its cookies and its storage) and the page's viewport. The
   state goes from one call straight into the other: it is never written to a
   file, recorded or logged. No sign-in is made, so the sign-in budget is not
   touched, and no credential is typed.
4. Starts the reading of standing requests (`readStandingRequests`) on the new
   context before its page opens, so that page is never unknown to it.
5. Loads the address the first such link leads to (its query string included)
   in a new page of that context, and waits for the landing as `navigateTo`
   does. A landing on the sign-in page (`session-lost`), or on another path
   within the bound (`landed-elsewhere`), is refused, and the new context is
   closed first.

It answers `{ path, from, elapsedMs, furtherPage, standing }`: the landed path,
the path it came from, the elapsed time, the page it opened, and the new
context's own reading of standing requests. Its line names the two paths and
says that the page stands in a browser context of its own; it never carries a
cookie, a storage value, an address or a query string. The caller closes
`furtherPage.context()` when it is done with it.

| Bound | Default | Covers |
| --- | --- | --- |
| `OWN_CONTEXT_LANDING_BOUND_MS` | 120_000 | from opening the new context to the landing of its page (`landingMs`) |
| `READING_BOUND_MS` | 5_000 | the reading of the link, and of the standing requests (`readingMs`) |

Refusal kinds: `input` (the page was not touched), `unreadable`, `no-link` and
`no-browser` (no context was opened), `driver-failure`, and `session-lost` and
`landed-elsewhere` (the new context was closed).

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
  over the same fixture pages, which keeps the double honest. In the checks, the
  job **Step tests in a real browser** runs them with the switch set for every
  pull request that changes a file here other than Markdown: first on the page
  double, then with the switch. Both runs receive `E2E_STEPS_UNIT_DATABASE_URL`
  from a job-scoped PostgreSQL service at its mapped host port, so the real
  `readRows` database cases run too. It fails unless every case passed, so in that
  job a browser that cannot be launched is a failure, not a skip, and the
  required `build` check fails with it. Any other pull request skips the job;
  the selection line of **Detect CI impact (build-image)** names the reason.
- **The live smoke**, one per step, against a running development server:
  `pnpm exec playwright test -c tests/e2e/config/steps.config.ts`. Without a
  browser or a server every test is skipped, and its reason names what is missing.
  `E2E_STEPS_ISLAND_PATH` and `E2E_STEPS_RUN_PATH` name a page with a review island
  and a run page for the two watching smokes.
