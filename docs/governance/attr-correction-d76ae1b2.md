# Attribution correction — d76ae1b2 (works-after SSE bridge contract, #1295)

The squash for the un-mocked SSE producer/parser bridge contract test
(`packages/a2a/src/__tests__/sse-bridge-contract.test.ts`, PR #1295, Refs #1147)
landed with an **`Accountable` trailer that omitted the `<email>` component
required by the gate grammar**:

    Accountable: Sandro Groganz (@groganz)

Because the `Accountable` line was malformed, the machine gate arm did not
resolve, so the post-merge `truthful-attribution-gate` push arm rejected the
record as "no verification arm". The change itself is unaffected: a non-high-risk,
test-only addition that was gate-suite green at the merged commit.

This forward, docs-only governance note records the **complete,
correctly-formatted** verification record for `d76ae1b2f497707c5da7519e8a348c4fdcac9a2b`:

    Assisted-by: Claude (claude-opus-4-8)
    Assisted-by: codex (gpt-5.5)
    Gate-suite: cinatra-core@2026.07.4
    Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)

No runtime code is changed by this note. Non-high-risk.
