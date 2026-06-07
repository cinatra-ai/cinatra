#!/usr/bin/env bash
# Batched Track A runner.
#
# Why: solo runs of every Track A fixture PASS. The 10-fixture full
# suite passed in 4.9 min. The 13-fixture full suite degrades (8/13 in
# 27.3 min) because the Next.js dev server accumulates JIT/cache/SSE
# state and progressively gets slower until per-fixture timeouts get
# outpaced (page.goto, page.reload, button visibility, terminal poll).
#
# Solution: run Track A in deterministic batches of
# 3 fixtures with a fresh dev server per batch. Each batch is small
# enough that the dev server stays healthy, and shell-level orchestration
# is simpler than Playwright-level webServer churn.
#
# Usage:
#   ./tests/e2e/agents-run/run-batched.sh              # all batches
#   ./tests/e2e/agents-run/run-batched.sh --batch 1    # one batch only
#
# Exit codes:
#   0 — all batches passed
#   1 — at least one batch failed (per-batch JUnit XML in playwright-report/)
set -euo pipefail

BATCH_FILTER="${1:-}"
TARGET_BATCH=""
if [ "$BATCH_FILTER" = "--batch" ] && [ -n "${2:-}" ]; then
  TARGET_BATCH="$2"
fi

# Batch lists are grep -E regexes that match the test title produced by
# `test.describe('agents-run :: <packageName>')` in agents-run.spec.ts.
# Fixtures grouped to balance wall-clock + load per batch.

BATCH1_FILTER="@cinatra-ai/(skill-recommender-agent|trigger-agent)"
BATCH2_FILTER="@cinatra-ai/(email-recipient-selection-agent)"
BATCH3_FILTER="@cinatra-ai/(email-drafting-agent|email-follow-up-agent|email-test-delivery-agent)"

run_batch() {
  local batch_num="$1"
  local filter="$2"
  echo ""
  echo "=================================================================="
  echo "Batch $batch_num: $filter"
  echo "=================================================================="
  # Kill any stale dev server before each batch so Playwright's webServer
  # spawns a fresh one (configured in tests/e2e/config/agents-run.config.ts).
  lsof -ti:3000 2>/dev/null | xargs -r kill -9 2>/dev/null || true
  sleep 2
  CI= pnpm exec playwright test \
    --config tests/e2e/config/agents-run.config.ts \
    --project=agents-run \
    -g "$filter" \
    || return 1
}

OVERALL_RC=0

if [ -z "$TARGET_BATCH" ] || [ "$TARGET_BATCH" = "1" ]; then
  run_batch 1 "$BATCH1_FILTER" || OVERALL_RC=1
fi
if [ -z "$TARGET_BATCH" ] || [ "$TARGET_BATCH" = "2" ]; then
  run_batch 2 "$BATCH2_FILTER" || OVERALL_RC=1
fi
if [ -z "$TARGET_BATCH" ] || [ "$TARGET_BATCH" = "3" ]; then
  run_batch 3 "$BATCH3_FILTER" || OVERALL_RC=1
fi

# Final cleanup.
lsof -ti:3000 2>/dev/null | xargs -r kill -9 2>/dev/null || true

if [ $OVERALL_RC -eq 0 ]; then
  echo ""
  echo "ALL BATCHES PASSED"
else
  echo ""
  echo "AT LEAST ONE BATCH FAILED"
fi

exit $OVERALL_RC
