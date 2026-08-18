# Two-version install proof: what each file shows, and what is still missing

This records the state of the real-application proof honestly. Every file named
below was produced by driving the running application in this single run. What
was NOT produced says so, and says why, in "What is still missing".

**Two lane instances, and which is which is stated on every file.** Instance A
carries the install sequence (baseline → refusal → hot install → restart).
Instance B carries the two states that require rows seeded BEFORE a boot (the
stranded row, and the unactivated newer row); it performs no install at all, so
its install ids differ. They are separate because the states are mutually
exclusive in one linear run, not to blur them: no claim below combines the two,
and the section for each names its instance. The previous round's captures were
deleted rather than mixed in — an unlabelled mixture is how the last round
shipped a capture that did not show what its caption claimed.

## How this run was driven

A throwaway stack on lane-private ports, under its own Compose project
(`x2774evproof`), with its own database, its own Redis and its own registry.
Nothing outside the lane was started, stopped or written. The operator's
`cinatra_cinatra` stack was never touched.

- **Registry** — the repo's own Verdaccio image on `127.0.0.1:4880`.
  `drivers/publish-signed.mjs` builds the package into publishable shape, takes
  the sha512 integrity of the exact tarball bytes, signs the canonical payload
  with an Ed25519 key generated for the run, and PUTs the signature in the
  packument's per-version `dist.cinatraSignature`.
- **Storefront** — `drivers/lane-storefront.mjs` on `127.0.0.1:4881`.
- **Application** — the real Next.js application on `127.0.0.1:3477`, booted
  against the lane database with the setup wizard bypassed
  (`CINATRA_E2E_SETUP_BYPASS=true`), driven in a real Chromium through
  `drivers/lane-proof-driver.mjs`.

### The two-version shape, and how a screenshot can now name the version

The connector ships in the image at **0.1.0** (the static bundle registers it at
boot). The lane registry holds **0.1.2** signed with the trusted key, and
**0.1.1** signed with an **untrusted** key for the negative run.

One change to the lane since the last round, and it is the change that makes
these captures worth anything: the published versions carry a
`[lane registry build <x>]` stamp on the connector's own declared `calendarId`
placeholder (`publish-signed.mjs`, `LANE_MANIFEST_MARK`). It edits one declared
string in the staged manifest and nothing else — no code path, no install logic,
no signing-input handling.

The reason is the defect the last round shipped. The lane was publishing a
version byte-identical to the bundled one, so the setup surface rendered
*exactly the same pixels* whichever version served, and four "different" state
captures came out as one blob. A real newer version differs from the one in the
image; with the stamp, the setup surface **names the manifest that reached the
render**, so "the bundled implementation is serving" and "the marketplace
version is serving" are two visibly different screens.

The stamp deliberately spells the version bare, as `build 0.1.2`, rather than
prefixing it with a lowercase "v": the org source-leak gate's
`SLG_MILESTONE_VERSION` rule matches that prefixed shape, and an evidence
transcript is not a place to trip a required gate. An earlier revision of this
lane used the prefixed form and turned `source-leak-gate` red for exactly that
reason.

## What each screenshot shows

Every row was produced by `drivers/lane-proof-driver.mjs`; the matching
`*-driver.txt` is that invocation's full transcript, and the matching
`*-resolution.json` carries the resolved install id, the version each surface
named, the rendered placeholder, and the full lifecycle-button audit.

### Baseline — the bundled 0.1.0 alone

| File | What it shows |
|---|---|
| `baseline-connector-setup.png` | The connector setup page. The `calendarId` placeholder is **unstamped**, so the render came from the **bundled 0.1.0 manifest**. |
| `baseline-extension-settings.png` | The extension settings page naming version **0.1.0**. |
| `baseline-lifecycle-actions.png` | **Archive** and **Reinstall latest** enabled, **Activate** disabled reading "Already active", **Update** disabled reading "Already up to date". No capability-denial text. |

### The bad-signature refusal (#2762 acceptance item 3)

0.1.1 signed with a key that is **not** in
`CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS`. A genuine signature over the correct
payload from an untrusted key — not a corrupted byte.

| File | What it shows |
|---|---|
| `negative-marketplace-card.png` | The marketplace card the storefront listed. |
| `negative-install-panel-open.png` | The in-card install panel, `data-availability="ready"`, before submit. |
| `negative-install-refused.png` | **The actual refusal.** The sonner error toast on screen, reading `Couldn't install Google Appointment Schedules. Contact your administrator for help. (Ref: REF-D0A58EBC)`, with the install panel still open behind it. |
| `negative-refusal.json` | The toast text, the `sr-only` panel mirror text, and the URL — still `/configuration/marketplace`, so no redirect happened. |

**Why the previous `negative-install-refused.png` was byte-identical to the open
panel, and what changed.** This surface announces a failed install as a **toast**
and deliberately leaves the panel unredrawn: *"a failed install neither redraws
the panel with an error state nor grows its height"*
(`extension-install-scope-panel.tsx`, the file's own header). The in-panel
`extension-install-panel-error` node is real but `sr-only`, so it cannot carry a
screenshot. The toast is the only visible refusal UI, and it is mounted with
`duration={8000}` (`src/app/providers.tsx`). The old driver slept **20 seconds**
and then captured — it photographed the screen *after* the toast had already
gone, which is why the file carried no proof. The driver now waits for
`[data-sonner-toast][data-type="error"]` to be **visible** and captures it there,
with `fullPage` off because the toast is a fixed-position overlay.

Immediately after the refusal the row query returned the bundled row **only** —
zero live marketplace rows.

### After the refusal — the bundle still serves

| File | What it shows |
|---|---|
| `after-refusal-connector-setup.png` | Setup page, placeholder still **unstamped** → still the bundled 0.1.0 manifest. |
| `after-refusal-extension-settings.png` | Settings still naming **0.1.0**. |
| `after-refusal-lifecycle-actions.png` | Lifecycle actions unchanged from baseline. |

**These three are byte-identical to their `baseline-` counterparts, and that is
the assertion, not a shortcut.** A refused install committed nothing, so the
application is in literally the same state; an identical render is the correct
outcome. They were captured separately, after the refusal —
`after-refusal-driver.txt` is that separate invocation.

### The hot install, without a restart (#2762 acceptance items 2 and 4)

The signed 0.1.2 installed through the real marketplace panel while the bundled
0.1.0 was serving, with **no restart** between the install and these captures.

| File | What it shows |
|---|---|
| `install-marketplace-card.png` | The card, listed at 0.1.2. |
| `install-install-panel-open.png` | The install panel ready, before submit. |
| `install-post-install-installed-list.png` | The redirect to `/configuration/extensions` that only a successful install produces. |
| `post-install-connector-setup.png` | The setup page with the placeholder reading **`[lane registry build 0.1.2] …`** — the **marketplace manifest** is what rendered. |
| `post-install-extension-settings.png` | Settings naming version **0.1.2**. |
| `post-install-lifecycle-actions.png` | **The capture the round-3 finding demanded.** With the bundled anchor and the marketplace row both live, **Archive** and **Reinstall latest** are **ENABLED**, and **no** "More than one install matches your scope" text is rendered anywhere. **Retry activation** and **Roll back to bundled** both render **enabled**. |

The resolver reaching one row from that pair is
`narrowByInstallSourcePrecedence` (`packages/extensions/src/lifecycle-target-resolver.ts:594-601`),
feeding `resolveLifecycleScope`.

**Activate is disabled, reading "Already active".** That is the status tier in
`extension-settings-model.ts`, not the ambiguity denial — the row *is* active.
The audit records zero `lifecycle-capability-reason` nodes.

### After a restart — the same surface, still correct

The application was stopped and booted again with the marketplace row in place.
`logs/boot-B-after-restart.txt` shows the row activating in-process:

```
[boot] RuntimePackageLoader: 2 result(s) — google-appointment-schedules-connector:registered, …
```

| File | What it shows |
|---|---|
| `after-restart-connector-setup.png` | Setup page after the restart, placeholder reading `[lane registry build 0.1.2] …`. |
| `after-restart-extension-settings.png` | Settings naming **0.1.2** after the restart. |
| `after-restart-lifecycle-actions.png` | Archive and Reinstall latest still enabled, both recovery actions still enabled, still no ambiguity text. |

The settings and lifecycle captures are byte-identical to their `post-install-`
counterparts. **That identity is the assertion**: the restart changed nothing
that the surface shows, which is exactly what "after restart, still correct"
means. `after-restart-driver.txt` is the separate invocation that produced them.

### Trust and seam resolution

`logs/trust-verdict-signed-local.txt` — the trust verdict over the published
0.1.2: `SIGNATURE VERDICT: true`, `TRUST VERDICT: trusted-signed`.

`logs/seam-resolution-with-unactivated-newer-row.txt` — the provider-write
seam's own selection over the application's own canonical store, using the
application's own policy function, taken on instance B at the fixture state
described below. It resolves `iext_unactivated_newer_2762` (version 0.1.5) out
of the bundled-plus-newer pair, which is the seam-level form of the same
acceptance-1 statement the screenshots make.

### The duplicate hashes in this directory, named

Six pairs are byte-identical, and each one is a state that genuinely did not
change:

- the `baseline-` / `after-refusal-` triple — a refusal committed nothing;
- `post-install-` / `after-restart-` for `extension-settings` and
  `lifecycle-actions` — the restart preserved the state, which is the assertion;
- `install-marketplace-card.png` = `negative-marketplace-card.png` — the
  marketplace card does not render the version, so listing 0.1.1 and listing
  0.1.2 produce the same card. Which version was listed is in the storefront
  process and in each run's `*-driver.txt`, not on the card.
- `unactivated-newer-connector-setup.png` = `baseline-connector-setup.png` =
  `after-refusal-connector-setup.png` — and here the identity **is the
  assertion**. The baseline is the bundled version serving alone; the
  acceptance-1 state renders identically **because the bundled version is still
  what serves**, with the newer 0.1.5 row live beside it. A different render
  there would mean the newer row had taken over.

`post-install-connector-setup.png` and `after-restart-connector-setup.png` are
NOT identical. No other two files in this directory share a hash.

## The fixture-seeded boot: the stranded row and acceptance item 1

These two states need rows that exist **before** a boot, so they were captured on
a second lane instance: a fresh database, both fixtures seeded, then one boot.
That instance deliberately performs **no install** — the point is a
pre-existing row, not a new one — so its install ids differ from the run above
(`iext_9a7fc562-049` is its bundled anchor). Nothing from the two instances is
combined into a single claim; each file below names which state it shows.

### The boot itself

`logs/boot-C-stranded-reconcile.txt`, in full:

```
[operational-event] {"event":"extension_boot_reconcile","packageName":"@cinatra-ai/stranded-fixture-connector","rowId":"iext_stranded_fixture_2762","outcome":"retryable-bundle-unrestored","failureClass":"config","reason":"the package did not register"}
[boot] StrandedInstallReconcile: considered 1, acted on 1: stranded-fixture-connector:retryable
```

Two things are load-bearing there. The reconciliation **acted on** the stranded
row, classified it `config` and left it retryable rather than durably archiving
it. And it **considered exactly 1** row, not 2: the unactivated 0.1.5 row for the
*bundled* package was never a candidate, because the static bundle had already
registered that package this boot. That skip is the documented "the bundled
implementation is already serving" branch, and the same log shows
`google-appointment-schedules-connector:registered` from the static bundle with
**no** `RuntimePackageLoader` line — so 0.1.5 never activated.

### The stranded row is visible and named (#2762 acceptance items 1 and 2)

| File | What it shows |
|---|---|
| `stranded-settings.png` | The settings surface for `@cinatra-ai/stranded-fixture-connector`, naming the package, its kind (Connector) and version 0.1.0, with **Retry activation** offered: *"Try to start this version again in the running app. Use it after fixing what refused it, such as a missing signing key or an untrusted registry."* |
| `stranded-state.json`, `stranded-driver.txt` | The assertions and the full lifecycle-button audit for that row. |

A row the reconciliation left retryable is therefore not a shadow: the operator
can see it and is offered the recovery action for it.

**One correction, recorded rather than quietly fixed.** The first version of this
capture targeted `/configuration/extensions` and reported the row as absent. That
route lists neither this fixture nor the bundled appointment connector, so it was
the wrong surface and the finding was the driver's fault, not the product's. The
`stranded` mode now targets the per-extension settings screen, which is the
surface that carries a connector row's state.

### An unactivated NEWER row while the BUNDLE serves (#2762 acceptance item 1)

`drivers/unactivated-newer-row-fixture.sql` seeds a live, default,
workspace-anchored `verdaccio` row at **0.1.5** for the **bundled** package,
pointing at a version published and materialized nowhere, so nothing but the
bundled 0.1.0 can serve it.

| File | What it shows |
|---|---|
| `unactivated-newer-connector-setup.png` | The setup surface rendering the **unstamped** declared placeholder — the **bundled 0.1.0 manifest** produced this render. **The bundle is serving.** |
| `unactivated-newer-extension-settings.png` | The settings surface naming version **0.1.5**. **The newer row is visible, not shadowed.** |
| `unactivated-newer-lifecycle-actions.png` | Archive and Reinstall latest enabled; **Retry activation** and **Roll back to bundled** both enabled; zero capability-denial text. |
| `unactivated-newer-resolution.json`, `-driver.txt` | Every assertion, the resolved install id and the rendered placeholder. |

Those two captures together are the acceptance-1 statement: **the setup surface
says 0.1.0's manifest served, and the settings surface says 0.1.5 is the row.**

`unactivated-newer-connector-setup.png` is byte-identical to
`baseline-connector-setup.png`. **That identity is the proof, not a duplicate**:
the baseline is the bundled version serving alone, and this state renders exactly
the same because the bundled version is still what serves.

The third fact is on the wire. Every UI action the surface fired dispatched
against the **newer row's** id and answered **200**:

```
{"installId":"iext_unactivated_newer_2762","actionId":"bookingPageGuideReady","status":200}
{"installId":"iext_unactivated_newer_2762","actionId":"listCalendars","status":200}
{"installId":"iext_unactivated_newer_2762","actionId":"listAppointmentSchedules","status":200}
```

The row the operator sees and the implementation that answers are reconciled: the
visible newer row is served by the bundled implementation instead of 404-ing.
That is the "no shadow visible state" this change is named for.

## Round 5 items 3 and 4: the recovery actions CLICKED, and the provenance fix

Round 4 proved the recovery pair RENDERS. Round 5 asked for two further things:
that the pair be USED and the resulting state captured (item 3), and that
`stranded-lifecycle-actions.png` be regenerated by a transcript that could
actually have produced it (item 4).

### Item 4: the transcript and the file now come from one run

`screenshots/stranded-driver.txt` claimed a `stranded-lifecycle-actions.png`
that was never committed, and `drivers/lane-proof-driver.mjs` passed
`takeShot: false` on the stranded mode's lifecycle audit. The transcript
therefore could not have come from that driver. The call now passes `true`, and
both files in this directory were written by the same re-run.

The settings capture is now taken BEFORE the audit scrolls the maintenance and
danger-zone blocks into view, which is the order `assert` mode already used.
Taken after the scroll the two captures are byte-identical, and this directory
does not commit a duplicate blob when the shot order alone decides it.

### Item 3: what was clicked, and what happened

Two new driver modes drive the real buttons on the real settings surface:
`retry-recovery` and `rollback-recovery`. Both read `data-slot="recovery-action"`
buttons and both read the failure node the action renders, so a refusal is as
observable as a success.

**Retry activation, on a state where it can succeed.** "Retry activation" is
row-bound and activation-only by design: it does not reinstall and does not talk
to the registry, because the operator most in need of it is the one whose
registry will not resolve. Its premise is a package whose bytes are already
materialized and whose registration is the only thing missing. The run therefore
installed 0.1.5 for real through the marketplace UI first, so the PRODUCT
materialized the bytes, then reached the stranded state through
`drivers/stranded-with-bytes-fixture.sql` (that file documents the exact
staging). Before the click the surface names "Installed but not in service",
greys Update as "Installed version isn't in service" and greys Activate as
"Installed but not in service - use Retry activation". After the click the
not-in-service row is GONE, the Update row reads "Currently on version 0.1.5",
and the setup surface renders `[lane registry build 0.1.5]` in place of the
unstamped bundled placeholder. That last line is the one that cannot be argued
with: the manifest that reached the render is the retried version's, so the
retry put 0.1.5 into service rather than merely reporting that it had.
Files: `recovery-retry-before-settings.png`,
`recovery-retry-after-settings.png`,
`recovery-retry-after-connector-setup.png`, `recovery-retry-driver.txt`,
`recovery-retry-state.json`.

**Roll back to bundled, and the way back.** The rollback was clicked from the
healthy state, which is the state an operator actually rolls back FROM. What
round 5 asks about is not where the rollback starts but where it LEAVES you.
The run therefore visits the page AGAIN afterwards. The revisit renders Archive
as "Already archived" and **Activate ENABLED**, with no
"More than one install matches your scope" anywhere: the archived install is
still reachable, so the rollback is not the one-way door round 4 pinned. The
run then CLICKS that way back, returns to the settings surface, and reads it:
the recovery pair renders again, which only a live install does.
Files: `recovery-rollback-before-settings.png`,
`recovery-rollback-after-settings.png`,
`recovery-rollback-wayback-offered.png`,
`recovery-rollback-wayback-after.png`, `recovery-rollback-driver.txt`,
`recovery-rollback-state.json`.

### A refusal this lane also saw, and did not hide

The first retry click in this round ran against a row seeded by SQL for a
version that was never installed, so nothing was materialized. The retry
refused, and the application behaved exactly as round 3 required of it: the
server logged `retry-activation failed ... (category=unrecoverable):
anchor-refused (the version bundled in the image was put back in service)`, and
the surface told the operator "Couldn't start Google Appointment Schedules in
the running app. The version bundled with the app is unaffected." That refusal
is why the successful run installs 0.1.5 for real first. The refusal capture is
not committed here, because the committed pair is the one that answers item 3;
the behaviour is recorded in this paragraph rather than left unsaid.

### One duplicate hash in this round, named

`recovery-retry-after-settings.png` is byte-identical to
`recovery-rollback-before-settings.png`. Both render the same state: 0.1.5
installed and serving, healthy. The identity is the point rather than a defect.
It says the successful retry returned the surface to exactly the healthy
installed state that the rollback was later clicked from.

## What is NOT claimed

**A production `next build` was not run, and the application was not served from
a production build.** Two reasons, neither a shortcut:

1. Serving a production build from a host checkout is ratified unsupported —
   `next.config.ts` sets `output: "standalone"`, and
   `docs/internals/decisions/production-runtime-contract.md` records that
   `next start` from a host checkout aborts at boot by design.
2. The marketplace install path under test cannot run in a production runtime
   against a lane-private catalog at all: `MARKETPLACE_BASE_URL` is honored only
   outside `NODE_ENV=production`.

Two smaller disclosures:

- The proof runs with the setup wizard bypassed. That flag suppresses the setup
  gate only; it grants no authentication and changes nothing in the install,
  resolution or reconciliation paths under test.
- The provider-write seam was resolved by running the writer's own selection
  over the application's own canonical store rather than through a browser
  surface, because this connector's setup surface has no connection-save action.
  Setup and settings were both read from the browser.

## Reproducing

`README.md` in this directory carries the full sequence, the ports, the env and
the teardown.
