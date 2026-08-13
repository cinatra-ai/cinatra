# Attribution-record corrections

The mechanical record of a correction is its COMMIT MESSAGE: a commit whose
trailer block carries `Correction-for: <full sha>` repairs the record of the
named commit, and the attribution engine's re-verify path judges the repaired
record in the target's stead (first-parent discovery, latest-wins;
cinatra-ai/ci#93). This file is the human-readable mirror: each correction
commit appends its full corrected record here so the repair is visible in the
tree as well as in history. Never edit past entries.

---

## Correction for `faacc2445befd72822a95e53d356b110e7db0a59`

```
correction: truthful-attribution record for faacc2445

The record on faacc2445 ("ci: a registry-provisioned lane runs the #2675 preflight suite for real ") is incomplete under the
ratified record grammar: the Accountable line is missing.
This commit carries the corrected record verbatim. The change itself was approved,
gated, and is untouched — this corrects the RECORD only.

Gate-suite: cinatra-core@2026.08.1
Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)
Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)
Assisted-by: Claude Code (claude-sonnet-5)
Assisted-by: Codex (gpt-5.6-sol)
Correction-for: faacc2445befd72822a95e53d356b110e7db0a59```

---

## Correction for `7a997e1dd87d6e1e6a7cc1c8f6c30e0e76174f7d`

```
correction: truthful-attribution record for 7a997e1dd

The record on 7a997e1dd ("test(archive): #1943 the acceptance manifest reaches 14/15 with a red ha") is incomplete under the
ratified record grammar: the Accountable line is missing.
This commit carries the corrected record verbatim. The change itself was approved,
gated, and is untouched — this corrects the RECORD only.

Gate-suite: cinatra-core@2026.08.1
Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)
Assisted-by: Claude Code (claude-opus-5)
Assisted-by: Codex (gpt-5.6-sol)
Correction-for: 7a997e1dd87d6e1e6a7cc1c8f6c30e0e76174f7d```
