# appt-split S4 — CLOSURE re-verification (cinatra#2370)

Second pass over the S4 acceptance list. The first pass is on branch
`appt-split-s4-evidence` (`evidence/2370-s4-e2e/checklist.md`); every row below
carries its PRIOR status so the delta is readable without opening that file.

Epic: cinatra#2367. Sub-issues: S1 #2368, S2 google-calendar-connector#55/#56,
S3 #2369, S4 #2370.

## What changed since the first pass

1. `@cinatra-ai/google-appointment-schedules-connector` **0.1.1** is published and
   promoted (`dist-tag latest`), built by the fixed publish pipeline
   (cinatra#2747 / #2751 — inline publishes prune and validate runtime deps on
   every emit path), and it carries the banner vocabulary (connector repo #8).
2. cinatra main carries `a6d54099f` — the #2752 error-toast fail-safe (#2756).
3. cinatra main carries `9d728817c` — #2751, the host-side install integrity fix.

## Run record

| Item | Value |
|---|---|
| Build sha | `59d3164086a60f83bd6d81dbd5b3d4b6cf7bb94d` (origin/main at fetch time; `a6d54099f` and `9d728817c` are both ancestors — verified with `git merge-base --is-ancestor`) |
| Prior run's sha | `82298994eebb81faf4d6bba231f48cbc46eba9fd` |
| Next BUILD_ID | `vu4XdHaOOtpvSAnRO31ly` |
| Build class | production-equivalent — `CI=true pnpm build` (Next 16.2.10) then `pnpm start` (`next start`). No dev server. |
| Build result | exit 0, `.next` written 09:18 CEST; boot readiness `ready` on every start |
| Host | a lane host (macOS, x86_64, 16 GB), no credentials placed on it |
| Checkout | `<lane-checkout>/s3-2722`, detached at origin/main |
| Extension closure | `scripts/ci/sync-dev-extensions.mjs --pinned` → 112/112 at the committed lock shas |
| Static-bundle appointment connector | dev lock `00d15367805e` = **0.1.0** (already carries the banner vocabulary; 0.1.1 is that same tree plus the version bump and the release-workflow pin) |
| Static-bundle calendar connector | `55723f958111` = 0.1.3 (post-S2 extraction) |
| Published appointment connector | **0.1.1**, storefront `freshness_at` 2026-08-15T07:05:22Z |
| App URL | http://localhost:3001 |
| Account | first-account bootstrap through `POST /api/auth/sign-up/email` → platform admin, org `appt-s4-org` |
| Browser | Playwright-launched Chromium, viewport 1440x1200 |
| Infra reused | the already-running `base-cinatra` compose stack (postgres 127.0.0.1:5434, redis, nango). No container was created, destroyed or reconfigured by this lane. App DB is `cinatra_2722`. |

### Env toggles used (all recorded)

| Toggle | Value | Why |
|---|---|---|
| `PORT` | `3001` | lane port, already set in this checkout's `.env.local` |
| `BETTER_AUTH_URL` | `http://localhost:3001` | **new this run.** `.env.local` ships `http://localhost:3000`; at this sha Better Auth rejects the lane origin (`ERROR [Better Auth]: Invalid origin: http://localhost:3001`) and every sign-in 403s. Setting it to the port actually served fixes it. |
| `CINATRA_E2E_SETUP_BYPASS` | `true` | documented browser-e2e switch (the wizard's Model step needs an LLM key this lane has none of) |
| `CINATRA_EXTENSION_DATA_ROOT` | `<checkout>/data/extensions` | the prior run's D-5: a host `next start` has no `/data`, so every install dies at `mkdir '/data'` |
| `CINATRA_GATEKEPT_INSTALL` | `true` | **new this run, and load-bearing — see item 1c.** With the flag OFF the install read goes straight to `registry.cinatra.ai` and 401s (`Unable to authenticate, need: Basic, Bearer`) because this lane holds no registry token. With it ON the read routes through the marketplace broker on the instance's existing consumer attachment and succeeds. No credential was added to a lane host to make this work. |
| `BULLMQ_QUEUE_NAME` | `appt-s4c-lane` | lane-scoped queue |
| `NODE_OPTIONS` | `--max-old-space-size=4096` | memory rail on a 16 GB shared host |
| node / pnpm | v24.19.0 / 11.1.2 | host toolchain |

No outward action was taken: nothing published, tagged, released or deployed.

## Item-by-item status (prior → now)

Legend: PASS = machine-proved on this build · FAIL = defect proved ·
NEEDS-LIVE-ACCOUNT = needs a real connected Google account ·
NEEDS-NON-BUNDLING-IMAGE = needs an image that does not ship the dependency ·
BLOCKED = a precondition outside this lane prevents the proof.

### 1. Closure / auto-install UX

| # | Sub-item | Prior | Now | Evidence |
|---|---|---|---|---|
| 1a | Catalog carries the connector; gatekept catalog read is live | PASS | **PASS** | F01, F02 — grid card + detail page render, detail states **Version 0.1.1** |
| 1b | The listing declares the required runtime dependency | PASS | **PASS** | F02 — "Requires @cinatra-ai/google-calendar-connector (a required runtime dependency)…"; the storefront JSON declares `dependencies: ["@cinatra-ai/google-calendar-connector@0.1.3"]` |
| 1c | Installing auto-satisfies the bundled google-calendar dependency | BLOCKED (D-1) | **PASS** | see below |
| 1d | Explicit rebuild refusal where the dependency cannot materialize | NOT EXERCISED | **NEEDS-NON-BUNDLING-IMAGE** | see below |
| 1e | Uninstall/archive of google-calendar refused while the dependent is active | BLOCKED | **NEEDS-NON-BUNDLING-IMAGE** (advanced, still unproven) | F10, F11, F12 |

**1c — the republished 0.1.1 installs, and the dependency is auto-satisfied.**
The whole path was walked in the product: `/configuration/marketplace` → the
Google Appointment Schedules card's live **Install now** CTA (F04) → the inline
install panel, `INSTALL FOR Workspace: All` (F05) → submit. The prior run's D-1
(package-store rejects the tarball because its runtime deps are neither bundled
nor covered by a signed plan) is **gone**: the installed manifest carries no
`dependencies` block at all — the fixed pipeline pruned `server-only` and emitted
a precompiled `register.mjs`
(`proof/0.1.1-installed-manifest.json`). The tarball was fetched, integrity- and
signature-checked and materialized into the content-addressed store
(`proof/0.1.1-store-record.json`):

```
registryUrl      https://registry.cinatra.ai
version          0.1.1
integrity        sha512-XV8JM8v/g0vDJSs7VzTVtxWpo8bj3XUSdsoFIUFkefgw63QfaXEXd0aAmYReXS8mKaadmL5W97arFToerOKskw==
tarballDigest    5d5f0933cbff…ce2ac93
materializedAt   2026-08-15T07:35:55.527Z
```

and the install row landed with the dependency edge RESOLVED, which is the
auto-satisfy proof itself:

```
installed_extension  @cinatra-ai/google-appointment-schedules-connector 0.1.1
                     status=active owner_level=organization
                     source.type=verdaccio (+ integrity, signature, activeDigest)

extension_dependency_edge
  declared_package_name  @cinatra-ai/google-calendar-connector
  edge_type/requirement  runtime / required   constraint ^0.1.0
  resolved_install_id    iext_b15093d1-ead   ← the bundled platform google-calendar 0.1.3
  resolution_reason      scoped:platform
```

So on an image that bundles google-calendar the required edge resolves to the
bundled install and nothing extra is fetched. **1c passes.** Two caveats are
recorded as defects N-1 and N-2 below: the successful install is reported to the
user as a failure, and it does not become usable on this lane.

**1d — still not exercisable, and now for a precisely nameable reason.**
Refusing because the dependency cannot materialize requires an image WITHOUT
google-calendar. On this image google-calendar is a platform static-bundle
install, so the edge always resolves (`resolution_reason=scoped:platform`) and
the refusal branch is unreachable. This is a **test-environment / image-shape
gap, not a spec gap** — the refusal machinery exists at the built sha
(`requiresRebuildState()` in `src/lib/extension-schema-config.ts` returns
`"<pkg>" ships a bundled React setup page, which cannot be hot-installed at
runtime. It is available after a base-image rebuild that includes this
connector.`), it simply has nothing to refuse here. Closing it needs a base image
built without `@cinatra-ai/google-calendar-connector` in the static bundle.

**1e — advanced from "no control at all" to "the control exists but a different
guard fires first"; still unproven.** The prior run found no lifecycle affordance
whatsoever for either connector. Now `/configuration/extensions/settings/connector/@cinatra-ai/google-calendar-connector`
renders the full Maintenance + Danger-zone block (F10) — but **Archive**,
**Activate** and **Reinstall latest** are all disabled with the title
`Installed for the whole platform — an organization-scoped session can't act on
it.` (F11). Only **Force-delete…** is enabled, and the dependents preview
(`[data-slot="archive-dependents-preview"]`) is empty. Dropping the active
organization to get a platform-scoped session does not change it (F12): the same
three controls stay disabled with the same copy. So the **scope guard pre-empts
the dependency guard** and the "refused while a dependent is active" path never
runs. Same root cause as 1d: proving it needs google-calendar installed as an
organization-scoped RUNTIME extension, i.e. an image that does not bundle it.
Not a spec gap — a test-environment gap.

### 2. Setup E2E

| # | Sub-item | Prior | Now | Evidence |
|---|---|---|---|---|
| 2a | Setup page renders record-list + booking-URL field + calendar select + "Add schedule" | PASS | **PASS** | F17 (`raw/d1` D1.7–D1.10) |
| 2b | Disconnected state renders the exact guidance placeholder | PASS | **PASS** | F14 — string-exact match on "No connected calendars yet — connect Google Calendar at /connectors/cinatra-ai/google-calendar-connector/setup to see your calendars here." |
| 2c | `listCalendars` returns an EMPTY SUCCESSFUL result when disconnected | PASS | **PASS** | `raw/c10b` — the field renders the declared placeholder, no throw, no error boundary |
| 2d | The prose tab renders the help text VERBATIM | PASS | **PASS** | F18 (`raw/d1` D1.13) |
| 2e | Help is last | PASS | **PASS** | F18 — tabs are exactly `Setup`, `Help` (observation O-1 from the prior run still stands: the prose IS the Help tab) |
| 2f | connect → calendar list populates the per-entry select | NEEDS-LIVE-ACCOUNT | **NEEDS-LIVE-ACCOUNT** | no Google OAuth client is configured on this instance and none may be minted here |
| 2g | add / list / delete schedules | NEEDS-LIVE-ACCOUNT | **NEEDS-LIVE-ACCOUNT** | `resolveCalendarSelection` refuses before storing when the account-scoped calendar list is empty |

### 3. Assistant add flow

| # | Sub-item | Prior | Now | Evidence |
|---|---|---|---|---|
| 3a | url-only add lands on the primary calendar | NEEDS-LIVE-ACCOUNT | **NEEDS-LIVE-ACCOUNT** | needs a connected account for the primary lookup |
| 3b | explicit `calendarId` respected | NEEDS-LIVE-ACCOUNT | **NEEDS-LIVE-ACCOUNT** | needs a live account-scoped list to validate against |
| 3c | invalid id refused with a CLEAR message | NEEDS-LIVE-ACCOUNT, masked by D-2 | **PASS for the surfacing half; NEEDS-LIVE-ACCOUNT for the invalid-id branch itself** | F23, F24, F27 |

**3c.** D-2 is fixed. The prior run's two add refusals both toasted a green
**"Done."** while discarding the connector's message. On this build the same two
repros toast the connector's own text in the error tone
(`raw/e3c/results.json`):

| repro | server payload | prior toast | toast now |
|---|---|---|---|
| `https://example.com/not-allowed` | `{"banner":"error","message":"Use a public Google Calendar appointment schedule link from calendar.app.google."}` | success · "Done." | **error · "Use a public Google Calendar appointment schedule link from calendar.app.google."** |
| `https://calendar.app.google/appt-s4-does-not-exist` | `{"banner":"error","message":"Unable to load the appointment schedule page (404)."}` | success · "Done." | **error · "Unable to load the appointment schedule page (404)."** |

The invalid-`calendarId` branch itself still needs a live account (the connector
scrapes the booking page BEFORE resolving the calendar, so an unreachable URL
short-circuits first). Its refusal string was driven through the real shell with
the handler's answer canned at the network boundary, and it surfaces verbatim
(F27): `"not-real" is not one of your Google calendars. Connect Google Calendar
and try again, or omit calendarId to use your primary calendar.`

### 3'. Banner vocabulary — does the SUCCESS path toast the declared text?

Asked explicitly for this run. **Yes.** Same technique as the #2752 lane: the
real page, real build, real shell and real declared schema, with only the
handler's answer canned at the network boundary (`drivers/c2-banner-vocabulary.mjs`,
`raw/c2/results.json`).

| canned answer | expected (declared variant) | toast tone | toast text | verdict |
|---|---|---|---|---|
| `{"banner":"saved"}` | success · "Appointment schedule added." | success | "Appointment schedule added." | **PASS** (F25) |
| `{"banner":"deleted"}` | success · "Appointment schedule removed." | success | "Appointment schedule removed." | **PASS** (F26) |
| `{"banner":"error","message":…}` | destructive, handler text wins | error | the handler's sentence, verbatim | **PASS** (F27) |
| `{"banner":"error"}` (no message) | destructive · "Couldn't add the appointment schedule." | error | "Couldn't add the appointment schedule." | **PASS** (F28) |

This closes the #2752 lane's open cost note: with the vocabulary declared, the
fail-safe no longer turns the connector's successes into red "Action failed."
toasts.

### 4. Consumer chain

| # | Sub-item | Prior | Now |
|---|---|---|---|
| 4a | The connector registers and activates at boot | PASS | **PASS** — `[boot] StaticBundleLoader: … google-appointment-schedules-connector:registered …` on every start |
| 4b | The `appointment-schedules` capability flows from the new connector | PASS (code) | **unchanged** — not re-driven this run |
| 4c | `chat-user-context` lines from the new connector | NEEDS-LIVE-ACCOUNT + LLM key | **unchanged** |
| 4d | email-outreach CTA renders `Book a meeting: <url>` | NEEDS-LIVE-ACCOUNT + BLOCKED | **unchanged** (needs the profile-gated WayFlow runtime + an LLM key) |
| 4e | The assistant hidden tool works under the new name | NEEDS-LLM-KEY | **unchanged** |

A supplementary fixture driver (`drivers/d3-consumer-chain.mjs`, `raw/d3`) seeds
one row directly into the connector's own config key and exercises the surfaces
downstream of the store. It is NOT part of the asked scope and its one
interesting negative is recorded as observation N-4 rather than as a result.

### 5. Extraction clean

| # | Sub-item | Prior | Now | Evidence |
|---|---|---|---|---|
| 5a | google-calendar setup page shows Setup / Help only | PASS | **PASS** | F19 — tabs are exactly `Setup`, `Help` |
| 5b | Zero appointment traces on the google-calendar setup page (both tabs) | PASS | **PASS** | F19, F20 — `/appointment/i` matches on neither panel |
| 5c | No "N appt" probe label anywhere in the connectors grid | PASS | **PASS** | F16 — `/\d+\s*appt/i` does not match page-wide |
| 5d | The google-calendar card's Connected reflects Nango state | PARTIAL (negative half) | **PARTIAL (negative half), unchanged** | F22 — with no Nango connection the badge reads "Not connected"; the positive half is NEEDS-LIVE-ACCOUNT |
| 5e | The installed google-calendar manifest carries no appointment copy | PASS | **PASS** | F10 — the settings page description is the post-extraction text |
| 5f | No appointment traces on the google-calendar MARKETPLACE surfaces | FAIL (D-3) | **FAIL — expected, waits on an internal storefront follow-up** | F03 |

**5f** is unchanged and stays FAIL by design: the storefront listing for
`@cinatra-ai/google-calendar-connector` is still the pre-extraction 0.1.3 copy
("Stores users' public appointment-schedule booking links (calendar.app.google)…",
capability bullets naming `google_calendar_appointments_list` and the
appointment-schedules capability). The published package has not been
republished/refreshed; that is an internal storefront follow-up's job. Everything the CODE owns is
clean (5a, 5b, 5e).

### 6. Screenshots + checklist

| # | Sub-item | Now |
|---|---|---|
| 6a | Screenshots for every item | PASS — 28 curated captures in `screenshots/`, full driver output in `raw/` |
| 6b | Item-by-item checklist with per-item status | PASS — this file |
| 6c | All four sub-issues' gates green at head | NOT CHECKED by this lane (CI-side) |

## Defects found this run (nothing was filed — for the coordinator to route)

### N-1 — a committed install is reported to the user as a failure

* Surface: `/configuration/marketplace`, inline install panel, Install now.
* Observed, three times (refs `REF-220AF38E`, `REF-D0D1C9D8`, and one in the
  pre-flag run): toast **"Couldn't install Google Appointment Schedules. Contact
  your administrator for help. (Ref: …)"** and the same text in
  `[data-testid="extension-install-panel-error"]` (F06, F09) — while the install
  actually **succeeded**: the row is written, active, with integrity + signature,
  and the dependency edge is resolved. The server itself says so:
  `install failed … (category=unrecoverable): install of @cinatra-ai/google-appointment-schedules-connector finalized the real-integrity pipeline but did NOT hot-activate in-process (anchor-refused) — the package is anchorable (it will load on the next boot) but did not load without a restart this call. The committed install was left intact.`
* `drivers/c7-install-timeline.mjs` samples `installed_extension` every 2 s for
  120 s after submit: the row appears and never goes away — there is no rollback
  the failure toast could be describing.
* So a terminal state the server classifies as "committed, needs a restart" is
  presented to the operator as an unqualified failure with no next step. The
  honest surface would name the restart.
* Evidence: F06, F09, `raw/c6-gatekept/assertions.json`, `raw/c7/timeline.json`,
  `proof/install-server-log-excerpt.txt`.

### N-2 — a committed-but-unactivated install SHADOWS the working bundle and silently breaks the connector

* After the successful install, every UI action on
  `/connectors/cinatra-ai/google-appointment-schedules-connector/setup` 404s:
  `No registered UI action "listCalendars" for "@cinatra-ai/google-appointment-schedules-connector"`
  (same for `listAppointmentSchedules` and `bookingPageGuideReady`).
* The page still renders in full — and the 404 text takes the place of the
  declared placeholder, so acceptance item 2b reads as broken (F13) even though
  the string is intact.
* Cause chain, from the boot log: `[runtime-package-loader] refusing 1
  package(s) for in-process import (untrusted-activation-mode=deny; …):
  @cinatra-ai/google-appointment-schedules-connector: no trusted install record`
  and `[artifact-bridge-rescan] skipping …: a live canonical row exists but its
  trusted anchor could not be resolved (refused/ambiguous) — fail closed`. The
  instance has no trusted signing keys (`[boot] ExtensionSignatureBackfill:
  skipped (no-trusted-keys)`), so the org-scoped 0.1.1 row becomes canonical,
  shadows the working platform 0.1.0 static bundle, and serves nothing.
* The no-trusted-keys condition is a lane/test-environment condition. The
  DEGRADATION is the finding: the shadow is taken before activation is known to
  succeed, and the user is told nothing — no banner, no fallback to the bundle,
  and the setup page looks merely misconfigured.
* Archiving through the product does not recover it either: the settings page for
  the package targets the PLATFORM 0.1.0 row (it reads "Currently on version
  0.1.0"), and clicking Archive there toasts **"Couldn't archive Google
  Appointment Schedules. Please try again…"** (F15, `raw/c11/assertions.json`).
  The lane recovered by deleting the shadowing 0.1.1 row directly in the lane DB
  and restarting; after that every item-2 assertion passes again (F14).
* Evidence: F13, F15, F14, `raw/c10`, `raw/c11`, `raw/c10b`,
  `proof/install-server-log-excerpt.txt`.

### N-3 — the platform-scope guard disables every reversible lifecycle control, with copy that misdescribes a platform-scoped session

* Surface: `/configuration/extensions/settings/connector/@cinatra-ai/google-calendar-connector`.
* Archive / Activate / Reinstall latest are disabled with
  `Installed for the whole platform — an organization-scoped session can't act on
  it.` The copy implies a platform-scoped session could. Clearing the active
  organization produces exactly the same disabled controls and the same title
  (F12), so either the copy is wrong or the platform-scoped path is not wired.
* Consequence for this epic: the dependency refusal (item 1e) can never fire for
  a bundled dependency, because the scope guard refuses first.
* Evidence: F10, F11, F12, `raw/c8/assertions.json`, `raw/c9/assertions.json`.

### N-4 — observation, unconfirmed: delete of a stored schedule left the row in the store

* In the supplementary fixture driver, clicking the record-list delete affordance
  on a seeded row left the row in the connector's config key
  (`raw/d3/assertions.json`, `D3.4`). The row was seeded directly rather than
  added through the (live-account-gated) add path, so this may be a fixture
  artifact — the seeded row may not carry whatever the host-authorized delete
  matches on. Recorded so a live-account round checks delete explicitly; NOT
  claimed as a defect.

### Prior-run defects, re-checked

| Prior | State now |
|---|---|
| D-1 — the published connector cannot be installed (deps neither bundled nor signed-planned) | **FIXED** by the republish: 0.1.1's installable manifest has no `dependencies` block and materializes cleanly. Note the fleet-wide control run from the prior lane (`mcp-server-connector`) was not repeated — other packages published by the old path are presumably still affected. |
| D-2 — every "Add schedule" failure reported as success ("Done.") | **FIXED** by #2756 + the connector's declared banner vocabulary. See item 3c and the banner table. |
| D-3 — the google-calendar marketplace listing still sells appointment schedules | **UNCHANGED** — waits on an internal storefront follow-up (item 5f). |
| D-4 — `/configuration/extensions` 500s when the instance namespace is unset | not re-checked (this instance has a namespace). |
| D-5 — a host `next start` cannot install anything without `CINATRA_EXTENSION_DATA_ROOT` | **UNCHANGED** — the toggle was set from the start this run precisely because of D-5. |

## What each remaining item still needs

| Item | Needs |
|---|---|
| 1d, 1e | A base image built WITHOUT `@cinatra-ai/google-calendar-connector` in the static bundle, so the dependency is a real organization-scoped runtime install. Then 1d is "install the appointment connector where google-calendar cannot materialize" and 1e is "archive google-calendar while the dependent is active". |
| 2f, 2g, 3a, 3b, 3c (invalid-id branch), 4c, 4d, 4e, 5d (positive half) | A connectable dev Google account: a Google OAuth client saved at `/connectors/cinatra-ai/google-oauth-connector/setup`, then Connect on `/connectors/cinatra-ai/google-calendar-connector/setup`. 4d additionally needs the WayFlow runtime and a configured LLM model. |
| 5f | an internal storefront follow-up — republish / refresh the `@cinatra-ai/google-calendar-connector` storefront listing with the post-extraction copy. |
| 6c | CI-side check of the four sub-issues' gates at head. |
| N-1, N-2, N-3 | Coordinator routing (nothing filed by this lane). |

## Host2 restoration

The lane left a lane host as it found it: the app process it started was stopped, the
shared `base-cinatra` compose stack was never touched, the shadowing 0.1.1 row
and the seeded fixture key were removed from the lane DB, and nothing was
installed on the host. See the final report for pids and the post-run probe.
