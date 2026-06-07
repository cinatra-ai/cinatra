#!/usr/bin/env bash
set -euo pipefail

# Regression fixture: a BARE `docker build` against an in-tree path that does
# not exist, preceded by an UNRELATED, already-closed existence guard. A naive
# "any guard within N lines counts" scanner would FALSELY pass this — the guard
# above neither encloses the build nor references its path. The setup-integrity
# gate must still FLAG the bare missing-path build.

if [ -f README.md ]; then
  echo "ok"
fi

echo "Building OpenAI shell Docker image..."
docker build -t cinatra/skill-shell:latest packages/connector-openai/runtime

echo "Setup complete."
