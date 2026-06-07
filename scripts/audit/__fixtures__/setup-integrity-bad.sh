#!/usr/bin/env bash
set -euo pipefail

# Regression fixture: a BARE `docker build` against an in-tree path that does
# not exist, with no enclosing existence guard. Under `set -euo pipefail` this
# hard-fails `make setup` for every fresh clone.

echo "Building OpenAI shell Docker image..."
docker build -t cinatra/skill-shell:latest packages/connector-openai/runtime

echo "Setup complete."
