#!/usr/bin/env bash
set -euo pipefail
# job-scoped-name.sh <base> — print a container/volume/network name that is
# UNIQUE to the CI job that asks for it (cinatra#3332).
#
# THE FAILURE CLASS. A step-run container started with a FIXED `--name` can
# exist exactly once per machine. On a hosted runner that is invisible — one
# job owns the whole VM. On a SELF-HOSTED runner it is not: a second job (a
# re-run attempt, or another branch's run) scheduled onto the same box hits
#   docker: Error response from daemon: Conflict. The container name
#   "/agents-it-verdaccio" is already in use ... (exit 125)
# and the second job dies before it reaches a single test. The sibling class
# for host PORTS was closed by cinatra#3267 (`-p 127.0.0.1::<port>`); this is
# the same collision one field over, on the NAME.
#
# THE RULE. One derivation, one helper, every caller. The suffix is the job's
# own identity — the run, the job and the attempt — plus the RUNNER that is
# executing it, and a random suffix off CI, where no such identity exists
# (scripts/ci/works-after/verdaccio.sh's original `wa-verdaccio-$$` shape, now
# sourced from here rather than copied).
#
# WHY THE RUNNER TOO. GITHUB_JOB is the job's YAML id, NOT the leg of a matrix:
# every leg of `strategy.matrix` in one run at one attempt reports the SAME
# GITHUB_JOB, so run+job+attempt alone is not unique for two CONCURRENT legs —
# which on a self-hosted pool is exactly the two-jobs-on-one-box case this
# helper exists to close. RUNNER_NAME closes it: a runner executes one job at a
# time, so two jobs running at the same moment — matrix legs included — are
# always on two different runners. No caller is a matrix job today; the guard
# is here so the next one cannot re-open the class silently.
#
# Callers own their cleanup: the name is printed, never registered, so a caller
# removes exactly the container IT created and never a name a neighbouring job
# is still using.
#
# Usage:  NAME="$(scripts/ci/job-scoped-name.sh agents-it-verdaccio)"

base="${1:-}"
if [ -z "$base" ]; then
  echo "usage: job-scoped-name.sh <base>" >&2
  exit 2
fi

if [ -n "${GITHUB_RUN_ID:-}" ]; then
  # GITHUB_JOB is the job's YAML id and GITHUB_RUN_ATTEMPT the re-run counter;
  # both are always set alongside GITHUB_RUN_ID on Actions, and the defaults
  # below only keep the helper honest if a caller exports one by hand.
  # RUNNER_NAME is appended when Actions provides it (see the header): it is
  # what separates two concurrent legs of one matrix job, which share the other
  # three values.
  suffix="${GITHUB_RUN_ID}-${GITHUB_JOB:-job}-${GITHUB_RUN_ATTEMPT:-1}${RUNNER_NAME:+-${RUNNER_NAME}}"
else
  # Off CI (a laptop, a lane host): no job identity exists, so a random suffix
  # carries the same guarantee for two shells on one machine.
  suffix="local-$$-${RANDOM}${RANDOM}"
fi

# Docker accepts [a-zA-Z0-9][a-zA-Z0-9_.-]* for a name; anything else in the
# environment's values (a job id is YAML-safe, but never assume) becomes a dash.
suffix="$(printf '%s' "$suffix" | tr -c 'a-zA-Z0-9_.-' '-')"

printf '%s-%s\n' "$base" "$suffix"
