# Marketplace extension wave runner

`extension-wave-runner.mjs` is the controlled, observable driver for publishing
many **0-dependency** `cinatra-ai` extensions to the marketplace back-to-back
(a marketplace "scaleout wave"). It does not invent a publish path — each
extension is submitted by shelling out to the same hardened
[`release-submit.mjs`](../extensions/templates/release/release-submit.mjs) the CI
release workflow uses (dependency-ordering gate, vendor auth, request timeout,
and the promotion-outcome assertion all apply identically).

It adds the seven things a multi-extension wave needs (each called for by the
wave readiness audit):

1. **Pacing** (`--pace-ms`, default 13000, floor 6000) — the credential broker
   rate-limits mutating ops on one bucket keyed by the vendor's HMAC keyId
   (burst 5, refill 10/min); each submit is ~2 mutating ops, so a back-to-back
   wave trips a 429 cascade.
2. **Pre-flight pack** — packs every extension locally first and asserts each is
   a valid `<50 MiB` tarball carrying `package.json` + `README.md` + a
   `cinatra.kind` (a missing kind → no storefront category; a missing README →
   blank Description tab).
3. **Auth pre-flight** — one authenticated `cinatra-extension-get` read so a
   bad/rotated token fails *before* any publish.
4. **Promotion-state truth** — a half-failed promotion returns
   `status=approved` + `promotion_state=failed` with **no** MCP error;
   `release-submit.mjs` throws on it, and the runner records each terminal
   outcome.
5. **Resume** (`--state`) — a re-run skips extensions already confirmed listed.
6. **Reconciliation** — after the wave, asserts each extension is an actually
   renderable storefront listing (`cinatra-extension-get` + the public
   `/extension/cinatra-ai-<slug>/` page).
7. **Safety** — **dry-run by default**; `--execute` is required to submit;
   `--canary <n>` caps NEW submits. The vendor token is read from
   `CINATRA_MARKETPLACE_VENDOR_TOKEN` (env only) and is **never** printed,
   logged, or placed on argv.

## Recommended ramp (irreversible — Verdaccio final-publish is immutable per version)

```bash
# 0. Token via env only (no-taint). E.g. from the source of truth:
#    export CINATRA_MARKETPLACE_VENDOR_TOKEN="$(infisical secrets get … --plain --silent)"

# 1. DRY RUN — enumerate, pre-flight pack all, auth pre-flight, reconcile existing.
node scripts/marketplace/extension-wave-runner.mjs

# 2. CANARY — one NEW 0-dep extension, then verify every surface by hand.
node scripts/marketplace/extension-wave-runner.mjs --execute --only <slug> --canary 1

# 3. SMALL BATCH — 3–5, paced, to exercise the rate-limit envelope.
node scripts/marketplace/extension-wave-runner.mjs --execute --canary 5

# 4. REMAINDER — paced, resumable; re-run is safe (skips already-listed).
node scripts/marketplace/extension-wave-runner.mjs --execute
```

Each run ends with a WAVE REPORT (eligible / pre-flight valid / submitted /
storefront-listed / not-yet-listed). A non-zero exit on `--execute` means at
least one extension is not yet a confirmed listing — reconcile before calling
the wave done.
