# Two-version install proof: what is established, and what is not

This records the state of the real-application proof honestly. Every claim below
was produced by driving the running application; nothing is claimed that was not
run, and the one item that was not run says so and says why.

## How the proof was run

A throwaway stack on lane-private ports, under its own Compose project, with its
own database, its own Redis and its own registry. Nothing outside the lane was
started, stopped or written.

- **Registry** — the repo's own Verdaccio image. `drivers/publish-signed.mjs`
  publishes to it: it builds the package into the shape a real publisher ships
  (built ESM, runtime dependencies bundled — see below), takes the sha512
  integrity of the exact tarball bytes, signs the canonical payload with an
  Ed25519 key generated for the run, and PUTs the signature in the packument's
  per-version `dist.cinatraSignature`. The public half of that key is the only
  key configured as trusted for the application under test.
- **Storefront** — `drivers/lane-storefront.mjs`, a dependency-free server for
  the anonymous public catalog the marketplace browses. The application reads
  its catalog from the storefront and its packages from the registry, so the two
  are separate processes here, as they are in production.
- **Application** — the real Next.js application, booted against the lane
  database with the setup wizard bypassed (`CINATRA_E2E_SETUP_BYPASS=true`,
  disclosed in `README.md`), driven in a real Chromium through
  `drivers/lane-proof-driver.mjs`. Every assertion reads an application surface:
  the marketplace screen, the connector setup page, the extension settings page,
  the UI-action dispatch endpoint, and the rows the application itself wrote.

**This is a dev-runtime proof, and that is not a shortcut.** The storefront base
URL is overridable only outside `NODE_ENV=production`
(`resolveMarketplaceBaseUrl`, `packages/marketplace-mcp-client/src/http-client.ts`),
so a production runtime always browses the single hardcoded marketplace. Driving
the real marketplace install path against a lane-private catalog therefore
*requires* the dev runtime. This is the same reason the repo's own
`marketplace-install` end-to-end suite runs against `pnpm dev`.

## The two-version shape

The connector under test ships in the image at the **older** version and is
published to the lane registry, signed, at a **newer** one. The older version
comes from the generated static manifest that the build bundles, so it is the
same in every runtime.

## What is established

**1. The application runs against a lane-private database with the older version
bundled.** The static-bundle anchor row is live for the older version at boot,
and every surface serves it before any install. `logs/install-run.txt`,
`screenshots/baseline-*`.

**2. The signed newer version installs through the real marketplace path.** The
marketplace lists the connector, the in-card access-target install panel opens
ready, and its submit runs the real server-action chain
(`installExtensionPackageFormAction` → `installExtensionFromRegistry`) to a
successful finalize and the redirect to the installed list. The install is a
genuine one: it resolved and verified the package from the registry, threaded
the declared dependency closure, and wrote a marketplace-sourced row beside the
bundled anchor. `screenshots/install-*`, `logs/install-run.txt`.

**3. The assertions, each with a screenshot, before and after a restart.**

- UI actions are not 404: the setup surface's own dispatches
  (`bookingPageGuideReady`, `listCalendars`, `listAppointmentSchedules`) all
  answer 200. These are the requests the rendered surface fires, recorded off
  the wire, not requests the driver invented.
- Setup, settings and provider-write resolution all resolve the **same row**.
  After the install all three name the marketplace row, with the bundled row
  still live underneath it. `logs/three-seam-resolution.txt`.
- The **declared** placeholder renders — the `calendarId` dynamic-select shows
  the manifest's own text under `data-testid="dynamic-select-empty"`, not the
  `No options available.` fallback that appears only when a field declares none.
- All of the above again after an application restart, unchanged. The restart
  boot also shows the marketplace row activating in-process
  (`RuntimePackageLoader: … registered`). `screenshots/after-restart-*`,
  `logs/boot-after-install.txt`.

**4. The negative run: a bad signature is refused before any live finalized row
exists, and the bundled version stays in service throughout.** The same package
was published at a third version signed with an **untrusted** key. The install
was refused, the panel stayed open with a non-technical message, and the
application's own log records why:

> was refused before anything was committed: package signature did not verify.
> No install-op journal, host-port grant or provenance was written, the
> materialized bytes were removed, and the version bundled in the image stays in
> service.

Zero live marketplace-sourced rows existed after the refusal, and re-running the
full assertion set against the bundled version passed unchanged.
`logs/negative-run.txt`, `screenshots/negative-*`, `screenshots/after-refusal-*`.

**5. A pre-existing stranded row exercises the boot reconciliation.**
`drivers/stranded-row-fixture.sql` writes a live, default, marketplace-sourced
row for a package the image does not bundle, before the boot. The reconciliation
found it, classified the failure and recorded it:

```
[boot] StrandedInstallReconcile: considered 1, acted on 1: …:retryable
[operational-event] {"event":"extension_boot_reconcile", … "outcome":"retryable-bundle-unrestored","failureClass":"config","reason":"the package did not register"}
```

The fixture package is deliberately one with no bundled fallback. A bundled
package always registers from the static bundle, which puts it in the set that
came up this boot, so it is never a reconciliation candidate — correctly, since
its bundled implementation is already serving. `logs/stranded-reconcile.txt`.

## What the proof CHANGED, because it found a blocker

The install in item 2 did not work when the proof first ran it. It failed at its
own provenance write and rolled itself back:

> recordProvenance: expected exactly 1 active installed_extension row for … in
> org (global) (0 or ambiguous owner scope) — fail closed

The cause is the two-live-default-rows shape this change exists to resolve,
reached from the install side: the marketplace install **creates** the second
row, so while the install is still running the bundled anchor and the new row
are both live and both default in one scope. Polling the database during an
install shows exactly that pair.

`pickSingleActiveRow` is what the install pipeline's canonical-row deps resolve
through — `recordProvenance`, `persistDependencyEdges`,
`persistAccessDeclaration` and the widget-auth key write all share one
`resolveTarget` built on it. It was the one picker that did not apply the shared
source-precedence policy, so it read that pair as cross-owner ambiguity and
failed closed. The effect was that a marketplace override could never finish
installing over a bundled package at all.

The fix applies the same policy the sibling picker already applies, and the
install then completes on the first attempt. Regression tests cover the pair,
order independence, the bundled-only case, two competing installs still failing
closed, unknown-provenance rows keeping the previous rule, and out-of-scope org
rows. Everything in items 2, 3 and 5 above was measured **after** that fix.

## What is NOT claimed

**A production `next build` was not run, and the application was not served from
a production build.** Two independent reasons, neither of them a shortcut:

1. Serving a production build from a host checkout is **ratified unsupported** —
   `next.config.ts` sets `output: "standalone"`, and
   `docs/internals/decisions/production-runtime-contract.md` records that
   `next start` / `pnpm start` / a bare `node .next/standalone/server.js` from a
   host checkout aborts at boot by design. The production runtime is the image.
2. The marketplace install path under test cannot run in a production runtime
   against a lane-private catalog at all, for the hardcoded-storefront reason
   above.

A production build would therefore have proven the build compiles, not that any
of items 2 to 5 work. It was also not safe to attempt here: the repo's own CI
notes measure this build peaking well above the memory available on the lane
machine. **Draft ask for the owner: whether a production-image proof of the
bundled version is wanted as separate work, and on what builder.**

Two smaller disclosures:

- The proof runs with the setup wizard bypassed. That flag suppresses the setup
  gate only; it grants no authentication and changes nothing in the install,
  resolution or reconciliation paths under test.
- The provider-write seam was resolved by running the writer's own selection
  over the application's own canonical store, using the application's own policy
  function — not through a browser surface, because this connector's setup
  surface has no connection-save action. Setup and settings were both read from
  the browser.

## Reproducing

`README.md` in this directory carries the full sequence, the ports, the env and
the teardown.
