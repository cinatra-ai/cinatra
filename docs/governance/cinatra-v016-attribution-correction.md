# Attribution-record correction — v0.1.6 #737 + #745 server-side squashes, malformed model-id + omitted machine arm (the Truthful Attribution protocol §5)

This note is the forward correction (truthful verification-record spec — the
Truthful Attribution protocol §5) for the attribution records that landed with
two server-side `--admin` squash merges at the head of the v0.1.6 loop. Both
records carried the same two defects and the second one (`38aa9050c`) is the
default-branch tip that the post-merge `truthful-attribution-gate` failed on:

- `d0b693413c4e1296672eacb5ddf89c6b7c56c538` (PR #745, `chore(audit): reset
  route-graph ratchet baseline to absorb dashboards graph growth`) — the
  first-of-two strictly-ordered changes for cinatra-ai/cinatra#732 (baseline
  reset; CI wiring follows in PR-B).
- `38aa9050c31862b24e65d487f793cff2d60c1b2c` (PR #737, `feat(marketplace):
  restyle browse cards to the listing-card spec`) — the v0.1.6 default-branch
  tip; the post-merge push gate failed RED on this commit.

## What landed

Both changes are genuine, machine-arm-eligible **non-high-risk** merges:

- **#745** regenerates `scripts/audit/route-graph-ratchet.baseline.json` (the
  ratchet gate is still inert / not yet wired into CI) to absorb the legitimate
  `+10`-reachable-modules growth the four backend locked routes picked up from
  the dashboards runtime-cube + portlet-registries feature. The baseline path,
  `scripts/audit/**`, is outside the gate-suite `highRiskPaths` set.
- **#737** restyles the `/configuration/marketplace` storefront cards to the
  design-system listing-card spec (§IV) — an opt-in `variant="listing"` banner
  with a 46×46 square icon tile + a meta row; the new card-model fields
  (`install_count`, `icon_url`, `vendor_logo_url`, `sdk_abi_range`) are optional
  and normalize to null. It touches `packages/extensions`,
  `packages/marketplace-mcp-client`, `packages/sdk-ui`, and `src/components`.

Neither change touches a `.github/gate-suite.json` `highRiskPaths` glob (the
high-risk set is `**/auth/**`, `**/permissions/**`, `**/session/**`,
`.github/**`, `**/gate-suite.json`, `**/migrations/**`, `**/schema.prisma`,
release/publish scripts, `packages/sdk-extensions/**`, the extension-loader /
trust-gate / signature-gate / capability- and transport-registry trees, etc.).
So both are **non-high-risk** changes, eligible for the machine verification arm,
and both self-verified that way: every required context — `source-leak-gate`
and the pre-merge `truthful-attribution-gate` — concluded success on each
reviewed head before the admin squash.

## What was wrong

Each server-side squash record carried two defects that the post-merge
default-branch push gate flagged:

1. **Malformed `Assisted-by` model-id.** Both records carried
   `Assisted-by: Claude Code (claude-opus-4-8[1m])`. The gate's model-id charset
   is `[A-Za-z0-9._/:-]` (one-per-line `Assisted-by: <name> (<model-id>)`), which
   does **not** include `[` or `]`, so the `[1m]` context-window suffix made the
   trailer a malformed owned trailer. The accepted form is the bare base model-id
   `claude-opus-4-8` (no `[1m]` suffix).
2. **Omitted machine verification arm.** Neither record carried the
   `Gate-suite` + `Accountable` gate-arm trailers, so even setting the model-id
   aside the post-merge arm reported:

   ```
   truthful-attribution-gate [post-merge/enforce]: record invalid: no verification
   arm — need a Reviewed-by (human arm) or a Gate-suite+Accountable (gate arm)
   ```

The global commit-msg hook normalizes `Assisted-by` and ensures one is present,
but it intentionally does **not** rewrite a name/model-id (it never fabricates an
identity) and it strips `Gate-suite`/`Accountable` from non-correction working
commits; the server-side `--admin` squash also runs outside the local hook
entirely. So the precise base model-id and the machine arm must be carried in
the squash body by the merging lane — that is exactly what these two records
omitted. The changes themselves are genuine and machine-arm-eligible; only the
records were incomplete/malformed. Same recovery shape as
#734/#725/#721/#712/#691/#688/#687.

## The correction

This docs-only governance note (`docs/governance/**`, non-high-risk) supplies the
forward correction. Its squash record carries:

- `Correction-for: 38aa9050c31862b24e65d487f793cff2d60c1b2c` — the
  default-branch tip whose post-merge gate is red (a single machine-readable
  `Correction-for` per the §1 grammar; `d0b693413` is documented here in the
  ledger as the same-defect ancestor, but it is not the tip the gate evaluates,
  so it needs no second machine-readable correction);
- the two `Assisted-by` trailers in the gate's accepted base-model-id form
  (`Claude Code (claude-opus-4-8)` + `codex (gpt-5.5)`, no `[1m]` suffix); and
- the complete machine arm matching `.github/gate-suite.json`
  (`Gate-suite: cinatra-core@2026.06.4` +
  `Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)`).

This green tip supersedes the red record. No code, behavior, or app-surface
change; the #737 and #745 product trees are unchanged.

Corrected records (for the ledger):

```
# 38aa9050c31862b24e65d487f793cff2d60c1b2c (#737)
Assisted-by: Claude Code (claude-opus-4-8)
Assisted-by: codex (gpt-5)

# d0b693413c4e1296672eacb5ddf89c6b7c56c538 (#745)
Assisted-by: Claude Code (claude-opus-4-8)
Assisted-by: codex (gpt-5.5)
```

(Both are non-high-risk, so the verification arm of record for each is the
machine arm `Gate-suite: cinatra-core@2026.06.4` /
`Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)`, asserted in this
correction's squash record.)
