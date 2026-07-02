#!/usr/bin/env bash
set -euo pipefail
# works-after :: Verdaccio arm (cinatra#352).
#
# Brings up a candidate Verdaccio (VERDACCIO_TAG, default 6) with the repo's OWN
# docker/verdaccio/config.yaml MOUNTED (so the real immutable-on-publish +
# `$authenticated`-to-publish policy is exercised — the config is load-bearing
# to the proof, design §2.2), on an ISOLATED network with an ephemeral storage
# volume, then runs the publish→install round-trip:
#   1. mint a throwaway registry user via the repo's createNpmUser (no
#      npm-cli-login, no ops/broker identity) → token into a temp .npmrc;
#   2. `npm publish` a generated @works-after/proof package to the registry;
#   3. from a SECOND clean temp dir, `npm install` it back and require() it,
#      asserting the installed module's sentinel == what was published.
# A Verdaccio major that breaks the publish/tarball/metadata path fails the
# install-back.
#
# Env: VERDACCIO_TAG (default 6).

WORKS_AFTER_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ci/works-after/lib.sh
source "${WORKS_AFTER_LIB_DIR}/lib.sh"

VERDACCIO_TAG="${VERDACCIO_TAG:-6}"
RUN_ID="wa-verdaccio-$$"
NET="${RUN_ID}-net"
VC="${RUN_ID}-verdaccio"
VOL="${RUN_ID}-storage"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/${RUN_ID}.XXXXXX")"
NS="works-after"
PKG_VERSION="0.0.$(date +%s)"

cleanup() {
  docker rm -fv "$VC" >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$WORK_DIR" >/dev/null 2>&1 || true
}
dump_diag() {
  wa_group_start "works-after verdaccio failure diagnostics"
  echo "--- docker ps -a (run containers) ---"; docker ps -a --filter "name=${RUN_ID}" || true
  echo "--- verdaccio logs (version + audit middleware) ---"; docker logs "$VC" 2>&1 | tail -50 || true
  if [ -n "${HOST_PORT:-}" ]; then
    echo "--- registry /-/ping ---"; curl -fsS "http://127.0.0.1:${HOST_PORT}/-/ping" 2>&1 | head -2 || true
    echo "--- @works-after/proof metadata ---"; curl -fsS "http://127.0.0.1:${HOST_PORT}/@${NS}%2Fproof" 2>&1 | head -c 400 || true
  fi
  wa_group_end
}
on_err() { echo "${_WA_RED}ERROR: works-after verdaccio FAILED (line $1).${_WA_RST}" >&2; dump_diag; }
trap 'on_err $LINENO' ERR
trap cleanup EXIT
fail() { echo "${_WA_RED}ERROR: $*${_WA_RST}" >&2; dump_diag; exit 1; }

wa_log "works-after verdaccio: candidate verdaccio/verdaccio:${VERDACCIO_TAG}"

docker network create "$NET" >/dev/null
docker volume create "$VOL" >/dev/null
# Mount the REAL repo config (the immutability/publish policy is the proof) and
# publish a loopback-only ephemeral host port for the host-side npm client.
docker run -d --name "$VC" --network "$NET" -p 127.0.0.1::4873 \
  -v "${VOL}:/verdaccio/storage" \
  -v "${REPO_ROOT}/docker/verdaccio/config.yaml:/verdaccio/conf/config.yaml:ro" \
  "verdaccio/verdaccio:${VERDACCIO_TAG}" >/dev/null

HOST_PORT=""
for i in $(seq 1 40); do
  HOST_PORT="$(wa_host_port "$VC" 4873)"
  if [ -n "$HOST_PORT" ] && curl -fsS "http://127.0.0.1:${HOST_PORT}/-/ping" >/dev/null 2>&1; then break; fi
  if [ "$i" -eq 40 ]; then fail "verdaccio did not answer /-/ping within 120s."; fi
  sleep 3
done
REGISTRY="http://127.0.0.1:${HOST_PORT}"
wa_info "verdaccio up at ${REGISTRY}"

# ── 1. Mint a throwaway registry user via the repo's createNpmUser ────────────
TOKEN="$(VERDACCIO_URL="$REGISTRY" WORKS_AFTER_NS="$NS" \
  wa_node --import tsx "${REPO_ROOT}/scripts/ci/works-after/rt/verdaccio-roundtrip.ts")" \
  || fail "throwaway registry user provisioning (createNpmUser) failed."
[ -n "$TOKEN" ] || fail "createNpmUser returned an empty token."
wa_info "minted throwaway registry user '${NS}'"

# A temp .npmrc carrying the token + the registry. Used for both publish + install.
NPMRC="${WORK_DIR}/.npmrc"
{
  echo "registry=${REGISTRY}/"
  echo "//127.0.0.1:${HOST_PORT}/:_authToken=${TOKEN}"
  echo "@${NS}:registry=${REGISTRY}/"
} > "$NPMRC"

# ── 2. Publish a generated @works-after/proof package ────────────────────────
PUB_DIR="${WORK_DIR}/pkg"
mkdir -p "$PUB_DIR"
SENTINEL="works-after-${PKG_VERSION}-${RANDOM}"
cat > "${PUB_DIR}/package.json" <<EOF
{
  "name": "@${NS}/proof",
  "version": "${PKG_VERSION}",
  "description": "works-after ephemeral publish/install proof package",
  "main": "index.js",
  "private": false
}
EOF
cat > "${PUB_DIR}/index.js" <<EOF
module.exports = { sentinel: "${SENTINEL}" };
EOF

wa_info "publishing @${NS}/proof@${PKG_VERSION}"
( cd "$PUB_DIR" && npm publish --userconfig "$NPMRC" --registry "${REGISTRY}/" ) \
  || fail "npm publish to the candidate verdaccio failed."

# ── 3. Install it back from a SECOND clean temp dir and require() it ──────────
INST_DIR="${WORK_DIR}/install"
mkdir -p "$INST_DIR"
echo '{ "name": "works-after-install", "version": "0.0.0", "private": true }' > "${INST_DIR}/package.json"
wa_info "installing @${NS}/proof@${PKG_VERSION} back from the registry"
( cd "$INST_DIR" && npm install --userconfig "$NPMRC" --registry "${REGISTRY}/" "@${NS}/proof@${PKG_VERSION}" ) \
  || fail "npm install of the just-published package failed (publish/tarball/metadata path broken?)."

INSTALLED_SENTINEL="$(cd "$INST_DIR" && wa_node -e 'process.stdout.write(require("@'"${NS}"'/proof").sentinel)')" \
  || fail "require() of the installed @${NS}/proof failed."
if [ "$INSTALLED_SENTINEL" != "$SENTINEL" ]; then
  fail "installed sentinel '${INSTALLED_SENTINEL}' != published sentinel '${SENTINEL}'."
fi

echo "${_WA_GREEN}==> works-after verdaccio PASSED${_WA_RST} — candidate verdaccio:${VERDACCIO_TAG} round-tripped a publish→install (sentinel matched)."
