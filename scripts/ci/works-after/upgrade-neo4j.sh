#!/usr/bin/env bash
set -euo pipefail
# works-after :: Neo4j UPGRADE-FROM arm (cinatra#1421 + cinatra#1422).
#
# The data-bearing prior-version fixture for the Neo4j family's guarded
# store-format upgrade path (scripts/upgrade/neo4j-upgrade-major.sh), landed as
# the coordinated pair of that path. Neo4j is the one non-Postgres stateful
# family whose supported hop is a real DATA-MIGRATING transition (the
# semver->CalVer store-format upgrade 5.26 -> 2026.05); this arm proves it, in
# order:
#
#   0. NEGATIVES (matrix, no containers): the downgrade (neo4j
#      ${TO_SERIES} -> ${FROM_SERIES}), a same-series no-op that is not a listed
#      transition (5.26 -> 5.26), and an unknown service FAIL CLOSED at resolve
#      time; the supported hop resolves. A downgrade driven THROUGH the path
#      refuses (exit 3) BEFORE any mutation, with no ledger touch.
#   1. QUIESCE STOP: the path refuses (exit 3, no ledger touch) while any
#      container still references the volume.
#   2. FIXTURE: a neo4j:${NEO4J_FROM_TAG} volume seeded with a small graph of
#      multiple labels + a relationship + a probe node, ledger-recorded at the
#      source version.
#   3. FAILURE INJECTION (pre-commit): the path run with
#      UPGRADE_INJECT_FAILURE=post-verify must exit 5 and land back on the
#      byte-identical source volume (COLD content digest compared pre/post)
#      WITH the source-version ledger entry intact, no pending journal, and no
#      leaked candidate volume — and the intact 5.26 volume still boots on the
#      SOURCE image with its data.
#   4. POSITIVE: the same fixture upgrades ${NEO4J_FROM_TAG} -> ${NEO4J_TO_TAG}
#      via the explicit offline `neo4j-admin database migrate`; the ledger
#      commits the target entry; the graph survives (node count read back under
#      the TARGET image; the path itself asserts the full content fingerprint);
#      the checksummed dump artifact exists.
#   5. INTERRUPTED (post-commit): on a second fixture,
#      UPGRADE_INJECT_FAILURE=cutover-verify must exit 4 and RETAIN the pending
#      ledger journal recording the TARGET image (the fail-closed "interrupted
#      migration" evidence the cinatra-cli preflight refuses on) with the live
#      entry still the SOURCE, plus the candidate volume as recovery material.
#
# Env: NEO4J_FROM_TAG (default: 5.26-community DIGEST-BOUND — an upgrade-from
# fixture pins its source-image digest, cinatra#1422; the last semver community
# release, what a live 5.x volume ran) and NEO4J_TO_TAG (default: the
# digest-bound 2026.05-community compose pin — the matrix-supported neo4j
# 5.26 -> 2026.05 hop); a future major lane overrides both. Fully isolated:
# named throwaway volumes, no host ports, throwaway neo4j password minted per
# run. Neo4j servers are heavy (JVM); the readiness waits are generous.

WORKS_AFTER_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ci/works-after/lib.sh
source "${WORKS_AFTER_LIB_DIR}/lib.sh"

# Digest-bound defaults (multi-arch index digests): the fixture pins its source
# AND target image bytes; an override may be a bare tag (an intentionally
# unpinned manual run).
NEO4J_FROM_TAG="${NEO4J_FROM_TAG:-5.26-community@sha256:4bae36aff76271e27fd6a6ed0835413f86a284cd179cfb1cb7d188f5f7533aca}"
NEO4J_TO_TAG="${NEO4J_TO_TAG:-2026.05-community@sha256:6c162e2432f861f2c4e3da77a6ba478e7f10e2160b870541f85294532bc6ff5f}"
# The MATRIX versions = the store-format series of each tag (strip the digest
# pin, then the -community variant suffix): 5.26-community@… -> 5.26.
FROM_BARE="${NEO4J_FROM_TAG%%@*}"; FROM_SERIES="${FROM_BARE%%-*}"
TO_BARE="${NEO4J_TO_TAG%%@*}";     TO_SERIES="${TO_BARE%%-*}"
SERVICE="neo4j"

RUN_ID="wa-upgneo-$$"
VOL1="${RUN_ID}-vol1"
VOL2="${RUN_ID}-vol2"
SEED="${RUN_ID}-seed"
CHK="${RUN_ID}-chk"
HOLD="${RUN_ID}-hold"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/${RUN_ID}.XXXXXX")"
LEDGER1="${WORK}/ledger1.json"
LEDGER2="${WORK}/ledger2.json"
BACKUPS="${WORK}/backups"
PATH_SH="${REPO_ROOT}/scripts/upgrade/neo4j-upgrade-major.sh"
RESOLVE="${REPO_ROOT}/scripts/upgrade/resolve-transition.mjs"
LEDGER_MJS="${REPO_ROOT}/scripts/upgrade/ledger.mjs"
# Throwaway password, minted per run (>=8 chars, clears the CalVer floor).
PW="wa-$(wa_throwaway_hexkey 12)"
export UPGRADE_NEO4J_PASSWORD="$PW"

cleanup() {
  docker rm -fv "$SEED" "$CHK" "$HOLD" >/dev/null 2>&1 || true
  for v in $(docker volume ls -q --filter "name=${RUN_ID}" 2>/dev/null); do
    docker volume rm -f "$v" >/dev/null 2>&1 || true
  done
  rm -rf "$WORK" >/dev/null 2>&1 || true
}
dump_diag() {
  wa_group_start "works-after upgrade-neo4j failure diagnostics"
  echo "--- docker ps -a (run containers) ---"; docker ps -a --filter "name=${RUN_ID}" || true
  echo "--- volumes ---"; docker volume ls --filter "name=${RUN_ID}" || true
  echo "--- ledger 1 ---"; cat "$LEDGER1" 2>/dev/null || true
  echo "--- ledger 2 ---"; cat "$LEDGER2" 2>/dev/null || true
  wa_group_end
}
on_err() { echo "${_WA_RED}ERROR: works-after upgrade-neo4j FAILED (line $1).${_WA_RST}" >&2; dump_diag; }
trap 'on_err $LINENO' ERR
trap cleanup EXIT
fail() { echo "${_WA_RED}ERROR: $*${_WA_RST}" >&2; dump_diag; exit 1; }

ledger_field() {
  node -e 'const l=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=eval(process.argv[2]);process.stdout.write(v===null||v===undefined?"null":String(v));' "$1" "$2"
}

neo_ready() {
  # neo_ready <container> <retries> — an authenticated query answers.
  local c="$1" n="${2:-40}" _
  for _ in $(seq 1 "$n"); do
    if docker exec -e NEO4J_PASSWORD="$PW" "$c" cypher-shell -u neo4j 'RETURN 1' >/dev/null 2>&1; then return 0; fi
    sleep 3
  done
  return 1
}

seed_fixture() {
  # seed_fixture <volume> <ledger-file> — data-bearing prior-version fixture
  # (multiple labels + a relationship + a probe) + a ledger source entry.
  local vol="$1" ledger="$2"
  docker volume create "$vol" >/dev/null
  docker run -d --name "$SEED" -v "${vol}:/data" \
    -e NEO4J_AUTH="neo4j/${PW}" \
    "neo4j:${NEO4J_FROM_TAG}" >/dev/null
  neo_ready "$SEED" 40 || fail "fixture neo4j:${NEO4J_FROM_TAG} did not become ready."
  docker exec -e NEO4J_PASSWORD="$PW" "$SEED" cypher-shell -u neo4j \
    "CREATE (a:Widget {name:'probe', nonce:'${PW}'})-[:LINKS {kind:'test'}]->(b:Widget {name:'other'}); CREATE (:Gadget {n:1}); CREATE (:Gadget {n:2});" >/dev/null \
    || fail "could not seed the fixture graph."
  # SIGTERM clean stop (exit 0), matching the path's clean-shutdown requirement.
  docker stop -t 120 "$SEED" >/dev/null && docker rm -f "$SEED" >/dev/null
  node "$LEDGER_MJS" record --file "$ledger" --service "$SERVICE" \
    --image "neo4j:${NEO4J_FROM_TAG}" --volume-name "$vol" \
    --volume-created-at "$(docker volume inspect -f '{{.CreatedAt}}' "$vol")" >/dev/null
}

assert_data() {
  # assert_data <volume> <image-tag[@digest]> <series> — boots a fresh server on
  # the volume and asserts the version series + that the graph is intact (4
  # nodes + the probe node readable).
  local vol="$1" tag="$2" series="$3" v n probe
  docker run -d --name "$CHK" -v "${vol}:/data" \
    -e NEO4J_AUTH="neo4j/${PW}" \
    "neo4j:${tag}" >/dev/null
  neo_ready "$CHK" 40 || fail "verification neo4j:${tag} did not become ready on '${vol}'."
  v="$(docker exec -e NEO4J_PASSWORD="$PW" "$CHK" cypher-shell -u neo4j -d neo4j --format plain 'CYPHER 5 CALL dbms.components() YIELD name, versions WHERE name = "Neo4j Kernel" RETURN versions[0];' | tail -1 | tr -d '"')"
  case "$v" in "${series}."*|"$series") : ;; *) fail "version on '${vol}' is '${v}', expected ${series}.*" ;; esac
  n="$(docker exec -e NEO4J_PASSWORD="$PW" "$CHK" cypher-shell -u neo4j -d neo4j --format plain 'CYPHER 5 MATCH (n) RETURN count(n);' | tail -1)"
  [ "$n" = "4" ] || fail "node count on '${vol}' under neo4j:${tag} is ${n}, expected 4 — data did not survive."
  probe="$(docker exec -e NEO4J_PASSWORD="$PW" "$CHK" cypher-shell -u neo4j -d neo4j --format plain "CYPHER 5 MATCH (w:Widget {name:'probe'}) RETURN w.nonce;" | tail -1 | tr -d '"')"
  [ "$probe" = "$PW" ] || fail "probe nonce on '${vol}' under neo4j:${tag} is '${probe}', expected '${PW}'."
  docker rm -fv "$CHK" >/dev/null
}

run_path() {
  # run_path <volume> <ledger> [env NAME=VALUE…] — returns the path's exit code.
  local vol="$1" ledger="$2"; shift 2
  local rc=0
  env "$@" UPGRADE_LEDGER_FILE="$ledger" UPGRADE_NEO4J_PASSWORD="$PW" \
    bash "$PATH_SH" \
    --service "$SERVICE" --volume "$vol" \
    --from "$FROM_SERIES" --to "$TO_SERIES" \
    --from-tag "$NEO4J_FROM_TAG" --to-tag "$NEO4J_TO_TAG" \
    --backup-dir "$BACKUPS" \
    --verify-cmd 'test "$(docker exec -e NEO4J_PASSWORD="$NEO4J_PASSWORD" "$UF_VERIFY_CONTAINER" cypher-shell -u neo4j -d neo4j --format plain "CYPHER 5 MATCH (n) RETURN count(n);" | tail -1)" = "4"' \
    || rc=$?
  return $rc
}

wa_log "works-after upgrade-neo4j: guarded path ${NEO4J_FROM_TAG} -> ${NEO4J_TO_TAG} (matrix ${SERVICE} ${FROM_SERIES} -> ${TO_SERIES})"

# ── 0. fail-closed negatives (no containers) ─────────────────────────────────
wa_info "negatives: downgrade + unlisted hops + unknown service must FAIL CLOSED at resolve time"
rc=0; node "$RESOLVE" neo4j "$TO_SERIES" "$FROM_SERIES" >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 3 ] || fail "neo4j ${TO_SERIES} -> ${FROM_SERIES} (downgrade) resolved rc=${rc}, expected fail-closed 3."
rc=0; node "$RESOLVE" neo4j "$FROM_SERIES" "$FROM_SERIES" >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 3 ] || fail "neo4j ${FROM_SERIES} -> ${FROM_SERIES} (unlisted no-op) resolved rc=${rc}, expected fail-closed 3."
rc=0; node "$RESOLVE" no-such-neo4j "$FROM_SERIES" "$TO_SERIES" >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 3 ] || fail "unknown service resolved rc=${rc}, expected fail-closed 3."
node "$RESOLVE" neo4j "$FROM_SERIES" "$TO_SERIES" >/dev/null \
  || fail "neo4j ${FROM_SERIES} -> ${TO_SERIES} should be a supported matrix transition."

# A downgrade driven THROUGH the path refuses pre-mutation, ledger untouched.
mkdir -p "$BACKUPS"
rc=0
UPGRADE_LEDGER_FILE="${WORK}/never-written.json" UPGRADE_NEO4J_PASSWORD="$PW" bash "$PATH_SH" \
  --service "$SERVICE" --volume "does-not-exist-${RUN_ID}" \
  --from "$TO_SERIES" --to "$FROM_SERIES" \
  --from-tag "$NEO4J_TO_TAG" --to-tag "$NEO4J_FROM_TAG" \
  --backup-dir "$BACKUPS" >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 3 ] || fail "a downgrade through the path exited ${rc}, expected fail-closed 3."
[ ! -f "${WORK}/never-written.json" ] || fail "a refused hop must not touch the ledger."

# ── 1. quiesce stop ──────────────────────────────────────────────────────────
wa_info "quiesce: the path must refuse while a container references the volume"
docker volume create "$VOL1" >/dev/null
docker run -d --name "$HOLD" -v "${VOL1}:/hold" alpine sleep 900 >/dev/null
rc=0; run_path "$VOL1" "${WORK}/never-quiesce.json" || rc=$?
[ "$rc" -eq 3 ] || fail "un-quiesced volume exited ${rc}, expected fail-closed 3."
[ ! -f "${WORK}/never-quiesce.json" ] || fail "a quiesce refusal must not touch the ledger."
docker rm -f "$HOLD" >/dev/null
docker volume rm "$VOL1" >/dev/null

# ── 2. fixture ───────────────────────────────────────────────────────────────
wa_info "fixture: seeding neo4j:${NEO4J_FROM_TAG} volume + ledger source entry"
seed_fixture "$VOL1" "$LEDGER1"

# ── 3. failure injection (pre-commit): intact source + source ledger ─────────
wa_info "failure injection: UPGRADE_INJECT_FAILURE=post-verify must roll back"
PRE_DIGEST="$(wa_volume_digest "$VOL1")"
rc=0; run_path "$VOL1" "$LEDGER1" UPGRADE_INJECT_FAILURE=post-verify || rc=$?
[ "$rc" -eq 5 ] || fail "injected post-verify failure exited ${rc}, expected pre-commit abort 5."
POST_DIGEST="$(wa_volume_digest "$VOL1")"
[ "$PRE_DIGEST" = "$POST_DIGEST" ] \
  || fail "the source volume's COLD content digest changed across the injected failure (${PRE_DIGEST} -> ${POST_DIGEST}) — the original was touched pre-commit."
[ "$(ledger_field "$LEDGER1" 'l.services["neo4j"].image')" = "neo4j:${NEO4J_FROM_TAG}" ] \
  || fail "after rollback the ledger must still carry the SOURCE entry."
[ "$(ledger_field "$LEDGER1" 'l.pending')" = "null" ] || fail "after rollback no pending journal may remain."
[ -z "$(docker volume ls -q --filter "name=${VOL1}-ufcand")" ] || fail "rollback leaked a candidate volume."
[ -z "$(docker volume ls -q --filter "name=${VOL1}-ufback")" ] || fail "rollback leaked a backup volume."

# A SECOND pre-commit failure point, still on the untouched S0 source (neither
# injected run boots a server on VOL1 — both only clone it read-only — so both
# compare against the SAME pre-injection PRE_DIGEST): the offline store migrate
# itself failing must ALSO land back on the byte-identical source with the
# source ledger entry (every executable failure point rolls back onto the
# intact source, cinatra#1421).
wa_info "failure injection: UPGRADE_INJECT_FAILURE=store-migrate must also roll back onto the intact source"
rc=0; run_path "$VOL1" "$LEDGER1" UPGRADE_INJECT_FAILURE=store-migrate || rc=$?
[ "$rc" -eq 5 ] || fail "injected store-migrate failure exited ${rc}, expected pre-commit abort 5."
[ "$(wa_volume_digest "$VOL1")" = "$PRE_DIGEST" ] \
  || fail "the source volume changed across the store-migrate injection — the original was touched pre-commit."
[ "$(ledger_field "$LEDGER1" 'l.services["neo4j"].image')" = "neo4j:${NEO4J_FROM_TAG}" ] \
  || fail "after the store-migrate rollback the ledger must still carry the SOURCE entry."
[ "$(ledger_field "$LEDGER1" 'l.pending')" = "null" ] || fail "after the store-migrate rollback no pending journal may remain."
[ -z "$(docker volume ls -q --filter "name=${VOL1}-ufcand")" ] || fail "the store-migrate rollback leaked a candidate volume."

# Independent source-intact proof: the untouched source still boots on 5.26 with
# its data (this DOES write to VOL1, so it runs AFTER both digest comparisons).
assert_data "$VOL1" "$NEO4J_FROM_TAG" "$FROM_SERIES"
wa_info "rollback verified: source volume byte-identical across both injections, boots on ${FROM_SERIES}, source ledger entry intact"

# ── 4. positive: guarded store-format upgrade end to end ─────────────────────
wa_info "positive: full guarded upgrade (explicit offline neo4j-admin database migrate on the candidate)"
run_path "$VOL1" "$LEDGER1" || fail "guarded neo4j upgrade path failed (exit $?)."
[ "$(ledger_field "$LEDGER1" 'l.services["neo4j"].image')" = "neo4j:${NEO4J_TO_TAG}" ] \
  || fail "after commit the ledger must carry the TARGET entry."
[ "$(ledger_field "$LEDGER1" 'l.pending')" = "null" ] || fail "after commit no pending journal may remain."
assert_data "$VOL1" "$NEO4J_TO_TAG" "$TO_SERIES"
ls "$BACKUPS"/${SERVICE}-*.tar >/dev/null 2>&1 || fail "checksummed backup artifact missing."
ls "$BACKUPS"/${SERVICE}-*.tar.sha256 >/dev/null 2>&1 || fail "backup checksum file missing."
wa_info "upgrade verified: graph survived onto ${TO_SERIES}; ledger committed; dump retained"

# ── 5. interrupted (post-commit): pending journal retained, fail-closed ──────
wa_info "interrupted: UPGRADE_INJECT_FAILURE=cutover-verify must retain the pending journal"
seed_fixture "$VOL2" "$LEDGER2"
rc=0; run_path "$VOL2" "$LEDGER2" UPGRADE_INJECT_FAILURE=cutover-verify || rc=$?
[ "$rc" -eq 4 ] || fail "injected cutover-verify failure exited ${rc}, expected post-commit interruption 4."
[ "$(ledger_field "$LEDGER2" 'l.pending && l.pending.service')" = "neo4j" ] \
  || fail "an interrupted migration must RETAIN its pending ledger journal (fail-closed evidence)."
[ "$(ledger_field "$LEDGER2" 'l.pending.target.image')" = "neo4j:${NEO4J_TO_TAG}" ] \
  || fail "the retained journal must record the TARGET image it was migrating to."
[ "$(ledger_field "$LEDGER2" 'l.services["neo4j"].image')" = "neo4j:${NEO4J_FROM_TAG}" ] \
  || fail "the live ledger entry must still be the SOURCE while interrupted."
[ -n "$(docker volume ls -q --filter "name=${VOL2}-ufcand")" ] \
  || fail "an interrupted migration must retain the candidate volume as recovery material."

echo "${_WA_GREEN}==> works-after upgrade-neo4j PASSED${_WA_RST} — guarded ${NEO4J_FROM_TAG} -> ${NEO4J_TO_TAG} path: fail-closed negatives + quiesce stop, rollback lands on the intact source + source ledger, offline store-format upgrade commits, interruption stays fail-closed."
