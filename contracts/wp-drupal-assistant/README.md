# WordPress / Drupal assistant contract

Versioned wire contract between the Cinatra core and the external CMS assistant
clients:

- `cinatra-ai/wordpress-plugin` (the `cinatra` WordPress plugin)
- `cinatra-ai/drupal-module` (the `cinatra` Drupal module)

Both clients embed a `contractVersion` in their bootstrap so a plugin built
against one version **fails loud with an admin-visible error** rather than
silently breaking when Cinatra's contract later changes.

## Layout

```
contracts/wp-drupal-assistant/
  v1/
    bundle-config.schema.json     # config block the plugin/module injects for bundle.js
    auth-init.schema.json         # authenticated stream-init POST body (carries contractVersion)
    sse-event.schema.json         # one decoded SSE frame {event, data}; FROZEN to text|changes|error|done
    assistant-action.schema.json  # content-edit action round-trip (the `changes` payload)
    fixtures/                     # ≥1 golden valid example per schema, per platform
```

The JSON Schemas (draft 2020-12) are the **source of truth**. The cinatra-side
runtime validator lives at `src/lib/wp-drupal-contract.ts` and imports
`auth-init.schema.json` directly (bundled, no runtime file I/O). Contract tests
in `tests/contracts/wp-drupal/` validate every fixture against its schema and
round-trip the auth-init fixtures through the runtime validator.

## Runtime enforcement

`/api/agents/{wordpress,drupal}-content-editor/stream` calls
`validateAuthInitRequest(body)` before doing any work:

- **present + supported** (`v1`) → request proceeds.
- **present + unsupported** (e.g. `v2` against a v1-only instance) → `400` with
  `{ error: { code: "unsupported_contract_version", message, supportedVersions, received } }`.
- **non-conforming versioned body** → `400` with
  `{ error: { code: "invalid_request_shape", … } }`.
- **absent** (legacy/unversioned) → request proceeds (not hard-broken at v0.1.0).

The `400` body is rendered by the widget panel, so the CMS admin sees an
actionable message — never an opaque `500`.

## Adding a new contract version

A breaking change does **not** mutate `v1`. Instead:

1. Add `contracts/wp-drupal-assistant/v2/` with the changed schemas + fixtures.
2. Extend `SUPPORTED_CONTRACT_VERSIONS` + the per-version validator wiring in
   `src/lib/wp-drupal-contract.ts`. The validator core does not change.
3. Ship the `v2`-aware Cinatra backend **first**; then ship the plugin/module
   update that sends `contractVersion: "v2"`. Keep `v1` supported during the
   transition until a deliberate deprecation PR removes it.

See `https://docs.cinatra.ai/guides/developer/wp-drupal-plugin-development/` for the full contract-bump
checklist and the two-repo coordination workflow.

## CI

Changes under `contracts/wp-drupal-assistant/**` (and the runtime validator /
widget stream route) are a hard gate via `.github/workflows/wp-drupal-contract.yml`:
the contract test suite (`tests/contracts/wp-drupal/`) must pass. The Playwright
UAT path-filter additionally triggers the full WordPress/Drupal end-to-end suite
on contract changes once that suite lands.
