#!/usr/bin/env bash
# Runner for the cinatra#1705 AC1/AC2/AC3 live-provider proof lane.
#
# CREDENTIALS ARE NEVER RETRIEVED, NAMED OR STORED HERE. Both provider keys
# must already be present in the environment of the calling shell:
#
#   AC123_OPENAI_KEY      an OpenAI API key
#   AC123_ANTHROPIC_KEY   an Anthropic API key
#
# On the lane that produced evidence/1705-ac123 they were read from the org
# secrets manager into shell-local variables by a wrapper that is deliberately
# NOT part of this repository, and handed to this script's child process
# environment only. No value is echoed, exported into a log, or written to
# disk at any point, and `set -x` is never enabled.
#
# Everything else is lane topology and is overridable, so a second operator can
# reproduce the walk on their own ports without editing this file:
#
#   AC123_DB_URL     Postgres holding the lane's `cinatra` schema
#   AC123_ORG_ID     tenant id the arms attribute to
#   AC123_USER_ID    actor principal id the arms attribute to
#
# Usage:
#   bash evidence/1705-ac123/drivers/run.sh              # every arm
#   bash evidence/1705-ac123/drivers/run.sh -t "AC3"     # one AC's arms
set -euo pipefail

: "${AC123_OPENAI_KEY:?export AC123_OPENAI_KEY before running (never hard-code it)}"
: "${AC123_ANTHROPIC_KEY:?export AC123_ANTHROPIC_KEY before running (never hard-code it)}"
: "${AC123_DB_URL:?export AC123_DB_URL — a Postgres URL for the lane's cinatra schema}"
: "${EXECUTION_BROKER_SECRET:?export EXECUTION_BROKER_SECRET — the lane's own random broker secret}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

AC123_ORG_ID="${AC123_ORG_ID:-ac123org}" \
AC123_USER_ID="${AC123_USER_ID:-ac123user}" \
SUPABASE_DB_URL="$AC123_DB_URL" \
SUPABASE_SCHEMA=cinatra \
CINATRA_EXECUTION_PLANE_ROLLOUT=on \
EXECUTION_SANDBOX_NETWORK="${EXECUTION_SANDBOX_NETWORK:-ac123-sandbox-net}" \
CINATRA_REQUIRE_ACTOR_CONTEXT=false \
NODE_ENV=test \
  pnpm exec vitest run --config evidence/1705-ac123/drivers/walk.config.ts "$@"
