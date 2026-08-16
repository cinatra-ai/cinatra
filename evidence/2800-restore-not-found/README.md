# cinatra#2800 — the restore page tells "gone" apart from "not yours"

Captured on a lane host: the real dev app, a real platform-admin session in a
real organization, headless Chromium at 1440x900. Every page load waited for
`domcontentloaded` and then for the rendered `main`, so each shot is a complete
render, not a skeleton. No console errors in either capture (see
`results.json`).

## What was captured

| File | The state | What the page says |
|---|---|---|
| `a-not-found.png` | **NEW** — a change set that is not there (`/configuration/artifacts/restore/no-such-change-set`) | "This change set does not exist or can no longer be restored" · "The link may be out of date." · Back to Restore objects |
| `b-confirmation.png` | Authorized — a real, restorable change set | "You are authorized to restore every affected object.", the change-set row, and the restore modal |

`a-not-found.png` is the fix. Before it, that same URL rendered the
authorization panel — "You're not authorized to restore this change" — to an
administrator who was, in fact, authorized. The panel now carries its own test
id (`artifacts-restore-route-missing`), distinct from the authorization panel's
`artifacts-restore-route-denied`.

The change set behind `b-confirmation.png` was made by the shipped writers
through the in-process lifecycle seed (`restorableChangeSet`), armed for this
capture only with a freshly minted per-launch token that was destroyed
afterwards. The seed names a subject — an org, an actor and a run — so the
capture inserted one `cinatra.agent_runs` row (with the `agent_templates` row
its foreign key requires) for that subject before seeding.

## The third state, and why there is no shot of it

The authorization panel (an existing change set the actor may not fully
reverse) is **not** in this set. The cheap way to reach it — a change set made
by another member of the same organization — does not deny an organization
owner, who holds restore authority over that object; the page correctly showed
the confirmation instead, and a confirmation filed under a denial's name would
be worse than no shot at all. The attempt and its outcome are recorded in
`results.json` under `unauthorizedCaseNotCaptured`.

That state is covered by the route test instead:
`src/app/configuration/artifacts/restore/[changeSetId]/__tests__/restore-route-states.test.tsx`
renders all three answers the eligibility gate can give and asserts that each
one gets its own screen, its own test id and its own words.

## Files

- `a-not-found.png` — the new not-found state
- `b-confirmation.png` — the authorized confirmation
- `results.json` — URLs, HTTP status, page title, the test ids found in the DOM,
  the panel's rendered text, and console errors for each capture
