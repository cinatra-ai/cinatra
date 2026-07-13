# Attribution correction — a01adbd5 (extensions layout 0.5.0, #1273)

The squash for the Extensions layout 0.5.0 change (PR #1273, Closes #1246)
landed with an **`Accountable` trailer that omitted the `<email>` component
required by the gate grammar**:

    Accountable: Sandro Groganz (@groganz)

Because the `Accountable` line was malformed, the machine gate arm did not
resolve, so the post-merge `truthful-attribution-gate` push arm rejected the
record as "no verification arm". The change itself is unaffected: a non-high-risk,
UI-layout change that was gate-suite green at the merged commit.

This forward, docs-only governance note records the **complete,
correctly-formatted** verification record for `a01adbd5cefb1b2efbfd3033b75b081e114b160a`:

    Assisted-by: Claude Code (claude-opus-4-8)
    Assisted-by: Codex (gpt-5.5)
    Gate-suite: cinatra-core@2026.07.4
    Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)

No runtime code is changed by this note. Non-high-risk.
