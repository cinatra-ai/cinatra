# Changelog

All notable changes to Cinatra are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.4] - 2026-06-28

A coordinated security-hardening release, a cleaner and more consistent UI built on the design system, and a tighter connectors and agents experience.

### Added

- **External MCP Servers connector.** A first-class **MCP Servers** connector lets you register external Model Context Protocol servers from its own setup page, with the external-MCP configuration moved off the global settings screen onto that connector. The connector card is now labelled **MCP Clients** to match its role.
- **Close self-registration.** Administrators can now turn off open self-registration for an instance from a single admin toggle, so a workspace can be locked to invited members only.
- **Installed agent templates on the Agents page.** The **Agents** page now lists the agent templates you have installed (including operator-vendor agents in the agent runner), so you can see and launch what is available without hunting through the marketplace.
- **Observable extension control plane.** Extension activation is now generated and observable through a first-class control plane, giving operators a clearer view of what is active on an instance.
- **API Requests analytics filters.** The API Requests analytics view gained server-side date-range and per-service filtering.

### Changed

- **UI on the design system.** A broad pass moved raw HTML elements across the app, packages, and configuration screens onto the shared shadcn-based design system — connector cards, onboarding, dashboards, skills, agents, permissions, and more — for consistent styling, theming, and accessibility. Connector cards now show a clear toggle, plug-status icon, and themed logo.
- **Connectors page.** The connectors list now shows only installed connector cards, and connector chrome (breadcrumbs, empty states, page headers) is aligned to the app's canonical layout.
- **Workflows.** The standalone Workflows browse page and its navigation entry were removed; the workflow engine and approvals are unchanged and remain available.
- **AI provider setup.** AI-provider key setup is surfaced consistently as **AI Providers**, and the Anthropic configuration section is hidden until that connector is set up.
- **OpenAI connector is now part of the bundled system set**, so an OpenAI-backed instance works out of the box.
- Internal: the dependency stack received bounded currency updates, and several large modules were refactored into focused units behind unchanged behavior.

### Fixed

- The assistant chat no longer "thinks forever" on a dropped connection — the event stream is guarded and the run is aborted cleanly on disconnect.
- Clearer, actionable diagnostics replaced bare "fetch failed"-style errors across chat, agent runs, the Nango connector, and the LLM-to-MCP path, each pointing at the concrete next step (for example, the missing OpenAI key).
- Agent run detail pages keep failed and stopped runs on screen instead of redirecting away, and only navigate on a successful setup.
- Numerous accessibility and polish fixes: password-toggle focus order and labelling, breadcrumb keys, sidebar active-state on nested routes, chat spacing, and themed empty states for Webhooks and Agents.

### Security

- This release ships a body of **coordinated security hardening** across the chat, agent, connector, and external-MCP surfaces — among them XSS hardening of the chat markdown renderer, tightened authorization on chat and connector routes, stricter actor binding and token-scope enforcement on the agent-to-agent bridge and MCP token minting, admin-gating of global external-MCP server writes, and a safer default for in-process extension activation trust. Coordinated advisories for the individually-tracked items will be published after deploy.

### Known issues

Carried forward to a future release:

- CLI backup restore is not yet end-to-end: restoring a CLI-created backup can fail while restoring the connector database. Tracked in [cinatra-cli#68](https://github.com/cinatra-ai/cinatra-cli/issues/68).
- The **source-checkout** production install path (`MODE=prod make setup` from a cloned tree) can abort during extension re-verification. The published **container image** install path is unaffected. Tracked in [cinatra-cli#74](https://github.com/cinatra-ai/cinatra-cli/issues/74).
- On a fresh local development setup, `make setup` can exit non-zero when the pre-wizard doctor check for the LLM-MCP connection runs before that connection is configurable. Tracked in [cinatra#674](https://github.com/cinatra-ai/cinatra/issues/674).

## [0.1.3] - 2026-06-25

A reusable webhooks and streams facility, an authenticated control plane for the CLI, security hardening, and a platform-dependency refresh.

### Added

- **Webhooks facility.** Cinatra now has a first-class webhooks layer. Extensions can register inbound webhooks that are served at a single, predictable URL — `/webhook/<vendor>/<slug>/<hook>` — with built-in signature verification (Standard-Webhooks) and duplicate-delivery protection, so the same event is never processed twice. Each connected site is issued its own webhook secret automatically at connect time, instead of one secret shared across a connector.
- **Webhooks page.** A new **Tools → Webhooks** screen lists every registered webhook — its vendor, package, hook, URL, and status — so operators can see what is wired up at a glance.
- Outbound webhooks are now delivered through one host-owned engine that signs every request with Standard-Webhooks, retries transient failures with exponential backoff, and records permanently-failed or exhausted deliveries in a durable dead-letter table.
- **`cinatra login` and an authenticated control plane.** The server now exposes an authenticated control-plane API (`/api/cli`) so the Cinatra CLI can manage a running instance — local or remote — after `cinatra login`. Operators can sign in with a browser flow (with a secure local token cache) or use machine credentials in CI, then run control-plane commands such as installing and removing extensions, importing and exporting agents, checking status, and managing model access against the instance they are signed in to.
- **Reusable stream primitives.** A new `@cinatra-ai/streams` package provides durable, resumable event-stream building blocks (and a `cinatra.streams` extension declaration). This is foundational groundwork for extension authors; existing streaming behavior in the app is unchanged.
- **Docker Hub images.** Cinatra release images are now published to the public `cinatra/cinatra` Docker Hub repository on every tagged release, multi-architecture (amd64/arm64) and identical to the GitHub Container Registry images — so you can pull Cinatra from Docker Hub, not just GHCR.

### Changed

- **Breaking (assistant webhook receivers):** the assistant `@mention` webhook is now signed with the Standard-Webhooks headers (`webhook-id` / `webhook-timestamp` / `webhook-signature`) instead of the legacy `X-Cinatra-Signature` HMAC header. The assistant id is still sent as the `X-Cinatra-Assistant-Id` header. Receivers must switch to Standard-Webhooks verification — see `docs/webhooks/outbound-delivery.md`.
- The WordPress "post published" webhook now runs on the new shared webhooks facility, with per-site authentication and duplicate-delivery protection in place of a single shared connector secret. Existing connected WordPress sites continue to work without any change — the previous signed path is kept live during the transition.
- **Platform dependencies upgraded.** The underlying framework and library stack (React/Next.js, TypeScript, the build and database tooling, and the agent runtime) has been brought up to current stable releases. These updates are transparent to your data and your workspace — no action is required on upgrade.
- **Platform databases move to PostgreSQL 17.** The platform now targets PostgreSQL 17. For self-hosting operators this is **not** an automatic, in-place upgrade: the live data move from PostgreSQL 15 to 17 is a deliberate, scheduled maintenance operation (back up, migrate, verify per database, with a clean rollback to 15 if needed). Follow the PostgreSQL major-upgrade runbook, and do not redeploy an un-migrated PostgreSQL 15 database onto a 17 image — the database will refuse to start. During the short migration windows, the app and existing connections keep working; only starting brand-new connector connections (and, separately, triggering new deploys) is briefly paused.
- Connectors page: your **Connected / Available** filter selection is now remembered across reloads and navigation instead of resetting each visit. Connect buttons and cards can be disabled until their prerequisites are met.

### Fixed

- Breadcrumbs no longer lead to dead ends: intermediate path segments that have no page of their own now render as plain labels instead of links that 404, while the connector breadcrumb links to its actual setup page.
- The "Become a vendor" flow is more robust: on an instance where the marketplace isn't configured, the form now explains that and points to the setup step instead of silently submitting a doomed application; a rejected application no longer gets stuck in a false "pending review" state and can always be cancelled, even when the marketplace is offline.
- The personal dashboard dialogs (add text, add portlet, configure filter, confirm delete) all close consistently with the Escape key and share a consistent backdrop, and an empty dashboard now explains in plain language what it is and how to add your first card.

### Security

- The Nango connector-configuration secret, when stored in the database rather than supplied through the environment, is now encrypted at rest instead of being saved in plain text; existing values are re-encrypted automatically. No operator action is required.
- Administrative and operator actions are hardened with a dedicated, separately-scoped OAuth permission (kept out of default client registration), audit logging of destructive admin operations, and tightened cross-origin and bearer-token acceptance — the safeguards that gate privileged, remote control-plane operations.

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

[0.1.4]: https://github.com/cinatra-ai/cinatra/releases/tag/v0.1.4
[0.1.3]: https://github.com/cinatra-ai/cinatra/releases/tag/v0.1.3
[0.1.2]: https://github.com/cinatra-ai/cinatra/releases/tag/v0.1.2
[0.1.1]: https://github.com/cinatra-ai/cinatra/releases/tag/v0.1.1
[0.1.0]: https://github.com/cinatra-ai/cinatra/releases/tag/v0.1.0
