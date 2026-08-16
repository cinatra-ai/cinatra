# cinatra#2701 — member surfaces stop offering /configuration links: visual proof

Real app on a lane host's dev server, 1440×900, a real member session
(`role=user`) and a real admin session (`role=admin`), Playwright with
`domcontentloaded` + `waitForSelector`. `results.json` records surface →
assertion for every row.

- `member-a-command-menu.png` / `admin-a-command-menu.png` — the command
  palette open: the member sees the Navigate and Theme groups only (zero
  /configuration destinations); the admin additionally sees the Configuration
  group with all seven entries.
- `member-b-development-toolbar.png` / `admin-b-development-toolbar.png` — the
  development toolbar renders for both; the member's carries no
  /configuration/development link, the admin's carries it.
- `member-c-notifications-feed.png` / `admin-c-notifications-feed.png` — a
  pre-existing "Agent proposal approved" notification row (seeded with the
  writer's own column list, so it is indistinguishable from a row written before
  this change): the member's row renders without a link, the admin's with it.

## (d) the restore surfaces, on a REAL change set

The first pass photographed a change-set id that did not exist, so the admin's
restore page rendered its per-object denial panel and read as "admins cannot
restore" — the opposite of what this slice does. That pair is replaced. This
pass writes REAL change sets first.

**How the change sets were made.** The repo's own in-process seed path,
`POST /api/development/lifecycle-seed` with fixture `restorableChangeSet`
(`src/app/api/development/lifecycle-seed/route.ts` →
`src/lib/test-support/lifecycle-seed-drivers.ts`). That driver holds no SQL: it
calls `openChangeSet` → `historyAwareUpsert` → `closeChangeSet` — the shipped
writers — and reads the set back through the same loader the eligibility gate
uses. One set is written for the admin, one for the member; each closes over one
real `object_change_event` and each is `restorable`. The one thing the driver
refuses to invent is the agent run its subject names, so two `cinatra.agent_runs`
rows were inserted for it; `results.json` says so.

- `admin-d-restore-console.png` — the admin on the Restore objects console: five
  real change sets, each carrying its **Restore** affordance.
- `admin-d-restore-confirmation.png` —
  `/configuration/artifacts/restore/<real change set id>` for the admin: the real
  "Restore this change?" confirmation, "You are authorized to restore every
  affected object.", the diff preview, and a live **Confirm restore**.
- `member-d-restore-console.png` / `member-d-restore-confirmation.png` — the same
  two URLs as the member: **Not authorized** both times. The member reaches no
  restore affordance at all, because the whole /configuration segment is
  admin-only (S1, #2700) — which is exactly why S2 withholds the member-facing
  affordances that used to point here.
- `admin-d-restore-applied.png` — the admin confirms: "Restored 1 event. New
  change-set: …". The object reverts (the row is tombstoned at version 2) and the
  original change set is preserved.
- `undo-candidate-gate.txt` — the chat "Undo last action" chip's own gate, live.
  Both roles ask about their own run and **both runs really did leave a
  restorable change set**, so the answers are not ambiguous any more: the admin
  gets the change-set id (the chip renders), the member gets `null` (the chip is
  withheld).

Where the affordance lives: the per-object `ObjectHistoryPanel` — the component
this slice gates — has no mount site in the shipped app; it is defined and pinned
by fixture only. The restore affordance a person actually reaches is the Artifacts
console tab and the targeted-restore route above, so those are what is
photographed.

**Follow-up, not part of this slice's claim.** On the targeted-restore route a
change set that does not exist renders the authorization-shaped denial
"You're not authorized to restore this change" — an admin reading it concludes
they lack the right. The state deserves its own "no such change set" copy.
Location: `src/app/configuration/artifacts/restore/[changeSetId]/page.tsx`, the
local `RestoreNotAuthorized()` component (`data-testid`
`artifacts-restore-route-denied`), reached whenever
`loadAuthorizedTargetedRestore()` (`src/lib/object-history/restore-eligibility.ts`)
returns null — which it also does for a missing id. No code was changed here.
