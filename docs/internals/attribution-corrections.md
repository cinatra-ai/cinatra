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
