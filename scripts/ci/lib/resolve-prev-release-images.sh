#!/usr/bin/env bash
set -euo pipefail

# Resolve the previous-release BASE images for the release upgrade proof
# (the `upgrade-proof` job in .github/workflows/build-image.yml — the
# recurrence barrier for the prod schema-sync failure class, cinatra#1136).
#
# "Previous release" is resolved from the repo's own release tag history, NOT
# from GHCR `:latest` (that tag floats to the main-branch tip on every push,
# so it is not a release). Rules:
#
#   * The candidate BASE set is stable release tags only (vMAJOR.MINOR or
#     vMAJOR.MINOR.PATCH — no pre-release/build suffix). Suffixed tags are
#     excluded both because `sort -V` does not order SemVer pre-releases
#     correctly (codex round-0 finding) and because a pre-release is never a
#     fleet upgrade base.
#   * Order by version and take tags STRICTLY below the building tag's numeric
#     core, walking DOWN from the highest. (A suffixed building tag compares
#     by its numeric core.)
#   * A tag whose image does NOT resolve in the registry is SKIPPED with a
#     warning, not fatal: a release that the upgrade-proof barrier itself
#     blocked leaves its git tag behind WITHOUT a published image — that tag
#     was never deployable, so it cannot be any deployment's database base,
#     and it must not poison every subsequent release's resolution.
#   * Collect up to MAX_BASES (default 2) resolvable bases. Proving the
#     upgrade from the last TWO published releases (not only the immediate
#     one) covers the published-but-never-successfully-deployed window: a
#     release can be tagged + published and still fail its prod deploy (the
#     exact incident this barrier answers), leaving production's database one
#     release behind when the next tag builds. Codex round-0 convergence: the
#     highest prior tag alone is a false green in that window.
#   * ZERO resolvable bases -> exit 1 (fail closed). Only a repo's very first
#     release has no upgrade path to prove; that state no longer exists here.
#
# Usage:
#   resolve-prev-release-images.sh <building-tag> <image-repo> [max-bases]
# Prints one image ref per line, most recent base first.
#
# Test seams (both optional; see scripts/ci/__tests__/resolve-prev-release-images.test.mjs):
#   UPGRADE_PROOF_TAG_LIST   newline-separated tag names; replaces the
#                            `git ls-remote --tags origin` read.
#   UPGRADE_PROOF_PROBE_CMD  command prefix invoked as `<cmd> <image-ref>`;
#                            replaces `docker buildx imagetools inspect`.

BUILDING_TAG="${1:-}"
IMAGE_REPO="${2:-}"
MAX_BASES="${3:-2}"

if [ -z "$BUILDING_TAG" ] || [ -z "$IMAGE_REPO" ]; then
  echo "usage: $0 <building-tag> <image-repo> [max-bases]" >&2
  exit 2
fi

# The building tag's numeric core (vMAJOR.MINOR[.PATCH], any suffix stripped).
# A tag without such a core is a checkpoint/marker tag — the workflow's
# release-tag guard filters those out BEFORE this script runs, so reaching
# here with one is a caller bug: fail loudly.
CORE="$(printf '%s' "$BUILDING_TAG" | sed -nE 's/^(v[0-9]+\.[0-9]+(\.[0-9]+)?).*$/\1/p')"
if [ -z "$CORE" ]; then
  echo "ERROR: '$BUILDING_TAG' is not a release tag (expected vMAJOR.MINOR[.PATCH][suffix])." >&2
  exit 2
fi

if [ -n "${UPGRADE_PROOF_TAG_LIST:-}" ]; then
  RAW_TAGS="$UPGRADE_PROOF_TAG_LIST"
else
  # ls-remote lists annotated tag objects AND their peeled `^{}` commit rows;
  # strip the peel suffix (the sort -u below dedupes the resulting doubles).
  RAW_TAGS="$(git ls-remote --tags origin 'v*' | awk '{print $2}' | sed -e 's|^refs/tags/||' -e 's|\^{}$||')"
fi

# Stable release tags strictly below the building core, ascending. Appending
# the core itself before sorting guarantees the awk cut-off fires at the
# core's sorted position whether or not the core is itself a tag in the list;
# `sort -u` collapses the duplicate when it is. `sort -V` is a correct order
# on this set because suffixed tags were excluded above.
BELOW="$(printf '%s\n%s\n' "$RAW_TAGS" "$CORE" \
  | grep -E '^v[0-9]+\.[0-9]+(\.[0-9]+)?$' \
  | sort -u -V \
  | awk -v core="$CORE" '$0 == core { exit } { print }')"

if [ -z "$BELOW" ]; then
  echo "ERROR: no stable release tag exists below ${BUILDING_TAG} — cannot resolve an upgrade base (fail closed)." >&2
  exit 1
fi

# Existence probe for a base image ref. Overridable for tests; the default is
# the same probe release-dispatch uses before deploying.
# shellcheck disable=SC2206 # a command PREFIX — word-splitting is the contract
PROBE=(${UPGRADE_PROOF_PROBE_CMD:-docker buildx imagetools inspect})

FOUND=0
while IFS= read -r TAG_NAME; do
  [ -n "$TAG_NAME" ] || continue
  REF="${IMAGE_REPO}:${TAG_NAME}"
  if "${PROBE[@]}" "$REF" >/dev/null 2>&1; then
    printf '%s\n' "$REF"
    FOUND=$((FOUND + 1))
    if [ "$FOUND" -ge "$MAX_BASES" ]; then
      break
    fi
  else
    echo "WARN: release tag '${TAG_NAME}' has no resolvable image at ${REF} — skipping it as an upgrade base (a barrier-blocked release publishes no image)." >&2
  fi
done <<< "$(printf '%s\n' "$BELOW" | sort -rV)"

if [ "$FOUND" -eq 0 ]; then
  echo "ERROR: no previous-release image below ${BUILDING_TAG} resolved in ${IMAGE_REPO} — refusing to skip the upgrade proof (fail closed)." >&2
  exit 1
fi
