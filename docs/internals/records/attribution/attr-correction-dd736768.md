# Attribution-record correction — dd736768 (proof artifacts leave the tree)

Forward correction (the Truthful Attribution protocol) for the verification record
of squash commit `dd736768963bc418907337d52f5ce1dc9ecf597b`
("chore(hygiene): proof artifacts leave the tree — evidence/ removed, gates read
pinned captures from history" — PR #3059).

## What landed
dd736768 removes the committed `evidence/` tree (82 folders, 1595 files), keeps the
two real test inputs as named fixtures, re-points the proof-of-record ledgers to
historical permalinks, and makes the capture gates read pinned artifacts from git
history and contain live captures by resolved path. The change is untouched by this
correction.

## What was wrong
The post-merge `truthful-attribution-gate` reported `tree-mismatch: tree(merged) !=
tree(reviewed head)`. The pull request's branch was two commits behind `main` when
it was squash-merged (the tier relocation and the second proof-dump removal had
landed after the branch was cut), so the landed tree is the branch's changes applied
onto the advanced `main`, not the branch head's own tree. The record's trailers were
well-formed and truthful; the binding of the machine arm to the landed tree could not
be established by the gate.

## Root cause: a behind branch was merged
The merge procedure verified the pinned head, every check on it, the required
contexts and the gate-suite version — but not that the branch was up to date with
`main`. Every required context ran on the pull request's merge ref (head + `main`),
which is the tree that landed; the reviewed head's tree simply was not that tree.
The procedure now refuses to merge a branch that is behind `main`.

## Corrected record
The machine arm is re-asserted for the landed tree by this correction, which is cut
from `main` at dd736768 itself so its own tree binding holds. The assistants are the
union of the merged branch's commit trailers and the agent producing this correction.

```
Gate-suite: cinatra-core@2026.08.4
Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)
Assisted-by: Claude Code (claude-opus-5)
Assisted-by: Claude Code (claude-fable-5)
Correction-for: dd736768963bc418907337d52f5ce1dc9ecf597b
```
