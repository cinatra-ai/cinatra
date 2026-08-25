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

---

## Correction for `df27cbee808f2b21d957fd5dc0d48db7d376ccd7`

```
correction: truthful-attribution record for df27cbee8

The record on df27cbee8 ("ci: the archive-acceptance gate honors its dependencies and stages stric") is incomplete under the
ratified record grammar: the Accountable line is missing.
This commit carries the corrected record verbatim. The change itself was approved,
gated, and is untouched — this corrects the RECORD only.

Gate-suite: cinatra-core@2026.08.1
Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)
Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)
Assisted-by: Claude Code (claude-sonnet-5)
Correction-for: df27cbee808f2b21d957fd5dc0d48db7d376ccd7```

---

## Correction for `409b1f2ebf13b24a2ec9d35d4588bad0fdc8339b`

```
correction: truthful-attribution record for 409b1f2eb

The record on 409b1f2eb ("test(archive): #1943 the live three-role proof — row 15 green, strict RE") is incomplete under the
ratified record grammar: the Accountable line is missing.
This commit carries the corrected record verbatim. The change itself was approved,
gated, and is untouched — this corrects the RECORD only.

Gate-suite: cinatra-core@2026.08.1
Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)
Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)
Assisted-by: Claude Code (claude-opus-5)
Assisted-by: Codex (gpt-5.6-sol)
Correction-for: 409b1f2ebf13b24a2ec9d35d4588bad0fdc8339b```

---

## Correction for `8a83cf09002bd28e545dbe357298eef7902275e1`

```
correction: truthful-attribution record for 8a83cf090

The record on 8a83cf090 ("feat(chat-hitl): #2577 + #2575 — the widget is a full-parity lifecycle s") is incomplete under the
ratified record grammar: the Accountable line is missing, and one Assisted-by line names a serving alias (claude-opus-5[1m]) instead of the model id.
This commit carries the corrected record verbatim. The change itself was approved,
gated, and is untouched — this corrects the RECORD only.

Gate-suite: cinatra-core@2026.08.1
Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)
Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)
Assisted-by: Claude Code (claude-opus-5)
Assisted-by: Codex (gpt-5.6-sol)
Correction-for: 8a83cf09002bd28e545dbe357298eef7902275e1```

---

## Correction for `d7ff228f89addacb8ead2d63832863d7f4b7b3ff`

```
correction: truthful-attribution record for d7ff228f8

The record on d7ff228f8 ("feat(chat-hitl): #2674 the iframe owns the widget sign-in") asserts a
Gate-suite arm at cinatra-core@2026.08.2. That claim cannot verify: the branch forked
before the engine-pin move (#2706), so its required-context runs reference the prior
pin — the gate arm is structurally unverifiable for a pin-transition-spanning merge.
The merge WAS gated (all required contexts green at the reviewed head) and humanly
approved; the corrected record carries the human arm only, per the pin-advance
precedent. The change itself is untouched — this corrects the RECORD only.

Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)
Assisted-by: Claude Code (claude-opus-5)
Assisted-by: Codex (gpt-5.6-sol)
Correction-for: d7ff228f89addacb8ead2d63832863d7f4b7b3ff
```

---

## Correction for `ed215702ae06aa726b2c23ebbe688dbd3455b119`

```
correction: truthful-attribution record for ed215702a

The record on ed215702a ("fix(runtime): derive the model-bridge output_schema from each node's declared outputs — a credential-free run reaches an artifact (#2949)") is malformed under the ratified record grammar: the Gate-suite line carries an empty version (a shell-quoting failure at merge time swallowed the value). The change itself was gated — all required contexts green at the reviewed head 30eb4b153e4a38f594705333c933361ce031a972 — and is untouched; this corrects the RECORD only.

Gate-suite: cinatra-core@2026.08.3
Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)
Assisted-by: Claude Code (claude-fable-5)
Correction-for: ed215702ae06aa726b2c23ebbe688dbd3455b119```

---

## Correction for `871443b9b7b655da90bd30046b4e477ab13792ef`

```
correction: truthful-attribution record for 871443b9b

The record on 871443b9b ("ci(build-image): un-serialize the image build + shard the perpetual gates — wall ~19 → ~13-14 min (#2962)") is invalid under the ratified record grammar: a high-risk change (.github/**) merged with no verification arm — the human approval existed but no Reviewed-by trailer carried it into the record. The change was humanly approved by @groganz at the reviewed head f87cf995e0eba1fe86ca171eeb7c4b12d08044eb (PR #2962) with every required context green after the post-approval gate rerun; the corrected record carries that human arm. The change itself is untouched — this corrects the RECORD only.

Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)
Assisted-by: Claude Code (claude-fable-5)
Correction-for: 871443b9b7b655da90bd30046b4e477ab13792ef
```

---

## Correction for `3ceba8711c35760c1d956c373154df7911d2c262`

```
correction: truthful-attribution record for 3ceba8711

The record on 3ceba8711 ("ci: consolidate 12 micro-gate workflows into gates.yml (~12 runner slots per PR) (#2963)") is invalid under the ratified record grammar: a high-risk change (.github/**) merged with no verification arm, and its Assisted-by line was malformed (comma-joined agents and a serving alias claude-opus-5[1m] instead of the model id). The change was humanly approved by @groganz at the reviewed head 5056f76a72a29677811f0313342c67e10d5eefdb (PR #2963) with every required context green after the post-approval gate rerun; the corrected record carries that human arm and one well-formed Assisted-by line per agent. The change itself is untouched — this corrects the RECORD only.

Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)
Assisted-by: Claude Code (claude-fable-5)
Assisted-by: Claude Code (claude-opus-5)
Correction-for: 3ceba8711c35760c1d956c373154df7911d2c262
```

---

## Correction for `871443b9b7b655da90bd30046b4e477ab13792ef`

```
correction: truthful-attribution record for 871443b9b (v2)

The record on 871443b9b ("ci(build-image): un-serialize the image build + shard the perpetual gates (#2962)") lacked a verification arm for a high-risk change. The prior correction attempt (5901ca07) asserted the human arm through an UNAPPROVED landing and was rightly flagged; THIS correction lands via an owner-approved PR. The underlying change was humanly approved by @groganz at the reviewed head f87cf995e0eba1fe86ca171eeb7c4b12d08044eb (PR #2962), every required context green after the post-approval rerun. The change itself is untouched — this corrects the RECORD only.

Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)
Assisted-by: Claude Code (claude-fable-5)
Correction-for: 871443b9b7b655da90bd30046b4e477ab13792ef
```

---

## Correction for `3ceba8711c35760c1d956c373154df7911d2c262`

```
correction: truthful-attribution record for 3ceba8711 (v2)

The record on 3ceba8711 ("ci: consolidate 12 micro-gate workflows into gates.yml (#2963)") lacked a verification arm for a high-risk change and carried a malformed Assisted-by line (comma-joined agents; serving alias claude-opus-5[1m]). The prior correction attempt (770744b74) asserted the human arm through an unapproved landing and was rightly flagged; THIS correction lands via an owner-approved PR. The underlying change was humanly approved by @groganz at the reviewed head 5056f76a72a29677811f0313342c67e10d5eefdb (PR #2963), every required context green after the post-approval rerun. The change itself is untouched — this corrects the RECORD only.

Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)
Assisted-by: Claude Code (claude-fable-5)
Assisted-by: Claude Code (claude-opus-5)
Correction-for: 3ceba8711c35760c1d956c373154df7911d2c262
```

---

## Correction for `5901ca07cb3f42945fc5a06b34f26ce092dfd8b6`

```
correction: truthful-attribution record for 5901ca07

The record on 5901ca07 (correction attempt for 871443b9b) asserted a maintainer-tier human arm, but the commit landed through PR #2964 with no review by the named login — the fabrication flag was correct. The commit is a docs-only ledger append (no high-risk path), so its corrected record carries the gate arm. Its Correction-for assertion is superseded by the v2 correction above (latest-wins).

Gate-suite: cinatra-core@2026.08.3
Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)
Assisted-by: Claude Code (claude-fable-5)
Correction-for: 5901ca07cb3f42945fc5a06b34f26ce092dfd8b6
```

---

## Correction for `770744b74613706220430b640ad4a73369f7ab86`

```
correction: truthful-attribution record for 770744b74

The record on 770744b74 (correction attempt for 3ceba8711) asserted a maintainer-tier human arm, but the commit landed through PR #2964 with no review by the named login — the fabrication flag was correct. The commit is a docs-only ledger append (no high-risk path), so its corrected record carries the gate arm. Its Correction-for assertion is superseded by the v2 correction above (latest-wins).

Gate-suite: cinatra-core@2026.08.3
Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)
Assisted-by: Claude Code (claude-fable-5)
Correction-for: 770744b74613706220430b640ad4a73369f7ab86
```

---

## Correction for `3fa0807e4b493611f6fc1aa09fbdd07bae4147e7`

```
correction: truthful-attribution record for 3fa0807e4

The record on 3fa0807e4 ("fix(chat): the canonical scoped-agent dispatch form streams (#2912)") asserted `Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)`, but no review by @groganz exists on PR #2912 — the fabrication flag was correct. The review actually performed is the bound APPROVAL by @groganz-bot at the merged head `31df9e974abda9a8c825adbc3ee5d302ad84a979` (round 6, submitted 2026-08-24T22:11:57Z), with every required context green at that head. The coordinator wrote the human-arm identity from the review request target instead of the approving login; the change itself is untouched — this corrects the RECORD only. The corrected record drops the fabricated human arm and carries the gate arm plus the bot review as performed; this correction lands via an owner-approved PR, and the owner's approval of THIS correction is the human ratification of that record.

Gate-suite: cinatra-core@2026.08.3
Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)
Assisted-by: Claude Code (claude-opus-5)
Assisted-by: Claude Code (claude-fable-5)
Correction-for: 3fa0807e4b493611f6fc1aa09fbdd07bae4147e7
```

---

## Correction for `c2eb50a75a619d61f507c17cd71617f6a99fc1af`

```
correction: truthful-attribution record for c2eb50a75

The record on c2eb50a75 ("feat(lifecycle): the schedule card through its states in the chat and on the run page — S9d rework (#2939)") is true in every line it asserts, and the gate's single finding on it is the tree-identity bridge: tree(c2eb50a75) = 13103a84945772f951470e65a7bfe3fc291b397c differs from tree(b0a9fe9d79) = 849873c8a2704cdb0ddbcca5bc0b1f970046a085, the reviewed head. PR #2939 was approved by @groganz at b0a9fe9d790f5c6bfda84743513b4af762b28c56 on 2026-08-25T04:34:38Z — that login's latest review, tier=maintainer, non-self (the PR author is @groganz-bot). The branch was ALREADY behind main at that moment and was never brought up to date: main had advanced by 3fa0807e4b493611f6fc1aa09fbdd07bae4147e7 (the squash of #2912) at 2026-08-25T01:12:02Z, three hours before the approval, and 3fa0807e4 is not an ancestor of b0a9fe9d79. The coordinator loop then performed the merge at 2026-08-25T05:00:07Z under the maintainer's login (GitHub records merged_by @groganz), onto that moved tip; main's protection does not require a branch to be up to date (strict=false), so no up-to-date check ran and the branch was not refreshed first. That intervening squash is the SOLE difference between the reviewed tree and the landed tree: the diff b0a9fe9d79..c2eb50a75 is byte-identical to the diff 95f3dd651..3fa0807e4 (9 files, 788 insertions, 11 deletions; stable patch-id db76c31cf0d29a53a1099f699217403ff56f4d8d on both sides). The landed change IS the reviewed change: the engine's content bridge re-derives fingerprint 98b4cbef5f9507551e9930576825c5170fa0eba2eec0e0120a93d5a48642dee4 on both sides wherever b0a9fe9d79 resolves — and on the origin that commit is reachable only through refs/pull/2939/head, which the gate's checkout does not fetch, so the bridge cannot decide and falls through to the tree finding. This correction therefore restates the record truthfully; it does not by itself clear the finding, which is a fact about c2eb50a75's context, not about its record. The merged change itself is untouched — this corrects the RECORD only. #2939 is high-risk under the live suite (src/lib/trigger-schedule-proposal-token.ts matches src/lib/**/*token*.ts), so the corrected record carries the maintainer human arm exactly as it was performed on #2939; this correction is submitted for the maintainer's approval, and that approval on the correction PR is the human ratification of this record.

Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)
Assisted-by: Claude Code (claude-opus-5)
Assisted-by: Claude Code (claude-fable-5)
Assisted-by: Codex (gpt-5.6-sol)
Correction-for: c2eb50a75a619d61f507c17cd71617f6a99fc1af
```

---

## Correction for `da9b71c24e55b21e1ffbf0b2f3ee1a6f92f27b8c`

```
correction: verification record for da9b71c24 (correction: truthful-attribution record for 8a83cf090)

The record on da9b71c24 ("correction: truthful-attribution record for 8a83cf090") cites `Gate-suite:
cinatra-core@2026.08.1`. That version is true of the commit this record repairs —
.github/gate-suite.json at 8a83cf090 reads cinatra-core@2026.08.1 — but the engine reads the suite
at the RECORD's own merged sha, and at da9b71c24 the committed suite reads cinatra-core@2026.08.2:
576297d34a45c2f7f61abf0ce385e805366efc12 (#2706) advanced the pin from cinatra-core@2026.08.1 to
cinatra-core@2026.08.2 earlier the same day, and this record landed after it — no commit of PR #2709
touched .github/gate-suite.json. The gate arm is therefore structurally unverifiable for this
record: it is the pin-transition class already on record for d7ff228f8.

What was verified at the time is unchanged by any of this. PR #2709 was approved by @groganz at
ca36beaf17e8d7ae1b8c43e01cc00eb8bc88a5d3 on 2026-08-13T13:33:16Z — that login's latest non-dismissed
review, APPROVED at the reviewed head, non-self (the pull request's author is @groganz-bot[bot]),
and that login's repository permission is admin, which meets tier=maintainer. Both required contexts
named by the suite concluded at that reviewed head: `source-leak-gate / source-leak-gate` success;
`truthful-attribution-gate / truthful-attribution-gate` success. Separately, the suite committed at
the merged sha reads cinatra-core@2026.08.2.

The corrected record carries the human arm only, per the pin-advance precedent set by the correction
for d7ff228f8, which landed in this same batch and stands unflagged.

The `Assisted-by` lines are this record's own assistants — carried over verbatim where the original
lines were well-formed, repaired from the pull request's own commits where they were not — together
with the agents that produced this correction, deduplicated on name and model id. No assistant the
original record named is dropped, and none is invented; the lines added beyond the original set are
the correcting agents, named as such.

The merged change itself is untouched — this repairs the RECORD only. This correction is submitted
for the maintainer's approval, and that approval on the correction pull request is the human
ratification of the record it states.

Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)
Assisted-by: Claude Code (claude-opus-5)
Assisted-by: Codex (gpt-5.6-sol)
Correction-for: da9b71c24e55b21e1ffbf0b2f3ee1a6f92f27b8c
```

---

## Correction for `dfb4822b96efd81aad8cc0049e2756d686c5e33f`

```
correction: verification record for dfb4822b9 (correction: truthful-attribution record for 409b1f2eb)

The record on dfb4822b9 ("correction: truthful-attribution record for 409b1f2eb") cites `Gate-suite:
cinatra-core@2026.08.1`. That version is true of the commit this record repairs —
.github/gate-suite.json at 409b1f2eb reads cinatra-core@2026.08.1 — but the engine reads the suite
at the RECORD's own merged sha, and at dfb4822b9 the committed suite reads cinatra-core@2026.08.2:
576297d34a45c2f7f61abf0ce385e805366efc12 (#2706) advanced the pin from cinatra-core@2026.08.1 to
cinatra-core@2026.08.2 earlier the same day, and this record landed after it — no commit of PR #2709
touched .github/gate-suite.json. The gate arm is therefore structurally unverifiable for this
record: it is the pin-transition class already on record for d7ff228f8.

What was verified at the time is unchanged by any of this. PR #2709 was approved by @groganz at
ca36beaf17e8d7ae1b8c43e01cc00eb8bc88a5d3 on 2026-08-13T13:33:16Z — that login's latest non-dismissed
review, APPROVED at the reviewed head, non-self (the pull request's author is @groganz-bot[bot]),
and that login's repository permission is admin, which meets tier=maintainer. Both required contexts
named by the suite concluded at that reviewed head: `source-leak-gate / source-leak-gate` success;
`truthful-attribution-gate / truthful-attribution-gate` success. Separately, the suite committed at
the merged sha reads cinatra-core@2026.08.2.

The corrected record carries the human arm only, per the pin-advance precedent set by the correction
for d7ff228f8, which landed in this same batch and stands unflagged.

The `Assisted-by` lines are this record's own assistants — carried over verbatim where the original
lines were well-formed, repaired from the pull request's own commits where they were not — together
with the agents that produced this correction, deduplicated on name and model id. No assistant the
original record named is dropped, and none is invented; the lines added beyond the original set are
the correcting agents, named as such.

The merged change itself is untouched — this repairs the RECORD only. This correction is submitted
for the maintainer's approval, and that approval on the correction pull request is the human
ratification of the record it states.

Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)
Assisted-by: Claude Code (claude-opus-5)
Assisted-by: Codex (gpt-5.6-sol)
Correction-for: dfb4822b96efd81aad8cc0049e2756d686c5e33f
```

---

## Correction for `b8c27563d0eeb0e3c2a1f1a05727c2222e943898`

```
correction: verification record for b8c27563d (correction: truthful-attribution record for df27cbee8)

The record on b8c27563d ("correction: truthful-attribution record for df27cbee8") cites `Gate-suite:
cinatra-core@2026.08.1`. That version is true of the commit this record repairs —
.github/gate-suite.json at df27cbee8 reads cinatra-core@2026.08.1 — but the engine reads the suite
at the RECORD's own merged sha, and at b8c27563d the committed suite reads cinatra-core@2026.08.2:
576297d34a45c2f7f61abf0ce385e805366efc12 (#2706) advanced the pin from cinatra-core@2026.08.1 to
cinatra-core@2026.08.2 earlier the same day, and this record landed after it — no commit of PR #2709
touched .github/gate-suite.json. The gate arm is therefore structurally unverifiable for this
record: it is the pin-transition class already on record for d7ff228f8.

What was verified at the time is unchanged by any of this. PR #2709 was approved by @groganz at
ca36beaf17e8d7ae1b8c43e01cc00eb8bc88a5d3 on 2026-08-13T13:33:16Z — that login's latest non-dismissed
review, APPROVED at the reviewed head, non-self (the pull request's author is @groganz-bot[bot]),
and that login's repository permission is admin, which meets tier=maintainer. Both required contexts
named by the suite concluded at that reviewed head: `source-leak-gate / source-leak-gate` success;
`truthful-attribution-gate / truthful-attribution-gate` success. Separately, the suite committed at
the merged sha reads cinatra-core@2026.08.2.

The corrected record carries the human arm only, per the pin-advance precedent set by the correction
for d7ff228f8, which landed in this same batch and stands unflagged.

The `Assisted-by` lines are this record's own assistants — carried over verbatim where the original
lines were well-formed, repaired from the pull request's own commits where they were not — together
with the agents that produced this correction, deduplicated on name and model id. No assistant the
original record named is dropped, and none is invented; the lines added beyond the original set are
the correcting agents, named as such.

The merged change itself is untouched — this repairs the RECORD only. This correction is submitted
for the maintainer's approval, and that approval on the correction pull request is the human
ratification of the record it states.

Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)
Assisted-by: Claude Code (claude-sonnet-5)
Assisted-by: Claude Code (claude-opus-5)
Assisted-by: Codex (gpt-5.6-sol)
Correction-for: b8c27563d0eeb0e3c2a1f1a05727c2222e943898
```

---

## Correction for `000f1e4c89a1c6bfb91557aeb8d90df7d28bc98a`

```
correction: verification record for 000f1e4c8 (correction: truthful-attribution record for 7a997e1dd)

The record on 000f1e4c8 ("correction: truthful-attribution record for 7a997e1dd") cites `Gate-suite:
cinatra-core@2026.08.1`. That version is true of the commit this record repairs —
.github/gate-suite.json at 7a997e1dd reads cinatra-core@2026.08.1 — but the engine reads the suite
at the RECORD's own merged sha, and at 000f1e4c8 the committed suite reads cinatra-core@2026.08.2:
576297d34a45c2f7f61abf0ce385e805366efc12 (#2706) advanced the pin from cinatra-core@2026.08.1 to
cinatra-core@2026.08.2 earlier the same day, and this record landed after it — no commit of PR #2709
touched .github/gate-suite.json. The gate arm is therefore structurally unverifiable for this
record: it is the pin-transition class already on record for d7ff228f8.

What was verified at the time is unchanged by any of this. PR #2709 was approved by @groganz at
ca36beaf17e8d7ae1b8c43e01cc00eb8bc88a5d3 on 2026-08-13T13:33:16Z — that login's latest non-dismissed
review, APPROVED at the reviewed head, non-self (the pull request's author is @groganz-bot[bot]),
and that login's repository permission is admin, which meets tier=maintainer. Both required contexts
named by the suite concluded at that reviewed head: `source-leak-gate / source-leak-gate` success;
`truthful-attribution-gate / truthful-attribution-gate` success. Separately, the suite committed at
the merged sha reads cinatra-core@2026.08.2.

The corrected record carries the human arm only, per the pin-advance precedent set by the correction
for d7ff228f8, which landed in this same batch and stands unflagged.

The `Assisted-by` lines are this record's own assistants — carried over verbatim where the original
lines were well-formed, repaired from the pull request's own commits where they were not — together
with the agents that produced this correction, deduplicated on name and model id. No assistant the
original record named is dropped, and none is invented; the lines added beyond the original set are
the correcting agents, named as such.

The merged change itself is untouched — this repairs the RECORD only. This correction is submitted
for the maintainer's approval, and that approval on the correction pull request is the human
ratification of the record it states.

Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)
Assisted-by: Claude Code (claude-opus-5)
Assisted-by: Codex (gpt-5.6-sol)
Correction-for: 000f1e4c89a1c6bfb91557aeb8d90df7d28bc98a
```

---

## Correction for `5def6afcad25817f73e6f3d30f57c8a58b8e56c1`

```
correction: verification record for 5def6afca (correction: truthful-attribution record for faacc2445)

The record on 5def6afca ("correction: truthful-attribution record for faacc2445") cites `Gate-suite:
cinatra-core@2026.08.1`. That version is true of the commit this record repairs —
.github/gate-suite.json at faacc2445 reads cinatra-core@2026.08.1 — but the engine reads the suite
at the RECORD's own merged sha, and at 5def6afca the committed suite reads cinatra-core@2026.08.2:
576297d34a45c2f7f61abf0ce385e805366efc12 (#2706) advanced the pin from cinatra-core@2026.08.1 to
cinatra-core@2026.08.2 earlier the same day, and this record landed after it — no commit of PR #2709
touched .github/gate-suite.json. The gate arm is therefore structurally unverifiable for this
record: it is the pin-transition class already on record for d7ff228f8.

What was verified at the time is unchanged by any of this. PR #2709 was approved by @groganz at
ca36beaf17e8d7ae1b8c43e01cc00eb8bc88a5d3 on 2026-08-13T13:33:16Z — that login's latest non-dismissed
review, APPROVED at the reviewed head, non-self (the pull request's author is @groganz-bot[bot]),
and that login's repository permission is admin, which meets tier=maintainer. Both required contexts
named by the suite concluded at that reviewed head: `source-leak-gate / source-leak-gate` success;
`truthful-attribution-gate / truthful-attribution-gate` success. Separately, the suite committed at
the merged sha reads cinatra-core@2026.08.2.

The corrected record carries the human arm only, per the pin-advance precedent set by the correction
for d7ff228f8, which landed in this same batch and stands unflagged.

The `Assisted-by` lines are this record's own assistants — carried over verbatim where the original
lines were well-formed, repaired from the pull request's own commits where they were not — together
with the agents that produced this correction, deduplicated on name and model id. No assistant the
original record named is dropped, and none is invented; the lines added beyond the original set are
the correcting agents, named as such.

The merged change itself is untouched — this repairs the RECORD only. This correction is submitted
for the maintainer's approval, and that approval on the correction pull request is the human
ratification of the record it states.

Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)
Assisted-by: Claude Code (claude-sonnet-5)
Assisted-by: Codex (gpt-5.6-sol)
Assisted-by: Claude Code (claude-opus-5)
Correction-for: 5def6afcad25817f73e6f3d30f57c8a58b8e56c1
```

---

## Correction for `1a143160411e68bfba1a633d9ef39745ee8b3263`

```
correction: verification record for 1a1431604 (feat(dashboards): #2474 PR4 — the installed-catalog read, its browse-only secti…)

The record on 1a1431604 ("feat(dashboards): #2474 PR4 — the installed-catalog read, its browse-only
section, and Personal wired to concept B (#2629)") places its `Reviewed-by:` line BETWEEN
`Gate-suite:` and `Accountable:`. The gate arm's two lines must be adjacent, `Accountable`
immediately following `Gate-suite`, so the record as written breaks the pair and carries no valid
machine arm.

What was verified at the time is unchanged by any of this. PR #2629 was approved by @groganz at
73059989971f12cc854822e4d8f54b07e8a5935f on 2026-08-10T09:41:41Z — that login's latest non-dismissed
review, APPROVED at the reviewed head, non-self (the pull request's author is @groganz-bot[bot]),
and that login's repository permission is admin, which meets tier=maintainer. Both required contexts
named by the suite concluded at that reviewed head: `source-leak-gate / source-leak-gate` success;
`truthful-attribution-gate / truthful-attribution-gate` success. Separately, the suite committed at
the merged sha reads cinatra-core@2026.08.1.

The machine half is left out deliberately, and not because it was absent. The engine compares a
`Gate-suite:` trailer against `.github/gate-suite.json` read at the sha the record sits on, so a
correction can only restate a gate arm whose suite version is the same at the corrected commit and
at the correction itself. Here those differ — cinatra-core@2026.08.1 then, cinatra-core@2026.08.3 at
this correction — so restating the machine arm would red this record exactly as the 2026-08-13 batch
was redded. The human arm is true in both readings and is what this record carries.

The `Assisted-by` lines are this record's own assistants — carried over verbatim where the original
lines were well-formed, repaired from the pull request's own commits where they were not — together
with the agents that produced this correction, deduplicated on name and model id. No assistant the
original record named is dropped, and none is invented; the lines added beyond the original set are
the correcting agents, named as such.

The merged change itself is untouched — this repairs the RECORD only. This correction is submitted
for the maintainer's approval, and that approval on the correction pull request is the human
ratification of the record it states.

Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)
Assisted-by: Claude Code (claude-opus-5)
Assisted-by: Codex (gpt-5.6-sol)
Correction-for: 1a143160411e68bfba1a633d9ef39745ee8b3263
```

---

## Correction for `65e1de87e2deda9fe75f7aedd98da2ce4a45cfdc`

```
correction: verification record for 65e1de87e (fix(chat): a thread is bound to its assistant at creation, not repaired later (…)

The record on 65e1de87e ("fix(chat): a thread is bound to its assistant at creation, not repaired
later (#2650) (#2662)") carries `Gate-suite: cinatra-core@2026.08.1` with no `Accountable:` line
beside it. The gate arm is a PAIR — a `Gate-suite` line without its `Accountable` line is a
structural violation, so the record as written carries no valid machine arm at all.

What was verified at the time is unchanged by any of this. PR #2662 was approved by @groganz at
300d3a6fdedea14a05c2f9e1941c73722e06e032 on 2026-08-11T15:10:31Z — that login's latest non-dismissed
review, APPROVED at the reviewed head, non-self (the pull request's author is @groganz-bot[bot]),
and that login's repository permission is admin, which meets tier=maintainer. Both required contexts
named by the suite concluded at that reviewed head: `source-leak-gate / source-leak-gate` success;
`truthful-attribution-gate / truthful-attribution-gate` success. Separately, the suite committed at
the merged sha reads cinatra-core@2026.08.1.

The machine half is left out deliberately, and not because it was absent. The engine compares a
`Gate-suite:` trailer against `.github/gate-suite.json` read at the sha the record sits on, so a
correction can only restate a gate arm whose suite version is the same at the corrected commit and
at the correction itself. Here those differ — cinatra-core@2026.08.1 then, cinatra-core@2026.08.3 at
this correction — so restating the machine arm would red this record exactly as the 2026-08-13 batch
was redded. The human arm is true in both readings and is what this record carries.

The `Assisted-by` lines are this record's own assistants — carried over verbatim where the original
lines were well-formed, repaired from the pull request's own commits where they were not — together
with the agents that produced this correction, deduplicated on name and model id. No assistant the
original record named is dropped, and none is invented; the lines added beyond the original set are
the correcting agents, named as such.

The merged change itself is untouched — this repairs the RECORD only. This correction is submitted
for the maintainer's approval, and that approval on the correction pull request is the human
ratification of the record it states.

Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)
Assisted-by: Claude Code (claude-opus-5)
Assisted-by: Codex (gpt-5.6-sol)
Correction-for: 65e1de87e2deda9fe75f7aedd98da2ce4a45cfdc
```

---

## Correction for `e6f0560da6e0c7d61ba30fa32aec39d64376d630`

```
correction: verification record for e6f0560da (feat(llm): #2641 the image ABI carries per-image usage and a sourced rate price…)

The record on e6f0560da ("feat(llm): #2641 the image ABI carries per-image usage and a sourced rate
prices it (#2676)") carries `Gate-suite: cinatra-core@2026.08.1` with no `Accountable:` line beside
it. The gate arm is a PAIR — a `Gate-suite` line without its `Accountable` line is a structural
violation, so the record as written carries no valid machine arm at all.

What was verified at the time is unchanged by any of this. PR #2676 was approved by @groganz at
cc0170e291ef38f34c8396e8016fd76754ff2b59 on 2026-08-11T21:29:35Z — that login's latest non-dismissed
review, APPROVED at the reviewed head, non-self (the pull request's author is @groganz-bot[bot]),
and that login's repository permission is admin, which meets tier=maintainer. Both required contexts
named by the suite concluded at that reviewed head: `source-leak-gate / source-leak-gate` success;
`truthful-attribution-gate / truthful-attribution-gate` success. Separately, the suite committed at
the merged sha reads cinatra-core@2026.08.1.

The machine half is left out deliberately, and not because it was absent. The engine compares a
`Gate-suite:` trailer against `.github/gate-suite.json` read at the sha the record sits on, so a
correction can only restate a gate arm whose suite version is the same at the corrected commit and
at the correction itself. Here those differ — cinatra-core@2026.08.1 then, cinatra-core@2026.08.3 at
this correction — so restating the machine arm would red this record exactly as the 2026-08-13 batch
was redded. The human arm is true in both readings and is what this record carries.

The `Assisted-by` lines are this record's own assistants — carried over verbatim where the original
lines were well-formed, repaired from the pull request's own commits where they were not — together
with the agents that produced this correction, deduplicated on name and model id. No assistant the
original record named is dropped, and none is invented; the lines added beyond the original set are
the correcting agents, named as such.

The merged change itself is untouched — this repairs the RECORD only. This correction is submitted
for the maintainer's approval, and that approval on the correction pull request is the human
ratification of the record it states.

Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)
Assisted-by: Claude Code (claude-opus-5)
Assisted-by: Codex (gpt-5.6-sol)
Correction-for: e6f0560da6e0c7d61ba30fa32aec39d64376d630
```

---

## Correction for `4beb572db54ef2591d018103ab6f50c13a2d9e38`

```
correction: verification record for 4beb572db (fix(embed): one strict origin resolver everywhere — wildcard-shaped origins can…)

The record on 4beb572db ("fix(embed): one strict origin resolver everywhere — wildcard-shaped
origins can never reach a framing policy (#2680)") carries `Gate-suite: cinatra-core@2026.08.1` with
no `Accountable:` line beside it. The gate arm is a PAIR — a `Gate-suite` line without its
`Accountable` line is a structural violation, so the record as written carries no valid machine arm
at all.

What was verified at the time is unchanged by any of this. PR #2680 was approved by @groganz at
17d9cc71bdaeccc352b74b731ea142116fbff09a on 2026-08-12T07:21:42Z — that login's latest non-dismissed
review, APPROVED at the reviewed head, non-self (the pull request's author is @groganz-bot[bot]),
and that login's repository permission is admin, which meets tier=maintainer. Both required contexts
named by the suite concluded at that reviewed head: `source-leak-gate / source-leak-gate` success;
`truthful-attribution-gate / truthful-attribution-gate` success. Separately, the suite committed at
the merged sha reads cinatra-core@2026.08.1.

The machine half is left out deliberately, and not because it was absent. The engine compares a
`Gate-suite:` trailer against `.github/gate-suite.json` read at the sha the record sits on, so a
correction can only restate a gate arm whose suite version is the same at the corrected commit and
at the correction itself. Here those differ — cinatra-core@2026.08.1 then, cinatra-core@2026.08.3 at
this correction — so restating the machine arm would red this record exactly as the 2026-08-13 batch
was redded. The human arm is true in both readings and is what this record carries.

The `Assisted-by` lines are this record's own assistants — carried over verbatim where the original
lines were well-formed, repaired from the pull request's own commits where they were not — together
with the agents that produced this correction, deduplicated on name and model id. No assistant the
original record named is dropped, and none is invented; the lines added beyond the original set are
the correcting agents, named as such.

The merged change itself is untouched — this repairs the RECORD only. This correction is submitted
for the maintainer's approval, and that approval on the correction pull request is the human
ratification of the record it states.

Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)
Assisted-by: Claude Code (claude-opus-5)
Assisted-by: Codex (gpt-5.6-sol)
Correction-for: 4beb572db54ef2591d018103ab6f50c13a2d9e38
```

---

## Correction for `d3c900151e4159078c1da774b6a18558b57b2048`

```
correction: verification record for d3c900151 (fix(auth): #2684 widget sessions die with their Better Auth session — sign-out…)

The record on d3c900151 ("fix(auth): #2684 widget sessions die with their Better Auth session —
sign-out cascades through one liveness predicate (#2685)") carries `Gate-suite:
cinatra-core@2026.08.1` with no `Accountable:` line beside it. The gate arm is a PAIR — a
`Gate-suite` line without its `Accountable` line is a structural violation, so the record as written
carries no valid machine arm at all.

What was verified at the time is unchanged by any of this. PR #2685 was approved by @groganz at
e89dfd861a61acae86155c1625e066c53da9eb26 on 2026-08-12T10:47:35Z — that login's latest non-dismissed
review, APPROVED at the reviewed head, non-self (the pull request's author is @groganz-bot[bot]),
and that login's repository permission is admin, which meets tier=maintainer. Both required contexts
named by the suite concluded at that reviewed head: `source-leak-gate / source-leak-gate` success;
`truthful-attribution-gate / truthful-attribution-gate` success. Separately, the suite committed at
the merged sha reads cinatra-core@2026.08.1.

The machine half is left out deliberately, and not because it was absent. The engine compares a
`Gate-suite:` trailer against `.github/gate-suite.json` read at the sha the record sits on, so a
correction can only restate a gate arm whose suite version is the same at the corrected commit and
at the correction itself. Here those differ — cinatra-core@2026.08.1 then, cinatra-core@2026.08.3 at
this correction — so restating the machine arm would red this record exactly as the 2026-08-13 batch
was redded. The human arm is true in both readings and is what this record carries.

The `Assisted-by` lines are this record's own assistants — carried over verbatim where the original
lines were well-formed, repaired from the pull request's own commits where they were not — together
with the agents that produced this correction, deduplicated on name and model id. No assistant the
original record named is dropped, and none is invented; the lines added beyond the original set are
the correcting agents, named as such.

The merged change itself is untouched — this repairs the RECORD only. This correction is submitted
for the maintainer's approval, and that approval on the correction pull request is the human
ratification of the record it states.

Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)
Assisted-by: Claude Code (claude-opus-5)
Assisted-by: Codex (gpt-5.6-sol)
Correction-for: d3c900151e4159078c1da774b6a18558b57b2048
```

---

## Correction for `f85c237c65698e85aa0bafd33f7e0aefcc4b8a44`

```
correction: verification record for f85c237c6 (fix(auth): #2687 the widget OBO token is sealed to its parent sign-in and its a…)

The record on f85c237c6 ("fix(auth): #2687 the widget OBO token is sealed to its parent sign-in and
its active turn (#2689)") carries `Gate-suite: cinatra-core@2026.08.1` with no `Accountable:` line
beside it. The gate arm is a PAIR — a `Gate-suite` line without its `Accountable` line is a
structural violation, so the record as written carries no valid machine arm at all.

What was verified at the time is unchanged by any of this. PR #2689 was approved by @groganz at
6ff49ca379ae22be80db61415c4782cc541504d7 on 2026-08-12T14:09:13Z — that login's latest non-dismissed
review, APPROVED at the reviewed head, non-self (the pull request's author is @groganz-bot[bot]),
and that login's repository permission is admin, which meets tier=maintainer. Both required contexts
named by the suite concluded at that reviewed head: `source-leak-gate / source-leak-gate` success;
`truthful-attribution-gate / truthful-attribution-gate` success. Separately, the suite committed at
the merged sha reads cinatra-core@2026.08.1.

The machine half is left out deliberately, and not because it was absent. The engine compares a
`Gate-suite:` trailer against `.github/gate-suite.json` read at the sha the record sits on, so a
correction can only restate a gate arm whose suite version is the same at the corrected commit and
at the correction itself. Here those differ — cinatra-core@2026.08.1 then, cinatra-core@2026.08.3 at
this correction — so restating the machine arm would red this record exactly as the 2026-08-13 batch
was redded. The human arm is true in both readings and is what this record carries.

The `Assisted-by` lines are this record's own assistants — carried over verbatim where the original
lines were well-formed, repaired from the pull request's own commits where they were not — together
with the agents that produced this correction, deduplicated on name and model id. No assistant the
original record named is dropped, and none is invented; the lines added beyond the original set are
the correcting agents, named as such.

The merged change itself is untouched — this repairs the RECORD only. This correction is submitted
for the maintainer's approval, and that approval on the correction pull request is the human
ratification of the record it states.

Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)
Assisted-by: Claude Code (claude-opus-5)
Assisted-by: Codex (gpt-5.6-sol)
Correction-for: f85c237c65698e85aa0bafd33f7e0aefcc4b8a44
```

---

## Correction for `d6a3fa6660d54988783f5e4b571a750c56003361`

```
correction: verification record for d6a3fa666 (Chat execution-claim provenance: mark unbacked claims, distinguish plane refusa…)

The record on d6a3fa666 ("Chat execution-claim provenance: mark unbacked claims, distinguish plane
refusals (#2187)") carries an EMPTY `Assisted-by:` line. A display-name must contain at least one
non-whitespace character, so the line is a malformed owned trailer and the record carries no
`Assisted-by` at all — and `Assisted-by` is mandatory on every merge.

What was verified at the time is unchanged by any of this. PR #2187 was approved by @groganz at
259e2fb41d8dcbdf04813bb0d8391467df38b311 on 2026-07-28T17:09:57Z — that login's latest non-dismissed
review, APPROVED at the reviewed head, non-self (the pull request's author is @groganz-bot[bot]),
and that login's repository permission is admin, which meets tier=maintainer. Both required contexts
named by the suite concluded at that reviewed head: `source-leak-gate / source-leak-gate` success;
`truthful-attribution-gate / truthful-attribution-gate` success. Separately, the suite committed at
the merged sha reads cinatra-core@2026.07.7.

The corrected `Assisted-by` is taken from PR #2187's own commits — the union of the well-formed
lines they carry, model ids only.

The machine half is left out deliberately, and not because it was absent. The engine compares a
`Gate-suite:` trailer against `.github/gate-suite.json` read at the sha the record sits on, so a
correction can only restate a gate arm whose suite version is the same at the corrected commit and
at the correction itself. Here those differ — cinatra-core@2026.07.7 then, cinatra-core@2026.08.3 at
this correction — so restating the machine arm would red this record exactly as the 2026-08-13 batch
was redded. The human arm is true in both readings and is what this record carries.

The `Assisted-by` lines are this record's own assistants — carried over verbatim where the original
lines were well-formed, repaired from the pull request's own commits where they were not — together
with the agents that produced this correction, deduplicated on name and model id. No assistant the
original record named is dropped, and none is invented; the lines added beyond the original set are
the correcting agents, named as such.

The merged change itself is untouched — this repairs the RECORD only. This correction is submitted
for the maintainer's approval, and that approval on the correction pull request is the human
ratification of the record it states.

Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)
Assisted-by: Claude Code (claude-opus-5)
Assisted-by: Codex (gpt-5.6-sol)
Correction-for: d6a3fa6660d54988783f5e4b571a750c56003361
```

---

## Correction for `281f005922afb6f3cc8eac3a4f4da3a3a9965bf2`

```
correction: verification record for 281f00592 (test(mcp): provider-scale smoke for trusted-read native injection + the pinned-…)

The record on 281f00592 ("test(mcp): provider-scale smoke for trusted-read native injection + the
pinned-stack empty-emission proof (#2019) (#2189)") carries `Assisted-by: Claude Code (Claude Sonnet
5)`. The parenthesised model id admits only [A-Za-z0-9._/:-], and the value written contains spaces,
so the line is a malformed owned trailer and the record carries no valid `Assisted-by` for that
assistant.

What was verified at the time is unchanged by any of this. PR #2189 was approved by @groganz at
f2e8d01450a9d6ff5bc8ecc55353d85775e2c26e on 2026-07-28T18:21:15Z — that login's latest non-dismissed
review, APPROVED at the reviewed head, non-self (the pull request's author is @marcushorndt), and
that login's repository permission is admin, which meets tier=maintainer. Both required contexts
named by the suite concluded at that reviewed head: `source-leak-gate / source-leak-gate` success
then success; `truthful-attribution-gate / truthful-attribution-gate` failure then success.
Separately, the suite committed at the merged sha reads cinatra-core@2026.07.7.

The malformed line is repaired as a grammar-safe normalisation of the label it wrote: the same
assistant, with the spaces the model-id character class forbids replaced by the hyphenated form this
repository writes elsewhere. The label is what the original record attests; the normalised form is
not independent provenance for the model, and nothing here claims it is.

For completeness: the context ran twice at that reviewed head — a failure completed
2026-07-28T18:12:20Z and a later run completed success at 2026-07-28T18:29:47Z. The engine reads the
freshest qualifying run, so the context stands green there; the earlier failure does not change
that.

The machine half is left out deliberately, and not because it was absent. The engine compares a
`Gate-suite:` trailer against `.github/gate-suite.json` read at the sha the record sits on, so a
correction can only restate a gate arm whose suite version is the same at the corrected commit and
at the correction itself. Here those differ — cinatra-core@2026.07.7 then, cinatra-core@2026.08.3 at
this correction — so restating the machine arm would red this record exactly as the 2026-08-13 batch
was redded. The human arm is true in both readings and is what this record carries.

The `Assisted-by` lines are this record's own assistants — carried over verbatim where the original
lines were well-formed, repaired from the pull request's own commits where they were not — together
with the agents that produced this correction, deduplicated on name and model id. No assistant the
original record named is dropped, and none is invented; the lines added beyond the original set are
the correcting agents, named as such.

The merged change itself is untouched — this repairs the RECORD only. This correction is submitted
for the maintainer's approval, and that approval on the correction pull request is the human
ratification of the record it states.

Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)
Assisted-by: Claude Code (claude-sonnet-5)
Assisted-by: Codex (gpt-5.5)
Assisted-by: Claude Code (claude-opus-5)
Assisted-by: Codex (gpt-5.6-sol)
Correction-for: 281f005922afb6f3cc8eac3a4f4da3a3a9965bf2
```

---

## Seven merges no correction commit can repair

Finding B of the gate-suite re-audit (#2974) found twenty landed merge records with an
uncorrected verification-record defect. Thirteen are repaired above, each by a
`Correction-for` commit restating a human arm. The remaining seven cannot be repaired
the same way, or any way, under the engine's own rules (`scripts/truthful-attribution-gate.mjs`
at `fdc26811b97f435bbf8a754247631db39267a197`, the SHA this repository's
`.github/gate-suite.json` pins): `classifyArm` (`:383-386`) requires a record to carry a
`Reviewed-by` or a complete `Gate-suite`+`Accountable` pair. An armless `Correction-for`
commit fails on two independent paths: check 1 (`:2769-2770`) finds no arm in ITS OWN
record and reds its own landing directly the moment it reaches main, exactly like any
ordinary commit with no arm; and separately, on the dedicated re-verify path that names
an original commit explicitly, `selectGoverningCorrection` (`:2580-2587`) refuses to let
an armless candidate govern — "correction-malformed," "it does NOT govern" — so even
past the first failure, it could never repair the commit it names. None of the seven
pull requests carries an approving review by anyone, so a human arm cannot be written
truthfully. A machine arm cannot be restated either: `verifyGateArm` (`:1675`) compares
the cited suite version against `.github/gate-suite.json` read at the sha the record
sits on, and a correction commit sits at today's sha, where the committed suite has
long since moved past the version that was true when each of these seven merged —
citing the old version reds the correction's own landing; citing today's would claim a
suite verified a merge before that suite version existed. There is no third option in
this grammar. Separately, and run directly against the pinned engine's own
`classifyHighRisk` (`:483`) with each merge's own `.github/gate-suite.json` and its own
changed-file set: all seven are normal-risk, so the machine arm — incomplete on six of
them, structurally complete on the seventh whose overall record was invalid only on a
separate, equally mandatory field (`Assisted-by`) — was the only arm any of them ever
had available. So for each of the seven, this is what was true at the time, stated
plainly instead of asserted as a record that never was.

**`dd32cf8a6f967cfca14dbf84d1ca6928582c8b2b` — PR #2693** — "fix(metrics): #2691 the This
Week boundary is timezone-independent — aligned with the #2673 month fix (#2693)"

The record today carries `Gate-suite: cinatra-core@2026.08.1` with no `Accountable` line,
and `Assisted-by: Claude Code (claude-sonnet-5)`. A `Gate-suite` without its paired
`Accountable` is not a complete gate arm, and no other arm is present. `GET
/pulls/2693/reviews` returns no review of any kind on this pull request — no maintainer
approved it. Both required contexts concluded `success` at the reviewed head
`f0383f3b70308154f446aed780ecf52581d90695`: `source-leak-gate / source-leak-gate` and
`truthful-attribution-gate / truthful-attribution-gate`. The suite committed at the
merged sha reads `cinatra-core@2026.08.1`. No verification record existed for this
merge, and none is asserted here.

**`579f8d29f7b7425c16bb1a5fb6dc94ebfced9d1d` — PR #2678** — "feat(agents): #2675 a
colliding publish refuses before any registry write — read-only claim preflight
(#2678)"

The record today carries `Gate-suite: cinatra-core@2026.08.1` with no `Accountable`
line, and three `Assisted-by` lines (`Claude Code (claude-opus-5)`, `Codex
(gpt-5.6-sol)`, `Claude Code (claude-fable-5)`). A `Gate-suite` without its paired
`Accountable` is not a complete gate arm, and no other arm is present. `GET
/pulls/2678/reviews` returns one review — `github-advanced-security[bot]`,
`COMMENTED` — and no `APPROVED` review by anyone; no maintainer approved this pull
request. Both required contexts concluded `success` at the reviewed head
`e312d78cb586a9e89b91727100d9db7275f682d6`: `source-leak-gate / source-leak-gate` and
`truthful-attribution-gate / truthful-attribution-gate`. The suite committed at the
merged sha reads `cinatra-core@2026.08.1`. No verification record existed for this
merge, and none is asserted here.

**`8860d5cfa960fc71f2c4759eddf9ee213e6545e6` — PR #2677** — "chore(extensions): #2641
advance the gemini-connector pin — image rows price up, register retires, logo rides
the regen (#2677)"

The record today carries `Gate-suite: cinatra-core@2026.08.1` with no `Accountable`
line, and `Assisted-by: Claude Code (claude-sonnet-5)`. A `Gate-suite` without its
paired `Accountable` is not a complete gate arm, and no other arm is present. `GET
/pulls/2677/reviews` returns no review of any kind on this pull request — no maintainer
approved it. Both required contexts concluded `success` at the reviewed head
`9a504c5fa8a11b894e04178a121889d8bc73b946`: `source-leak-gate / source-leak-gate` and
`truthful-attribution-gate / truthful-attribution-gate`. The suite committed at the
merged sha reads `cinatra-core@2026.08.1`. No verification record existed for this
merge, and none is asserted here.

**`04c205f0b1c8bea83040af28f9df84534a02ecdd` — PR #2673** — "fix(metrics): #2669
unknown-cost rows are visible in the time series, llm_usage cube, and budget alert
(#2673)"

The record today carries `Gate-suite: cinatra-core@2026.08.1` with no `Accountable`
line, and two `Assisted-by` lines (`Claude Code (claude-opus-5)`, `Codex
(gpt-5.6-sol)`). A `Gate-suite` without its paired `Accountable` is not a complete gate
arm, and no other arm is present. `GET /pulls/2673/reviews` returns no review of any
kind on this pull request — no maintainer approved it. Both required contexts
concluded `success` at the reviewed head `66ada11861e2c0e171037546dac90f714e996e01`:
`source-leak-gate / source-leak-gate` and `truthful-attribution-gate /
truthful-attribution-gate`. The suite committed at the merged sha reads
`cinatra-core@2026.08.1`. No verification record existed for this merge, and none is
asserted here.

**`c56c007f66fcd28432bdf86c87503f20668f9310` — PR #2671** — "fix(llm): #2670 metering
proxy answers for the adapter through a facade — frozen/non-configurable methods stay
metered (#2671)"

The record today carries `Gate-suite: cinatra-core@2026.08.1` with no `Accountable`
line, and two `Assisted-by` lines (`Claude Code (claude-opus-5)`, `Codex
(gpt-5.6-sol)`). A `Gate-suite` without its paired `Accountable` is not a complete gate
arm, and no other arm is present. `GET /pulls/2671/reviews` returns no review of any
kind on this pull request — no maintainer approved it. Both required contexts
concluded `success` at the reviewed head `f756050a19951a2031fe39181c39de45a074b714`:
`source-leak-gate / source-leak-gate` and `truthful-attribution-gate /
truthful-attribution-gate`. The suite committed at the merged sha reads
`cinatra-core@2026.08.1`. No verification record existed for this merge, and none is
asserted here.

**`841375f1883e7d04c2a6dbb397caf3d1684102e2` — PR #2667** — "fix(llm): #2641 meter
generateImage at the seam as a counted, unpriced usage_events row (#2667)"

The record today carries `Gate-suite: cinatra-core@2026.08.1` with no `Accountable`
line, and three `Assisted-by` lines (`Claude Code (claude-opus-5)`, `Codex
(gpt-5.6-sol)`, `Claude Code (claude-fable-5)`). A `Gate-suite` without its paired
`Accountable` is not a complete gate arm, and no other arm is present. `GET
/pulls/2667/reviews` returns no review of any kind on this pull request — no maintainer
approved it. Both required contexts concluded `success` at the reviewed head
`17fa65b0218bfbf82fa8d3ae66e14fb5063def5d`: `source-leak-gate / source-leak-gate` and
`truthful-attribution-gate / truthful-attribution-gate`. The suite committed at the
merged sha reads `cinatra-core@2026.08.1`. No verification record existed for this
merge, and none is asserted here.

**`c2df5be84c063352df204bdd20a03f8a0742f1c6` — PR #2184** — "pacote 22 + libnpmpublish
12 with a token-redacting registry-error facade (#2184)"

The record today carries an empty `Assisted-by:` line, then `Gate-suite:
cinatra-core@2026.07.7` immediately followed by `Accountable: Sandro Groganz
<sandro@cinatra.ai> (@groganz)` — unlike the other six here, the gate arm's own pairing
and adjacency rule is satisfied, so a complete machine arm is present. But a
display-name must contain at least one non-whitespace character, and the `Assisted-by`
line has none, so that separate, equally mandatory field is malformed and the record
carries no `Assisted-by` at all. `GET /pulls/2184/reviews` returns no review of any
kind on this pull request — no maintainer approved it, so a human arm cannot be
substituted, and, as above, the intact gate arm cannot be restated in a correction at
today's suite version either. Both required contexts concluded `success` at the
reviewed head `22cfb69d91091a166274ebeeb9011f56df766637`: `source-leak-gate /
source-leak-gate` and `truthful-attribution-gate / truthful-attribution-gate`. The
suite committed at the merged sha reads `cinatra-core@2026.07.7`. No *valid*
verification record existed for this merge — the arm was intact, the record was not —
and none is asserted here.
