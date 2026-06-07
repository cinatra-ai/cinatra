#!/usr/bin/env bash
# Batched Track B (chat-MCP) runner.
#
# Same pattern as run-batched.sh for Track A: 4-5 fixtures per batch with
# fresh dev server per batch so progressive dev-server degradation under
# sustained Playwright + chat LLM load doesn't outpace timeouts.
#
# Usage:
#   ./tests/e2e/agents-run/run-batched-trackb.sh            # all batches
#   ./tests/e2e/agents-run/run-batched-trackb.sh --batch 1  # one batch
set -euo pipefail

BATCH_FILTER="${1:-}"
TARGET_BATCH=""
if [ "$BATCH_FILTER" = "--batch" ] && [ -n "${2:-}" ]; then
  TARGET_BATCH="$2"
fi

# Batch groupings — HITL fixtures grouped together so the dev server is
# fresh when driving multi-gate flows. Non-HITL fixtures bundled in
# subsequent batches since they're faster.
BATCH1_FILTER="@cinatra-ai/(skill-recommender-agent|trigger-agent)"
BATCH2_FILTER="@cinatra-ai/(web-scrape-agent|web-research-agent|media-feed-lister-agent|media-transcript-agent)"
BATCH3_FILTER="@cinatra-ai/(blog-idea-generator-agent|blog-draft-writer-agent|blog-image-prompt-agent)"
BATCH4_FILTER="@cinatra-ai/(company-discovery-agent|contact-discovery-agent|planner-agent)"
BATCH5_FILTER="@cinatra-ai/(code-reviewer-agent|security-reviewer-agent|lint-policy-agent)"

run_batch() {
  local batch_num="$1"
  local filter="$2"
  echo ""
  echo "=================================================================="
  echo "Track B Batch $batch_num: $filter"
  echo "=================================================================="
  lsof -ti:3000 2>/dev/null | xargs -r kill -9 2>/dev/null || true
  sleep 2
  CI= pnpm exec playwright test \
    --config tests/e2e/config/agents-run.config.ts \
    --project=chat-mcp \
    -g "$filter" \
    || return 1
}

OVERALL_RC=0

if [ -z "$TARGET_BATCH" ] || [ "$TARGET_BATCH" = "1" ]; then run_batch 1 "$BATCH1_FILTER" || OVERALL_RC=1; fi
if [ -z "$TARGET_BATCH" ] || [ "$TARGET_BATCH" = "2" ]; then run_batch 2 "$BATCH2_FILTER" || OVERALL_RC=1; fi
if [ -z "$TARGET_BATCH" ] || [ "$TARGET_BATCH" = "3" ]; then run_batch 3 "$BATCH3_FILTER" || OVERALL_RC=1; fi
if [ -z "$TARGET_BATCH" ] || [ "$TARGET_BATCH" = "4" ]; then run_batch 4 "$BATCH4_FILTER" || OVERALL_RC=1; fi
if [ -z "$TARGET_BATCH" ] || [ "$TARGET_BATCH" = "5" ]; then run_batch 5 "$BATCH5_FILTER" || OVERALL_RC=1; fi

lsof -ti:3000 2>/dev/null | xargs -r kill -9 2>/dev/null || true

if [ $OVERALL_RC -eq 0 ]; then
  echo ""
  echo "ALL TRACK B BATCHES PASSED"
else
  echo ""
  echo "AT LEAST ONE TRACK B BATCH FAILED"
fi

exit $OVERALL_RC
