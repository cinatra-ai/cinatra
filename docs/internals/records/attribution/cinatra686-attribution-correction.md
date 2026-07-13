# Attribution-record correction — #686 outbound-webhook SSRF/egress guard (the Truthful Attribution protocol §5)

This note is the forward correction (truthful verification-record spec — the
Truthful Attribution protocol §5) for the attribution record that landed with the
squash merge of PR #686 (`feat(webhooks): SSRF/egress guard on the outbound webhook
delivery engine`, squash commit
`4f9982e99adb423fb9850422edfddb81186e8608`).

## What landed

PR #686 adds an SSRF/egress guard to the outbound webhook delivery engine
(`packages/webhooks`). `deliverOutbound` now validates the operator-supplied target
URL before sending and pins the connection to a validated address: an http/https
scheme allow-list, rejection of embedded credentials and internal host aliases, a
deny list for the IPv4/IPv6 special-use / private / loopback / link-local / ULA /
cloud-metadata ranges (with IPv4-mapped/-compatible/-translated/NAT64
unwrap-and-reclassify), DNS-resolve-then-recheck, and an undici connect-pinning
dispatcher for DNS-rebind defense. `redirect:"manual"` keeps an open redirect from
chaining into an internal address. A block is a permanent failure (dead-lettered,
no retry storm). It touches only `packages/webhooks/**` plus a single added
dependency line in `pnpm-lock.yaml` — none of which matches any high-risk glob in
`.github/gate-suite.json` `highRiskPaths` (verified with the gate's own
`globToRegExp` matcher), so the change is non-high-risk and was correctly
machine-armed. It was merged to `main` as squash commit
`4f9982e99adb423fb9850422edfddb81186e8608`.

## What was wrong

The #686 squash record carried a complete, valid machine arm
(`Gate-suite: cinatra-core@2026.06.4` + `Accountable: Sandro Groganz
<sandro@cinatra.ai> (@groganz)`), but the **`Assisted-by` model-id was
malformed**: it carried a `[1m]` context-window suffix that is outside the gate's
accepted model-id grammar.

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

## The correction

The truthful record for `4f9982e99adb423fb9850422edfddb81186e8608` is exactly the
one that landed, with the `Assisted-by` model id normalized to the gate's accepted
form (the `[1m]` suffix dropped — the model is `claude-opus-4-8`):

```
Assisted-by: Claude Code (claude-opus-4-8)
Assisted-by: Codex CLI (gpt-5.5)
Gate-suite: cinatra-core@2026.06.4
Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)
```

Nothing about the change's content, risk classification, or machine arm changes —
only the malformed `Assisted-by` model-id token is corrected. This docs-only
governance note carries the `Correction-for:` trailer that the post-merge gate
consumes to clear the blocked line, plus its own valid machine arm.
