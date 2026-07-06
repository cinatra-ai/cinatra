# Attribution-record correction — 05ed5e5b (nango env-override precedence)

Forward correction (the Truthful Attribution protocol) for the verification record
of squash commit `05ed5e5b0289f365abc248130f71abbb3b726f4a`
("feat(nango): host-side env-override precedence on the connector-config capability
(#982 Option A)" — PR #1063).

## What landed
05ed5e5b implements the owner-approved Option A for #982's remaining scope:
host-side env-override precedence on the connector-config capability, with the
env-var names sourced solely from the connector manifest's `cinatra.envOverrides`
declaration. It touches six files (the new resolver module + tests, the nango
system wiring, the connections setup page, and the route-graph ratchet baseline).

## What was wrong
The 05ed5e5b squash carried an `Assisted-by` line whose model field was the Codex
CLI **version string**, not a model id:

    Assisted-by: Codex CLI (codex-cli 0.142.5)

`codex-cli 0.142.5` contains a space, which the gate's model-id grammar
(`ASSISTED_RE`, charset `[A-Za-z0-9._/:-]{1,64}`) rejects, so the post-merge
`truthful-attribution-gate` failed with `no-record: malformed Assisted-by trailer`.
The record was otherwise truthful: the named agents did materially change the
diff; only the Codex model field was mis-stated as a CLI version.

## Root cause: a malformed model id, not a wrong or missing attribution
The Codex CLI convergence reviewer's findings materially changed the diff, so its
`Assisted-by` line belongs in the record — but the model field must carry the
model id (`gpt-5.5`), not the CLI's own version. The verification arm on 05ed5e5b
was present and valid (machine arm `Gate-suite: cinatra-core@2026.07.2` +
`Accountable`). Additionally, the owner's real GitHub approval of PR #1063 exists
on the PR at head `651d7fcf`.

## The corrected truthful record for 05ed5e5b
The agents + models that materially changed the diff:

- `Assisted-by: Claude Code (claude-opus-4-8)`
- `Assisted-by: Claude Code (claude-fable-5)`
- `Assisted-by: Codex CLI (gpt-5.5)`

Verification arm (machine): `Gate-suite: cinatra-core@2026.07.2`,
`Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)`.

## The correction
This forward, docs-only note records the corrected `Assisted-by` set for 05ed5e5b.
Its own squash carries `Correction-for: 05ed5e5b…` plus the corrected trailers and
the machine arm. It is non-high-risk and changes no runtime code.
