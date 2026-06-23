# Changelog

All notable changes to Cinatra are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Outbound webhooks are now delivered through one host-owned engine that signs every request with Standard-Webhooks, retries transient failures with exponential backoff, and records permanently-failed or exhausted deliveries in a durable dead-letter table.

### Changed

- **Breaking (assistant webhook receivers):** the assistant `@mention` webhook is now signed with the Standard-Webhooks headers (`webhook-id` / `webhook-timestamp` / `webhook-signature`) instead of the legacy `X-Cinatra-Signature` HMAC header. The assistant id is still sent as the `X-Cinatra-Assistant-Id` header. Receivers must switch to Standard-Webhooks verification — see `docs/webhooks/outbound-delivery.md`.

## [0.1.2] - 2026-06-22

Authenticated in-CMS assistant, an installable developer CLI, project-management integration, and unified analytics dashboards.

### Added

- The in-CMS assistant widget now requires the end user to sign in (hosted sign-in flow) and authorizes content edits per user and per connected site. Edits are bound to the specific connector instance and fail closed, so a signed-out, stale, or non-member user cannot write — each change is attributed to the person who made it.
- A developer CLI you can run without cloning the repo: `npx @cinatra-ai/cinatra` installs, bootstraps, and manages a Cinatra instance from zero. `cinatra login` authenticates against a running server, and the CLI can export and import agents over the server API. The self-hosting production image now installs the published CLI.
- Project-management tool integration: connect an external PM tool (Plane) so schedules sync to PM tasks both ways, a background reconcile loop repairs drifted links, and scheduled release jobs check their PM task's state before running. The development environment can stand up Plane on its own.
- A dashboard analytics portlet backed by embedded analytics, including a new LLM cost-and-usage view that surfaces token spend directly on a dashboard.

### Changed

- Dashboards are unified on a single analytics format. Existing dashboards are migrated automatically on upgrade, and the legacy dashboard rendering path has been removed.
- The Workflows GANTT view is replaced by a task list and index list driven by the PM-tool integration.
- The CLI's commands are unified under one consistent dispatch surface with `--help`/`-h` and `--version` available everywhere.
- Marketplace and registry screens clarify vendor scope, and an instance's display name is decoupled from its provisioning namespace (with offline rename when the marketplace is unreachable).
- LLM cost estimates now include gpt-5.5 pricing.

### Fixed

- The assistant widget no longer returns an empty "(no response)" when editing content from a connected CMS.
- A workspace whose only platform administrator authored an agent can now approve it, clearing a single-admin deadlock; admin-authored chat agents publish immediately instead of getting stuck as "proposed".
- Agent-approval pages now show the reason when a decision fails instead of silently reloading, aggregated approval notifications open on the correct tab, and the approvals timestamp column is labelled "Requested".
- A failed marketplace install no longer crashes the page.
- The thread list reorders only on real activity and sorts by most recently updated.
- Polished UI details: a themed not-found page, a pointer cursor on the sidebar rail, a correctly scaled app favicon, and no raw diagnostic output leaking into the authoring chat.

## [0.1.1] - 2026-06-18

Extensions Dev Kit and milestone hardening.

### Added

- Extensions Dev Kit: author agents, artifacts, skills, and workflows declaratively from chat, backed by a typed extension SDK (`@cinatra-ai/sdk-extensions`) with a stable host ABI and a `migrationsDir` contract for connector-owned schema.
- `create-cinatra-extension` scaffolder for all five extension kinds (agent, artifact, skill, workflow, connector), wired to the SDK with per-kind authoring guidance.
- Marketplace connector vendor-identity publish gate: per-vendor-key ownership binding plus an owner-controlled provider-mapping check (with a manual-review fallback), preventing vendor-namespace squatting and provider misrepresentation.

### Changed

- Dependency currency: bounded patch/minor updates and added security overrides across the workspace.
- Documented and CI-gated the SDK ABI policy and the source-mirror model for first-party `@cinatra-ai/*` packages.

### Fixed

- Fresh development setup no longer fails to boot when `OPENAI_API_KEY` is unset — it is optional (used only for Graphiti object embeddings); the assistant's model provider is configured in-app.
- Documentation: corrected the self-hosting production deploy-flow runbook and an extension-authoring guide.

## [0.1.0] - 2026-06-08

The first public open source release of Cinatra, the open source AI workspace.

### Added

- Browser-based, multi-user workspace with chat, agents, dashboards, typed data objects, lists, and real-time notifications.
- Declarative agents on open standards (OAS Flow) running in a WayFlow sidecar, with A2A cross-agent calling, AG-UI event streams, and MCP primitives.
- Durable background execution on BullMQ over Redis, with persistent state in PostgreSQL and human-in-the-loop approval gates.
- A unified object and list layer with typed object families and MCP-exposed data primitives.
- Pre-built connectors brokered through an OAuth gateway: Gmail, Google Calendar, Apollo, LinkedIn, WordPress, Drupal, Apify, YouTube, and GitHub.
- Skill extensions and per-user custom skills with runtime, agent-scoped resolution.
- An extension marketplace: install agents, connectors, artifacts, skills, and workflows onto a running workspace with per-extension access control, and publish your own to the registry.
- Multi-provider LLM routing with per-provider token and cost reporting.
- An external MCP server that exposes the platform's capabilities to MCP-compliant clients.
- A four-tier ownership model (user, team, organization, workspace) and projects as bounded spaces for related work.
- A five-audience documentation set: User, Admin, Hosting, Developer, and MCP.

[0.1.2]: https://github.com/cinatra-ai/cinatra/releases/tag/v0.1.2
[0.1.1]: https://github.com/cinatra-ai/cinatra/releases/tag/v0.1.1
[0.1.0]: https://github.com/cinatra-ai/cinatra/releases/tag/v0.1.0
