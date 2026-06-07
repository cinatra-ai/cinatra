#!/usr/bin/env bash
set -euo pipefail

# Regression fixture: a script that is clean of missing in-tree path references
# but carries an obvious shellcheck standard lint (SC2086 — an unquoted variable
# expansion subject to word splitting / globbing). The setup-integrity gate must
# FAIL on this when the shellcheck binary is available.

target_dir="$1"

echo "Listing target..."
# SC2086: $target_dir should be double-quoted to prevent word splitting.
ls $target_dir

echo "Done."
