# Attribution-record correction — #737 marketplace listing-card restyle (malformed model-id + omitted machine arm)

This note is the forward correction (truthful verification-record spec — the
Truthful Attribution protocol §5) for the attribution record that landed with the
squash merge of PR #737 (`feat(marketplace): restyle browse cards to the
listing-card spec`, squash commit
`38aa9050c31862b24e65d487f793cff2d60c1b2c`).

## What landed

PR #737 restyles the `/configuration/marketplace` browse cards to the
design-system listing-card spec (§IV): an opt-in `variant="listing"` banner with
a square icon tile + the name in the banner, an install-count meta line, and new
OPTIONAL card-model fields (`install_count`, `icon_url`, `vendor_logo_url`,
`sdk_abi_range`) that degrade gracefully. It touches only the extensions package, the vendored marketplace MCP client
package, the SDK-UI package, and `src/components/**` — none of which is a
`.github/gate-suite.json` `highRiskPaths` glob (the high-risk set is
`**/auth/**`, `**/permissions/**`, `**/session*`, `**/secrets/**`,
`**/migrations/**`, `.github/**`, `**/gate-suite.json`,
`packages/sdk-extensions/**`, release/publish scripts, etc.). So #737 is a
**non-high-risk** change, eligible for the machine verification arm.

## What was wrong with the record

The squash commit carried an Assisted-by-only record with two defects:

1. **Malformed `Assisted-by` model-id.** It read
   `Assisted-by: Claude Code (claude-opus-4-8[1m])` — the `[1m]` context-window
   suffix is not part of the model-id the gate accepts, so the gate flagged the
   trailer as malformed. The compliant model-id is `claude-opus-4-8`. The codex
   model-id was likewise off (`codex CLI (gpt-5)` → should be `codex (gpt-5.5)`).
2. **No verification arm.** The squash body omitted the machine arm entirely, so
   the post-merge `truthful-attribution-gate` failed closed with
   `no verification arm — need a Reviewed-by (human arm) or a
   Gate-suite+Accountable (gate arm)`.

## The correction

This correction supersedes the #737 record with a compliant one: the correct
`Assisted-by` model-ids plus the machine arm
(`Gate-suite: cinatra-core@2026.06.4` + `Accountable`), valid because #737 is
non-high-risk and every required check concluded success on the merged head
before merge. The product tree merged by #737 is correct and unchanged — only
the historical commit message's attribution record was non-compliant.

Correction-for: 38aa9050c31862b24e65d487f793cff2d60c1b2c
