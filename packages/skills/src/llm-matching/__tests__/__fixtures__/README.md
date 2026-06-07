# Skill-Match Golden Fixture

This directory holds the labelled reference dataset that calibrates the LLM
skill-matcher's decisions against expert judgment. It is the production-trust
signal the matcher's `score` and `matched` outputs depend on.

## Contents

- `golden-matches.jsonl` — 20 (agent, skill, expected_match, expected_score_band) tuples in JSONL format. Each line is one `GoldenMatchRow`.

## Row schema

```jsonc
{
  "id": "GM-NN",                          // stable row identifier
  "category": "obvious-match" | "obvious-no-match" | "borderline" | "rule-short-circuit" | "rule-fallthrough-to-llm",
  "agent": { ...AgentForMatching },       // packageId, name, description, tags
  "skill": { ...SkillForMatching },       // skillId, name, level, content, matchWhenRaw?
  "expectedMatched": boolean,             // human-labelled ground truth
  "expectedScoreBand": "high" | "medium" | "low",
                                          // Band → numeric midpoint used for Spearman:
                                          //   high   = 0.92 (clearly applicable, prompt threshold ≥0.85)
                                          //   medium = 0.67 (plausibly useful, prompt threshold 0.50-0.85)
                                          //   low    = 0.20 (irrelevant, prompt threshold <0.50)
                                          // The midpoints come from
                                          // packages/skills/src/llm-matching/eval-calibration.ts
                                          // and reflect the prompt's stated decision criteria. Bands
                                          // are diagnostic, not enforced as per-row gates by the
                                          // live eval (which asserts aggregate accuracy + Spearman).
  "expectedSource": "rule" | "llm",       // which evaluator path the row exercises
  "rationale": "human notes"              // why the label is what it is — audit trail
}
```

## Category coverage

| Category | Count | What it exercises |
|----------|------:|-------------------|
| `obvious-match` | 5 | LLM should say MATCH with high confidence (e.g., cold-email skill on email-outreach agent) |
| `obvious-no-match` | 5 | LLM should say NO MATCH with high confidence (cross-domain pairs) |
| `borderline` | 5 | Hard cases — could go either way without expert judgment; documents the consensus |
| `rule-short-circuit` | 3 | `match_when` clause matches → `source="rule"`, LLM **never called** |
| `rule-fallthrough-to-llm` | 2 | `match_when` clause exists but mismatches → falls through to LLM (rule grammar has no negative form) |
| **TOTAL** | **20** | — |

## Curation method

1. **Source agents** are real installed Cinatra agents from `agents/cinatra/` (descriptions + tags lifted verbatim from each agent's `package.json`). No synthetic agent shapes.
2. **Source skills** are plausibly-paraphrased SKILL.md content (~200-500 bytes per row) that mirrors the structure of real third-party skills.
3. **Two-expert labelling** — each row was labelled by two reviewers (the human plan author + the implementing AI) independently, and disagreements were resolved by consensus before the row was added. For `borderline` rows the consensus rationale is preserved verbatim in the `rationale` field as the audit trail.
4. **Dispute-resolution policy** — when two reviewers disagree on a borderline row's `expectedMatched` boolean, the row is dropped or rewritten with clearer agent/skill content. We do not ship rows whose ground truth is contested.
5. **Freeze date** — 2026-05-11. The fixture is locked at this point and treated as the calibration baseline. New rows may be added in future PRs (with the new freeze date documented), but existing rows MUST NOT be silently relabelled.

## How the live eval uses this fixture

`__tests__/golden-eval.live.test.ts` loads the JSONL, calls the **real** OpenAI API (gated by `OPENAI_API_KEY`), and asserts:

- **Per-row** assertions are limited to evaluator-path correctness: `expectedSource: "rule"` rows MUST come back with `result.row.source === "rule"` (LLM never called) and `result.row.status === "ok"`; `expectedSource: "llm"` rows MUST come back with `result.row.source === "llm"` and `result.row.status === "ok"`. The fixture's `expectedMatched` and `expectedScoreBand` are NOT asserted per-row — they feed the aggregate calibration below.
- **Aggregate** assertion: `eval-calibration.ts` computes `{ accuracy, spearman, perBandAccuracy, mismatchCount, mismatches }` and the test gates on `accuracy ≥ 0.85` AND `spearman ≥ 0.7`. Borderline rows are excluded from accuracy (rewarding rank correlation over hard binary gates), included in Spearman. Rule-source rows are excluded from both (they bypass the LLM).

See `https://docs.cinatra.ai/references/platform/skill-matching/#evaluation--calibration` for the full policy and the `OPENAI_API_KEY` + `GOLDEN_EVAL_LIVE=1` double-gate.

## Rationale grounding interaction

The production evaluator (`evaluate-pair.ts`) runs a deterministic rationale-grounding check on every `matched=true` row BEFORE persisting. If the LLM rationale fails the token-overlap test (`overlapRatio < 0.20` against skill+agent metadata), the persisted `rationale` is replaced with a conservative fallback and a structured `skill-match-ungrounded-rationale` warning is emitted. The classifier `matched` and `score` are NOT changed — only the user-visible rationale text.

This guard runs during the live golden eval too. Implications for fixture maintenance:

- Live-eval rows with `expectedMatched: true` that produce a sparse/ungrounded LLM rationale will get the fallback rationale in `result.row.rationale`. This is correct behavior, not a regression — the row still satisfies the per-row `source`/`status` assertions and the aggregate accuracy/Spearman gates.
- The guard is NOT asserted by the live eval per-row. To verify the guard itself, the unit suite at `__tests__/rationale-grounding.test.ts` + the integration suite at `__tests__/evaluate-pair-grounding.test.ts` together pin the deterministic contract. Adding a hallucination-prone fixture row WITHOUT also adding a per-row grounding-warning assertion would be coverage theater.
- When the matcher prompt is changed (`prompt.md`), re-run the live eval and inspect for `skill-match-ungrounded-rationale` warnings — a spike in warnings is a signal that the prompt is producing detached rationales.

## Regenerating / extending

When extending this fixture:

- Add new rows to the **end** of `golden-matches.jsonl` with the next-numbered `GM-NN` id.
- Update the category-coverage table above and the freeze date.
- Re-run the live eval and update the calibration report in `https://docs.cinatra.ai/references/platform/skill-matching/` if accuracy/Spearman shifts by more than 0.05.
- Never silently relabel an existing row — bump the row's `id` (e.g., `GM-11` → `GM-11b`) and document the relabel reason in the rationale.

## Why JSONL (not JSON)

JSONL keeps each row independently parseable so reviewers can `git diff` individual labels without merge conflicts on the surrounding array structure, and so a malformed line fails ONE row instead of the whole fixture.
