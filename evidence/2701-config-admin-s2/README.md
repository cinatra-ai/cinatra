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
- `member-d-restore-surface.png` / `admin-d-restore-surface.png` — the restore
  destination: the member lands on Not authorized, the admin on "Restore this
  change?".
- `undo-candidate-gate.txt` — the undo chip's own gate probed live for both
  roles; both answer no candidate on this instance (a positive admin answer
  needs a real agent run), so the admin-positive branch is covered by fixture.
