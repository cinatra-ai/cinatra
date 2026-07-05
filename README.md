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
