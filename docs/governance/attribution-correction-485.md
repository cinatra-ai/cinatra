# Attribution-record correction — squash 30bc6f9b (PR #485)

Forward attribution-record correction (cinatra-engineering#119 §5) for the
closeout Wave 2 dead-code sweep squash
`30bc6f9bd147a26a9299e7a6dc7331fee25a9c5b` (PR #485).

The squash body placed `Closes #288` INSIDE the final trailer block, between
the `Accountable:` and `Assisted-by:` trailers. `Closes #288` is not a
recognized git trailer key, so it breaks the contiguous trailer block — the
post-merge `truthful-attribution-gate` parses the final block as pure trailers
and rejected the record with `[no-record] non-trailer line in the final trailer
block`. The underlying change (30 dead-file deletions, purely non-high-risk) and
its machine arm (`Gate-suite: cinatra-core@2026.06.2` + `Accountable: @groganz`)
were valid; only the record FORMAT was malformed by the stray `Closes` line.

This green tip supersedes the red one. The `Closes #288` linkage is preserved
out-of-band: eng#288 is closed manually with a link to this correction and to
PR #485. The machine arm is re-asserted below in a clean, contiguous trailer
block (the `Correction-for:` / `Closes` reference lives in the prose above, not
in the trailer block).

No code change; docs-only; non-high-risk.
