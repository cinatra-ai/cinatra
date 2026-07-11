#!/usr/bin/env bash
set -euo pipefail

# Regression fixture: a BARE `docker build` against an in-tree path that does
# not exist, with no enclosing existence guard. Under `set -euo pipefail` this
# hard-fails `make setup` for every fresh clone.
#
# The path names the live shell-runtime namespace (extensions/…/runtime) but
# drops the org-scope segment that clone-back always inserts
# (extensions/<scope>/<name>/runtime), so it is stably missing in every
# environment -- the exact kind of near-miss hardcoding this gate must catch.

echo "Building OpenAI shell Docker image..."
docker build -t cinatra/skill-shell:latest extensions/openai-connector/runtime

echo "Setup complete."
