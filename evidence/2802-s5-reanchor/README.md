# §V re-anchor — real-app evidence (cinatra#2802)

Captured on a lane host against a real Cinatra dev instance: a real platform-admin
session, a real Postgres, the shipped settings page and the shipped server action.
No mockups, no stubs. Viewport 1440x900; every page was loaded with
`domcontentloaded` + an explicit selector wait (never `networkidle`, which never
fires under the dev server's HMR socket).

Package under test: `@cinatra-ai/audio-artifact` (artifact kind).

## Fixture, stated plainly

On a fresh instance every bundled package is already installed at the **platform**
tier, so the marketplace offers no organization install to run. The organization
install row — and a second organization holding an **archived** row of the same
package — were therefore seeded directly in the canonical writer shape (the same
columns the canonical insert writes). Everything after that is the shipped path:
the real §V picker, the real save action, the real primitive, the real database.

## What each screenshot shows

| File | What it shows |
| --- | --- |
| `a1-picker-workspace-all.png` | The §V picker open on the settings page, with "Workspace: All" about to be chosen by the platform admin. The drawing is unchanged — the same rows, the same copy. |
| `a2-saved-status-line.png` | The picker reading "Workspace: All" and the saved status line, "Access saved." |
| `b1-installed-card.png` | The installed extension list after the widening. |
| `b2-marketplace-pill.png` | The marketplace card's disabled installed pill after the widening — it reads **"Installed (Workspace: All)"**. |
| `c1-archived-superseded-row.png` | The installed list with the Archived filter selected after the widening. |
| `d1-narrowed-state.png` | The same picker after narrowing the workspace-anchored row back to a conflict-free organization: "Organization: Default" with "Access saved." |
| `e1-anchor-conflict-error.png` | The existing generic error state — "Could not save access. Try again." — after a re-anchor into an organization that already holds an **archived** row of the package. No special copy; the typed refusal rides the error state the design already specifies. |

## What the database says

- After the widening: the **same install row id**, moved to
  `owner_level=workspace`, `organization_id NULL`, `owner_id=__platform__`, with
  `["workspace"]` on all three visibility fields — and the second organization's
  **active** row archived in place by the same transaction.
- After the narrowing: the same id again, back at
  `owner_level=organization` with the destination organization, carrying
  `["org:<destination>"]`. Archived rows stay archived — nothing revives by itself.
- After the refused save: nothing changed at all.

## Two honest divergences

1. **The superseded row is not listed under Archived while the workspace row is
   live.** That is the S4 rule already in the code — an organization row of a
   package that has a live workspace row is filtered out of the card model and
   becomes addressable again once the workspace install is gone. So `c1` shows the
   Archived filter after the widening, and the supersession itself is proven at the
   database layer above and by the real-Postgres fixtures in the test tier.
2. **The active installed list draws no card for this package on this instance.**
   Its artifact descriptor comes from the platform-tier row, which the fixture
   archived so the settings page would resolve the organization row without
   ambiguity. The marketplace card carries the reach statement the issue names, and
   it reads exactly "Installed (Workspace: All)".

Zero console errors were recorded during the capture (`results.json`).
