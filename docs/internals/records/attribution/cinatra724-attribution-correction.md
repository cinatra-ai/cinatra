# Attribution-record correction — #724 required-extension lock refresh, omitted machine arm (the Truthful Attribution protocol §5)

This note is the forward correction (truthful verification-record spec — the
Truthful Attribution protocol §5) for the attribution record that landed with the
squash merge of PR #724 (`chore(extensions): refresh required-extension acquisition
lock + regenerate manifest`, squash commit
`95dca5945acd5a3b6ed44fd0a608f61caf727199`).

## What landed

PR #724 is a v0.1.5 closeout (Wave 1, bounded currency) change that refreshes the
SHA-pinned prod-acquisition lock `cinatra-required-extensions.lock.json` over the
full required-extension set and regenerates the static manifest it feeds:

- `cinatra-required-extensions.lock.json`: all 9 required-extension entries
  re-pinned to their companion repo current `main`-head SHA with refreshed
  `treeSha256`. Version movement this milestone: `nango-connector` 0.1.2 → 0.1.4,
  `openai-connector` 0.1.3 → 0.1.5; the other 7 stay 0.1.0 (new SHA = post-tag
  comment/UI commits at the same package version). Every locked version satisfies
  the declared `^0.1.0` range in `cinatra.extensions`, so no range bump was
  required.
- `src/lib/generated/extensions.server.ts`: regenerated against the pinned-
  acquisition tree (`scripts/extensions/generate-extension-manifest.mjs`), picking
  up the bumped nango/openai versions and the `vendor` descriptor those releases
  now declare. Additive manifest metadata; no loader/auth behavior change.

Neither path is a `.github/gate-suite.json` `highRiskPaths` glob (the lock,
`packages/extensions`, and the generated tree are all outside the high-risk set).
So #724 is a **non-high-risk** change, eligible for the machine verification arm,
and it self-verified that way: the required-extension lock consistency suite, the
generated-manifest drift+parity gate (`--check`), the Presence-degraded
(required-only universe) build, and the `build` job (prod acquisition + boot e2e)
all concluded success on the PR before the admin squash.

## What was wrong

The squash record carried both `Assisted-by` trailers in the gate's accepted form
(`Claude Code (claude-opus-4-8)` + `codex (gpt-5.5)`) but **OMITTED the machine
verification arm** (no `Gate-suite` + `Accountable` trailers). The post-merge
default-branch push gate therefore went RED with:

```
[no-record] record invalid: no verification arm — need a Reviewed-by (human arm)
or a Gate-suite+Accountable (gate arm)
```

The change itself was a genuine, machine-arm-eligible non-high-risk merge with all
required contexts green; only the record was incomplete. Same recovery shape as
the #712 / #691 / #688 / #687 corrections.

## The correction

This docs-only governance note (under `docs/governance/**`, non-high-risk) supplies
the `Correction-for` trailer plus the complete machine arm for the malformed
record, greening `main` via the post-merge Correction-for mechanism.

Correction-for: 95dca5945acd5a3b6ed44fd0a608f61caf727199
