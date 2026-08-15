# Visual proof — #2698 (install-semantics S4): lifecycle operations target the full row identity

Real app, real dev server, real browser sessions, on a lane host. No mockup.

## The one user-visible change

A package can be installed for the whole workspace. That install writes ONE
canonical row with an app-wide anchor: `owner_level='workspace'`,
`organization_id` NULL, `owner_id='__platform__'`.

Before this slice the lifecycle resolver matched a row on organization equality
only. A platform administrator almost always has an active organization, so that
administrator matched no row. The extension settings page (design §V) therefore
greyed out Archive, Activate and Reinstall on the app-wide row, and gave this
reason:

> Installed for the whole platform. Only a platform administrator with no active
> organization can act on it.

After this slice the resolver also gives a platform administrator the org-NULL
rows when the administrator's own organization holds none. The same
administrator, in the same session, now gets live Archive, Activate and
Reinstall on the same row. The refusal copy also drops the "with no active
organization" clause; it now reads:

> Installed for the whole platform. Only a platform administrator can act on it.

## What was captured

| File | What it shows |
|---|---|
| `before-a-platform-admin-active-org.png` | BASE (the branch's base commit). The platform administrator, with an active organization, on the settings page of the workspace-anchored connector. Whole page. |
| `before-a-platform-admin-active-org-maintenance.png` | BASE. The §V Maintenance section. Archive and Activate are grey. Each carries the old reason with the "with no active organization" clause. |
| `before-a-platform-admin-active-org-danger-zone.png` | BASE. The §V Danger zone. Reinstall latest is grey with the same old reason. Force-delete stays live (it is platform-admin-only and row-independent). |
| `before-b-org-admin.png` | BASE. The organization administrator, who is not a platform administrator, opens the same address. The page's own gate sends this account to `/not-authorized`. |
| `after-a-platform-admin-active-org.png` | BRANCH. The same administrator, the same session shape, the same row. Whole page. |
| `after-a-platform-admin-active-org-maintenance.png` | BRANCH. The §V Maintenance section. Archive is LIVE. No refusal copy is left on the page. Activate reads "Already active", which is the row's status, not a refusal. |
| `after-a-platform-admin-active-org-danger-zone.png` | BRANCH. The §V Danger zone. Reinstall latest is LIVE. |
| `after-c-platform-admin-archived-row.png` | BRANCH. The page after the live Archive button ran. Whole page. |
| `after-c-platform-admin-archived-row-maintenance.png` | BRANCH. With the row archived, Activate (restore) is LIVE for the same administrator. |
| `after-c-platform-admin-archived-row-danger-zone.png` | BRANCH. The Danger zone of the archived row. |
| `after-b-org-admin.png` | BRANCH. The organization administrator, same address, same result as the base: `/not-authorized`. This slice does not change that. |
| `results-before.json` | Every assertion of the base pass: the row identity, the two actors, and each affordance with its enabled state and its exact reason text. |
| `results-after.json` | The same assertions on the branch, plus the archive and restore round trip with the row read back from the store each time. |
| `lifecycle-log-excerpt.txt` | The dev server's own lines for the archive and the restore of the workspace-anchored row. |
| `proof-2698-capture.mjs` | The capture script. It reads every account value from the environment, so it holds no credential. |

## The row under test

One canonical row, and it is the only row the package carries:

```
id              iext_1964ffd4-cea
package_name    @cinatra-ai/youtube-connector
kind            connector
owner_level     workspace
owner_id        __platform__
organization_id NULL
status          active
is_default      true
version         0.1.4
```

The row was made workspace-anchored by a direct write to the store, in the exact
shape the platform invariant permits and the canonical store writes for a
"Workspace: All" install: `owner_level='workspace'`, `organization_id` NULL,
`owner_id='__platform__'`, `is_default` true, status active. The shipped install
path was not used, because reaching it needs a marketplace install and a lane
host holds no credential.

Everything else came from the app itself: the instance namespace was provisioned
through the setup wizard, and the archive and the restore were run by clicking
the page's own buttons.

## The two actors

| Account | Platform role | Organization role | Active organization in session |
|---|---|---|---|
| platform administrator | `admin` | owner | yes |
| organization administrator | `user` | admin | yes |

## The round trip

The live Archive button was clicked. The store then held the same row, archived,
with its anchor tuple unchanged. The page then offered a live Activate. That
button was clicked. The store held the row active again, still workspace-
anchored. So the operation kept the row's own anchor; it did not move the row to
the actor's organization.

The dev server reports one dev-only caveat on the restore: the package was
re-activated in the store but was not re-registered in the running process,
because its source is a local development checkout rather than the registry. The
row is active; the code path that re-registers needs a registry source.

## Two honest limits

1. The new refusal copy is not reachable on this page today. Only an actor who
   is refused sees it, and the only such actor is a non-platform-administrator
   with an active organization. That actor never reaches the page: the page
   calls the platform-admin gate first and redirects to `/not-authorized`. The
   `before-b-org-admin.png` and `after-b-org-admin.png` captures record exactly
   that. The copy change itself is pinned by the package's unit tests.
2. Force-delete is live for a platform administrator in both passes. It is
   platform-admin-only by rule and does not resolve a row, so this slice does
   not change it.
