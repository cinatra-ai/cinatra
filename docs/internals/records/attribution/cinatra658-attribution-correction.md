# Attribution-record correction — #658 hot-install connector cards/setup-pages (the Truthful Attribution protocol §5)

This note is the forward correction (truthful verification-record spec — the
Truthful Attribution protocol §5) for the attribution record that landed with the
squash merge of PR #658 (`feat(connectors): runtime-sourced connector cards +
setup pages without rebuild`, squash commit
`fa853e9824c644dbc9f8a280a3da33667bef0ad0`).

## What landed

PR #658 is PR-4 of the v0.1.5 hot-installability work: it migrates the
`/connectors` card index off the static-only installed predicate onto the
runtime-sourced actor-scoped predicate, adds a runtime-only setup-route fallback,
extends the declarative setup DSL (`select` / `record-list` / `banner` /
`advisory`), binds the external-MCP write actions host-side (discovered from the
generated manifest — core names no extension), and bumps the
`@cinatra-ai/mcp-server-connector` dev-extension pin to its schema-config version
so the bundled exemplar renders without a rebuild. It touches host `src/` +
`packages/` code, the generated manifest, and the dev-extension lock — none of
which matches any high-risk glob in `.github/gate-suite.json` `highRiskPaths`, so
the change is non-high-risk and was correctly machine-armed. It was merged to
`main` as squash commit `fa853e9824c644dbc9f8a280a3da33667bef0ad0`.

## What was wrong

The #658 squash record carried a complete, valid machine arm
(`Gate-suite: cinatra-core@2026.06.4` + `Accountable: Sandro Groganz
<sandro@cinatra.ai> (@groganz)`), but the **`Assisted-by` model-id was
malformed**: it carried a `[1m]` context-window suffix that is outside the gate's
accepted model-id grammar.

```
Assisted-by: claude-code (claude-opus-4-8[1m])
```

The `truthful-attribution-gate` `Assisted-by` grammar
(`(?<model>[A-Za-z0-9._/:-]{1,64})`) does not permit the `[` / `]` characters, so
the trailer failed to match and the line was reported as
`malformed Assisted-by trailer`. The post-merge (default-branch push) arm on
`main` therefore went RED with `[no-record]` even though the change was a genuine,
correctly-machine-armed non-high-risk merge — only the record **format** was
wrong (the bracketed `[1m]` marker, not part of the canonical model id).

## The correction

The truthful record for `fa853e9824c644dbc9f8a280a3da33667bef0ad0` is exactly the
one that landed, with the `Assisted-by` model id normalized to the gate's accepted
form (the `[1m]` suffix dropped — the model is `claude-opus-4-8`):

```
Closes #658

Assisted-by: claude-code (claude-opus-4-8)
Assisted-by: codex (gpt-5.5)
Gate-suite: cinatra-core@2026.06.4
Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)
```

Nothing about the change's content, risk classification, or machine arm changes —
only the malformed `Assisted-by` model-id token is corrected. This docs-only
governance note carries the `Correction-for:` trailer that the post-merge gate
consumes to clear the blocked line, plus its own valid machine arm.
