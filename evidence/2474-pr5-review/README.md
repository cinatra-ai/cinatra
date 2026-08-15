# cinatra#2474 PR5 — the owner's review changes (PR #2638)

Two changes were requested on this PR, verbatim:

> Remove the three dots inside the toolbar that show up in some of the screenshots.

> Don't show the empty cards below the textfield at "Reference an existing
> dashboard" - only show actually selected dashboards.

Both are applied. This folder holds the re-capture of **only the cells the two
changes alter**; everything else in `evidence/2474-pr5/` still describes the
product correctly and is unchanged.

## Where these behaviours came from

Neither is a PR5 regression. Recorded plainly so the record is not flattering:

| Change | Introduced by | Fixed here because |
|---|---|---|
| The toolbar's three-dot overflow (the per-dashboard Rename / Delete menu) | `778892417` — the reusable entity Dashboards-tab shell, cinatra#701 | it is a review-requested change on this PR |
| The placeholder cards under the search field (two loading skeletons + a dashed empty panel) | `acd59b772` — #2474 PR3 (#2600); the shape traces further back to #1897 B4's standalone `<AddToScopePicker>` | same |

## What the first change strands

**Rename and Delete for an entity dashboard now have no user-reachable entry
point.** That menu was the only one. The owner's instruction is unconditional, so
the control is gone and the loss is recorded rather than argued with.

Nothing underneath was removed: `EntityDashboardsContext.onRename` / `.onDelete`
are still wired by `entity-dashboards-shell.tsx` to the real server actions, those
actions still authorize and still work, and their behaviour is still covered by
tests. Re-surfacing them later is a render change in
`entity-dashboard-toolbar-controls.tsx` alone.

## The re-capture

Host2 (`<lane-host>`), real dev server, the **same** PR5 fixture database
as the original walk (same organization, same `PR5 Walk Team`, same `pr5mgr` /
`pr5member` rows), signed in as `pr5mgr` through the real sign-in endpoint. No
credential or secret was placed on that host. Viewport 1440x900.

| # | Capture | What it shows |
|---|---|---|
| 12 | `12-personal-toolbar-no-overflow.png` | `/personal` with the writable non-default `Dashboard dashboard` selected — the exact state that raised the three dots in `02-personal-after-add.png`. Toolbar: `Dashboard dashboard` · `New dashboard` · `Edit dashboard`. |
| 13 | `13-team-toolbar-no-overflow.png` | The team page, same selection — the frame of `06-team-manager-after-add.png`. Toolbar: `Dashboard dashboard` · `Add dashboard` · `Edit dashboard`. |
| 14 | `14-toolbar-before-after.png` | The two toolbars side by side, with the removed control ringed in the BEFORE frame. |
| 15 | `15-reference-loading-no-cards.png` | The popup with the candidate pool still loading — where the two grey cards sat in `05-team-manager-popup.png`. The search field, and **nothing** below it. |
| 16 | `16-reference-six-real-rows.png` | The same popup once the pool resolves: **six real candidate rows**, each a dashboard with its own disposition. Only actual dashboards. |
| 17 | `17-reference-no-match-no-cards.png` | The search narrowed to a string nothing matches: the column empties instead of showing a "nothing here" panel. |
| 18 | `18-reference-before-after.png` | Before / after / populated, stacked. |

### The DOM, read at each of those frames

`facts.json` is the machine-read output of the capture run. In summary:

| Frame | `data-state` | elements below the search field | candidate rows | skeletons | dashed panels |
|---|---|---|---|---|---|
| 15 — loading | `loading` (`aria-busy="true"`) | **0** | 0 | 0 | 0 |
| 16 — populated | *(absent)* | 1 (the `<ul>`) | **6** | 0 | 0 |
| 17 — no match | `empty` | **0** | 0 | 0 | 0 |

And for both toolbars (12 and 13): **3** buttons, **0** wordless buttons, **0**
buttons named `Manage …`, **0** ellipsis glyphs.

## Honest notes

- **`facts.json` and the images come from the same run**, at head
  `573a538fa2bda09bf441d99b421303ac5ac9a4cd`.
- **The loading frame (15) is held open deliberately.** The candidate-pool server
  action is delayed by the capture harness so the loading state is a stable frame
  instead of a race. That is a timing device only — the rendered markup is the
  product's own.
- **A load FAILURE still draws.** It prints one line of text ("Couldn't load your
  dashboards"), not a card. Suppressing it would turn "we could not read your
  dashboards" into "you have none", which is a different and false statement. That
  is a deliberate reading of the instruction, not an oversight.
- **§IX.1's closed data-state set moved, it did not go.** `empty` · `error` ·
  `loading` used to ride the three removed panels; they now ride one `data-state`
  on the section root, absent when populated. The table above is that attribute
  read off the real render.
- **The walk users' passwords were reset** to a local value so this capture could
  sign in through the real endpoint (the original walk did not record them). Local
  dev database, credential-free host, disposable data.
- **Cells not re-taken:** everything in `evidence/2474-pr5/` that neither change
  touches — the add outcomes, the name-collision refusal, the currentness refusal,
  the 390px cell. Their originals still describe the product. The two frames that
  are now superseded in the detail these changes alter are `02` / `06` (the
  toolbar) and `05` (the placeholder cards); 12–18 are their replacements.
- The dark pill in the bottom-right of some frames is the Next dev-server compile
  indicator, not product UI.
