#!/usr/bin/env bash
set -euo pipefail

# Regression fixture: a BARE `docker build` against an in-tree path that does
# not exist, preceded by an UNRELATED, already-closed existence guard. A naive
# "any guard within N lines counts" scanner would FALSELY pass this — the guard
# above neither encloses the build nor references its path. The setup-integrity
# gate must still FLAG the bare missing-path build.
#
# The build path names the live shell-runtime namespace (extensions/…/runtime)
# but drops the org-scope segment clone-back always inserts, so it is stably
# missing in every environment.

if [ -f README.md ]; then
  echo "ok"
fi

echo "Building OpenAI shell Docker image..."
docker build -t cinatra/skill-shell:latest extensions/openai-connector/runtime

echo "Setup complete."
