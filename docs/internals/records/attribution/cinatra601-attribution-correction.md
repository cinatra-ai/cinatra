# Attribution-record correction — #601 openai-connector promote (the Truthful Attribution protocol §5)

This note is the forward correction (truthful verification-record spec — the
Truthful Attribution protocol §5) for the attribution record that landed with
the squash merge of PR #601 (`fix(extensions): bundle openai-connector (promote
to required/system set)`, squash commit
`b5293b2780eb1b7e7aba81871b88ed775d9971f4`).

## What landed

PR #601 promotes `@cinatra-ai/openai-connector` into the static-bundled
required/system extension set so the prod image bundles and activates it (the
connector ships TypeScript source the runtime extension store refuses, so static
bundling is the only viable path). It adds the package to
`cinatra.systemExtensions` + `cinatra.extensions` in `package.json`, regenerates
the required + dev extension locks (`cinatra-required-extensions.lock.json`,
`cinatra-dev-extensions.lock.json`) and the committed generated maps
(`src/lib/generated/*`), and updates one host-import coverage test
(`scripts/audit/__tests__/required-extensions-cover-host-imports.test.mjs`). It
touches seven files, none of which matches any high-risk glob in
`.github/gate-suite.json` `highRiskPaths`. It was merged to `main` as squash
commit `b5293b2780eb1b7e7aba81871b88ed775d9971f4`.

## What was wrong

The #601 squash record carried `Assisted-by` only — it omitted the verification
arm entirely (no `Gate-suite`+`Accountable` machine arm, no `Reviewed-by` human
arm). The `truthful-attribution-gate` post-merge (default-branch push) arm on
`main` rejected it (verbatim job-log line):

```
[error] no-record: record invalid: no verification arm — need a Reviewed-by (human arm) or a Gate-suite+Accountable (gate arm)
```

The squash was produced by a coordinator `--admin` merge whose `--body` listed
the description + `Closes #595` + `Assisted-by` but never carried the arm
trailer, so the post-merge gate read the record as `no-record`.

## Root cause: an omitted merge-record arm, not a missing verification

The defect is **not** that #601 lacked verification. #601 is a non-high-risk
change (none of its seven files matches a high-risk glob), and its full
gate-suite ran green on the reviewed/merged head `8a61aa4` before merge — so the
**machine arm** (`Gate-suite` + `Accountable`) is the correct and sufficient
verification, and it was simply omitted from the squash body. The change was
additionally reviewed: @groganz approved PR #601 at the reviewed head `8a61aa4`,
tier=maintainer, non-self (PR author `groganz-bot[bot]`) — so the human arm was
independently available too.

## The correction

This forward, docs-only governance note records the verification arm omitted
from `b5293b2`. Its own squash carries `Correction-for: b5293b2…` plus the
machine arm (`Gate-suite: cinatra-core@2026.06.2` and the canonical
`Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)`), recorded at the
Accountable engineer's explicit direction. It is non-high-risk and changes no
runtime code.
