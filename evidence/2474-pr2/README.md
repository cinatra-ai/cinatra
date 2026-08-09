# cinatra#2474 PR2 — live conformance proof (folded #1897 collection + route deletion)

Agent-run render check against a **real running dev server** on this branch's code,
with **real authenticated sessions** — not a fixture route, not a stub.

| | |
|---|---|
| Design-spec pin | `specs/app-artifacts.html` **§IX** @ `design@60cf789ec9b6d6455148a086cacc6ae43f447cef` (current tip of the file; the same revision PR1/#2547 pinned) |
| Result | **35 PASS · 0 FAIL** · 0 console errors · 0 page errors |
| Captures | 11 full-page PNGs (1440×900 desktop, 390×844 narrow, light + dark) |
| Probe record | `probe-results.json` — every assertion with its raw DOM/geometry evidence |
| Battery source | `battery.mjs` — the script that produced both (re-runnable) |

## What it proves

- **The fold.** The #1897 scope collection renders on the org / team / project
  **landing**, below the per-user shell, with the shell and its non-removable
  **Overview** untouched (DOM-order assert, not a text guess).
- **§IX row anatomy.** Glyph + name + updated-time + Open on every row; **no**
  Home/Listed badge, **no** per-row type label; **Remove appears only on the
  removable secondary listing**, never on a homed row.
- **Open goes to the canonical surface** — `/<scope>/<id>/dashboards/<dashboardId>`,
  the nested route this PR deliberately did **not** delete (it still serves 200).
- **The deletion.** All three `/<scope>/<id>/dashboards` collection routes return
  **404 to an authenticated actor** — a deletion, not a redirect.
- **§IX.2 permission axis**, on a **real second member's session** (org `member`,
  team `member`, project `read`): the collection and every row still render, with
  Add and Remove **suppressed — not disabled** (zero disabled controls).
- **§IX.1** the add-to-scope picker still opens from the folded panel.
- **§X axes** — dark theme, and at 390px the Add affordance **drops beneath** the
  panel heading with no horizontal overflow (**geometry probed**, not eyeballed).
- The **#2547 placement observation** is answered: the duplicate page-level scope
  lede is gone — it is now the panel's `<h2>`, below the tablist.

## How it ran

Fresh worktree; extensions materialised at their committed lock SHAs; isolated
lane schema on the local verify Postgres; dev server on a dedicated lane port.
`/api/health` returned `200 readiness:ready` before any capture. Fixtures (one
org, one team, one project, a bootstrap admin and a second plain member) were
created through the app's own auth endpoints plus direct SQL. Assertions are live
DOM + computed-style + geometry probes with explicit selector waits — never
`networkidle`, never a snapshot diff. No provider credential or secret was used;
the fixture identities are local throwaways on a disposable database.
