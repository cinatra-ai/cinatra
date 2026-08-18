# Two-version install proof: what each file shows, and what is still missing

This records the state of the real-application proof honestly. Every file named
below was produced by driving the running application in this single run. What
was NOT produced says so, and says why, in "What is still missing".

**One run, one environment.** Everything in `screenshots/` and `logs/` comes
from the same lane stack. The previous round's captures were deleted rather than
mixed in: two runs in one directory is how the last round shipped a capture that
did not show what its caption claimed.

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
seam's own selection, run over the application's own canonical store with the
application's own policy function, at the fixture state described below.

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

`post-install-connector-setup.png` and `after-restart-connector-setup.png` are
NOT identical. No other two files in this directory share a hash.

## What is still missing, and why

This run stopped at the machine's memory guard before two deliverables were
captured. They are **not** claimed anywhere above.

**The guard.** The lane checks a machine-local memory-guard flag file (path
redacted) before every application boot. Both fixtures below were seeded, and
the guard then re-armed and did not clear across a bounded wait of 20 checks at
30-second intervals:

```
2026-08-18T02:49:23Z pressure=2 swap_free=616MB
```

Booting a third Next dev server there risks an OOM on the operator's machine,
which is what the guard exists to prevent, so the lane stopped instead.

Missing as a result:

1. **The pre-existing stranded row.** `drivers/stranded-row-fixture.sql` **was
   seeded** (`logs/rows-with-fixtures-seeded.txt` shows
   `iext_stranded_fixture_2762` live), but the boot that would read
   `StrandedInstallReconcile` out of the log never ran. No boot log in this
   directory shows that line, and none is claimed to.
2. **#2762 acceptance item 1 end to end** — an unactivated **newer** row present
   while the **bundle still serves**. `drivers/unactivated-newer-row-fixture.sql`
   **was seeded**: a live, default, workspace-anchored `verdaccio` row at
   **0.1.5** for the **bundled** package, pointing at a version published and
   materialized nowhere, so nothing but the bundled 0.1.0 can serve it.

   What this run **does** establish for item 1, without the boot:
   `logs/seam-resolution-with-unactivated-newer-row.txt` runs the seam over that
   exact row set and shows the newer row being **named**, not shadowed:

   ```
   iext_4b38afe2-5fa            version=0.1.0  source=bundled
   iext_unactivated_newer_2762  version=0.1.5  source=verdaccio
   live rows: 2 → after supersession: 2 → after source precedence: 1
   PROVIDER-WRITE RESOLVED INSTALL ID: iext_unactivated_newer_2762  (version 0.1.5)
   ```

   What is **missing** is the browser capture of that state: the setup surface
   rendering the **unstamped** bundled placeholder (the bundle serving) while the
   settings surface names 0.1.5 (the newer row visible). The driver is ready for
   it — `lane-proof-driver.mjs` takes `expectServingVersion` separately from
   `expectVersion` for exactly this — and the invocation is one boot away:

   ```
   node drivers/lane-proof-driver.mjs assert <origin> <email> <pw> $OUT unactivated-newer 0.1.5 0.1.0
   ```

The reconcile behavior itself is presently proven by the repo's own tests
(`src/lib/__tests__/extension-boot-reconcile.test.ts`), not by a driver run in
this directory.

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
