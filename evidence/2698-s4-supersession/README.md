# Visual proof — #2698 (install-semantics S4): a workspace install supersedes organization rows

Real app, real dev server, real browser sessions, on a lane host. No mockup.

## The rule under proof

Owner ruling 2026-08-16. A "Workspace: All" install writes ONE canonical row
with an app-wide anchor — `owner_level='workspace'`, `organization_id` NULL,
`owner_id='__platform__'` — that reaches every organization. An
organization-anchored row of the same package beside it is redundant, so the
workspace install supersedes it: the organization row is archived in place, and
while the workspace row lives it is the package's EFFECTIVE row for every
screen, every lifecycle operation and every resolution seam.

Four consequences are visible in the app, and all four are captured here:

1. One card per extension. The installed list shows the effective row; the
   superseded organization row contributes nothing to it.
2. The settings page (design §V) acts on the effective row. A platform
   administrator whose session carries an active organization gets live Archive
   and Reinstall on it, with no refusal copy anywhere on the page.
3. The marketplace states the reach the install was made at, on the card's
   existing disabled pill — "Installed (Workspace: All)" — and offers no install
   action, because the server install boundary would refuse one.
4. Removing the workspace install revives nothing: the superseded organization
   row stays archived and is visible, and restorable, under the Archived filter.

## What was captured

| File | What it shows |
|---|---|
| `a-installed-list-one-card.png` | The installed list, Active filter, as a platform administrator. Exactly ONE card for the package (`youtubeConnectorCardCount: 1` of 78 cards). |
| `b-settings-platform-admin-active-org.png` | Design §V for the same administrator, whose session carries an active organization, on the effective workspace row. Archive is LIVE, Reinstall latest is LIVE, and `reasonsOnPage` is empty — no refusal copy at all. |
| `c-marketplace-installed-workspace-all.png` | The marketplace card for the same package. The disabled pill reads "Installed (Workspace: All)". No install, update or restore action is offered on that card. |
| `d-archived-organization-row.png` | The installed list, Archived filter. The superseded ORGANIZATION row is there — the only archived card — visible and restorable to an authorized administrator. |
| `e-marketplace-org-admin-gated.png` | The SAME marketplace address opened by an organization administrator who is not a platform administrator. See the note below. |
| `results.json` | Every assertion: the two canonical rows read straight from the store, the retained access policies, each page's HTTP status and final path, each affordance with its enabled state and its exact reason text, and the marketplace card's resolved CTA. |
| `proof-2698rw.mjs` | The capture script. Every account value comes from the environment, so it holds no credential. |

## The two rows under test

```
id              iext_1964ffd4-cea          iext_f853560c-137
package_name    @cinatra-ai/youtube-connector
kind            connector
owner_level     workspace                  organization
owner_id        __platform__               <the organization id>
organization_id NULL                       <the organization id>
status          active                     archived        <- superseded, in place
version         0.1.4                      0.1.4
```

Both rows keep their own `extension_access_policy` row, read back in
`results.json` under `retainedPolicies`. That is the point of archiving in
place: the superseded row keeps its id, and everything keyed on that id —
permissions, co-owners, dependency provenance, settings, secrets, connections,
claims — survives untouched. None of the uninstall or data-teardown hooks run.

## How the state was produced, exactly

The captures above are the running application rendering real store rows. The
rows themselves were seeded on this lane rather than produced by clicking
through an install, and it is worth being precise about why and about what that
does and does not prove.

- The workspace-anchored row already existed on this lane from the previous S4
  pass. The organization row was written in the exact canonical writer shape
  (its columns copied from the workspace row and re-anchored) at the archived
  status that supersession produces, together with its own access-policy row.
- The supersession TRANSITION itself — that the organization row is archived in
  place, that only `status` moves, that every other column, its dependency
  edges and its access policy are byte-identical afterwards, that a mid-way
  failure compensates cleanly, and that removing the workspace install revives
  nothing — is proven separately against a real Postgres by the
  install-semantics database tier, which drives the shipped lifecycle primitive
  and the shipped addressing rule.
- The marketplace card could not be driven through an install click on this
  lane: the card offers an install action only for a package that is not
  installed, so a package that already carries an organization row has no
  in-app affordance for widening it to "Workspace: All". That is an epic-level
  gap in the install flow, not a defect in this slice, and it is reported to the
  owner rather than worked around here.

## Note on capture (e)

The slice text says an organization administrator sees the card read "Installed
(Workspace: All)" with no install action. On this branch that administrator
never reaches the card: the whole `/configuration` area became
platform-admin-only in a separate, already-merged slice, so the address answers
`/not-authorized`. The card state itself is proven by capture (c) and by unit
fixtures that resolve the same CTA for a non-platform-admin viewer. The conflict
between the two slices is reported to the owner, not resolved here.
