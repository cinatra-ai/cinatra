# Attribution correction: prose-joined trailer blocks on three 2026-08-04 merge records

Three squash records on main are invalid under the truthful-attribution grammar and
are corrected by this record. In all three cases the underlying verifications were
real; the transcribed records were malformed by a single coordinator-side assembly
defect: the squash body's descriptive paragraph was joined directly to the trailer
lines with no blank line between them, so the final block contains a non-trailer
line and the record fails as "a record cannot hide behind prose".

## 13b57a16dc6c956884e587de10c87adbc8740640 (PR #2425, lifecycle capability for the settings affordances)

The true, verifiable state: the diff was produced with Claude Code (claude-opus-5)
and Codex (gpt-5.6-sol) assistance; the change touched no high-risk path; every
required context concluded success at the reviewed head, satisfying the
cinatra-core@2026.07.8 gate arm with the Accountable engineer as committed.

## 77cc16561ba161969376c1ead9641b3d478b7327 (PR #2426, skills-drift-gate caller pin advance)

The true, verifiable state: the diff was produced with Claude Code (claude-opus-5)
assistance; the change touched a high-risk workflow path and was backed by a real
maintainer-tier approval by @groganz at the exact reviewed head
(aec7015fafffbe7edcd0997b4fd5c05da5564810), with the designed-red attribution check
re-run green there before merging.

## 4819b1fee678e2572d121f07975421d72c8a4e2f (PR #2427, extension-readme-gate base resolution)

The true, verifiable state: the diff was produced with Claude Code (claude-opus-5)
and Codex (gpt-5.6-sol) assistance; the change touched a high-risk workflow path and
was backed by a real maintainer-tier approval by @groganz at the exact reviewed head
(8fa116743c87b8da09f15727ce9d17a7e96c93d4), with the designed-red attribution check
re-run green there before merging.

Process fix applied coordinator-side: squash bodies are assembled with an explicit
blank line before the trailer block, and the pre-merge validator now asserts the
paragraph boundary (a body whose trailers touch prose is rejected before the merge
call is issued).
