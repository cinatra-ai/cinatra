# Attribution-record correction — #685 marketplace install/update failure copy (the Truthful Attribution protocol §5)

This note is the forward correction (truthful verification-record spec — the
Truthful Attribution protocol §5) for the attribution record that landed with the
squash merge of PR #690 (`fix(marketplace): actionable, non-technical
install/update failure copy`, squash commit
`20bb651495c04947eb4235c6879437746d7ebeb2`), which closes #685.

## What landed

PR #690 replaces the single hardcoded marketplace install/update/restore failure
string (`"Could not install X. The package may be unavailable in the connected
registry."`) with plain-language, actionable, NON-technical end-user copy
classified from the merged install-failure taxonomy (marketplace#152's
`InstallFailureTaxonomy`). It adds a pure classifier+copy module
(`packages/extensions/src/screens/marketplace-failure-copy.ts`, a TS mirror of the
five taxonomy categories that fails safe to `unrecoverable`), makes the
install/update/restore form actions RETURN the classified category (a returned
value survives Next.js production masking, where a thrown message does not) while
logging the full technical error operator-side, and has the client form toast the
category-mapped copy. It also adds a source/component test appended to the
`packages/extensions` `test:invariants` list. It touches only
`packages/extensions/**` — none of which matches any high-risk glob in
`.github/gate-suite.json` `highRiskPaths` — so the change is non-high-risk and was
correctly machine-armed. It was merged to `main` as squash commit
`20bb651495c04947eb4235c6879437746d7ebeb2`.

## What was wrong

The #690 squash record carried a complete, valid machine arm
(`Gate-suite: cinatra-core@2026.06.4` + `Accountable: Sandro Groganz
<sandro@cinatra.ai> (@groganz)`), but the **`Assisted-by` model-id was
malformed**: it carried a `[1m]` context-window suffix that is outside the gate's
accepted model-id grammar (and the agent name was the bare model string rather
than the agent identifier).

```
Assisted-by: claude-opus-4-8 (claude-opus-4-8[1m])
```

The `truthful-attribution-gate` `Assisted-by` grammar
(`(?<model>[A-Za-z0-9._/:-]{1,64})`) does not permit the `[` / `]` characters, so
the trailer failed to match and the line was reported as
`malformed Assisted-by trailer`. The post-merge (default-branch push) arm on
`main` therefore went RED with `[no-record]` even though the change was a genuine,
correctly-machine-armed non-high-risk merge — only the record **format** was wrong
(the bracketed `[1m]` marker, not part of the canonical model id).

This is the same format defect corrected for #686 in
`docs/governance/cinatra686-attribution-correction.md`.

## The correction

The truthful record for `20bb651495c04947eb4235c6879437746d7ebeb2` is exactly the
one that landed, with the `Assisted-by` agent/model normalized to the gate's
accepted form (the `[1m]` suffix dropped — the model is `claude-opus-4-8` — and the
agent named `Claude Code`):

```
Assisted-by: Claude Code (claude-opus-4-8)
Assisted-by: Codex CLI (gpt-5.5)
Gate-suite: cinatra-core@2026.06.4
Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)
```

Nothing about the change's content, risk classification, or machine arm changes —
only the malformed `Assisted-by` token is corrected. This docs-only governance note
carries the `Correction-for:` trailer that the post-merge gate consumes to clear
the blocked line, plus its own valid machine arm.
