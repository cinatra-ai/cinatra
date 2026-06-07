# Changelog

All notable changes to Cinatra are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-06-07

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

[0.1.0]: https://github.com/cinatra-ai/cinatra
