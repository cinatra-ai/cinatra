# cinatra#2502 — setup wizard rail, rendered proof

Captured by `tests/e2e/setup/05-rail-spec-conformance.spec.ts` on the REAL
running wizard with `CINATRA_E2E_SETUP_BYPASS` unset, at the setup-acceptance
suite's two widths (`--medium` 1440×1100, `--narrow`). Checked against
`specs/app-setup.html` revision 0.3.0 at design commit
`052bfb5f5ec7545124e50d2adf656d9adc80eca1`.

| Capture | What it shows |
| --- | --- |
| `2502-01-presignup-rail-forecast` | §VI/§VII — the signed-out first screen: five pills including **Secrets**, one current, the rest upcoming, nothing checked, no green connector, nothing clickable. |
| `2502-02-midflow-done-current-upcoming` | §III — all three states side by side, with the green connector run over the passed prefix. |
| `2502-03-secrets-step-current-cardless` | §I/§VII — the Secrets step under its own name, fields directly on the column, no card. |
| `2502-04-secrets-passed-still-checked` | §III/§VII — **the regression this issue exists for**: the passed Secrets step is still on the rail, green and checked. It used to vanish here. |
| `2502-04b-secrets-revisit-link-lands` | §IV — clicking the passed Secrets pill LANDS on the step instead of bouncing forward (the `?stay=1` marker). |
| `2502-05-done-over-current-precedence` | §III — done wins over current: the step on screen is one the operator already passed, so it stays green and checked. |
| `2502-06-upcoming-return-link-focus-ring` | §IV — the navigable **upcoming** return link with its 2px focus ring (it had none). |
| `2502-07-upcoming-return-link-hover` | §IV — the same pill's hover lift (it had none). |
