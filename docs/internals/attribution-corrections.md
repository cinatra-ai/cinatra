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
