# PR #1003 (card-siv-988) — §IV listing-card close-proof screenshots

Real-surface evidence, replacing the earlier fixture-page renders (owner
ruling: the purpose-built `/design-fixtures` §IV fixture section was
unnecessary and has been stripped from the PR — "you had everything you
needed").

**Surface:** `/configuration/marketplace`, standalone production build
(`pnpm build` + `node server.js`, `CINATRA_DISABLE_REQUIRED_EXTENSION_MATERIALIZE`),
listings seeded via the real dev-sync catalog (no synthetic six-state
fixture data).

## Files

- `marketplace-real-light.png` / `marketplace-real-dark.png` — first
  viewport of the live catalog grid, light + dark.
- `marketplace-real-statemix-light.png` / `-dark.png` — a grid region
  showing several CTA states side by side (Install now / Update now /
  Installed / Restore), also evidencing equal-height rows (§IV item 6).
- `card-install-light.png`, `card-installed-{light,dark}.png`,
  `card-update-{light,dark}.png`, `card-restore-{light,dark}.png` —
  per-card close-ups: banner (icon tile + name only, no badge stack),
  publisher line, centred price row, underlined "More details" link,
  two-column footer meta.
- `marketplace-detail-modal-{light,dark}.png` — the "More details" modal
  trigger (item 4), light + dark.

## Item-by-item (live-screenshotable vs test-exercised)

| # | §IV item | Live-screenshotable here? |
|---|----------|---------------------------|
| 1 | Banner = icon tile + name only, no badge stack | Yes — every card |
| 2 | Publisher line ({Type} by {Vendor}) | Yes — every card |
| 3 | Centred price row | Yes — every card ("Free, Open Source") |
| 4 | "More details" underlined link + modal | Yes |
| 5 | Two-column footer meta | Yes |
| 6 | Equal-height grid rows | Yes — `marketplace-real-statemix-*` |
| 8a | Install now / Installed / Update now / Restore CTA states | Yes — all four appear naturally in the dev-sync catalog |
| 8b | Installing… (pending-submit spinner) | **No** — every Install/Update CTA in this environment is disabled ("Connect the package registry to install/update"); the transient pending state cannot be triggered without a connected package registry. Test-exercised only (`marketplace-install-form.tsx` behaviour, unit-covered) |
| 8c | Incompatible (unsatisfiable `sdkAbiRange`, greyed CTA + red-triangle badge) | **No** — the real dev-sync catalog carries no extension with an unsatisfiable ABI range, so this state does not occur naturally on the live surface. Test-exercised only, via `marketplace-card-model.test.ts` (the six-state CTA resolver, kept in the product diff) |

Vendor/vendor-link + VERIFIED check (part of item 2) is visible in the
detail modal ("Connector by **Cinatra Auto Approver**" — an underlined
link); no card in the synced catalog carries a vendor block wired to a
live store URL, so the check-mark itself is not shown on a card in this
capture — also test-exercised (`marketplace-card-model.test.ts` vendor
mapping cases).

## 2026-07-05 refresh — owner CHANGES_REQUESTED fix pass (three real §IV card bugs)

The owner's 2026-07-05T11:03 review flagged three additional real bugs in the
§IV `MarketplaceListingCard` (beyond the `/design-fixtures` removal above,
already fixed at that point). `marketplace-real-{light,dark}.png` and
`marketplace-detail-modal-{light,dark}.png` above are REPLACED with a fresh
capture off the fixed code (same standalone-production recipe, same real
public storefront catalog); the `card-install-*` / `card-installed-*` /
`card-update-*` / `card-restore-*` / `marketplace-real-statemix-*` CTA-state
screenshots are UNCHANGED from the prior capture (they evidence CTA-state
rendering, not the three bugs below, and are unaffected by this fix pass).

New close-up files added this pass:

- `compat-meta-closeup-{light,dark}.png` — a card's full footer-meta row.
- `compat-fontsize-closeup-{light,dark}.png` — just the compat element,
  cropped tight, proving the correct small (`text-badge-xs`, 10px) mono
  treatment survived the fix (see item 1 below).
- `card-banner-vendor-logo-{light,dark}.png` — an icon tile now rendering
  the extension's REAL vendor logo (the cinatra-ai mustard fedora mark),
  where before it always fell back to a generic kind pictogram.
- `card-banner-kind-fallback-{light,dark}.png` — a different card whose
  vendor-logo asset didn't load, gracefully degrading to the kind-emblem
  glyph instead of a blank/broken tile.

### 1. "'compatible' is not supposed to be a badge."

Spec `specs/app.html` §IV L481/L631: the compat verdict is a **plain**
icon+text row (font-mono 10px), not a pill — identical anatomy to "Updated N
ago" beneath it. The card's `<ExtensionCompatBadge>` (a shadcn `Badge`) is
replaced with a local `CompatMeta` presentational function: Compatible → blue
check + ink label; Incompatible → destructive-red triangle + label; Unknown
(no declared ABI range) → neutral muted, same anatomy, never green.

`compat-meta-closeup-*.png` / `compat-fontsize-closeup-*.png` show the fixed
render. **Codex-caught regression in the first fix attempt** (adopted before
this capture): `CompatMeta`'s className was built via the app's plain
`cn()` (`@/lib/utils`, not the `sdk-ui` EXTENDED tailwind-merge), which
silently drops the `text-badge-xs` SIZE token whenever it's merged with a
text-COLOR class in the same call (`twMerge("font-mono text-badge-xs",
"text-foreground")` → `"font-mono text-foreground"` — empirically verified,
and the same trap the codebase's own `extension-card.tsx` docstring already
warns about). Fixed by building the className via plain string
concatenation instead of `cn()` (matching the `RatingRow` precedent already
in this diff) — `compat-fontsize-closeup-*.png` is the tight crop proving
the row renders at the correct small size, not the default/inherited size
the bug would have produced.

### 2. "Why is the PDF Extractor square green without a logo?"

Live-probed the real public storefront catalog
(`https://marketplace.cinatra.ai/wp-json/cinatra/v1/extensions`): every one
of 83 real listings serves `icon_url`/`vendor_logo_url` as a WP-media
descriptor object `{url, width, height}` — the same shape the detail
endpoint's `icon_url` already carries — but the catalog TYPE + mapper treated
these fields as a bare `string`, so the normalizer silently discarded every
real vendor-logo/icon URL (a `typeof` check rejects an object), and every
card always fell through to the generic kind-emblem pictogram. Fixed via a
new `normalizeCatalogAssetUrl()` that unwraps `.url` (accepting a legacy bare
string too), plus a new `ExtensionCardIconImage` client component that
degrades to the kind-emblem glyph on an image *load* failure (not just URL
absence) — the tile can no longer go blank.

`card-banner-vendor-logo-*.png` shows a card now rendering the real
cinatra-ai vendor logo; `card-banner-kind-fallback-*.png` shows a different
card gracefully falling back to its kind emblem (never blank) when its own
logo asset didn't load. Both behaviors are visible side-by-side across the
grid in the refreshed `marketplace-real-*.png`.

### 3. "Stars / rating has the wrong colours."

Spec §IV L477 draws stars `#f5a623` (filled) / `#d0cbbd` (empty). The app's
`globals.css` already defines matching named tokens `--rating-star` /
`--rating-star-muted` (exposed as `text-rating-star` / `text-rating-star-muted`,
already used by the §V detail-modal's own review stars) — the card's
`RatingRow` was instead using `text-foreground` + `opacity-40`, plain grey.
Fixed by switching to the existing named tokens (no new raw hex
introduced). Visible in every card's footer meta in the refreshed
`marketplace-real-*.png` / `compat-meta-closeup-*.png`.

### Two coordinator fold-ins (not separate bugs)

- **"Still not showing the human readable name."** Confirmed the card
  already prefers `display_name` over the package name (existing passing
  unit test); live-probed the real catalog and found **all 83 listings
  currently have `display_name === package_name` at the source** — a
  storefront/dev-sync data-population gap, not a card rendering bug. No card
  code change. Visible as-is in `marketplace-real-*.png` (titles still read
  as `@cinatra-ai/…` package names).
- **"Modal design is wrong."** The owner's review commit predates this
  branch's merge-up with `main`, which had already landed the owner-approved
  §V detail-modal (#995). Re-rendered fresh from the current branch head:
  `marketplace-detail-modal-{light,dark}.png` confirms the light-panel hero,
  no banner, primary right-aligned Install now, and plain "Compatible up to"
  specs row — matches #995 exactly, no divergence found.

### Codex convergence

Round-0 found one MAJOR (the `text-badge-xs` cn()-merge drop above — adopted)
and one MINOR/candidate (the image-load-error fallback goes straight to the
kind-emblem rather than retrying the *other* fallback-chain link first, e.g.
`iconUrl` 404s but `vendorLogoUrl` was also available — rebutted: the live
catalog's `icon_url` is always null in practice so this doesn't currently
occur, and the owner's "never blank" requirement is already satisfied by the
single-link degrade). No other findings.
