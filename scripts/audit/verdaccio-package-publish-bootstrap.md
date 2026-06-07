# Runbook: Verdaccio package publish bootstrap — RETIRED

**This runbook is retired. Do not follow it.**

It described a one-time + steady-state flow for publishing three internal
workspace packages — `@cinatra-ai/design`, `@cinatra-ai/sdk-ui`, and
`@cinatra-ai/marketplace-mcp-contract` — to `registry.cinatra.ai` via
monorepo tag pushes (`@cinatra-ai/<pkg>@<version>`) handled by a
`Package Tag Publish (Verdaccio)` workflow, then verified by a
`Package Smoke Install (Verdaccio)` scheduled workflow.

That pipeline no longer exists:

- `registry.cinatra.ai` holds **only marketplace-published extensions**
  (agents / skills / connectors / artifacts / workflows), which are published
  from their own extracted repos — **not** via a monorepo tag-push gate.
- The internal SDK / app packages (`design`, `sdk-ui`, `marketplace-mcp-client`,
  etc.) are **not** publishable. They are now `"private": true` in the monorepo
  and stay there. Whether to publish any of them to npm later is a separate
  future decision.

The supporting machinery has been removed:

- `.github/workflows/package-tag-publish.yml` — deleted (design / sdk-ui →
  Verdaccio tag-push publish).
- `.github/workflows/extension-tag-publish.yml` — deleted (extension →
  Verdaccio tag-push publish).
- `.github/workflows/package-smoke-install.yml` — deleted (daily smoke install
  of the three now-private/non-existent packages; it could only ever fail
  post-rule).
- `scripts/audit/package-publish-allowlist.mjs` — `PUBLISH_ALLOWLIST` is now
  empty, so the tag-publish allowlist gate rejects every monorepo package tag.

This file is kept (rather than deleted) only as a tombstone so the historical
references above resolve to an explanation instead of a dangling link.
